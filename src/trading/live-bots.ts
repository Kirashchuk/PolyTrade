import type { Book, BotConfig, Market, OrderInput } from '../shared/contracts';
import type { LiveAccount, LiveOutcome, LiveSessionStatus } from './live';
import { ACTIVE_ORDER_STATUSES as ACTIVE, TERMINAL_ORDER_STATUSES as TERMINAL, livePositionQuantity } from './live';
import { D, decimal, roundGrid, signedDecimal, validateBook, validateMetadata, validateOrder } from './math';
import { planPaperOrders } from './strategies';

export interface LiveBotConfig extends BotConfig { slippageBps:number; maxDurationSeconds:number; }
export interface LiveBotOrder {
  clientOrderId:string;orderId:number|null;side:'buy'|'sell';quantity:string;filledQuantity:string;
  status:string;terminal:boolean;submittedAt:number;updatedAt:number|null;
}
export interface LiveBotFillObservation {clientOrderId:string;orderId:number;quantity:string;observedAt:number;}
export interface LiveBotState {
  mode:'live';id:string;owner:string;config:LiveBotConfig;status:'starting'|'running'|'stopping'|'completed'|'stopped'|'halted';
  note:string;ticks:number;createdAt:number;nextRunAt:number;deadline:number;lastArmedAt:number;
  filledQuantity:string;scheduledQuantity:string;ownedOrderIds:number[];orders:LiveBotOrder[];fills:LiveBotFillObservation[];
}
interface AutoCancelStatus {deadline:number;triggered:number;dailyLimit:number;nextReset:number;observedAt:number;}
export interface LiveBotPort {
  status():LiveSessionStatus;
  readAccount():Promise<LiveAccount>;
  readOrders(query?:{orderId?:number;clientOrderId?:string}):Promise<unknown>;
  submit(input:OrderInput,market:Market,book:Book,confirm:boolean):Promise<LiveOutcome>;
  cancel(orderId:number,confirm:boolean):Promise<LiveOutcome>;
  armAutoCancel(deadline:number,confirm:boolean):Promise<LiveOutcome>;
  readAutoCancel():Promise<AutoCancelStatus>;
  reconcile():Promise<LiveAccount&{resolved:boolean;status:LiveSessionStatus}>;
}
export interface LiveBotOptions {
  session:{status():LiveSessionStatus;withBotControl<T>(callback:(control:LiveBotPort)=>Promise<T>):Promise<T>};
  load:(instrumentId:number)=>Promise<{market:Market;book:Book;cancelOnly?:boolean}>;
  storage?:Pick<Storage,'getItem'|'setItem'>;now?:()=>number;
}
const KEY='polytrade.live-bot.v1',DEADMAN_MS=60_000,RENEW_MS=15_000,RENEW_EARLY_MS=10_000,MIN_HEADROOM_MS=15_000,MAX_ORDERS=1000;
const object=(value:unknown):Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:{};
const message=(error:unknown)=>error instanceof Error?error.message:'Live strategy safety check failed';

