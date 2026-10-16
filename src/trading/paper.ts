import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditRow, Book, Market, OrderInput, PaperAccount, PaperOrder, PaperPosition } from '../shared/contracts';
import { D, quoteDepth, validateBook, validateOrder, type DepthFill } from './math';

interface PositionRecord { instrumentId: number; symbol: string; quantity: string; entryPrice: string; leverage: number; }
interface PaperState { initialBalance: string; balance: string; realizedPnl: string; fees: string; positions: PositionRecord[]; orders: PaperOrder[]; depth: {instrumentId:number; key:string; used:Record<string,string>}[]; }
export interface PaperOptions { now?: () => number; initialBalance?: number; makerFeeRate?: string; takerFeeRate?: string; }
export const isResting = (order: PaperOrder) => order.input.type === 'limit' && (order.status === 'open' || order.status === 'partial');
export const orderRemaining = (order: PaperOrder) => new D(order.input.quantity).minus(order.filledQuantity).toFixed();

/** Local simulation only. This module has no exchange transport or signing dependency. */
export class PaperEngine {
  private db: Database;
  private state: PaperState;
  private markets = new Map<number, Market>();
  private now: () => number;
  private makerFee: string;
  private takerFee: string;
  constructor(dbPath = 'data/paper.sqlite', options: PaperOptions = {}) {
    this.now = options.now ?? Date.now;
    this.makerFee = options.makerFeeRate ?? '0.000125'; this.takerFee = options.takerFeeRate ?? '0.0004';
    this.validateFees(this.makerFee, this.takerFee);
    const initial = options.initialBalance ?? 10_000;
    if (!Number.isFinite(initial) || initial <= 0) throw new Error('Paper initial balance must be positive');
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS paper_state(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS paper_audit(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,action TEXT NOT NULL,instrument_id INTEGER,detail TEXT NOT NULL);');
    const saved = this.db.query<{body:string}, []>('SELECT body FROM paper_state WHERE id=1').get();
    this.state = saved ? JSON.parse(saved.body) as PaperState : { initialBalance:String(initial), balance:String(initial), realizedPnl:'0', fees:'0', positions:[], orders:[], depth:[] };
    if (!saved) this.atomic(() => this.audit('initialize', null, `Paper balance ${initial} pUSD. Estimated fees: maker ${this.makerFee}, taker ${this.takerFee}. Funding and liquidation are not simulated.`));
  }
  private validateFees(maker: string, taker: string) {
    for (const rate of [maker,taker]) if (!/^-?\d+(\.\d+)?$/.test(rate) || !new D(rate).isFinite() || new D(rate).abs().gt('0.1')) throw new Error('Invalid simulation fee rate');
  }
  setFeeRates(maker: string, taker: string) { this.validateFees(maker,taker); this.makerFee=maker;this.takerFee=taker; }
  private save() { this.db.query('INSERT INTO paper_state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(this.state)); }
  private atomic<T>(operation: () => T): T {
    const before = structuredClone(this.state);
    try { return this.db.transaction(() => { const result=operation();this.save();return result; })(); }
    catch (error) { this.state=before;throw error; }
  }
  private audit(action: string, instrumentId: number | null, detail: string) {
    this.db.query('INSERT INTO paper_audit VALUES(?,?,?,?,?)').run(crypto.randomUUID(),this.now(),action,instrumentId,detail);
  }
  private observe(markets: Market[]) { for (const market of markets) this.markets.set(market.id,market); }
  private position(instrumentId: number) { return this.state.positions.find(p => p.instrumentId===instrumentId); }
  private riskOrders(instrumentId:number,excludeId?:string){return this.state.orders.filter(order=>isResting(order)&&order.input.instrumentId===instrumentId&&order.id!==excludeId).map(order=>({side:order.input.side,remainingQuantity:orderRemaining(order),reduceOnly:order.input.reduceOnly,price:order.input.price!}));}
  private depth(book: Book): Map<string,string> {
    // A snapshot can only be swept once in this simulation, including across process restarts.
    const key=`${book.timestamp}:${book.sequence}`;
    let row=this.state.depth.find(d=>d.instrumentId===book.instrumentId);
    if(!row){row={instrumentId:book.instrumentId,key,used:{}};this.state.depth.push(row);}
    const previousTime=Number(row.key.split(':')[0]);
    if(book.timestamp<previousTime)throw new Error('Order book is stale relative to the last consumed snapshot');
    if(row.key!==key){row.key=key;row.used={};}
    return new Map(Object.entries(row.used));
  }
  private consume(book: Book, side: 'buy'|'sell', fills: DepthFill[]) {
    const used=this.depth(book),row=this.state.depth.find(d=>d.instrumentId===book.instrumentId)!;
    for(const fill of fills){const key=`${side}:${fill.price}`;used.set(key,new D(used.get(key)??'0').plus(fill.quantity).toFixed());}
    row.used=Object.fromEntries(used);
  }
  account(markets: Market[] = []): PaperAccount {
    this.observe(markets);
    let unrealized = new D(0),margin=new D(0);
    const positions: PaperPosition[]=this.state.positions.map(position=>{
      const market=this.markets.get(position.instrumentId),mark=market?.markPrice??null;
      const pnl=mark!==null&&Number.isFinite(mark)?new D(mark).minus(position.entryPrice).mul(position.quantity):null;
      if(pnl)unrealized=unrealized.plus(pnl);
      margin=margin.plus(new D(position.quantity).abs().mul(mark??position.entryPrice).div(position.leverage));
      return {...position,markPrice:mark,unrealizedPnl:pnl?.toNumber()??null};
    });
    for(const order of this.state.orders.filter(isResting))if(!order.input.reduceOnly) margin=margin.plus(new D(orderRemaining(order)).mul(order.input.price!).div(order.input.leverage));
    const equity=new D(this.state.balance).plus(unrealized);
    const journal=this.db.query<{id:string;timestamp:number;action:string;instrumentId:number|null;detail:string}, []>('SELECT id,timestamp,action,instrument_id AS instrumentId,detail FROM paper_audit ORDER BY rowid DESC LIMIT 100').all() as AuditRow[];
    return {mode:'paper',initialBalance:Number(this.state.initialBalance),balance:Number(this.state.balance),equity:equity.toNumber(),realizedPnl:Number(this.state.realizedPnl),fees:Number(this.state.fees),marginUsed:margin.toNumber(),availableMargin:equity.minus(margin).toNumber(),positions,orders:structuredClone(this.state.orders).reverse(),journal};
  }
  private fill(order: PaperOrder, market: Market, fills: DepthFill[], maker: boolean) {
    const previousFilled=new D(order.filledQuantity),previousNotional=previousFilled.mul(order.averagePrice??0);
    let newNotional=new D(0),newFilled=new D(0);
    for(const fill of fills){
      const q=new D(fill.quantity),price=new D(fill.price),signed=order.input.side==='buy'?q:q.neg();
      let position=this.position(market.id),old= new D(position?.quantity??0),entry=new D(position?.entryPrice??0),realized=new D(0);
      if(order.input.reduceOnly&&(old.isZero()||old.mul(signed).gte(0)||q.gt(old.abs())))throw new Error('Reduce-only position changed before the simulated fill');
      if(old.mul(signed).lt(0)) realized=price.minus(entry).mul(D.min(old.abs(),q)).mul(old.isPositive()?1:-1);
      const next=old.plus(signed);
      const nextEntry=old.isZero()||old.mul(next).lt(0)?price:old.mul(signed).gt(0)?old.abs().mul(entry).plus(q.mul(price)).div(old.abs().plus(q)):entry;
      if(next.isZero())this.state.positions=this.state.positions.filter(p=>p.instrumentId!==market.id);
      else if(position){position.quantity=next.toFixed();position.entryPrice=nextEntry.toFixed();position.leverage=order.input.leverage;}
      else this.state.positions.push({instrumentId:market.id,symbol:market.symbol,quantity:next.toFixed(),entryPrice:nextEntry.toFixed(),leverage:order.input.leverage});
      const fee=q.mul(price).mul(maker?this.makerFee:this.takerFee);
      this.state.balance=new D(this.state.balance).plus(realized).minus(fee).toFixed();
      this.state.realizedPnl=new D(this.state.realizedPnl).plus(realized).toFixed();this.state.fees=new D(this.state.fees).plus(fee).toFixed();
      newFilled=newFilled.plus(q);newNotional=newNotional.plus(q.mul(price));
      this.audit('paper_fill',market.id,`${order.input.side} ${q.toFixed()} @ ${price.toFixed()}; ${maker?'maker':'taker'} fee estimate ${fee.toFixed()}; realized gross PnL ${realized.toFixed()}; order ${order.id}`);
    }
    const total=previousFilled.plus(newFilled);order.filledQuantity=total.toFixed();order.averagePrice=total.gt(0)?previousNotional.plus(newNotional).div(total).toFixed():null;
    order.status=total.eq(order.input.quantity)?'filled':total.gt(0)?'partial':'open';
  }
  private ensureMargin(reduceOnly=false) {
    const account=this.account();
    if(!reduceOnly&&account.availableMargin < -1e-8)throw new Error('Insufficient paper margin, including resting-order reserves and estimated fees');
  }
  submit(input: OrderInput, market: Market, book: Book): PaperAccount {
    this.observe([market]);
    const duplicate=this.state.orders.find(order=>order.input.clientOrderId===input.clientOrderId);
    if(duplicate){if(JSON.stringify(duplicate.input)!==JSON.stringify(input))throw new Error('Client order ID is already used for another order');return this.account();}
    try {
      this.atomic(()=>{
        const validated=validateOrder(input,market,book,this.position(market.id)?.quantity??'0',this.now(),{openOrders:this.riskOrders(market.id)});
        const order:PaperOrder={id:crypto.randomUUID(),input:structuredClone(input),status:'open',filledQuantity:'0',averagePrice:null,createdAt:this.now(),reason:null};
        this.state.orders.push(order);
        this.audit('paper_order',market.id,`${input.type} ${input.side} ${input.quantity}, limit ${validated.limitPrice}, leverage ${input.leverage}; client ${input.clientOrderId}`);
        const quote=quoteDepth(input,book,validated.limitPrice,this.depth(book));
        if(input.postOnly&&quote.fills.length)throw new Error('Post-only order would take liquidity');
        if(!input.postOnly&&quote.fills.length){this.fill(order,market,quote.fills,false);this.consume(book,input.side,quote.fills);}
        if(input.type==='market'&&order.status!=='filled'){
          order.status=new D(order.filledQuantity).gt(0)?'partial':'cancelled';order.reason=`IOC remainder ${quote.unfilledQuantity} cancelled; only displayed depth is simulated`;
          this.audit('paper_ioc_remainder',market.id,order.reason);
        }
        this.ensureMargin(input.reduceOnly);
      });
    } catch(error) {
      this.atomic(()=>this.audit('paper_rejected',market.id,error instanceof Error?error.message:'Order rejected'));throw error;
    }
    return this.account();
  }
  cancel(id: string): PaperAccount {
    this.atomic(()=>{
      const order=this.state.orders.find(o=>o.id===id);
      if(!order)throw new Error('Paper order not found');
      if(isResting(order)){order.status='cancelled';order.reason='Cancelled by operator';this.audit('paper_cancel',order.input.instrumentId,`Order ${id}, remaining ${orderRemaining(order)}`);}
    });return this.account();
  }
  cancelOwned(prefix: string) { for(const order of [...this.state.orders])if(isResting(order)&&order.input.clientOrderId.startsWith(prefix))this.cancel(order.id); }
  activeInstrumentIds(): number[] { return [...new Set(this.state.orders.filter(isResting).map(o=>o.input.instrumentId))]; }
  tick(markets: Market[], books: Map<number, Book>): void {
    this.observe(markets);
    for(const orderId of this.state.orders.filter(isResting).map(order=>order.id)){
      const order=this.state.orders.find(candidate=>candidate.id===orderId)!;
      const market=this.markets.get(order.input.instrumentId),book=books.get(order.input.instrumentId);
      if(!market||!book)continue;
      try {
        validateBook(book,market.id,this.now());
        if(book.timestamp<=order.createdAt)continue;
        this.atomic(()=>{
          const remaining=orderRemaining(order),position=this.position(market.id);
          // A resting post-only order may fill later; post-only only gates its original placement.
          validateOrder({...order.input,quantity:remaining,postOnly:false},market,book,position?.quantity??'0',this.now(),{openOrders:this.riskOrders(market.id,order.id)});
          const quote=quoteDepth({...order.input,quantity:remaining},book,order.input.price!,this.depth(book),true);
          if(!quote.fills.length)return;
          this.fill(order,market,quote.fills.map(fill=>({...fill,price:order.input.price!})),true);this.consume(book,order.input.side,quote.fills);this.ensureMargin(order.input.reduceOnly);
        });
      } catch(error) {
        // Stale data never creates a fill. Invalid current metadata/risk cancels the simulated resting order.
        if(error instanceof Error&&/stale|empty|unsorted|crossed/.test(error.message))continue;
        this.atomic(()=>{const current=this.state.orders.find(o=>o.id===order.id)!;current.status='cancelled';current.reason=error instanceof Error?error.message:'Risk check failed';this.audit('paper_risk_cancel',current.input.instrumentId,current.reason);});
      }
    }
  }
  reset(): PaperAccount {
    this.atomic(()=>{this.state={initialBalance:this.state.initialBalance,balance:this.state.initialBalance,realizedPnl:'0',fees:'0',positions:[],orders:[],depth:[]};this.audit('paper_reset',null,'Paper account reset; historical audit remains available');});return this.account();
  }
  close() { this.db.close(); }
}
