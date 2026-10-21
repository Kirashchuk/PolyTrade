import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode } from '@msgpack/msgpack';
import { hashTypedData, keccak256, recoverTypedDataAddress, type EIP1193Provider, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Book, BotConfig, Market, OrderInput } from '../src/shared/contracts';
import { estimateOrder, validateOrder } from '../src/trading/math';
import { setExchangeClockOffset } from '../src/shared/clock';
import { PaperEngine } from '../src/trading/paper';
import { BotManager } from '../src/trading/bots';
import { planPaperOrders } from '../src/trading/strategies';
import { compactOperation, createLiveSession, createProxyTypedData, livePositionQuantity, liveRiskOrders, operationHash, operationTypedData, signOperation, type TradingOperation } from '../src/trading/live';

const TIME=1_800_000_000_000;
const market=(patch:Partial<Market>={}):Market=>({id:1,symbol:'TEST-USD',displaySymbol:'TEST',baseAsset:'TEST',quoteAsset:'pUSD',category:'crypto',priceDecimals:2,quantityDecimals:3,priceBounds:'0.2',minNotional:'1',maxMarketNotional:'100000',maxLimitNotional:'100000',maxOrderCount:200,maxLeverage:10,riskTiers:[{lowerBound:'0',maxLeverage:10}],closeOnly:false,isolatedOnly:false,settled:false,fundingIntervalHours:1,markPrice:100,indexPrice:100,lastPrice:100,openInterest:null,openInterestUsd:null,volume24h:null,change24h:null,fundingRate:null,fundingApr:null,nextFunding:null,timestamp:TIME,sparkline:[],...patch});
const book=(patch:Partial<Book>={}):Book=>({instrumentId:1,bids:[{price:'99',quantity:'10'}],asks:[{price:'100',quantity:'1'},{price:'101',quantity:'1'}],timestamp:TIME,sequence:1,...patch});
let counter=0;
const order=(patch:Partial<OrderInput>={}):OrderInput=>({instrumentId:1,side:'buy',type:'market',quantity:'1',leverage:5,reduceOnly:false,postOnly:false,slippageBps:100,clientOrderId:(++counter).toString(16).padStart(32,'0'),...patch});
const closeables:{close():void}[]=[],temporary:string[]=[];
afterEach(()=>{for(const item of closeables.splice(0))item.close();for(const path of temporary.splice(0))rmSync(path,{recursive:true,force:true});});
const engine=(options:ConstructorParameters<typeof PaperEngine>[1]={})=>{const instance=new PaperEngine(':memory:',{now:()=>TIME,...options});closeables.push(instance);return instance;};

