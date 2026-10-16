// Browser-only signing. Credentials are deliberately held in this closure, never serialized to browser storage.
import { encode } from '@msgpack/msgpack';
import { createWalletClient, custom, getAddress, keccak256, recoverTypedDataAddress, type Address, type EIP1193Provider, type Hex } from 'viem';
import { polygon } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Book, Market, OrderInput } from '../shared/contracts';
import { D, signedDecimal, validateOrder, type RiskOrder } from './math';

export const SIGNING_DOMAIN = { name:'Polymarket', version:'1', chainId:137 } as const;
export const CREATE_PROXY_TYPES = { CreateProxy:[{name:'addr',type:'address'},{name:'exp',type:'uint64'},{name:'salt',type:'uint64'},{name:'ts',type:'uint64'}] } as const;
export const OP_TYPES = { Op:[{name:'data',type:'bytes32'},{name:'salt',type:'uint64'},{name:'ts',type:'uint64'}] } as const;
export interface WireOrder { iid:number;buy:boolean;p:string;qty:string;tif:'ioc'|'gtc';po:boolean;ro:boolean;c:string; }
export type TradingOperation = {type:'createOrders';args:WireOrder[]} | {type:'cancelOrders';args:number[]} | {type:'autoCancel';args:{time:number}};
export interface SignedOperation { op:TradingOperation;sig:Hex;salt:number;ts:number; }
export interface LivePending { owner:string;clientOrderId:string|null;orderId:number|null;action:string;submittedAt:number;deadline?:number; }
export interface LiveSessionStatus { owner:string|null;proxy:string|null;expiresAt:number|null;connected:boolean;authorized:boolean;blockedReason:string|null;pending:LivePending|null;botControlled:boolean; }
export interface AutoCancelStatus { deadline:number;triggered:number;dailyLimit:number;nextReset:number;observedAt:number; }
export interface LiveOutcome { status:'accepted'|'rejected'|'unknown';message:string;response?:unknown;autoCancel?:AutoCancelStatus; }
export interface LiveAccount { portfolio:unknown;orders:unknown;config:unknown; }
export interface LiveReconciliation extends LiveAccount {resolved:boolean;status:LiveSessionStatus;autoCancel?:AutoCancelStatus;}
export interface LiveOrderQuery {orderId?:number;clientOrderId?:string;}
export interface LiveBotControl {
  status():LiveSessionStatus;
  readAccount():Promise<LiveAccount>;
  readOrder(query:LiveOrderQuery):Promise<unknown[]>;
  readOrders(query:LiveOrderQuery):Promise<unknown[]>;
  readAutoCancel():Promise<AutoCancelStatus>;
  submit(input:OrderInput,market:Market,book:Book,confirm:boolean):Promise<LiveOutcome>;
  cancel(orderId:number,confirm:boolean):Promise<LiveOutcome>;
  armAutoCancel(deadline:number,confirm:boolean):Promise<LiveOutcome>;
  reconcile():Promise<LiveReconciliation>;
}
export type LiveBotSession=LiveBotControl;
export interface LiveAuditRow {timestamp:number;event:string;owner:string|null;pending:LivePending|null;}
export interface LiveSessionOptions {provider:EIP1193Provider;token:string;fetcher?:typeof fetch;now?:()=>number;storage?:Pick<Storage,'getItem'|'setItem'>;withLock?:<T>(operation:()=>Promise<T>)=>Promise<T>;withBotLock?:<T>(operation:()=>Promise<T>)=>Promise<T>;}
type Json = Record<string,unknown>;
const jsonObject=(value:unknown):Json=>typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Json:{};
const errorMessage=(value:unknown,fallback:string)=>typeof jsonObject(value).error==='string'?jsonObject(value).error as string:fallback;
const salt=()=>{const bytes=new Uint32Array(1);crypto.getRandomValues(bytes);return bytes[0]!;};
const injectedBotLocks=new WeakMap<NonNullable<LiveSessionOptions['withLock']>,{busy:boolean}>();
/** Non-browser tests inject execution locking; give that adapter a separate, shared lifetime gate. */
function injectedBotLock(lock:NonNullable<LiveSessionOptions['withLock']>):NonNullable<LiveSessionOptions['withBotLock']>{
  let state=injectedBotLocks.get(lock);if(!state){state={busy:false};injectedBotLocks.set(lock,state);}
  const shared=state;
  return async<T>(operation:()=>Promise<T>):Promise<T>=>{if(shared.busy)throw new Error('Another tab owns live bot control. Stop and reconcile that session first.');shared.busy=true;try{return await operation();}finally{shared.busy=false;}};
}
function parsePending(value:unknown):LivePending|null{
  if(value===null)return null;
  const p=jsonObject(value);
  if(typeof p.owner!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(p.owner)||!['createOrders','cancelOrders','autoCancel'].includes(String(p.action))||!Number.isSafeInteger(p.submittedAt)||(p.clientOrderId!==null&&(typeof p.clientOrderId!=='string'||!/^[0-9a-f]{32}$/.test(p.clientOrderId)))||(p.orderId!==null&&(!Number.isSafeInteger(p.orderId)||Number(p.orderId)<0)))throw new Error('Saved live intent is invalid');
  if(p.action==='autoCancel'&&(!Number.isSafeInteger(p.deadline)||Number(p.deadline)<0||p.clientOrderId!==null||p.orderId!==null))throw new Error('Saved auto-cancel intent is invalid');
  return p as unknown as LivePending;
}
export const createProxyTypedData=(proxy:Address,expiry:number,requestSalt:number,timestamp:number)=>({domain:SIGNING_DOMAIN,types:CREATE_PROXY_TYPES,primaryType:'CreateProxy' as const,message:{addr:proxy,exp:BigInt(expiry),salt:BigInt(requestSalt),ts:BigInt(timestamp)}});
export function compactOperation(op:TradingOperation):unknown[] {
  if(op.type==='createOrders')return [op.type,op.args.map(order=>[order.iid,order.buy,order.p,order.qty,order.tif,order.po,order.ro,order.c].filter(value=>value!==undefined))];
  if(op.type==='autoCancel')return [op.type,[op.args.time]];
  return [op.type,op.args];
}
export const operationHash=(op:TradingOperation)=>keccak256(encode(compactOperation(op)));
export const operationTypedData=(op:TradingOperation,requestSalt:number,timestamp:number)=>({domain:SIGNING_DOMAIN,types:OP_TYPES,primaryType:'Op' as const,message:{data:operationHash(op),salt:BigInt(requestSalt),ts:BigInt(timestamp)}});
/** Open-order admission includes accepted/unfilled quantity, even before it has reached the resting book. */
export function liveRiskOrders(value:unknown,instrumentId:number):RiskOrder[]{
  if(!Array.isArray(value))throw new Error('Open-order snapshot is incomplete');
  const orders:RiskOrder[]=[];
  for(const valueRow of value){
    const row=jsonObject(valueRow);
    if(!Number.isSafeInteger(row.instrument_id))throw new Error('Open-order instrument metadata is incomplete');
    if(row.instrument_id!==instrumentId)continue;
    if(typeof row.buy!=='boolean'||typeof row.ro!=='boolean'||typeof row.price!=='string'||typeof row.quantity!=='string'||typeof row.filled_quantity!=='string'||typeof row.resting_quantity!=='string')throw new Error('Open-order risk snapshot is incomplete');
    for(const amount of [row.quantity,row.filled_quantity,row.resting_quantity])if(!/^(0|[1-9]\d*)(\.\d+)?$/.test(amount))throw new Error('Open-order quantities are invalid');
    const unfilled=new D(row.quantity).minus(row.filled_quantity);
    if(unfilled.lt(0))throw new Error('Open-order fill quantity exceeds its original size');
    orders.push({side:row.buy?'buy':'sell',reduceOnly:row.ro,price:row.price,remainingQuantity:D.max(unfilled,row.resting_quantity).toFixed()});
  }
  return orders;
}
export function livePositionQuantity(value:unknown,instrumentId:number):string{
  if(!Array.isArray(value))throw new Error('Position snapshot is incomplete');
  let result='0',found=false;
  for(const raw of value){
    const position=jsonObject(raw);
    if(!Number.isSafeInteger(position.instrument_id))throw new Error('Position instrument metadata is incomplete');
    const quantity=signedDecimal(position.size,'Live position quantity');
    if(position.instrument_id===instrumentId){if(found)throw new Error('Duplicate position rows');result=quantity.toFixed();found=true;}
  }
  return result;
}
export async function signOperation(op:TradingOperation,account:Pick<ReturnType<typeof privateKeyToAccount>,'signTypedData'>,requestSalt:number,timestamp:number):Promise<SignedOperation>{
  return {op,sig:await account.signTypedData(operationTypedData(op,requestSalt,timestamp)),salt:requestSalt,ts:timestamp};
}

