import { resolve, extname, sep, dirname } from 'node:path';
import type { Book, BotConfig, Market, OrderInput } from '../shared/contracts';
import { HttpError, localHost, readJson, requireControl, type GuardConfig } from './guard';
import { relay } from './relay';
import { VenueClient } from './venue';
import { PaperEngine } from '../trading/paper';
import { BotManager } from '../trading/bots';

export interface AppOptions { port: number; token: string; liveEnabled: boolean; dataPath?: string; venue?: VenueClient; paper?: PaperEngine; bots?: BotManager; distPath?: string; }
const securityHeaders: Record<string,string> = {
  'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer',
  'cross-origin-resource-policy':'same-origin','x-frame-options':'DENY',
  'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss://ws.perpetuals.polymarket.com; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
export function createApp(options: AppOptions) {
  const venue = options.venue ?? new VenueClient();
  const dataPath = options.dataPath ?? 'data/paper.sqlite';
  const paper = options.paper ?? new PaperEngine(dataPath);
  const bots = options.bots ?? new BotManager(paper, dataPath === ':memory:' ? ':memory:' : resolve(dirname(dataPath), 'bots.sqlite'));
  const guard: GuardConfig = {port:options.port,token:options.token};
  const dist = resolve(options.distPath ?? 'dist');
  let ticking = false; let closed = false; let tickError: string | null = null;
  const counts = new Map<string,{start:number;count:number}>();
  const json = (data:unknown,status=200) => Response.json(data,{status,headers:{'cache-control':'no-store'}});
  async function activeMarkets(): Promise<Market[]> {
    const snapshot = await venue.markets();
    if (snapshot.status !== 'live' || !snapshot.data) throw new HttpError(503,snapshot.error ?? 'Fresh official market data is required');
    return snapshot.data;
  }
  async function freshBook(id:number): Promise<Book> {
    const snapshot=await venue.book(id);
    if(snapshot.status!=='live' || !snapshot.data || Date.now()-snapshot.data.timestamp>=15_000) throw new HttpError(503,'A fresh official order book is required');
    return snapshot.data;
  }
  const idFrom = (text:string) => {const n=Number(text);if(!/^\d+$/.test(text)||!Number.isSafeInteger(n)||n<0)throw new HttpError(400,'Invalid instrument ID');return n;};
  async function handleApi(request:Request,url:URL):Promise<Response> {
    localHost(request,guard);
    const key=url.pathname;
    const count=counts.get(key);const now=Date.now();
    if(!count||now-count.start>10_000)counts.set(key,{start:now,count:1});
    else if(++count.count>150)throw new HttpError(429,'Local request budget exceeded');
    if(counts.size>256)counts.clear();
    if(key==='/api/session' && request.method==='GET')return json({token:options.token,liveEnabled:options.liveEnabled});
    if(key==='/api/live'){requireControl(request,guard);return relay(request,options.liveEnabled);}
    if(!['GET','HEAD'].includes(request.method))requireControl(request,guard);
    if(request.method==='GET') {
      if(key==='/api/health')return json({now,liveEnabled:options.liveEnabled,mode:'local',venue:'Polymarket Perps',database:'Browser live journal · credentials in memory',tickError});
      if(key==='/api/markets')return json(await venue.markets());
      if(key==='/api/overview')return json(await venue.overview());
      if(key==='/api/fees')return json(await venue.fees());
      if(key==='/api/exchange')return json(await venue.exchange());
      if(key==='/api/leaderboard') {
        const window=url.searchParams.get('window')??'day',sort=url.searchParams.get('sort')??'pnl';
        if(!['day','week','month','all'].includes(window)||!['pnl','notional','account_value','roi'].includes(sort))throw new HttpError(400,'Unsupported leaderboard window or sort');
        return json(await venue.leaderboard(window,sort));
      }
      const match=key.match(/^\/api\/(book|candles|trades|funding)\/(\d+)$/);
      if(match){const id=idFrom(match[2]);switch(match[1]){
        case 'book':return json(await venue.book(id));
        case 'trades':return json(await venue.trades(id));
        case 'funding':return json(await venue.funding(id));
        case 'candles':{const interval=url.searchParams.get('interval')??'1h';if(!['1m','5m','15m','30m','1h','4h','1d'].includes(interval))throw new HttpError(400,'Unsupported candle interval');return json(await venue.candles(id,interval));}
      }}
      if(key==='/api/paper')return json(paper.account((await venue.markets()).data??[]));
      if(key==='/api/bots')return json(bots.list());
    }
    if(key==='/api/paper/orders'&&request.method==='POST'){
      const input=await readJson(request) as OrderInput; const markets=await activeMarkets();const market=markets.find(m=>m.id===input?.instrumentId);
      if(!market)throw new HttpError(400,'Unknown instrument');
      if(market.timestamp===null||Date.now()-market.timestamp>=15_000||market.timestamp>Date.now()+1000)throw new HttpError(503,'A fresh official mark is required');
      const exchange=await venue.exchange();if(exchange.status!=='live'||!exchange.data||exchange.data.cancelOnly)throw new HttpError(503,'Exchange state is unavailable or cancel-only');
      const book=await freshBook(market.id);paper.submit(input,market,book);return json(paper.account(markets));
    }
    const cancel=key.match(/^\/api\/paper\/orders\/([\da-f-]+)$/i);
    if(cancel&&request.method==='DELETE'){paper.cancel(cancel[1]);return json(paper.account((await venue.markets()).data??[]));}
    if(key==='/api/paper/reset'&&request.method==='POST'){bots.kill();paper.reset();return json(paper.account((await venue.markets()).data??[]));}
    if(key==='/api/bots'&&request.method==='POST'){
      const config=await readJson(request) as BotConfig;const markets=await activeMarkets();if(!markets.find(m=>m.id===config?.instrumentId))throw new HttpError(400,'Unknown instrument');
      return json(bots.start(config,markets,new Map([[config.instrumentId,await freshBook(config.instrumentId)]])));
    }
    const stop=key.match(/^\/api\/bots\/([\da-f-]+)\/stop$/i);
    if(stop&&request.method==='POST')return json(bots.stop(stop[1]));
    if(key==='/api/bots/kill'&&request.method==='POST')return json(bots.kill());
    throw new HttpError(404,'API route not found');
  }
  async function fetchHandler(request:Request):Promise<Response> {
    let response:Response;
    try {
      const url=new URL(request.url);
      if(url.pathname.startsWith('/api/'))response=await handleApi(request,url);
      else if(!['GET','HEAD'].includes(request.method))response=json({error:'Method not allowed'},405);
      else {
        let decoded:string;try{decoded=decodeURIComponent(url.pathname);}catch{throw new HttpError(400,'Invalid path');}
        const target=resolve(dist,'.'+decoded);
        if(target!==dist&&!target.startsWith(dist+sep))throw new HttpError(403,'Invalid file path');
        const file=Bun.file(target);
        if(target!==dist&&await file.exists())response=new Response(request.method==='HEAD'?null:file,{headers:{'cache-control':extname(target)==='.html'?'no-cache':'public, max-age=3600'}});
        else if(!extname(decoded)&&await Bun.file(resolve(dist,'index.html')).exists())response=new Response(request.method==='HEAD'?null:Bun.file(resolve(dist,'index.html')),{headers:{'content-type':'text/html','cache-control':'no-cache'}});
        else response=new Response('Build the web app first: bun run build',{status:404});
      }
    } catch(error) {
      response=json({error:error instanceof Error?error.message:'Request failed'},error instanceof HttpError?error.status:400);
    }
    for(const [key,value]of Object.entries(securityHeaders))response.headers.set(key,value);
    return response;
  }
  async function tick():Promise<void>{
    if(ticking||closed)return;
    const ids=new Set([...paper.activeInstrumentIds(),...bots.list().filter(b=>b.status==='running').map(b=>b.config.instrumentId)]);
    if(!ids.size){tickError=null;return;}
    ticking=true;
    try{
      const marketsSnapshot=await venue.markets();
      if(closed)return;
      if(marketsSnapshot.status!=='live'||!marketsSnapshot.data){tickError='Paper execution paused: market data unavailable or stale';bots.haltAll(tickError);return;}
      const markets=marketsSnapshot.data;
      const books=new Map<number,Book>();
      await Promise.allSettled([...ids].map(async id=>{const snapshot=await venue.book(id);if(snapshot.status==='live'&&snapshot.data)books.set(id,snapshot.data);}));
      if(closed)return;
      const exchange=await venue.exchange();
      if(closed)return;
      if(exchange.status!=='live'||!exchange.data||exchange.data.cancelOnly){tickError='Paper execution paused: exchange cancel-only or unavailable';bots.haltAll(tickError);return;}
      paper.tick(markets,books);bots.tick(markets,books);tickError=null;
    }catch(error){tickError=error instanceof Error?error.message:'Paper tick failed';if(!closed)bots.haltAll(tickError);}finally{ticking=false;}
  }
  return {fetch:fetchHandler,tick,close:()=>{if(closed)return;closed=true;bots.close();paper.close();},venue,paper,bots};
}