describe('exact order validation and depth',()=>{
  test('IOC limit uses directional decimal rounding and only displayed depth',()=>{
    const quote=estimateOrder(order({quantity:'3',slippageBps:100}),market(),book(), '0',TIME);
    expect(quote.limitPrice).toBe('101');expect(quote.filledQuantity).toBe('2');expect(quote.unfilledQuantity).toBe('1');expect(quote.averagePrice).toBe('100.5');expect(quote.notional).toBe('201');
    const sell=estimateOrder(order({side:'sell',quantity:'1',slippageBps:1}),market(),book(),'0',TIME);
    expect(sell.limitPrice).toBe('99');
  });
  test('rejects stale/crossed data, metadata gaps, precision, tier and price bounds',()=>{
    expect(()=>validateOrder(order(),market(),book({timestamp:TIME-15000}),'0',TIME)).toThrow('stale');
    expect(()=>validateOrder(order(),market({timestamp:TIME-15000}),book(),'0',TIME)).toThrow('stale');
    expect(()=>validateOrder(order(),market({timestamp:null}),book(),'0',TIME)).toThrow('unavailable');
    expect(()=>validateOrder(order(),market(),book({bids:[{price:'100',quantity:'1'}]}),'0',TIME)).toThrow('crossed');
    expect(()=>validateOrder(order({quantity:'0.0001'}),market(),book(),'0',TIME)).toThrow('decimal places');
    expect(()=>validateOrder(order({leverage:1.5}),market(),book(),'0',TIME)).toThrow('integer');
    expect(()=>validateOrder(order({leverage:5}),market({riskTiers:[{lowerBound:'0',maxLeverage:10},{lowerBound:'100',maxLeverage:2}]}),book(),'0',TIME)).toThrow('risk tier');
    expect(()=>validateOrder(order({type:'limit',price:'121'}),market(),book(),'0',TIME)).toThrow('price bounds');
    expect(()=>validateOrder(order(),market({riskTiers:[]}),book(),'0',TIME)).toThrow('risk metadata');
  });
  test('enforces reduce-only, settled and post-only rules',()=>{
    expect(()=>validateOrder(order({reduceOnly:true}),market(),book(),'0',TIME)).toThrow('Reduce-only');
    expect(()=>validateOrder(order({side:'sell',reduceOnly:true,quantity:'2'}),market(),book(),'1',TIME)).toThrow('Reduce-only');
    expect(()=>validateOrder(order(),market({closeOnly:true}),book(),'0',TIME)).toThrow('close-only');
    expect(()=>validateOrder(order({side:'sell',reduceOnly:true}),market({settled:true}),book(),'1',TIME)).toThrow('settled');
    expect(()=>validateOrder(order({type:'limit',price:'100',postOnly:true}),market(),book(),'0',TIME)).toThrow('cross');
    expect(validateOrder(order({side:'sell',reduceOnly:true}),market({closeOnly:true}),book(),'1',TIME).quantity).toBe('1');
  });
  test('contingent buys and sells use independent worst-sided exposure and order caps',()=>{
    const m=market({maxOrderCount:2,maxLeverage:50,riskTiers:[{lowerBound:'0',maxLeverage:50},{lowerBound:'100',maxLeverage:10}]}),b=book({asks:[{price:'101',quantity:'10'}]});
    const resting={side:'buy' as const,remainingQuantity:'0.9',reduceOnly:false,price:'100'};
    expect(()=>validateOrder(order({type:'limit',price:'100',quantity:'0.9',leverage:50}),m,b,'0',TIME,{openOrders:[resting]})).toThrow('risk tier');
    expect(validateOrder(order({type:'limit',side:'sell',price:'101',quantity:'0.9',leverage:50}),m,b,'0',TIME,{openOrders:[resting]}).maxLeverage).toBe(50);
    expect(()=>validateOrder(order({type:'limit',price:'100',quantity:'0.1',leverage:10}),m,b,'0',TIME,{openOrders:[resting,{...resting,side:'sell'}]})).toThrow('open-order count');
    expect(()=>validateOrder(order(),market(),book(),'NaN',TIME)).toThrow('finite exact');
    expect(()=>validateOrder(order(),market(),book(),'Infinity',TIME)).toThrow('finite exact');
  });
});

