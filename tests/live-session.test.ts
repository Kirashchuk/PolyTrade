import { describe, expect, test } from 'bun:test';
import { encode } from '@msgpack/msgpack';
import { keccak256, recoverTypedDataAddress, type EIP1193Provider, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compactOperation, createLiveSession, operationHash, operationTypedData, signOperation, type LiveBotControl, type LiveSessionOptions, type TradingOperation } from '../src/trading/live';
import type { Book, Market, OrderInput } from '../src/shared/contracts';

const TIME = 1_792_053_933_071;
const owner = privateKeyToAccount(('0x' + '11'.repeat(32)) as Hex);
const proxy = privateKeyToAccount(('0x' + '22'.repeat(32)) as Hex);
const market = ():Market => ({id:1,symbol:'TEST-USD',displaySymbol:'TEST',baseAsset:'TEST',quoteAsset:'pUSD',category:'crypto',priceDecimals:2,quantityDecimals:3,priceBounds:'0.2',minNotional:'1',maxMarketNotional:'100000',maxLimitNotional:'100000',maxOrderCount:200,maxLeverage:10,riskTiers:[{lowerBound:'0',maxLeverage:10}],closeOnly:false,isolatedOnly:false,settled:false,fundingIntervalHours:1,markPrice:100,indexPrice:100,lastPrice:100,openInterest:null,openInterestUsd:null,volume24h:null,change24h:null,fundingRate:null,fundingApr:null,nextFunding:null,timestamp:TIME,sparkline:[]});
const book = ():Book => ({instrumentId:1,bids:[{price:'99',quantity:'10'}],asks:[{price:'101',quantity:'10'}],timestamp:TIME,sequence:1});
const order = ():OrderInput => ({instrumentId:1,side:'buy',type:'market',quantity:'1',leverage:2,reduceOnly:false,postOnly:false,slippageBps:50,clientOrderId:crypto.randomUUID().replaceAll('-','')});
const botRecord = (status:string) => ({version:1,state:{mode:'live',id:'ab'.repeat(16),owner:owner.address,status,orders:[]}});
const provider = { request: async ({ method, params }: {method:string;params?:unknown}) => {
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [owner.address];
  if (method === 'eth_chainId') return '0x89';
  if (method === 'eth_signTypedData_v4') {
    const typed = JSON.parse((params as [string,string])[1]); delete typed.types.EIP712Domain;
    return owner.signTypedData(typed);
  }
  throw new Error(`Unexpected wallet request ${method}`);
} } as unknown as EIP1193Provider;

