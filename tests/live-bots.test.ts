import { describe, expect, test } from 'bun:test';
import type { Book, Market, OrderInput } from '../src/shared/contracts';
import type { LiveOutcome, LiveSessionStatus } from '../src/trading/live';
import { createLiveBotManager, type LiveBotConfig, type LiveBotPort } from '../src/trading/live-bots';

const OWNER='0x'+'11'.repeat(20),TIME=1_800_000_000_000;
const config:LiveBotConfig={instrumentId:1,strategy:'twap',side:'buy',totalQuantity:'2',slices:2,intervalSeconds:5,spreadBps:20,leverage:2,slippageBps:25,maxDurationSeconds:60};
function fixture(){
  let now=TIME,deadline=0,held=false,authorized=true,storageFails=false,preexisting=false,stale=false,cancelOnly=false,triggered=0,dailyLimit=1000;
  let pending:LiveSessionStatus['pending']=null,submitMode:'filled'|'partial'|'unknown'|'missing'|'throw'='filled',resolvePending=true,nextId=1,skew=0,limitStatus='open';
  const values=new Map<string,string>(),calls:string[]=[],submitted:OrderInput[]=[],orders=new Map<string,Record<string,unknown>>();
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{if(storageFails)throw new Error('Quota');values.set(key,value);}};
  const status=():LiveSessionStatus=>({owner:OWNER,proxy:'0x'+'22'.repeat(20),expiresAt:TIME+86_400_000,connected:true,authorized,blockedReason:null,pending,botControlled:held});
  const market=():Market=>({id:1,symbol:'TEST-USD',displaySymbol:'TEST',baseAsset:'TEST',quoteAsset:'pUSD',category:'crypto',priceDecimals:2,quantityDecimals:3,priceBounds:'0.2',minNotional:'1',maxMarketNotional:'100000',maxLimitNotional:'100000',maxOrderCount:200,maxLeverage:10,riskTiers:[{lowerBound:'0',maxLeverage:10}],closeOnly:false,isolatedOnly:false,settled:false,fundingIntervalHours:1,markPrice:100,indexPrice:100,lastPrice:100,openInterest:null,openInterestUsd:null,volume24h:null,change24h:null,fundingRate:null,fundingApr:null,nextFunding:null,timestamp:stale?now-15000:now,sparkline:[]});
  const book=():Book=>({instrumentId:1,bids:[{price:'99',quantity:'10'}],asks:[{price:'100',quantity:'10'}],timestamp:stale?now-15000:now,sequence:1});
  const account=()=>({portfolio:{positions:[],margin:{available_order_margin:'10000'},in_liquidation:false,timestamp:now},orders:preexisting?[{order_id:999}]:[...orders.values()].filter(row=>['open','accepted','partial'].includes(String(row.status))),config:[{instrument_id:1,leverage:2,cross:false}]});
  const port:LiveBotPort={
    status,readAccount:async()=>{calls.push('account');return account();},
    readOrders:async query=>{calls.push('history');if(submitMode==='missing')return [];return [...orders.values()].filter(row=>query?.clientOrderId?row.client_order_id===query.clientOrderId:row.order_id===query?.orderId);},
    readAutoCancel:async()=>{calls.push('auto-read');return {deadline,triggered,dailyLimit,nextReset:now+86_400_000,observedAt:now};},
    armAutoCancel:async time=>{calls.push(time?'arm':'disarm');deadline=time;return {status:'accepted',message:'Mock confirmed protection'};},
    submit:async input=>{
      calls.push('submit');submitted.push(structuredClone(input));
      if(submitMode==='throw')throw new Error('Insufficient confirmed margin');
      const filled=input.type==='limit'?'0':submitMode==='partial'?'0.5':input.quantity,terminal=input.type==='market';
      orders.set(input.clientOrderId,{order_id:nextId++,client_order_id:input.clientOrderId,instrument_id:input.instrumentId,buy:input.side==='buy',quantity:input.quantity,filled_quantity:filled,resting_quantity:terminal||limitStatus!=='open'?'0':input.quantity,status:terminal?(submitMode==='partial'?'ioc_expired':'filled'):limitStatus,updated_timestamp:now+skew});
      pending={owner:OWNER,action:'createOrders',clientOrderId:input.clientOrderId,orderId:null,submittedAt:now};
      if(submitMode==='unknown'){resolvePending=false;return {status:'unknown',message:'Lost mock acknowledgement'};}
      return {status:'accepted',message:'Mock order ACK, not a fill'};
    },
    cancel:async orderId=>{
      calls.push(`cancel:${orderId}`);
      const row=[...orders.values()].find(value=>value.order_id===orderId);if(!row)throw new Error('Unknown owned order');
      row.status='cancelled';row.resting_quantity='0';row.updated_timestamp=now;
      pending={owner:OWNER,action:'cancelOrders',clientOrderId:null,orderId,submittedAt:now};return {status:'accepted',message:'Mock cancel ACK'};
    },
    reconcile:async()=>{calls.push('reconcile');if(resolvePending)pending=null;return {...account(),resolved:pending===null,status:status()};},
  };
  const session={status,withBotControl:async<T>(callback:(port:LiveBotPort)=>Promise<T>)=>{if(held)throw new Error('Another bot holds the account lease');held=true;try{return await callback(port);}finally{held=false;}}};
  const options={session,storage,now:()=>now,load:async()=>({market:market(),book:book(),cancelOnly})};
  const bot=createLiveBotManager(options);
  return {bot,port,options,storage,values,calls,submitted,orders,market,book,status,
    setNow:(value:number)=>{now=value;},advance:(ms:number)=>{now+=ms;},setMode:(mode:typeof submitMode)=>{submitMode=mode;},setStale:(value:boolean)=>{stale=value;},setCancelOnly:(value:boolean)=>{cancelOnly=value;},setAuthorized:(value:boolean)=>{authorized=value;},setPreexisting:(value:boolean)=>{preexisting=value;},setQuota:(value:boolean)=>{storageFails=value;},setUsage:(count:number,limit:number)=>{triggered=count;dailyLimit=limit;},resolve:()=>{resolvePending=true;},getDeadline:()=>deadline,setSkew:(value:number)=>{skew=value;},setLimitStatus:(value:string)=>{limitStatus=value;}};
}