describe('exchange five-significant-figure order grid',()=>{
  const high=(patch:Partial<Market>={})=>market({priceDecimals:1,quantityDecimals:6,markPrice:65162.5,...patch});
  const highBook=book({bids:[{price:'65160',quantity:'2'}],asks:[{price:'65163',quantity:'2'}]});
  test('computed IOC bounds use integer or five-significant-figure prices',()=>{
    expect(validateOrder(order({quantity:'0.1',slippageBps:1}),high(),highBook,'0',TIME).limitPrice).toBe('65169');
    expect(validateOrder(order({side:'sell',quantity:'0.1',slippageBps:1}),high(),highBook,'0',TIME).limitPrice).toBe('65154');
    expect(validateOrder(order({quantity:'100',slippageBps:10}),market({priceDecimals:6,markPrice:0.12345}),book({bids:[{price:'0.1234',quantity:'1000'}],asks:[{price:'0.12345',quantity:'1000'}]}),'0',TIME).limitPrice).toBe('0.12357');
  });
  test('reviewed prices and quantities beyond five significant figures are refused before signing',()=>{
    expect(()=>validateOrder(order({type:'limit',price:'65162.5',quantity:'0.1'}),high(),highBook,'0',TIME)).toThrow('significant');
    expect(validateOrder(order({type:'limit',price:'65162',quantity:'0.1'}),high(),highBook,'0',TIME).limitPrice).toBe('65162');
    expect(()=>validateOrder(order({quantity:'0.123456'}),high(),highBook,'0',TIME)).toThrow('significant');
    expect(validateOrder(order({quantity:'0.12345'}),high(),highBook,'0',TIME).quantity).toBe('0.12345');
  });
  test('default freshness clock follows the measured exchange offset',()=>{
    const at=Date.now()+2_900,observed={market:market({timestamp:at}),book:book({timestamp:at})};
    try{
      expect(()=>validateOrder(order(),observed.market,observed.book)).toThrow('stale');
      setExchangeClockOffset(2_900);expect(validateOrder(order(),observed.market,observed.book).limitPrice).toBe('101');
      setExchangeClockOffset(60_000);expect(()=>validateOrder(order(),observed.market,observed.book)).toThrow('stale');
    }finally{setExchangeClockOffset(0);}
  });
  test('strategy quotes and slices are planned on the same grid',()=>{
    const config:BotConfig={instrumentId:1,strategy:'maker',side:'buy',totalQuantity:'2',slices:1,intervalSeconds:5,spreadBps:20,leverage:2};
    const [bid,ask]=planPaperOrders(config,high(),highBook,'2.4691356');
    expect([bid!.price,ask!.price,bid!.quantity]).toEqual(['65096','65227','1.2345']);
    expect(planPaperOrders({...config,strategy:'twap'},high(),highBook,'1.2345678')[0]!.quantity).toBe('1.2345');
  });
});