function deferred<T>() {
  let resolve!: (value:T)=>void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function lock(): NonNullable<LiveSessionOptions['withLock']> {
  let busy = false;
  return async <T>(operation:()=>Promise<T>):Promise<T> => {
    if (busy) throw new Error('Another tab owns this lock');
    busy = true; try { return await operation(); } finally { busy = false; }
  };
}
function storage() {
  const values = new Map<string,string>();
  return { getItem:(key:string)=>values.get(key)??null, setItem:(key:string,value:string)=>{values.set(key,value);}, values };
}
function harness() {
  const durable = storage();
  const executionLock = lock(), botLock = lock();
  const requests: {path:string;method:string;headers:Headers;body:unknown}[] = [];
  const history:Record<string,unknown>[] = [];
  const state: {
    now:number;deadline:number;lostAck:boolean;applyBeforeLostAck:boolean;readDeadline:number|null;
    failRead:boolean;malformedRead:boolean;reject:boolean;waitRead:Promise<void>|null;onPortfolio:(()=>void)|null;
  } = { now:TIME, deadline:0, lostAck:false, applyBeforeLostAck:false, readDeadline:null, failRead:false, malformedRead:false, reject:false, waitRead:null,onPortfolio:null };
  const fetcher = (async (input:RequestInfo|URL, init?:RequestInit) => {
    const path = new URL(String(input), 'http://localhost').searchParams.get('path')!, method = init?.method??'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ path, method, headers:new Headers(init?.headers), body });
    if (path.startsWith('/v1/info/registered')) return Response.json({registered:true});
    if (path === '/v1/account/proxy') return Response.json({secret:'memory-only-test-secret'});
    if (path === '/v1/trade/auto-cancel') {
      if (state.reject) return Response.json({error:'auto_cancel_daily_limit_reached'}, {status:400});
      if (state.lostAck) {
        if (state.applyBeforeLostAck) state.deadline = body.op.args.time;
        throw new Error('Lost auto-cancel response');
      }
      state.deadline = body.op.args.time;
      return Response.json({status:'ok', deadline:state.deadline});
    }
    if (path === '/v1/account/auto-cancel') {
      if (state.waitRead) await state.waitRead;
      if (state.failRead) throw new Error('Read unavailable');
      if (state.malformedRead) return Response.json({deadline:state.deadline});
      return Response.json({deadline:state.readDeadline??state.deadline, triggered:3, daily_limit:1000, next_reset:TIME+86_400_000});
    }
    if (path === '/v1/account/portfolio') {state.onPortfolio?.();return Response.json({positions:[],margin:{available_order_margin:'10000'},in_liquidation:false,timestamp:state.now});}
    if (path === '/v1/account/open-orders') return Response.json([]);
    if (path === '/v1/account/config') return Response.json([{instrument_id:1,leverage:2,cross:false}]);
    if (path.startsWith('/v1/account/orders?')) {
      const query=new URL(path,'https://example.test').searchParams;
      return Response.json(history.filter((row)=>query.has('order_id')?row.order_id===Number(query.get('order_id')):row.client_order_id===query.get('client_order_id')));
    }
    if(path==='/v1/trade/orders'&&method==='POST'){
      const wire=body.op.args[0],id=history.length+1;
      history.push({order_id:id,client_order_id:wire.c,status:'filled',updated_timestamp:state.now});
      return Response.json([{status:'ok',oid:id}]);
    }
    throw new Error(`Unexpected endpoint ${method} ${path}`);
  }) as typeof fetch;
  const session = () => createLiveSession({provider,token:'test-control-token',fetcher,now:()=>state.now,storage:durable,withLock:executionLock,withBotLock:botLock});
  const live = session();
  const authorize = async (target=live) => {await target.connect();await target.authorize();};
  const patches = () => requests.filter((request)=>request.path==='/v1/trade/auto-cancel');
  return {live,session,state,durable,requests,authorize,patches};
}

describe('single-attempt exchange auto-cancel', () => {
  test('official compact MessagePack shape has the positional time field and recoverable proxy signature', async () => {
    const operation:TradingOperation = {type:'autoCancel',args:{time:TIME+60_000}};
    expect(compactOperation(operation)).toEqual(['autoCancel',[TIME+60_000]]);
    expect(operationHash(operation)).toBe(keccak256(encode(['autoCancel',[TIME+60_000]])));
    const signed = await signOperation(operation,proxy,123,TIME);
    expect(await recoverTypedDataAddress({...operationTypedData(operation,123,TIME),signature:signed.sig})).toBe(proxy.address);
  });

  test('arm sends one PATCH and clears pending only after authenticated positive readback', async () => {
    const h = harness();await h.authorize();
    const deadline = TIME+60_000, outcome = await h.live.armAutoCancel(deadline,true);
    expect(outcome.status).toBe('accepted');expect(outcome.autoCancel?.deadline).toBe(deadline);
    expect(outcome.autoCancel?.dailyLimit).toBe(1000);expect(h.live.status().pending).toBeNull();
    expect(h.patches()).toHaveLength(1);expect(h.patches()[0]!.method).toBe('PATCH');
    expect(h.patches()[0]!.body).toMatchObject({op:{type:'autoCancel',args:{time:deadline}},ts:TIME});
    const readback = h.requests.find((request)=>request.path==='/v1/account/auto-cancel')!;
    expect(readback.headers.get('polymarket-proxy')).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(readback.headers.get('polymarket-secret')).toBe('memory-only-test-secret');
    expect([...h.durable.values.values()].join('')).not.toContain('memory-only-test-secret');
    expect(h.live.journal().some((row)=>row.event==='auto_cancel_reconciled')).toBe(true);
    expect((await h.live.armAutoCancel(0,true)).status).toBe('accepted');expect(h.state.deadline).toBe(0);
  });

  test('acknowledgement alone cannot establish dead-man protection', async () => {
    const h = harness();await h.authorize();h.state.readDeadline = 0;
    const result = await h.live.armAutoCancel(TIME+60_000,true);
    expect(result.status).toBe('unknown');expect(h.live.status().pending?.action).toBe('autoCancel');
    await expect(h.live.cancel(1,true)).rejects.toThrow('reconciliation');
    await expect(h.live.armAutoCancel(TIME+90_000,true)).rejects.toThrow('reconciliation');
    await expect(h.live.submit({} as OrderInput,{} as Market,{} as Book,true)).rejects.toThrow('reconciliation');
    expect((await h.live.reconcile()).resolved).toBe(false);expect(h.patches()).toHaveLength(1);
    h.state.readDeadline = null;
    expect((await h.live.reconcile()).resolved).toBe(true);expect(h.live.status().pending).toBeNull();expect(h.patches()).toHaveLength(1);
  });

  test('lost response is never retried; durable auto-cancel intent survives reload and reconciles by status', async () => {
    const h = harness();await h.authorize();h.state.lostAck = true;h.state.applyBeforeLostAck = true;
    const deadline = TIME+60_000;
    expect((await h.live.armAutoCancel(deadline,true)).status).toBe('unknown');expect(h.patches()).toHaveLength(1);
    const restored = h.session();expect(restored.status().pending?.deadline).toBe(deadline);
    await h.authorize(restored);
    const result = await restored.withBotControl((control)=>control.reconcile());
    expect(result.resolved).toBe(true);expect(result.autoCancel?.deadline).toBe(deadline);expect(h.patches()).toHaveLength(1);
    expect(h.requests.some((request)=>request.path.includes('client_order_id=null'))).toBe(false);
  });

  test('malformed readback and expired schedules retain the safety block', async () => {
    const h = harness();await h.authorize();h.state.malformedRead = true;
    expect((await h.live.armAutoCancel(TIME+60_000,true)).status).toBe('unknown');
    expect(h.live.status().pending?.action).toBe('autoCancel');
    await expect(h.live.reconcile()).rejects.toThrow('malformed');
    h.state.malformedRead = false;h.state.now += 61_000;
    expect((await h.live.reconcile()).resolved).toBe(false);expect(h.live.status().pending).not.toBeNull();
  });

  test('confirmation and exact safe future deadlines are required before a signed request', async () => {
    const h = harness();
    await expect(h.live.armAutoCancel(TIME+60_000,false)).rejects.toThrow('confirm');
    for (const deadline of [-1,TIME+4_999,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,TIME+60_000.5]) {
      await expect(h.live.armAutoCancel(deadline,true)).rejects.toThrow('5 seconds');
    }
    expect(h.requests).toHaveLength(0);
  });

  test('a definite exchange rejection clears the pending request without inventing protection', async () => {
    const h = harness();await h.authorize();h.state.reject = true;
    const result = await h.live.armAutoCancel(TIME+60_000,true);
    expect(result.status).toBe('rejected');expect(h.live.status().pending).toBeNull();
    expect(result.autoCancel).toBeUndefined();expect(h.patches()).toHaveLength(1);
  });
});

describe('live bot lifetime control', () => {
  test('held bot control rejects manual actions in either tab and permits only its scoped channel', async () => {
    const h = harness();await h.authorize();const other = h.session();await h.authorize(other);
    const entered = deferred<void>(), release = deferred<void>(), holder:{control:LiveBotControl|null}={control:null};
    const running = h.live.withBotControl(async(control)=>{holder.control=control;entered.resolve();await release.promise;return 7;});
    await entered.promise;
    const control = holder.control!;
    expect(h.live.status().botControlled).toBe(true);expect(control.status().blockedReason).toBeNull();
    for (const action of [()=>h.live.connect(),()=>h.live.authorize(),()=>h.live.cancel(1,true),()=>h.live.armAutoCancel(TIME+60_000,true),()=>h.live.reconcile(),()=>h.live.disconnect(),()=>h.live.acknowledgeManualReconciliation(true),()=>other.authorize(),()=>other.cancel(1,true)]) {
      await expect(action()).rejects.toThrow('Another tab');
    }
    expect((await control.armAutoCancel(TIME+60_000,true)).status).toBe('accepted');
    expect(await control.readOrder({clientOrderId:'ab'.repeat(16)})).toEqual([]);
    release.resolve();expect(await running).toBe(7);expect(h.live.status().botControlled).toBe(false);
    await expect(control.armAutoCancel(0,true)).rejects.toThrow('released');
    expect((await h.live.armAutoCancel(0,true)).status).toBe('accepted');
  });

  test('unawaited scoped work retains lifetime protection until the request finishes', async () => {
    const h = harness();await h.authorize();
    const read = deferred<void>(), started = deferred<void>();h.state.waitRead = read.promise;
    const running = h.live.withBotControl(async(control)=>{void control.armAutoCancel(TIME+60_000,true);started.resolve();});
    await started.promise;
    await expect(h.live.disconnect()).rejects.toThrow('Another tab');
    read.resolve();await running;
    expect(h.live.status().botControlled).toBe(false);expect(h.live.status().pending).toBeNull();
  });
});

describe('manual creation after live-bot recovery',()=>{
  test('unresolved bot journals block manual creates while recovery reads and acknowledgement remain usable',async()=>{
    for(const status of ['starting','running','stopping','halted']){
      const h=harness();await h.authorize();
      h.durable.setItem('polytrade.live-bot.v1',JSON.stringify(botRecord(status)));
      await expect(h.live.submit(order(),market(),book(),true)).rejects.toThrow('Stop/reconcile live bot cleanup first');
      expect((await h.live.readAccount()).orders).toEqual([]);
      expect((await h.live.reconcile()).resolved).toBe(true);
      expect((await h.live.acknowledgeManualReconciliation(true)).pending).toBeNull();
      await expect(h.live.submit(order(),market(),book(),true)).rejects.toThrow('cleanup first');
      expect(h.requests.filter((request)=>request.path==='/v1/trade/orders')).toHaveLength(0);
    }
  });

  test('scoped bot execution remains available for explicitly requested cleanup or restart',async()=>{
    const h=harness();await h.authorize();
    h.durable.setItem('polytrade.live-bot.v1',JSON.stringify(botRecord('halted')));
    await h.live.withBotControl(async(control)=>{
      expect((await control.submit(order(),market(),book(),true)).status).toBe('accepted');
      expect((await control.reconcile()).resolved).toBe(true);
    });
    expect(h.requests.filter((request)=>request.path==='/v1/trade/orders')).toHaveLength(1);
    await expect(h.live.submit(order(),market(),book(),true)).rejects.toThrow('cleanup first');
  });

  test('only clean stopped/completed journals permit manual creation',async()=>{
    for(const status of ['stopped','completed']){
      const h=harness();await h.authorize();h.durable.setItem('polytrade.live-bot.v1',JSON.stringify(botRecord(status)));
      expect((await h.live.submit(order(),market(),book(),true)).status).toBe('accepted');
    }
  });

  test('malformed recovery data fails closed before account reads or signing',async()=>{
    const records=['not-json',JSON.stringify({version:2,state:botRecord('stopped').state}),JSON.stringify({version:1,state:{status:'completed'}}),JSON.stringify(botRecord('unknown')),
      JSON.stringify({...botRecord('stopped'),state:{...botRecord('stopped').state,orders:[{terminal:false}]}})];
    for(const record of records){
      const h=harness();await h.authorize();const before=h.requests.length;
      h.durable.setItem('polytrade.live-bot.v1',record);
      await expect(h.live.submit(order(),market(),book(),true)).rejects.toThrow('malformed');
      expect(h.requests).toHaveLength(before);
    }
  });

  test('a recovery journal changed during account reads is checked again before signed transport',async()=>{
    const h=harness();await h.authorize();
    h.state.onPortfolio=()=>h.durable.setItem('polytrade.live-bot.v1',JSON.stringify(botRecord('halted')));
    await expect(h.live.submit(order(),market(),book(),true)).rejects.toThrow('cleanup first');
    expect(h.requests.some((request)=>request.path==='/v1/account/portfolio')).toBe(true);
    expect(h.requests.some((request)=>request.path==='/v1/trade/orders')).toBe(false);
  });
});