export function createLiveSession(options:LiveSessionOptions){
  const fetcher=options.fetcher??fetch,now=options.now??Date.now;
  const wallet=createWalletClient({transport:custom(options.provider),chain:polygon});
  let owner:Address|null=null,proxy:ReturnType<typeof privateKeyToAccount>|null=null,secret:string|null=null,expiresAt:number|null=null,pending:LivePending|null=null;
  let busy=false,generation=0,authorizationUnknown=false,botControlled=false;
  const browserLocks=globalThis.navigator?.locks;
  const serialize:LiveSessionOptions['withLock']|null=options.withLock??(browserLocks?(async<T>(operation:()=>Promise<T>):Promise<T>=>await browserLocks.request('polytrade-live-execution-v1',{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw new Error('Another PolyTrade tab is signing, submitting or reconciling. Complete that action first.');return operation();})):null);
  const withLiveLock=<T>(operation:()=>Promise<T>):Promise<T>=>{if(!serialize)return Promise.reject(new Error('This browser cannot provide an exclusive live-execution lock. Use a current browser on localhost.'));return serialize(operation);};
  const serializeBot:LiveSessionOptions['withBotLock']|null=options.withBotLock??(browserLocks?(async<T>(operation:()=>Promise<T>):Promise<T>=>await browserLocks.request('polytrade-live-bot-v1',{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw new Error('Another PolyTrade tab owns live bot control. Stop and reconcile it before manual actions.');return operation();})):options.withLock?injectedBotLock(options.withLock):null);
  const withControlLock=<T>(operation:()=>Promise<T>):Promise<T>=>{if(!serializeBot)return Promise.reject(new Error('This browser cannot provide an exclusive live-bot control lock.'));return serializeBot(operation);};
  const manual=<T>(operation:()=>Promise<T>):Promise<T>=>withControlLock(()=>withLiveLock(operation));
  const STORAGE_KEY='polytrade.live-intents.v1';
  let storage=options.storage,audit:LiveAuditRow[]=[],storageFailure:string|null=null;
  try{
    storage??=globalThis.localStorage;
    if(!storage)throw new Error('Browser storage is unavailable');
    const saved=storage.getItem(STORAGE_KEY);
    if(saved){
      const value:unknown=JSON.parse(saved),record=jsonObject(value);
      if(record.version!==1||!Array.isArray(record.audit)||typeof record.authorizationUnknown!=='boolean')throw new Error('Live intent journal is unreadable');
      pending=parsePending(record.pending);
      authorizationUnknown=record.authorizationUnknown;audit=record.audit.slice(-100) as LiveAuditRow[];
    }
  }catch(error){storageFailure=error instanceof Error?error.message:'Live intent journal is unavailable';}
  function persist(event:string){
    if(!storage||storageFailure)throw new Error(`Durable nonsecret live journal unavailable: ${storageFailure??'browser storage unavailable'}`);
    const row:LiveAuditRow={timestamp:now(),event,owner,pending:pending?{...pending}:null};
    try{
      const current=storage.getItem(STORAGE_KEY),saved=current?jsonObject(JSON.parse(current)):null;
      if(saved&&saved.version!==1)throw new Error('Live journal format changed');
      const previous=saved&&Array.isArray(saved.audit)?saved.audit as LiveAuditRow[]:audit;
      storage.setItem(STORAGE_KEY,JSON.stringify({version:1,pending,authorizationUnknown,audit:[...previous,row].slice(-100)}));audit=[...previous,row].slice(-100);
    }
    catch{storageFailure='Browser storage write failed';throw new Error('Live intent could not be saved. No new request is allowed.');}
  }
  function clearPending(event:string){const previous=pending;pending=null;try{persist(event);}catch(error){pending=previous;throw error;}}
  function refreshUnresolved(){
    if(!storage||storageFailure)throw new Error(`Durable nonsecret live journal unavailable: ${storageFailure??'browser storage unavailable'}`);
    const saved=storage.getItem(STORAGE_KEY);
    if(!saved)return;
    const record=jsonObject(JSON.parse(saved));
    if(record.version!==1||!Array.isArray(record.audit)||typeof record.authorizationUnknown!=='boolean')throw new Error('Live intent journal changed unexpectedly');
    pending=parsePending(record.pending);
    authorizationUnknown=record.authorizationUnknown;audit=record.audit.slice(-100) as LiveAuditRow[];
  }
  function requireManualBotCleanup(){
    let record:Json;
    try{
      if(!storage||storageFailure)throw new Error('Storage unavailable');
      const saved=storage.getItem('polytrade.live-bot.v1');
      if(saved===null)return;
      record=jsonObject(JSON.parse(saved));
      if(record.version!==1||!Object.prototype.hasOwnProperty.call(record,'state'))throw new Error('Invalid bot journal version');
      if(record.state===null)return;
      const state=jsonObject(record.state);
      if(state.mode!=='live'||typeof state.id!=='string'||!state.id||typeof state.owner!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(state.owner)||!Array.isArray(state.orders)||!['starting','running','stopping','halted','stopped','completed'].includes(String(state.status)))throw new Error('Invalid bot recovery state');
      if(['stopped','completed'].includes(String(state.status))){
        if(state.orders.some((order)=>jsonObject(order).terminal!==true))throw new Error('Terminal bot still has unresolved orders');
        return;
      }
    }catch{
      throw new Error('Live bot recovery journal is unavailable or malformed. Stop/reconcile live bot cleanup first.');
    }
    throw new Error('Stop/reconcile live bot cleanup first. Owned orders or native account-wide auto-cancel protection may remain active.');
  }
  const status=(botScope=false):LiveSessionStatus=>({owner,proxy:proxy?.address??null,expiresAt,connected:owner!==null,authorized:!!secret&&!!proxy&&!!expiresAt&&expiresAt>now(),blockedReason:storageFailure?`Durable nonsecret live journal unavailable: ${storageFailure}`:!serialize?'This browser cannot provide an exclusive live-execution lock.':pending?'A signed write is awaiting order-state reconciliation.':authorizationUnknown?'Proxy registration outcome is unknown. Inspect the official account before authorizing another proxy.':busy?'A wallet or account action is in progress.':botControlled&&!botScope?'Live bot control is active. Stop and reconcile the bot before manual actions.':!owner?'Connect a wallet.':!secret?'Authorize an expiring proxy.':!expiresAt||expiresAt<=now()?'Proxy credentials expired. Authorize again.':null,pending:pending?{...pending}:null,botControlled});
  const credentials=()=>{
    if(!owner||!proxy||!secret||!expiresAt||expiresAt<=now())throw new Error('A connected wallet and unexpired proxy session are required');
    return {owner,proxy,secret,expiresAt};
  };
  async function relay(path:string,method='GET',body?:unknown,privateRead=false):Promise<Response>{
    const headers:Record<string,string>={'x-polytrade-token':options.token};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(privateRead){const credential=credentials();headers['polymarket-proxy']=credential.proxy.address;headers['polymarket-secret']=credential.secret;}
    return fetcher(`/api/live?path=${encodeURIComponent(path)}`,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15_000),cache:'no-store'});
  }
  async function read(path:string):Promise<unknown>{const response=await relay(path,'GET',undefined,true);const value:unknown=await response.json();if(!response.ok)throw new Error(errorMessage(value,`Private read failed (${response.status})`));return value;}
  async function checkOwner(){
    const accounts=await options.provider.request({method:'eth_accounts'}) as string[];
    if(!owner||!accounts[0]||getAddress(accounts[0])!==owner){proxy=null;secret=null;expiresAt=null;throw new Error('Wallet account changed. Reconnect and authorize the correct account.');}
    const chain=await options.provider.request({method:'eth_chainId'});
    if(Number(chain)!==137)throw new Error('Select Polygon (chain 137) in the wallet before authorizing or signing');
  }
  async function readAccount():Promise<LiveAccount>{
    credentials();await checkOwner();
    const results=await Promise.all([read('/v1/account/portfolio'),read('/v1/account/open-orders'),read('/v1/account/config')]);
    return {portfolio:results[0],orders:results[1],config:results[2]};
  }
  async function readOrders(query:LiveOrderQuery):Promise<unknown[]>{
    await checkOwner();credentials();
    const byId=query?.orderId!==undefined,byClient=query?.clientOrderId!==undefined;
    if(byId===byClient)throw new Error('Choose one exact exchange order ID or client order ID');
    if(byId&&(!Number.isSafeInteger(query.orderId)||query.orderId!<0)||byClient&&!/^[0-9a-f]{32}$/.test(query.clientOrderId??''))throw new Error('Invalid order-history identity');
    const key=byId?`order_id=${query.orderId}`:`client_order_id=${query.clientOrderId}`;
    const rows=await read(`/v1/account/orders?${key}`);
    if(!Array.isArray(rows))throw new Error('Order history snapshot is incomplete');
    return rows;
  }
  async function readAutoCancel():Promise<AutoCancelStatus>{
    await checkOwner();credentials();
    const row=jsonObject(await read('/v1/account/auto-cancel'));
    for(const key of ['deadline','triggered','daily_limit','next_reset'])if(!Number.isSafeInteger(row[key])||Number(row[key])<0)throw new Error('Auto-cancel status is incomplete or malformed');
    return {deadline:row.deadline as number,triggered:row.triggered as number,dailyLimit:row.daily_limit as number,nextReset:row.next_reset as number,observedAt:now()};
  }
  async function connectUnlocked():Promise<LiveSessionStatus>{
    if(busy)throw new Error('A wallet action is already in progress');
    const accounts=await options.provider.request({method:'eth_requestAccounts'}) as string[];
    if(!accounts[0])throw new Error('Wallet returned no account');
    const next=getAddress(accounts[0]);
    if(owner&&owner!==next){proxy=null;secret=null;expiresAt=null;generation++;}
    owner=next;return status();
  }
  async function authorizeUnlocked(ttlMinutes=60):Promise<LiveSessionStatus>{
    refreshUnresolved();
    if(busy||authorizationUnknown||storageFailure)throw new Error(status().blockedReason??'Session busy');
    if(!owner)throw new Error('Connect a registered Polymarket signer first');
    if(pending&&getAddress(pending.owner)!==owner)throw new Error('Reconnect the owner of the saved unresolved live intent before recovering account access');
    if(!Number.isFinite(ttlMinutes)||ttlMinutes<1||ttlMinutes>1440)throw new Error('Proxy lifetime must be 1 to 1440 minutes');
    busy=true;const currentGeneration=generation;
    try{
      await checkOwner();
      const response=await relay(`/v1/info/registered?address=${owner}`),registration:unknown=await response.json();
      if(!response.ok||jsonObject(registration).registered!==true)throw new Error('This signer does not have a registered Polymarket Perps account. Use the official account setup first.');
      const nextProxy=privateKeyToAccount(generatePrivateKey()),expiry=Math.floor(now()+ttlMinutes*60_000),requestSalt=salt(),timestamp=now();
      const typed=createProxyTypedData(nextProxy.address,expiry,requestSalt,timestamp);
      const sig=await wallet.signTypedData({...typed,account:owner});
      const recovered=await recoverTypedDataAddress({...typed,signature:sig});
      if(getAddress(recovered)!==owner)throw new Error('Wallet signature does not match the connected signer');
      if(generation!==currentGeneration)throw new Error('Session changed during authorization');
      await checkOwner();
      refreshUnresolved();
      if(authorizationUnknown||pending&&getAddress(pending.owner)!==owner)throw new Error('A different or indeterminate proxy action requires reconciliation first');
      authorizationUnknown=true;persist('proxy_registration_pending');
      let registrationResponse:Response;
      try{registrationResponse=await relay('/v1/account/proxy','POST',{op:{type:'createProxy',args:{owner,proxy:nextProxy.address,expiry}},sig,salt:requestSalt,ts:timestamp,label:'polytrade'});}
      catch{authorizationUnknown=true;throw new Error('Proxy registration outcome unknown. Do not repeat authorization until checking the official account.');}
      let value:unknown;
      try{value=await registrationResponse.json();}catch{authorizationUnknown=true;throw new Error('Proxy registration returned an unreadable response; inspect the official account.');}
      if(!registrationResponse.ok){if(registrationResponse.status<500&&registrationResponse.status!==408){authorizationUnknown=false;persist('proxy_registration_rejected');}throw new Error(errorMessage(value,`Proxy authorization failed (${registrationResponse.status})`));}
      if(typeof jsonObject(value).secret!=='string'||!(jsonObject(value).secret as string)){authorizationUnknown=true;throw new Error('Proxy authorization did not return a secret');}
      if(generation!==currentGeneration){authorizationUnknown=true;throw new Error('Session changed after proxy registration');}
      proxy=nextProxy;secret=jsonObject(value).secret as string;expiresAt=expiry;authorizationUnknown=false;persist('proxy_registered');
    }finally{busy=false;}
    return status();
  }
  async function send(op:TradingOperation,method:'POST'|'DELETE'|'PATCH',identity:Omit<LivePending,'submittedAt'|'owner'>):Promise<LiveOutcome>{
    const credential=credentials();await checkOwner();const currentGeneration=generation;
    const timestamp=now(),request=await signOperation(op,credential.proxy,salt(),timestamp);
    if(currentGeneration!==generation)throw new Error('Session changed before submission');
    refreshUnresolved();
    if(pending||authorizationUnknown)throw new Error('Another signed intent is awaiting reconciliation');
    pending={...identity,owner:credential.owner,submittedAt:timestamp};persist('signed_intent');
    try{
      const response=await relay(op.type==='autoCancel'?'/v1/trade/auto-cancel':'/v1/trade/orders',method,request),value:unknown=await response.json();
      if(!response.ok){
        if(response.status>=500||response.status===408){persist('write_unknown');return {status:'unknown',message:'Exchange response is indeterminate. Reconcile this signed write before another order.',response:value};}
        clearPending('write_rejected');return {status:'rejected',message:errorMessage(value,`Signed request rejected (${response.status})`),response:value};
      }
      const row=op.type==='autoCancel'?jsonObject(value):Array.isArray(value)&&value.length===1?jsonObject(value[0]):{};
      if(row.status==='err'){clearPending('write_rejected');return {status:'rejected',message:typeof row.error==='string'?row.error:'Exchange rejected the command',response:value};}
      if(row.status!=='ok'){persist('write_unknown');return {status:'unknown',message:'Malformed acknowledgement. Reconcile before another signed write.',response:value};}
      if(op.type==='autoCancel'){
        if(row.deadline!==op.args.time){persist('write_unknown');return {status:'unknown',message:'Auto-cancel acknowledgement does not match the requested deadline. Reconcile before any order.',response:value};}
        persist('write_acknowledged');
        const observed=await readAutoCancel();
        if(observed.deadline!==op.args.time||(observed.deadline!==0&&observed.deadline<=now())){persist('write_unknown');return {status:'unknown',message:'Auto-cancel deadline was not positively confirmed by the exchange. No new order is allowed.',response:value,autoCancel:observed};}
        clearPending('auto_cancel_reconciled');
        return {status:'accepted',message:observed.deadline===0?'Exchange auto-cancel schedule is confirmed cleared.':'Exchange auto-cancel deadline is positively confirmed.',response:value,autoCancel:observed};
      }
      if(typeof row.oid==='number'&&Number.isSafeInteger(row.oid))pending!.orderId=row.oid;
      persist('write_acknowledged');
      return {status:'accepted',message:'Request acknowledged. Acceptance does not confirm a fill or cancellation; reconcile order state.',response:value};
    }catch{try{persist('write_unknown');}catch{/* The durable pre-submit intent remains unresolved. */}return {status:'unknown',message:'Signed request may have reached the exchange. No retry was made; reconcile order state before another write.'};}
  }
  async function submitUnlocked(input:OrderInput,market:Market,book:Book,confirm:boolean,manualCreate=false):Promise<LiveOutcome>{
    if(confirm!==true)throw new Error('Explicit review confirmation is required for real orders');
    if(manualCreate)requireManualBotCleanup();
    refreshUnresolved();
    if(busy||pending||authorizationUnknown||storageFailure)throw new Error(status().blockedReason??'Live session busy');
    busy=true;
    try{
      const account=await readAccount(),portfolio=jsonObject(account.portfolio),positions=portfolio.positions;
      if(!Array.isArray(positions)||portfolio.in_liquidation!==false)throw new Error('Complete non-liquidating account state is required');
      const observed=Number(portfolio.timestamp);
      if(!Number.isFinite(observed)||now()-observed>=15_000||observed>now()+1000)throw new Error('Private portfolio is stale');
      const quantity=livePositionQuantity(positions,market.id);
      const valid=validateOrder(input,market,book,quantity,now(),{openOrders:liveRiskOrders(account.orders,market.id)});
      const configs=Array.isArray(account.config)?account.config.map(jsonObject):[],config=configs.find(c=>c.instrument_id===market.id);
      if(!config||typeof config.leverage!=='number'||config.leverage!==input.leverage||typeof config.cross!=='boolean'||market.isolatedOnly&&config.cross!==false)throw new Error('Selected leverage/margin mode must match the confirmed account configuration. Set it on the official terminal, then refresh.');
      const available=jsonObject(portfolio.margin).available_order_margin;
      const availableMargin=signedDecimal(available,'Available order margin');
      if(!input.reduceOnly&&availableMargin.lt(new D(valid.notional).div(input.leverage).plus(new D(valid.notional).mul('0.0004'))))throw new Error('Insufficient confirmed available order margin, including a default taker-fee buffer');
      if(!Array.isArray(account.orders))throw new Error('Open-order snapshot is incomplete');
      if(account.orders.map(jsonObject).some(order=>order.client_order_id===input.clientOrderId))throw new Error('Client order ID is already present in the live account');
      const wire:WireOrder={iid:market.id,buy:input.side==='buy',p:valid.limitPrice,qty:input.quantity,tif:input.type==='market'?'ioc':'gtc',po:input.postOnly,ro:input.reduceOnly,c:input.clientOrderId};
      if(manualCreate)requireManualBotCleanup();
      return await send({type:'createOrders',args:[wire]},'POST',{action:'createOrders',clientOrderId:input.clientOrderId,orderId:null});
    }finally{busy=false;}
  }
  async function cancelUnlocked(orderId:number,confirm:boolean):Promise<LiveOutcome>{
    if(confirm!==true)throw new Error('Confirm cancellation of this real exchange order');
    refreshUnresolved();
    if(!Number.isSafeInteger(orderId)||orderId<0)throw new Error('Invalid exchange order ID');
    if(busy||pending||authorizationUnknown||storageFailure)throw new Error(status().blockedReason??'Live session busy');
    busy=true;
    try{return await send({type:'cancelOrders',args:[orderId]},'DELETE',{action:'cancelOrders',clientOrderId:null,orderId});}
    finally{busy=false;}
  }
  async function armAutoCancelUnlocked(deadline:number,confirm:boolean):Promise<LiveOutcome>{
    if(confirm!==true)throw new Error('Explicitly confirm the account-wide auto-cancel schedule');
    if(!Number.isSafeInteger(deadline)||deadline<0||(deadline!==0&&deadline<now()+5_000))throw new Error('Auto-cancel deadline must be zero or at least 5 seconds in the future');
    refreshUnresolved();
    if(busy||pending||authorizationUnknown||storageFailure)throw new Error(status().blockedReason??'Live session busy');
    busy=true;
    try{return await send({type:'autoCancel',args:{time:deadline}},'PATCH',{action:'autoCancel',clientOrderId:null,orderId:null,deadline});}
    finally{busy=false;}
  }
  async function reconcileUnlocked():Promise<LiveReconciliation>{
    refreshUnresolved();
    if(pending&&(!owner||getAddress(pending.owner)!==owner))throw new Error('Reconnect the owner of the unresolved live intent before reconciliation');
    if(busy)throw new Error('Live session busy');busy=true;
    try{
      const account=await readAccount();
      let autoCancel:AutoCancelStatus|undefined;
      if(pending){
        if(pending.action==='autoCancel'){
          autoCancel=await readAutoCancel();
          if(autoCancel.deadline===pending.deadline&&(autoCancel.deadline===0||autoCancel.deadline>now()))clearPending('auto_cancel_reconciled');
        }else{
          const history=await readOrders(pending.orderId!==null?{orderId:pending.orderId}:{clientOrderId:pending.clientOrderId!}),rows=history.map(jsonObject);
          const row=rows.find(r=>pending!.orderId!==null?r.order_id===pending!.orderId:r.client_order_id===pending!.clientOrderId);
          const known=['accepted','open','partial','filled','cancelled','canceled','rejected','ioc_no_fill','ioc_expired','stp_cancelled'];
          const terminal=['filled','cancelled','canceled','rejected','ioc_no_fill','ioc_expired','stp_cancelled'];
          if(row&&typeof row.status==='string'&&known.includes(row.status)&&Number(row.updated_timestamp)>=pending.submittedAt&&(pending.action!=='cancelOrders'||terminal.includes(row.status)))clearPending('order_reconciled');
        }
      }
      return {...account,resolved:pending===null,status:status(),...(autoCancel?{autoCancel}:{})};
    }finally{busy=false;}
  }
  async function disconnectUnlocked(){if(busy)throw new Error('Live session busy');generation++;owner=null;proxy=null;secret=null;expiresAt=null;}
  async function acknowledgeManualReconciliationUnlocked(confirm:boolean){
    refreshUnresolved();
    if(confirm!==true||!owner||pending&&getAddress(pending.owner)!==owner)throw new Error('Connect the original owner and explicitly confirm reconciliation on the official terminal');
    if(busy)throw new Error('Live session busy');
    const oldPending=pending,oldAuthorization=authorizationUnknown;pending=null;authorizationUnknown=false;
    try{persist('operator_confirmed_official_reconciliation');}catch(error){pending=oldPending;authorizationUnknown=oldAuthorization;throw error;}
    return status();
  }
  async function withBotControl<T>(operation:(control:LiveBotControl)=>Promise<T>):Promise<T>{
    return withControlLock(async()=>{
      refreshUnresolved();
      if(busy||authorizationUnknown||storageFailure)throw new Error(status().blockedReason??'Live session busy');
      credentials();await checkOwner();
      if(pending&&getAddress(pending.owner)!==owner)throw new Error('Reconnect the owner of the unresolved live intent before bot recovery');
      botControlled=true;
      let active=true,accepting=true;
      const inflight=new Set<Promise<unknown>>();
      const scoped=<R>(action:()=>Promise<R>,financial=false):Promise<R>=>{
        if(!active||!accepting)return Promise.reject(new Error('Live bot control has been released'));
        const promise=financial?withLiveLock(action):action();
        inflight.add(promise);void promise.then(()=>inflight.delete(promise),()=>inflight.delete(promise));
        return promise;
      };
      const control:LiveBotControl={
        status:()=>status(true),
        readAccount:()=>scoped(readAccount),
        readOrder:(query)=>scoped(()=>readOrders(query)),readOrders:(query)=>scoped(()=>readOrders(query)),
        readAutoCancel:()=>scoped(readAutoCancel),
        submit:(input,market,book,confirm)=>scoped(()=>submitUnlocked(input,market,book,confirm),true),
        cancel:(orderId,confirm)=>scoped(()=>cancelUnlocked(orderId,confirm),true),
        armAutoCancel:(deadline,confirm)=>scoped(()=>armAutoCancelUnlocked(deadline,confirm),true),
        reconcile:()=>scoped(async()=>{const result=await reconcileUnlocked();return {...result,status:status(true)};},true),
      };
      try{return await operation(control);}
      finally{
        accepting=false;
        // A caller cannot release the lifetime lock by forgetting to await a started scoped request.
        await Promise.allSettled([...inflight]);active=false;botControlled=false;
      }
    });
  }
  const connect=()=>manual(connectUnlocked);
  const authorize=(ttlMinutes=60)=>manual(()=>authorizeUnlocked(ttlMinutes));
  const submit=(input:OrderInput,market:Market,book:Book,confirm:boolean)=>manual(()=>submitUnlocked(input,market,book,confirm,true));
  const cancel=(orderId:number,confirm:boolean)=>manual(()=>cancelUnlocked(orderId,confirm));
  const armAutoCancel=(deadline:number,confirm:boolean)=>manual(()=>armAutoCancelUnlocked(deadline,confirm));
  const reconcile=()=>manual(reconcileUnlocked);
  const disconnect=()=>manual(disconnectUnlocked);
  const acknowledgeManualReconciliation=(confirm:boolean)=>manual(()=>acknowledgeManualReconciliationUnlocked(confirm));
  return {status:()=>status(),connect,authorize,readAccount,readOrder:readOrders,readOrders,readAutoCancel,submit,cancel,armAutoCancel,reconcile,disconnect,withBotControl,acknowledgeManualReconciliation,journal:()=>structuredClone(audit)};
}
export type BrowserLiveSession=ReturnType<typeof createLiveSession>;
