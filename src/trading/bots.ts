import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Book, BotConfig, BotState, Market } from '../shared/contracts';
import { D, decimal, roundGrid, validateBook, validateMetadata } from './math';
import { PaperEngine } from './paper';
import { planPaperOrders } from './strategies';

/** Bounded paper strategies. One caller owns the serial scheduler; no internal timers or upstream writes. */
export class BotManager {
  private db: Database;
  private states: BotState[];
  private now: () => number;
  private ticking=false;
  constructor(private engine: PaperEngine, databasePath='data/bots.sqlite', options:{now?:()=>number}={}) {
    this.now=options.now??Date.now;
    if(databasePath!==':memory:')mkdirSync(dirname(databasePath),{recursive:true});
    this.db=new Database(databasePath,{create:true});
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS paper_bots(id TEXT PRIMARY KEY,body TEXT NOT NULL);');
    this.states=this.db.query<{body:string},[]>('SELECT body FROM paper_bots ORDER BY rowid').all().map(row=>JSON.parse(row.body) as BotState);
    for(const state of this.states)if(state.status==='running'){
      state.status='halted';state.note='Recovered after restart. Paper quotes cancelled; explicitly start a new session to resume.';
      this.engine.cancelOwned(state.id);this.save(state);
    }
  }
  private save(state:BotState){this.db.query('INSERT INTO paper_bots VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(state.id,JSON.stringify(state));}
  list():BotState[]{return structuredClone(this.states).reverse();}
  start(config:BotConfig,markets:Market[],books:Map<number,Book>):BotState{
    const market=markets.find(m=>m.id===config.instrumentId),book=books.get(config.instrumentId);
    if(!market||!book)throw new Error('Fresh instrument metadata and book are required to start a paper bot');
    validateMetadata(market);validateBook(book,market.id,this.now());
    if(market.settled||market.closeOnly)throw new Error('Paper bots require an active instrument that permits opening exposure');
    if(!['twap','maker'].includes(config.strategy)||!['buy','sell'].includes(config.side))throw new Error('Invalid paper strategy');
    const total=decimal(config.totalQuantity,'Total strategy quantity');
    if(!Number.isInteger(config.slices)||config.slices<1||config.slices>1000||!Number.isFinite(config.intervalSeconds)||config.intervalSeconds<1||config.intervalSeconds>86400)throw new Error('Use 1 to 1000 slices and an interval of 1 to 86400 seconds');
    if(!Number.isFinite(config.spreadBps)||config.spreadBps<0||config.spreadBps>500||!Number.isSafeInteger(config.leverage)||config.leverage<1||config.leverage>market.maxLeverage)throw new Error('Invalid strategy spread or leverage');
    if((config.totalQuantity.split('.')[1]?.length??0)>market.quantityDecimals)throw new Error('Strategy quantity exceeds instrument precision');
    const minimumSlice=total.div(config.slices).div(config.strategy==='maker'?2:1);
    if(new D(roundGrid(minimumSlice,market.quantityDecimals)).lte(0)||minimumSlice.mul(book.asks[0]!.price).lt(market.minNotional))throw new Error('Strategy slices are below the instrument minimum quantity/notional');
    const cap=config.strategy==='twap'?market.maxMarketNotional:market.maxLimitNotional;
    if(total.mul(book.asks[0]!.price).gt(cap))throw new Error('Strategy total exceeds instrument notional cap');
    if(this.states.some(s=>s.status==='running'&&s.config.instrumentId===config.instrumentId))throw new Error('A paper bot already owns this instrument');
    const state:BotState={id:crypto.randomUUID().replaceAll('-','').slice(0,16),config:structuredClone(config),status:'running',createdAt:this.now(),nextRunAt:this.now(),ticks:0,note:'Paper only. Waiting for first scheduled slice.'};
    this.states.push(state);this.save(state);return structuredClone(state);
  }
  stop(id:string):BotState{
    const state=this.states.find(s=>s.id===id);if(!state)throw new Error('Paper bot not found');
    this.engine.cancelOwned(state.id);state.status='stopped';state.note='Stopped. Owned paper quotes cancelled; existing paper positions remain.';this.save(state);return structuredClone(state);
  }
  kill():BotState[]{for(const state of this.states)if(state.status==='running'||state.status==='halted')this.stop(state.id);return this.list();}
  haltAll(reason:string):BotState[]{
    for(const state of this.states)if(state.status==='running'){
      this.engine.cancelOwned(state.id);state.status='halted';state.note=reason;this.save(state);
    }
    return this.list();
  }
  tick(markets:Market[],books:Map<number,Book>):void{
    if(this.ticking)return;this.ticking=true;
    try{
      for(const state of this.states){
        if(state.status!=='running'||this.now()<state.nextRunAt)continue;
        try{
          const market=markets.find(m=>m.id===state.config.instrumentId),book=books.get(state.config.instrumentId);
          if(!market||!book)throw new Error('Current market/book unavailable');
          validateBook(book,market.id,this.now());
          this.engine.cancelOwned(state.id);
          const orders=this.engine.account(markets).orders.filter(o=>o.input.clientOrderId.startsWith(state.id));
          const filled=orders.reduce((sum,order)=>sum.plus(order.filledQuantity),new D(0)),remaining=new D(state.config.totalQuantity).minus(filled);
          if(remaining.lte(0)||state.ticks>=state.config.slices){state.status='completed';state.note=`Paper session complete; filled ${filled.toFixed()} of ${state.config.totalQuantity}.`;this.save(state);continue;}
          const slice=D.min(remaining,new D(state.config.totalQuantity).div(state.config.slices));
          for(const intent of planPaperOrders(state.config,market,book,slice.toFixed()))
            this.engine.submit({...intent,clientOrderId:state.id+crypto.randomUUID().replaceAll('-','').slice(0,16)},market,book);
          state.ticks++;state.nextRunAt=this.now()+state.config.intervalSeconds*1000;state.note=state.config.strategy==='maker'?'Two paper post-only quotes; displayed depth must trade through before simulated fills.':`Paper TWAP slice ${state.ticks}/${state.config.slices}; unfilled IOC quantity is not retried automatically.`;this.save(state);
        }catch(error){this.engine.cancelOwned(state.id);state.status='halted';state.note=error instanceof Error?error.message:'Paper strategy halted';this.save(state);}
      }
    }finally{this.ticking=false;}
  }
  close(){this.db.close();}
}