describe('persisted paper execution',()=>{
  test('partial IOC cancels remainder and never reuses displayed liquidity',()=>{
    const e=engine(),first=e.submit(order({quantity:'3'}),market(),book());
    expect(first.orders[0]!.status).toBe('partial');expect(first.orders[0]!.filledQuantity).toBe('2');expect(first.orders[0]!.reason).toContain('IOC remainder 1');
    expect(first.fees).toBeCloseTo(201*.0004,10);
    const second=e.submit(order(),market(),book());expect(second.orders[0]!.status).toBe('cancelled');expect(second.positions[0]!.quantity).toBe('2');
  });
  test('decimal spelling cannot bypass same-snapshot liquidity consumption',()=>{
    const e=engine(),raw=book({asks:[{price:'100.00',quantity:'1.000'}]});
    e.submit(order(),market(),raw);const next=e.submit(order(),market(),raw);
    expect(next.orders[0]!.status).toBe('cancelled');expect(next.positions[0]!.quantity).toBe('1');
  });
  test('restart restores balance, ledger and consumed book depth',()=>{
    const path=mkdtempSync(join(tmpdir(),'polytrade-test-'));temporary.push(path);const file=join(path,'paper.sqlite');
    const e=new PaperEngine(file,{now:()=>TIME});e.submit(order(),market(),book());e.close();
    const restored=new PaperEngine(file,{now:()=>TIME});closeables.push(restored);
    const before=restored.account([market()]);expect(before.positions[0]!.quantity).toBe('1');expect(before.journal.some(row=>row.action==='paper_fill')).toBe(true);
    const after=restored.submit(order({slippageBps:0}),market(),book());expect(after.orders[0]!.status).toBe('cancelled');expect(after.positions[0]!.quantity).toBe('1');
  });
  test('realized PnL, remaining entry, fees and duplicate client IDs are exact',()=>{
    const e=engine({makerFeeRate:'0',takerFeeRate:'0'}),buy=order();
    e.submit(buy,market(),book());expect(e.submit(buy,market(),book()).positions[0]!.quantity).toBe('1');
    const sell=e.submit(order({side:'sell',quantity:'0.5',reduceOnly:true}),market({markPrice:110}),book({bids:[{price:'110',quantity:'10'}],asks:[{price:'111',quantity:'10'}],sequence:2,timestamp:TIME+1}));
    expect(sell.realizedPnl).toBe(5);expect(sell.balance).toBe(10005);expect(sell.positions[0]!.quantity).toBe('0.5');expect(sell.positions[0]!.entryPrice).toBe('100');expect(sell.equity).toBe(10010);
    expect(()=>e.submit({...buy,quantity:'2'},market(),book())).toThrow('already used');
  });
  test('insufficient margin rolls back every fill and leaves an audit rejection',()=>{
    const e=engine({initialBalance:10});expect(()=>e.submit(order({quantity:'1',leverage:1}),market(),book())).toThrow('margin');
    const account=e.account();expect(account.positions).toHaveLength(0);expect(account.orders).toHaveLength(0);expect(account.balance).toBe(10);expect(account.journal[0]!.action).toBe('paper_rejected');
  });
  test('paper admission rejects the second same-side order before cumulative exposure crosses a leverage tier',()=>{
    const e=engine(),m=market({maxOrderCount:2,maxLeverage:50,riskTiers:[{lowerBound:'0',maxLeverage:50},{lowerBound:'100',maxLeverage:10}]}),b=book({asks:[{price:'101',quantity:'10'}]});
    e.submit(order({type:'limit',price:'100',quantity:'0.9',leverage:50,postOnly:true}),m,b);
    expect(()=>e.submit(order({type:'limit',price:'100',quantity:'0.9',leverage:50,postOnly:true}),m,b)).toThrow('risk tier');
    const both=e.submit(order({type:'limit',side:'sell',price:'101',quantity:'0.9',leverage:50,postOnly:true}),m,b);expect(both.orders).toHaveLength(2);
    expect(()=>e.submit(order({type:'limit',price:'99',quantity:'0.02',leverage:10,postOnly:true}),m,b)).toThrow('open-order count');
  });
  test('touch is not a passive fill; later trade-through fills at the owned limit',()=>{
    let now=TIME;const e=engine({now:()=>now,makerFeeRate:'0',takerFeeRate:'0'});
    e.submit(order({type:'limit',price:'99',postOnly:true}),market(),book());now+=100;
    e.tick([market({timestamp:now})],new Map([[1,book({timestamp:now,sequence:2,asks:[{price:'99',quantity:'1'}],bids:[{price:'98',quantity:'10'}]})]]));expect(e.account().positions).toHaveLength(0);
    now+=100;e.tick([market({timestamp:now})],new Map([[1,book({timestamp:now,sequence:3,asks:[{price:'98',quantity:'1'}],bids:[{price:'97',quantity:'10'}]})]]));
    const account=e.account();expect(account.positions[0]!.entryPrice).toBe('99');expect(account.orders[0]!.averagePrice).toBe('99');expect(account.orders[0]!.status).toBe('filled');
  });
  test('risk cancellation rollback does not detach following resting-order references',()=>{
    let now=TIME;const e=engine({now:()=>now});
    e.submit(order({type:'limit',price:'99',postOnly:true}),market(),book());e.submit(order({type:'limit',price:'98',postOnly:true}),market(),book());now+=100;
    // First order is now outside the newly narrowed mark bounds, while second remains valid.
    e.tick([market({markPrice:98,priceBounds:'0.005',timestamp:now})],new Map([[1,book({timestamp:now,sequence:2,bids:[{price:'96',quantity:'10'}],asks:[{price:'97',quantity:'2'}]})]]));
    const account=e.account();expect(account.orders.find(o=>o.input.price==='99')!.status).toBe('cancelled');expect(account.orders.find(o=>o.input.price==='98')!.status).toBe('filled');expect(account.positions[0]!.quantity).toBe('1');
  });
  test('cancel/reset persist state without deleting the historical audit',()=>{
    const e=engine();const account=e.submit(order({type:'limit',price:'98',postOnly:true}),market(),book());e.cancel(account.orders[0]!.id);
    expect(e.activeInstrumentIds()).toEqual([]);expect(e.reset().balance).toBe(10000);expect(e.account().journal.some(row=>row.action==='paper_cancel')).toBe(true);
  });
});