describe('real browser bot lifecycle with mocked exchange transport',()=>{
  test('requires consent, authorized account, no foreign orders and native protection budget',async()=>{
    const f=fixture();await expect(f.bot.start(config,false)).rejects.toThrow('confirmation');expect(f.calls).toHaveLength(0);
    f.setAuthorized(false);await expect(f.bot.start(config,true)).rejects.toThrow('Authorize');f.setAuthorized(true);
    f.setPreexisting(true);await expect(f.bot.start(config,true)).rejects.toThrow('pre-existing');expect(f.status().botControlled).toBe(false);expect(f.calls).not.toContain('arm');
    f.setPreexisting(false);f.setUsage(1000,1000);await expect(f.bot.start(config,true)).rejects.toThrow('budget');expect(f.submitted).toHaveLength(0);
    await f.bot.stop();
  });
  test('native timer confirms before first write; TWAP never retries partial IOC remainder',async()=>{
    const f=fixture();f.setMode('partial');await f.bot.start(config,true);expect(f.submitted).toHaveLength(0);expect(f.status().botControlled).toBe(true);
    await f.bot.tick();expect(f.submitted[0]!.quantity).toBe('1');expect(f.bot.state()!.filledQuantity).toBe('0.5');
    f.advance(5000);await f.bot.tick();f.advance(5000);await f.bot.tick();
    expect(f.bot.state()!.status).toBe('completed');expect(f.bot.state()!.scheduledQuantity).toBe('2');expect(f.bot.state()!.filledQuantity).toBe('1');expect(f.submitted).toHaveLength(2);
    expect(f.calls.indexOf('arm')).toBeLessThan(f.calls.indexOf('submit'));expect(f.getDeadline()).toBe(0);expect(f.status().botControlled).toBe(false);
  });
  test('maker budget includes fills on cancelled orders and cancels only owned IDs',async()=>{
    const f=fixture();await f.bot.start({...config,strategy:'maker',totalQuantity:'4'},true);await f.bot.tick();expect(f.submitted).toHaveLength(2);
    const first=[...f.orders.values()][0]!;first.filled_quantity='0.6';first.resting_quantity='0.4';first.status='partial';first.updated_timestamp=TIME+5000;
    f.advance(5000);await f.bot.tick();expect(f.bot.state()!.filledQuantity).toBe('0.6');expect(f.submitted).toHaveLength(4);
    const active=f.bot.state()!.orders.filter(row=>!row.terminal).reduce((sum,row)=>sum+Number(row.quantity)-Number(row.filledQuantity),0);
    expect(active+Number(f.bot.state()!.filledQuantity)).toBeLessThanOrEqual(4);expect(f.calls.filter(call=>call.startsWith('cancel:'))).toEqual(['cancel:1','cancel:2']);
    await f.bot.stop();expect(f.bot.state()!.status).toBe('stopped');expect(f.status().botControlled).toBe(false);
  });
  test('checks stale/cancel-only data before next due time and cleans up owned orders',async()=>{
    for(const cause of ['stale','cancel-only'] as const){
      const f=fixture();await f.bot.start({...config,strategy:'maker',intervalSeconds:20},true);await f.bot.tick();f.advance(1000);
      if(cause==='stale')f.setStale(true);else f.setCancelOnly(true);
      await f.bot.tick();expect(f.bot.state()!.status).toBe('halted');expect(f.submitted).toHaveLength(2);expect(f.calls.filter(call=>call.startsWith('cancel:'))).toHaveLength(2);expect(f.getDeadline()).toBe(0);
    }
  });
  test('renews confirmed native timer by 15 seconds even when another slice is not due',async()=>{
    const f=fixture();await f.bot.start({...config,strategy:'maker',intervalSeconds:30,maxDurationSeconds:120},true);await f.bot.tick();f.advance(15000);await f.bot.tick();
    expect(f.calls.filter(call=>call==='arm')).toHaveLength(2);expect(f.submitted).toHaveLength(2);expect(f.getDeadline()).toBe(TIME+75000);await f.bot.stop();
  });
  test('unknown submission halts without retry; reload preserves COID and explicit stop recovers',async()=>{
    const f=fixture();f.setMode('unknown');await f.bot.start(config,true);await f.bot.tick();expect(f.bot.state()!.status).toBe('halted');expect(f.bot.state()!.filledQuantity).toBe('0');expect(f.submitted).toHaveLength(1);
    await f.bot.tick();expect(f.submitted).toHaveLength(1);await f.bot.stop();expect(f.status().botControlled).toBe(false);
    const before=f.storage.getItem('polytrade.live-bot.v1'),restored=createLiveBotManager(f.options);expect(f.storage.getItem('polytrade.live-bot.v1')).toBe(before);expect(restored.state()!.orders[0]!.clientOrderId).toBe(f.submitted[0]!.clientOrderId);
    f.resolve();await restored.stop();expect(restored.state()!.status).toBe('stopped');expect(f.submitted).toHaveLength(1);expect(f.getDeadline()).toBe(0);
  });
  test('missing accepted history never becomes a fill or replacement',async()=>{
    const f=fixture();f.setMode('missing');await f.bot.start(config,true);await f.bot.tick();expect(f.bot.state()!.status).toBe('halted');expect(f.bot.state()!.filledQuantity).toBe('0');expect(f.submitted).toHaveLength(1);await f.bot.stop();
  });
  test('preflight throw without signed pending becomes not_submitted and releases native protection',async()=>{
    const f=fixture();f.setMode('throw');await f.bot.start(config,true);await f.bot.tick();expect(f.bot.state()!.status).toBe('halted');expect(f.bot.state()!.orders[0]!.status).toBe('not_submitted');expect(f.bot.state()!.orders[0]!.terminal).toBe(true);
    expect(f.getDeadline()).toBe(0);expect(f.status().botControlled).toBe(false);f.setMode('filled');await f.bot.start(config,true);await f.bot.stop();
  });
  test('storage failure prevents order transport and keeps native fallback armed',async()=>{
    const f=fixture();await f.bot.start(config,true);f.setQuota(true);await f.bot.tick();expect(f.submitted).toHaveLength(0);expect(f.bot.state()!.status).toBe('halted');expect(f.getDeadline()).toBeGreaterThan(TIME);await f.bot.stop();
  });
  test('malformed exchange resting quantity or status consistency halts before another slice',async()=>{
    const f=fixture();await f.bot.start({...config,strategy:'maker'},true);await f.bot.tick();const row=[...f.orders.values()][0]!;row.resting_quantity='NaN';f.advance(1000);
    await f.bot.tick();expect(f.bot.state()!.status).toBe('halted');expect(f.submitted).toHaveLength(2);row.resting_quantity='1';await f.bot.stop();
  });
  test('Stop requested during an asynchronous startup cannot be cleared before protection or orders',async()=>{
    const f=fixture();let resume:()=>void=()=>{};const wait=new Promise<void>(resolve=>{resume=resolve;});
    const bot=createLiveBotManager({...f.options,load:async()=>{await wait;return {market:f.market(),book:f.book()};}});
    const start=bot.start(config,true),stopped=bot.stop();resume();await expect(start).rejects.toThrow('Stop requested');await stopped;
    expect(f.submitted).toHaveLength(0);expect(f.calls).not.toContain('arm');expect(f.status().botControlled).toBe(false);
  });
  test('exchange history timestamps are not compared with the browser clock',async()=>{
    for(const skew of [2000,-500]){
      const f=fixture();f.setSkew(skew);await f.bot.start(config,true);await f.bot.tick();
      expect(f.bot.state()!.status).toBe('running');expect(f.bot.state()!.filledQuantity).toBe('1');await f.bot.stop();expect(f.bot.state()!.status).toBe('stopped');
    }
  });
  test('documented post-only rejection is terminal; the maker keeps running and cleans up',async()=>{
    const f=fixture();f.setLimitStatus('post_only_rejected');await f.bot.start({...config,strategy:'maker'},true);await f.bot.tick();
    expect(f.bot.state()!.status).toBe('running');expect(f.bot.state()!.orders.every(order=>order.terminal&&order.status==='post_only_rejected')).toBe(true);
    await f.bot.stop();expect(f.bot.state()!.status).toBe('stopped');expect(f.getDeadline()).toBe(0);expect(f.calls.some(call=>call.startsWith('cancel:'))).toBe(false);
  });
});