/** Browser execution only. Strategy math is pure; all fills come from authenticated exchange order snapshots. */
export function createLiveBotManager(options:LiveBotOptions){
  const now=options.now??Date.now;
  let storage=options.storage,storageFailure:string|null=null,current:LiveBotState|null=null;
  let control:LiveBotPort|null=null,releaseLease:(()=>void)|null=null,leaseTask:Promise<void>|null=null;
  let work:Promise<LiveBotState|null>|null=null,stopRequested=false;
  try{
    storage??=globalThis.localStorage;if(!storage)throw new Error('Browser storage unavailable');
    const saved=storage.getItem(KEY);
    if(saved){
      const record=object(JSON.parse(saved)),state=object(record.state);
      if(record.version!==1||!/^0x[0-9a-fA-F]{40}$/.test(String(state.owner))||typeof state.id!=='string'||!Array.isArray(state.orders)||state.orders.length>MAX_ORDERS||!Array.isArray(state.fills)||state.mode!=='live')throw new Error('Live bot recovery record is invalid');
      current=state as unknown as LiveBotState;
      for(const order of current.orders){
        if(!/^[0-9a-f]{32}$/.test(order.clientOrderId)||!['buy','sell'].includes(order.side)||!Number.isFinite(order.submittedAt)||typeof order.terminal!=='boolean')throw new Error('Live bot owned-order record is invalid');
        decimal(order.quantity);const filled=signedDecimal(order.filledQuantity);if(filled.lt(0)||filled.gt(order.quantity))throw new Error('Live bot fill record is invalid');
      }
      if(!['stopped','completed'].includes(current.status)){current.status='halted';current.note='Recovered after page reload. No automatic resume. Authorize the original owner and press Stop / reconcile to clean up tracked orders.';}
    }
  }catch(error){storageFailure=message(error);}
  function save(){
    if(!storage||storageFailure)throw new Error(`Live bot journal unavailable: ${storageFailure??'storage unavailable'}`);
    try{storage.setItem(KEY,JSON.stringify({version:1,state:current}));}
    catch{storageFailure='Browser storage write failed';throw new Error('Live bot intent could not be saved; no new order is allowed');}
  }
  const state=()=>current?structuredClone(current):null;
  function halt(reason:string){if(current){current.status='halted';current.note=reason;try{save();}catch{current.note+=`. ${storageFailure}`;}}}
  function snapshotSafety(market:Market,book:Book,cancelOnly?:boolean){
    validateMetadata(market);validateBook(book,market.id,now());
    if(market.timestamp===null||!Number.isFinite(market.timestamp)||now()-market.timestamp>=15_000||market.timestamp>now()+1000||market.markPrice===null||!Number.isFinite(market.markPrice)||market.markPrice<=0)throw new Error('Instrument mark observation is stale or unavailable');
    if(market.closeOnly||market.settled||cancelOnly===true)throw new Error('Venue is cancel-only, or instrument is close-only / settled');
  }
  function accountSafety(account:LiveAccount){
    const portfolio=object(account.portfolio),timestamp=portfolio.timestamp;
    if(typeof timestamp!=='number'||!Number.isFinite(timestamp)||now()-timestamp>=15_000||timestamp>now()+1000||portfolio.in_liquidation!==false||!Array.isArray(portfolio.positions)||!Array.isArray(account.orders))throw new Error('Fresh complete non-liquidating account data is required');
    return portfolio;
  }
  function ready(){
    if(!current||!control)throw new Error('No live bot owns this session');
    const status=control.status();
    if(!status.authorized||!status.owner||status.owner.toLowerCase()!==current.owner.toLowerCase()||!status.expiresAt||status.expiresAt<=now())throw new Error('Original wallet / proxy session changed or expired');
    return status;
  }
  async function acquire(){
    if(control)return;
    let accept:()=>void=()=>{},reject:(error:unknown)=>void=()=>{};
    const acquired=new Promise<void>((resolve,fail)=>{accept=resolve;reject=fail;});
    const held=new Promise<void>(resolve=>{releaseLease=resolve;});
    leaseTask=options.session.withBotControl(async port=>{control=port;accept();await held;control=null;}).catch(error=>{reject(error);if(current&&['running','starting','stopping'].includes(current.status))halt(`Live bot ownership lost: ${message(error)}`);});
    await acquired;
  }
  async function release(){releaseLease?.();releaseLease=null;await leaseTask;leaseTask=null;control=null;}
  function totals(){
    if(!current)return;
    current.filledQuantity=current.orders.reduce((sum,order)=>sum.plus(order.filledQuantity),new D(0)).toFixed();
    current.ownedOrderIds=current.orders.filter(order=>!order.terminal&&order.orderId!==null).map(order=>order.orderId!);
    if(new D(current.filledQuantity).gt(current.config.totalQuantity))throw new Error('Exchange fills exceeded the configured strategy budget; reconciliation required');
  }
  async function syncOrders(){
    if(!current||!control)return;
    if(control.status().pending){const result=await control.reconcile();if(!result.resolved)throw new Error('Signed request remains indeterminate. No retry or new exposure is permitted.');}
    // Terminal snapshots have final cumulative fills; retain them in the budget without refetching each tick.
    for(const order of current.orders.filter(order=>!order.terminal)){
      const result=await control.readOrders({clientOrderId:order.clientOrderId}),rows=Array.isArray(result)?result:[];
      const row=rows.map(object).find(value=>value.client_order_id===order.clientOrderId||(order.orderId!==null&&value.order_id===order.orderId));
      if(!row)throw new Error(`Accepted / uncertain order ${order.clientOrderId} is absent from order history. Scheduling halted.`);
      // Exchange update times are compared only with each other, never with the browser clock.
      if(row.instrument_id!==current.config.instrumentId||row.buy!==(order.side==='buy')||row.client_order_id!==order.clientOrderId||!signedDecimal(row.quantity,'Exchange order quantity').eq(order.quantity)||!Number.isSafeInteger(row.order_id)||Number(row.order_id)<0||typeof row.status!=='string'||(!ACTIVE.has(row.status)&&!TERMINAL.has(row.status))||typeof row.updated_timestamp!=='number'||!Number.isFinite(row.updated_timestamp)||order.updatedAt!==null&&row.updated_timestamp<order.updatedAt)throw new Error('Owned order history is incomplete, mismatched or stale');
      const filled=signedDecimal(row.filled_quantity,'Exchange filled quantity');
      if(filled.lt(order.filledQuantity)||filled.gt(order.quantity)||filled.lt(0))throw new Error('Exchange cumulative fill quantity is inconsistent');
      const resting=signedDecimal(row.resting_quantity,'Exchange resting quantity');
      if(resting.lt(0)||resting.gt(new D(order.quantity).minus(filled))||TERMINAL.has(row.status)&&!resting.isZero()||row.status==='filled'&&!filled.eq(order.quantity)||['rejected','ioc_no_fill','fok_unfilled','post_only_rejected'].includes(row.status)&&!filled.isZero())throw new Error('Exchange order status, filled quantity and resting quantity are inconsistent');
      const delta=filled.minus(order.filledQuantity);order.orderId=row.order_id as number;
      if(delta.gt(0)){current.fills.push({clientOrderId:order.clientOrderId,orderId:order.orderId,quantity:delta.toFixed(),observedAt:now()});current.fills=current.fills.slice(-MAX_ORDERS);}
      order.filledQuantity=filled.toFixed();order.status=row.status;order.terminal=TERMINAL.has(row.status);order.updatedAt=row.updated_timestamp;
      totals();save();
    }
  }
  async function arm(){
    if(!current||!control)return;ready();
    const usage=await control.readAutoCancel();
    if(!Number.isSafeInteger(usage.triggered)||!Number.isSafeInteger(usage.dailyLimit)||usage.triggered<0||usage.dailyLimit<1||usage.triggered>=usage.dailyLimit||!Number.isFinite(usage.observedAt)||now()-usage.observedAt>=15_000||usage.observedAt>now()+1000)throw new Error('Native auto-cancel daily trigger budget is exhausted, stale or unavailable');
    const deadline=now()+DEADMAN_MS;current.note='Arming native account-wide auto-cancel.';save();
    const result=await control.armAutoCancel(deadline,true);
    if(result.status!=='accepted')throw new Error(`Deadman protection ${result.status}: ${result.message}`);
    const confirmed=await control.readAutoCancel();
    if(confirmed.deadline!==deadline||deadline-now()<DEADMAN_MS-RENEW_MS||control.status().pending)throw new Error('Native account-wide auto-cancel deadline was not confirmed with sufficient headroom');
    current.deadline=deadline;current.lastArmedAt=now();save();
  }
  async function cancelOwned(){
    if(!current||!control)return;
    await syncOrders();
    for(const order of current.orders.filter(order=>!order.terminal)){
      if(order.orderId===null)throw new Error('Owned order ID remains unknown; native auto-cancel protection stays armed');
      current.note=`Cancelling owned order ${order.orderId}.`;save();
      const outcome=await control.cancel(order.orderId,true);
      if(outcome.status!=='accepted')throw new Error(`Owned cancel ${outcome.status}: ${outcome.message}`);
      await syncOrders();
      if(!order.terminal)throw new Error('Owned cancellation is not terminal yet. No replacement order is permitted.');
    }
  }
  async function finish(target:'stopped'|'completed'|'halted',note:string){
    if(!current)return;
    try{
      current.status='stopping';current.note=note;save();
      ready();await cancelOwned();
      if(current.orders.some(order=>!order.terminal)||control!.status().pending)throw new Error('Owned orders remain unresolved');
      // Do not clear an account-wide timer while foreign orders are present.
      const account=await control!.readAccount();accountSafety(account);
      if((account.orders as unknown[]).length!==0)throw new Error('Foreign account orders appeared; native account-wide protection remains armed');
      current.note='All owned orders terminal. Clearing native auto-cancel.';save();
      const result=await control!.armAutoCancel(0,true);
      if(result.status!=='accepted'||(await control!.readAutoCancel()).deadline!==0)throw new Error('Native auto-cancel disarm is not confirmed');
      current.deadline=0;current.status=target;current.note=note;save();await release();
    }catch(error){
      halt(`${note} Cleanup unresolved: ${message(error)}. Native protection is left armed; do not place new orders until reconciliation.`);
      if(!control?.status().authorized)await release();
    }
  }
  function configuration(config:LiveBotConfig,market:Market,book:Book){
    snapshotSafety(market,book);
    if(config.instrumentId!==market.id||!['twap','maker'].includes(config.strategy)||!['buy','sell'].includes(config.side))throw new Error('Invalid live strategy or instrument');
    const total=decimal(config.totalQuantity,'Strategy total quantity');
    if((config.totalQuantity.split('.')[1]?.length??0)>market.quantityDecimals||!Number.isSafeInteger(config.slices)||config.slices<1||config.slices>(config.strategy==='maker'?500:1000))throw new Error('Invalid strategy quantity precision or slice count');
    if(!Number.isFinite(config.intervalSeconds)||config.intervalSeconds<1||config.intervalSeconds>300||!Number.isFinite(config.maxDurationSeconds)||config.maxDurationSeconds<5||config.maxDurationSeconds>3600||(config.slices-1)*config.intervalSeconds>config.maxDurationSeconds)throw new Error('Use a bounded 5 to 3600 second duration and 1 to 300 second interval that covers the requested slices');
    if(!Number.isFinite(config.slippageBps)||config.slippageBps<0||config.slippageBps>500||!Number.isFinite(config.spreadBps)||config.spreadBps<0||config.spreadBps>500||!Number.isSafeInteger(config.leverage)||config.leverage<1||config.leverage>market.maxLeverage)throw new Error('Invalid live strategy slippage, spread or leverage');
    const slice=total.div(config.slices),unit=roundGrid(slice.div(config.strategy==='maker'?2:1),market.quantityDecimals);
    if(new D(unit).lte(0)||new D(unit).mul(book.bids[0]!.price).lt(market.minNotional))throw new Error('Strategy slice is below the instrument minimum size / notional');
    if(total.mul(book.asks[0]!.price).gt(config.strategy==='twap'?market.maxMarketNotional:market.maxLimitNotional))throw new Error('Declared strategy total exceeds the instrument notional cap');
  }
  async function startInner(config:LiveBotConfig,confirm:boolean){
    if(confirm!==true)throw new Error('Explicit confirmation of real orders and native account-wide auto-cancel is required');
    if(storageFailure)throw new Error(`Live bot journal unavailable: ${storageFailure}`);
    if(current&&!['completed','stopped'].includes(current.status)&&!(current.status==='halted'&&current.deadline===0&&current.orders.every(order=>order.terminal)))throw new Error('Stop / reconcile the previous live bot before starting another');
    const initial=options.session.status();if(!initial.authorized||initial.pending||!initial.owner||!initial.expiresAt)throw new Error('Authorize an unexpired wallet session with no pending signed write first');
    if(initial.expiresAt<now()+config.maxDurationSeconds*1000+DEADMAN_MS)throw new Error('Proxy session must remain valid for the entire strategy duration plus native protection window');
    const loaded=await options.load(config.instrumentId);snapshotSafety(loaded.market,loaded.book,loaded.cancelOnly);configuration(config,loaded.market,loaded.book);
    if(stopRequested)throw new Error('Stop requested during startup');
    await acquire();
    try{
      const persisted=storage!.getItem(KEY),latest=persisted?object(object(JSON.parse(persisted)).state):null;
      if(latest&&latest.id!==current?.id&&!['completed','stopped'].includes(String(latest.status))&&!(latest.status==='halted'&&latest.deadline===0&&Array.isArray(latest.orders)&&latest.orders.every(value=>object(value).terminal===true)))throw new Error('Another saved bot requires original-owner reconciliation before a new bot can start');
      const account=await control!.readAccount(),portfolio=accountSafety(account);
      if((account.orders as unknown[]).length!==0)throw new Error('Live bot requires zero pre-existing account orders because native auto-cancel is account-wide');
      const position=livePositionQuantity(portfolio.positions,config.instrumentId),configs=Array.isArray(account.config)?account.config.map(object):[];
      if(!configs.some(value=>value.instrument_id===config.instrumentId&&value.leverage===config.leverage&&typeof value.cross==='boolean'&&(!loaded.market.isolatedOnly||value.cross===false)))throw new Error('Set the requested leverage / margin mode on the official terminal before starting');
      for(const intent of planPaperOrders(config,loaded.market,loaded.book,new D(config.totalQuantity).div(config.slices).toFixed()))validateOrder({...intent,slippageBps:config.slippageBps,clientOrderId:'0'.repeat(32)},loaded.market,loaded.book,position,now());
      if(stopRequested)throw new Error('Stop requested during startup');
      current={mode:'live',id:crypto.randomUUID().replaceAll('-',''),owner:initial.owner,config:structuredClone(config),status:'starting',note:'Native account-wide auto-cancel must confirm before any real order.',ticks:0,createdAt:now(),nextRunAt:now(),deadline:0,lastArmedAt:0,filledQuantity:'0',scheduledQuantity:'0',ownedOrderIds:[],orders:[],fills:[]};save();
      if(stopRequested)throw new Error('Stop requested during startup');
      await arm();current.status='running';current.note='Native protection confirmed. Waiting for the first real strategy slice.';save();return state();
    }catch(error){if(current)halt(`Live bot start halted: ${message(error)}`);if(!current||current.deadline===0&&!control!.status().pending)await release();throw error;}
  }
  async function tickInner(){
    if(!current||current.status!=='running')return state();
    try{
      ready();
      const loaded=await options.load(current.config.instrumentId);snapshotSafety(loaded.market,loaded.book,loaded.cancelOnly);
      if(stopRequested){await finish('stopped','Stopped by operator. Positions are retained.');return state();}
      if(now()>=current.createdAt+current.config.maxDurationSeconds*1000){await finish('completed','Bounded live strategy duration reached. Positions are retained.');return state();}
      if(current.deadline-now()<=MIN_HEADROOM_MS)throw new Error('Native protection window expired or timer maintenance was delayed; scheduling halted');
      if(now()-current.lastArmedAt>RENEW_MS)throw new Error('Native protection renewal was delayed beyond 15 seconds; scheduling halted');
      if(now()-current.lastArmedAt>=RENEW_EARLY_MS)await arm();
      await syncOrders();
      if(now()<current.nextRunAt)return state();
      await cancelOwned();
      if(current.ticks>=current.config.slices){await finish('completed','Declared live slices completed. Positions are retained.');return state();}
      const account=await control!.readAccount(),portfolio=accountSafety(account);
      const owned=new Set(current.orders.filter(order=>!order.terminal).map(order=>order.orderId));
      if((account.orders as unknown[]).some(row=>!owned.has(Number(object(row).order_id))))throw new Error('Untracked account orders appeared; no new bot exposure is permitted');
      const budget=new D(current.config.totalQuantity).minus(current.config.strategy==='twap'?current.scheduledQuantity:current.filledQuantity);
      if(budget.lte(0)){await finish('completed','Live quantity budget reached. Positions are retained.');return state();}
      const slice=D.min(budget,new D(current.config.totalQuantity).div(current.config.slices));
      const intents=planPaperOrders(current.config,loaded.market,loaded.book,slice.toFixed());
      if(current.orders.length+intents.length>MAX_ORDERS)throw new Error('Live strategy owned-order journal limit reached');
      const position=livePositionQuantity(portfolio.positions,current.config.instrumentId);
      for(const intent of intents){
        if(stopRequested)throw new Error('Stop requested; no further order will be submitted');
        ready();snapshotSafety(loaded.market,loaded.book,loaded.cancelOnly);
        if(now()-current.lastArmedAt>=RENEW_MS||current.deadline-now()<=MIN_HEADROOM_MS)throw new Error('Protection maintenance exceeded the scheduling bound');
        const input:OrderInput={...intent,slippageBps:current.config.slippageBps,clientOrderId:crypto.randomUUID().replaceAll('-','')};
        validateOrder(input,loaded.market,loaded.book,position,now());
        const outstanding=current.orders.filter(order=>!order.terminal).reduce((sum,order)=>sum.plus(new D(order.quantity).minus(order.filledQuantity)),new D(0));
        if(new D(current.filledQuantity).plus(outstanding).plus(input.quantity).gt(current.config.totalQuantity))throw new Error('Filled plus outstanding live quantity would exceed the declared budget');
        current.orders.push({clientOrderId:input.clientOrderId,orderId:null,side:input.side,quantity:input.quantity,filledQuantity:'0',status:'submitting',terminal:false,submittedAt:now(),updatedAt:null});
        current.scheduledQuantity=new D(current.scheduledQuantity).plus(input.quantity).toFixed();save(); // Durable owned identity before any signing or transport.
        const tracked=current.orders[current.orders.length-1]!;
        let result:LiveOutcome;
        try{result=await control!.submit(input,loaded.market,loaded.book,true);}
        catch(error){
          tracked.status=control!.status().pending?'unknown':'not_submitted';tracked.terminal=!control!.status().pending;save();throw error;
        }
        if(result.status==='rejected'){tracked.status='rejected';tracked.terminal=true;save();throw new Error(`Live order rejected: ${result.message}`);}
        if(result.status==='unknown'){tracked.status='unknown';save();throw new Error(`Live submission outcome unknown: ${result.message}`);}
        tracked.status='accepted';save();await syncOrders();
        if(current.config.strategy==='twap'&&!tracked.terminal)throw new Error('IOC order has not reached a terminal exchange state; scheduling halted');
      }
      current.ticks++;current.nextRunAt=now()+current.config.intervalSeconds*1000;current.note=`Live ${current.config.strategy} cycle ${current.ticks}/${current.config.slices}. Fills reflect authenticated order history.`;save();
      return state();
    }catch(error){
      halt(message(error));
      if(control?.status().pending)return state();
      await finish(stopRequested?'stopped':'halted',message(error));return state();
    }
  }
  function run(operation:()=>Promise<LiveBotState|null>){
    if(work)return work;
    const task=operation();work=task;void task.finally(()=>{if(work===task)work=null;}).catch(()=>{});return task;
  }
  async function start(config:LiveBotConfig,confirm:boolean):Promise<LiveBotState>{
    if(work)throw new Error('Live bot action already in progress');
    stopRequested=false;
    const result=await run(()=>startInner(config,confirm));if(!result)throw new Error('Live bot did not start');return result;
  }
  async function stop():Promise<LiveBotState|null>{
    stopRequested=true;if(work)await work.catch(()=>{});
    return run(async()=>{
      if(!current||['stopped','completed'].includes(current.status))return state();
      const status=options.session.status();
      if(!status.authorized||!status.owner||status.owner.toLowerCase()!==current.owner.toLowerCase()){
        halt('Authorize the original owner to reconcile owned orders. Native protection is not cleared.');await release();return state();
      }
      try{await acquire();await finish('stopped','Stopped by operator. Only tracked orders were cancelled; positions are retained.');}
      catch(error){halt(`Stop requires reconciliation: ${message(error)}`);}
      if(current?.status==='halted'){
        current.note+=' Local scheduling is stopped. Ownership is released for original-owner manual reconciliation; native protection is not cleared.';
        try{save();}catch{/* The last durable owned-order identities remain intact. */}await release();
      }
      return state();
    });
  }
  const tick=()=>work?Promise.resolve(state()):run(tickInner);
  return {state,start,stop,tick};
}
export type LiveBotManager=ReturnType<typeof createLiveBotManager>;