describe('bounded paper strategies',()=>{
  const config:BotConfig={instrumentId:1,strategy:'maker',side:'buy',totalQuantity:'2',slices:1,intervalSeconds:1,spreadBps:10,leverage:5};
  test('pure planning is deterministic, conserves the slice budget and rounds maker quotes outward',()=>{
    const m=market(),b=book({bids:[{price:'99.99',quantity:'10'}],asks:[{price:'100.01',quantity:'10'}]}),cfg={...config,spreadBps:75};
    const before=JSON.stringify({m,b,cfg}),intents=planPaperOrders(cfg,m,b,'1.001');
    expect(planPaperOrders(cfg,m,b,'1.001')).toEqual(intents);expect(JSON.stringify({m,b,cfg})).toBe(before);
    expect(intents.map(intent=>intent.quantity)).toEqual(['0.5','0.5']);expect(intents.reduce((sum,intent)=>sum+Number(intent.quantity),0)).toBeLessThanOrEqual(1.001);
    expect(intents.map(intent=>intent.price)).toEqual(['99.62','100.38']);expect(intents.every(intent=>intent.postOnly&&intent.type==='limit'&&!('clientOrderId' in intent))).toBe(true);
    const twap=planPaperOrders({...cfg,strategy:'twap',side:'sell'},m,b,'0.3339');expect(twap).toHaveLength(1);expect(twap[0]!.quantity).toBe('0.333');expect(twap[0]!.side).toBe('sell');expect(twap[0]!.type).toBe('market');expect(twap[0]!.postOnly).toBe(false);
  });
  test('maker owns two bounded orders; stop cancels only its orders',()=>{
    const e=engine(),bots=new BotManager(e,':memory:',{now:()=>TIME});closeables.push(bots);
    e.submit(order({type:'limit',price:'95',postOnly:true}),market(),book());const state=bots.start(config,[market()],new Map([[1,book()]]));bots.tick([market()],new Map([[1,book()]]));
    expect(e.account().orders.filter(o=>o.status==='open')).toHaveLength(3);bots.stop(state.id);
    expect(e.account().orders.filter(o=>o.status==='open')).toHaveLength(1);expect(bots.list()[0]!.status).toBe('stopped');
  });
  test('TWAP tick is idempotent and stale books halt without orders',()=>{
    let now=TIME;const e=engine({now:()=>now}),bots=new BotManager(e,':memory:',{now:()=>now});closeables.push(bots);
    bots.start({...config,strategy:'twap',slices:2},[market()],new Map([[1,book()]]));bots.tick([market()],new Map([[1,book()]]));bots.tick([market()],new Map([[1,book()]]));expect(e.account().orders).toHaveLength(1);
    now+=16000;bots.tick([market()],new Map([[1,book()]]));expect(bots.list()[0]!.status).toBe('halted');expect(e.account().orders).toHaveLength(1);
  });
});

const OWNER_KEY=('0x'+'11'.repeat(32)) as Hex;
const owner=privateKeyToAccount(OWNER_KEY);
const proxy=privateKeyToAccount(('0x'+'22'.repeat(32)) as Hex);
const memoryStorage=()=>{const map=new Map<string,string>();return {getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value);},map};};
const testLock=async<T>(operation:()=>Promise<T>)=>operation();
const provider={request:async({method,params}:{method:string;params?:unknown})=>{
  if(method==='eth_requestAccounts'||method==='eth_accounts')return [owner.address];
  if(method==='eth_chainId')return '0x89';
  if(method==='eth_signTypedData_v4'){
    const typed=JSON.parse((params as [string,string])[1]);delete typed.types.EIP712Domain;return owner.signTypedData(typed);
  }
  throw new Error(`Unexpected wallet call ${method}`);
}} as unknown as EIP1193Provider;

describe('official browser signing and uncertain writes',()=>{
  test('live risk snapshots include admitted unfilled exposure and reject malformed position values',()=>{
    const open=liveRiskOrders([{instrument_id:1,buy:true,ro:false,quantity:'0.9',filled_quantity:'0.1',resting_quantity:'0',price:'100'}],1);
    expect(open[0]!.remainingQuantity).toBe('0.8');
    expect(()=>livePositionQuantity([{instrument_id:1}],1)).toThrow('finite exact');
    expect(()=>livePositionQuantity([{instrument_id:1,size:'NaN'}],1)).toThrow('finite exact');
    expect(livePositionQuantity([{instrument_id:1,size:'-0.5'}],1)).toBe('-0.5');
    expect(()=>liveRiskOrders([{instrument_id:1,buy:true,ro:false,quantity:'NaN',filled_quantity:'0',resting_quantity:'0',price:'100'}],1)).toThrow('invalid');
  });
  test('CreateProxy and compact operation preserve exact string/boolean positions',async()=>{
    const typed=createProxyTypedData(proxy.address,TIME+60000,123,TIME),signature=await owner.signTypedData(typed);
    expect(await recoverTypedDataAddress({...typed,signature})).toBe(owner.address);expect(hashTypedData(typed)).toMatch(/^0x[0-9a-f]{64}$/);
    const op:TradingOperation={type:'createOrders',args:[{iid:1,buy:false,p:'100.00',qty:'0.001',tif:'gtc',po:false,ro:false,c:'ab'.repeat(16)}]};
    expect(compactOperation(op)).toEqual(['createOrders',[[1,false,'100.00','0.001','gtc',false,false,'ab'.repeat(16)]]]);
    expect(operationHash(op)).toBe(keccak256(encode(['createOrders',[[1,false,'100.00','0.001','gtc',false,false,'ab'.repeat(16)]]])));
    const signed=await signOperation(op,proxy,123,TIME);expect(await recoverTypedDataAddress({...operationTypedData(op,123,TIME),signature:signed.sig})).toBe(proxy.address);
  });
  test('timeout submits once, blocks fresh writes and clears only matching reconciliation',async()=>{
    let writes=0,resolve=false;const requests:{path:string;method:string;headers:Headers;body:unknown}[]=[];
    const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const path=new URL(String(input),'http://localhost').searchParams.get('path')!,method=init?.method??'GET';requests.push({path,method,headers:new Headers(init?.headers),body:init?.body?JSON.parse(String(init.body)):null});
      if(path.startsWith('/v1/info/registered'))return Response.json({registered:true});
      if(path==='/v1/account/proxy')return Response.json({secret:'mock-private-secret'});
      if(path==='/v1/account/portfolio')return Response.json({positions:[],margin:{available_order_margin:'10000'},in_liquidation:false,timestamp:TIME});
      if(path==='/v1/account/open-orders')return Response.json([]);
      if(path==='/v1/account/config')return Response.json([{instrument_id:1,leverage:5,cross:false}]);
      if(path.startsWith('/v1/account/orders?'))return Response.json(resolve?[{order_id:7,client_order_id:'aa'.repeat(16),status:'filled',updated_timestamp:TIME+1}]:[]);
      if(path==='/v1/trade/orders'){writes++;throw new Error('Simulated lost response');}
      throw new Error(`Unexpected request ${path}`);
    }) as typeof fetch;
    const storage=memoryStorage(),live=createLiveSession({provider,token:'test-control-token',fetcher,now:()=>TIME,storage,withLock:testLock});await live.connect();await live.authorize(60);
    const input=order({clientOrderId:'aa'.repeat(16)}),outcome=await live.submit(input,market(),book(),true);expect(outcome.status).toBe('unknown');expect(writes).toBe(1);
    await expect(live.submit(order(),market(),book(),true)).rejects.toThrow('reconciliation');expect(writes).toBe(1);expect((await live.reconcile()).resolved).toBe(false);
    resolve=true;expect((await live.reconcile()).resolved).toBe(true);expect(live.status().pending).toBeNull();
    expect(requests.every(r=>r.headers.get('x-polytrade-token')==='test-control-token')).toBe(true);
    const body=requests.find(r=>r.path==='/v1/account/proxy')!.body as {op:{args:{owner:string;proxy:string;expiry:number}}};expect(body.op.args.owner).toBe(owner.address);expect(body.op.args.expiry).toBe(TIME+3600000);
    expect(JSON.stringify(live.status())).not.toContain('mock-private-secret');
    expect(JSON.stringify([...storage.map.values()])).not.toContain('mock-private-secret');
  });
  test('explicit confirmation is required before any financial request',async()=>{
    let calls=0;const live=createLiveSession({provider,token:'test',fetcher:(async()=>{calls++;return Response.json({});}) as unknown as typeof fetch,now:()=>TIME,storage:memoryStorage(),withLock:testLock});
    await expect(live.submit(order(),market(),book(),false)).rejects.toThrow('confirmation');await expect(live.cancel(1,false)).rejects.toThrow('Confirm');expect(calls).toBe(0);
  });
  test('restored nonsecret intent blocks new writes and can recover read credentials',async()=>{
    const storage=memoryStorage();storage.setItem('polytrade.live-intents.v1',JSON.stringify({version:1,authorizationUnknown:false,pending:{owner:owner.address,clientOrderId:'ab'.repeat(16),orderId:null,action:'createOrders',submittedAt:TIME},audit:[]}));
    let writes=0;
    const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const path=new URL(String(input),'http://localhost').searchParams.get('path')!;
      if(path.startsWith('/v1/info/registered'))return Response.json({registered:true});
      if(path==='/v1/account/proxy')return Response.json({secret:'recover-secret'});
      if(init?.method==='POST')writes++;
      return Response.json([]);
    }) as typeof fetch;
    const live=createLiveSession({provider,token:'test',fetcher,now:()=>TIME,storage,withLock:testLock});await live.connect();
    expect(live.status().pending?.clientOrderId).toBe('ab'.repeat(16));await expect(live.submit(order(),market(),book(),true)).rejects.toThrow('reconciliation');expect(writes).toBe(0);
    await live.authorize();expect(live.status().authorized).toBe(true);expect(live.status().pending).not.toBeNull();expect(live.journal().some(row=>row.event==='proxy_registered')).toBe(true);
    expect((await live.acknowledgeManualReconciliation(true)).pending).toBeNull();expect(JSON.stringify([...storage.map.values()])).not.toContain('recover-secret');
  });
  test('journal write failure refuses authorization before upstream financial transport',async()=>{
    let writes=0;const storage={getItem:()=>null,setItem:()=>{throw new Error('Storage quota');}};
    const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{if(init?.method==='POST')writes++;return Response.json({registered:true});}) as typeof fetch;
    const live=createLiveSession({provider,token:'test',fetcher,storage,now:()=>TIME,withLock:testLock});await live.connect();await expect(live.authorize()).rejects.toThrow('could not be saved');expect(writes).toBe(0);
  });
  test('an already-open second session cannot overwrite another session unresolved intent',async()=>{
    const storage=memoryStorage();let writes=0;
    const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const path=new URL(String(input),'http://localhost').searchParams.get('path')!;
      if(path.startsWith('/v1/info/registered'))return Response.json({registered:true});
      if(path==='/v1/account/proxy')return Response.json({secret:'mock-secret'});
      if(path==='/v1/account/portfolio')return Response.json({positions:[],margin:{available_order_margin:'10000'},in_liquidation:false,timestamp:TIME});
      if(path==='/v1/account/config')return Response.json([{instrument_id:1,leverage:5,cross:false}]);
      if(path==='/v1/account/open-orders')return Response.json([]);
      if(path==='/v1/trade/orders'){writes++;throw new Error('Lost response');}
      throw new Error(`Unexpected request ${path}`);
    }) as typeof fetch;
    const a=createLiveSession({provider,token:'test',fetcher,storage,now:()=>TIME,withLock:testLock}),b=createLiveSession({provider,token:'test',fetcher,storage,now:()=>TIME,withLock:testLock});
    await a.connect();await a.authorize();await b.connect();await b.authorize();
    const first=order({clientOrderId:'ac'.repeat(16)});expect((await a.submit(first,market(),book(),true)).status).toBe('unknown');
    await expect(b.submit(order(),market(),book(),true)).rejects.toThrow('reconciliation');expect(writes).toBe(1);
    expect(JSON.parse(storage.getItem('polytrade.live-intents.v1')!).pending.clientOrderId).toBe(first.clientOrderId);
    expect(JSON.parse(storage.getItem('polytrade.live-intents.v1')!).audit.filter((r:{event:string})=>r.event==='proxy_registered')).toHaveLength(2);
  });
  test('live admission uses contingent orders and rejects malformed account economics before a signed send',async()=>{
    const resting={instrument_id:1,buy:true,ro:false,quantity:'0.9',filled_quantity:'0',resting_quantity:'0.9',price:'100'};
    const scenarios=[
      {orders:[resting],positions:[],available:'10000',maxOrders:200,expected:'risk tier'},
      {orders:[resting,{...resting,buy:false,price:'101'}],positions:[],available:'10000',maxOrders:2,expected:'open-order count'},
      {orders:[],positions:[],available:'NaN',maxOrders:200,expected:'Available order margin'},
      {orders:[],positions:[{instrument_id:1,size:'NaN'}],available:'10000',maxOrders:200,expected:'Live position quantity'},
    ];
    for(const scenario of scenarios){
      let writes=0;
      const fetcher=(async(input:RequestInfo|URL)=>{
        const path=new URL(String(input),'http://localhost').searchParams.get('path')!;
        if(path.startsWith('/v1/info/registered'))return Response.json({registered:true});
        if(path==='/v1/account/proxy')return Response.json({secret:'test-secret'});
        if(path==='/v1/account/portfolio')return Response.json({positions:scenario.positions,margin:{available_order_margin:scenario.available},in_liquidation:false,timestamp:TIME});
        if(path==='/v1/account/config')return Response.json([{instrument_id:1,leverage:50,cross:false}]);
        if(path==='/v1/account/open-orders')return Response.json(scenario.orders);
        if(path==='/v1/trade/orders'){writes++;return Response.json([{status:'ok',oid:1}]);}
        throw new Error(`Unexpected request ${path}`);
      }) as typeof fetch;
      const live=createLiveSession({provider,token:'test',fetcher,storage:memoryStorage(),now:()=>TIME,withLock:testLock});await live.connect();await live.authorize();
      const m=market({maxOrderCount:scenario.maxOrders,maxLeverage:50,riskTiers:[{lowerBound:'0',maxLeverage:50},{lowerBound:'100',maxLeverage:10}]}),b=book({asks:[{price:'101',quantity:'10'}]});
      await expect(live.submit(order({type:'limit',price:'100',quantity:'0.9',postOnly:true,leverage:50}),m,b,true)).rejects.toThrow(scenario.expected);expect(writes).toBe(0);
    }
  });
  test('cross-session lock rejects concurrent authorization while another wallet action is pending',async()=>{
    let locked=false,release:()=>void=()=>{};
    const paused=new Promise<void>(resolve=>{release=resolve;});
    const lock=async<T>(operation:()=>Promise<T>)=>{if(locked)throw new Error('Another tab owns the live lock');locked=true;try{return await operation();}finally{locked=false;}};
    const fetcher=(async(input:RequestInfo|URL)=>{
      const path=new URL(String(input),'http://localhost').searchParams.get('path')!;
      if(path.startsWith('/v1/info/registered')){await paused;return Response.json({registered:true});}
      return Response.json({secret:'mock-secret'});
    }) as typeof fetch;
    const storage=memoryStorage(),a=createLiveSession({provider,token:'test',fetcher,storage,now:()=>TIME,withLock:lock}),b=createLiveSession({provider,token:'test',fetcher,storage,now:()=>TIME,withLock:lock});
    await a.connect();await b.connect();const authorizing=a.authorize();
    await expect(b.authorize()).rejects.toThrow('Another tab');release();await authorizing;
    expect(a.status().authorized).toBe(true);expect(b.status().authorized).toBe(false);
  });
});
