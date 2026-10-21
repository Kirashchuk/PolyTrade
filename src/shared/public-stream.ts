import { exchangeNow } from './clock';
import { VENUE_WS, type Book, type Trade } from './contracts';

export interface StreamHandlers { onBook?: (book:Book)=>void; onTrades?: (trades:Trade[])=>void; onState?: (state:'connecting'|'live'|'reconnecting'|'closed',note:string)=>void; }
type Frame = {ch?:string; ts?:number; ets?:number; sq?:number; data?:unknown; id?:number;};
function positive(value:unknown):value is string {return typeof value==='string'&&/^\d+(\.\d+)?$/.test(value)&&Number.isFinite(Number(value))&&Number(value)>0;}
/** The book channel provides the entire requested top-depth view, not incremental deltas. */
export function parseStreamBook(frame:Frame,id:number,now=exchangeNow()):Book|null {
  if(!new RegExp(`^book::${id}(::(20|50))?$`).test(frame.ch??'')||!Number.isSafeInteger(frame.sq)||!Number.isFinite(frame.ets)||frame.ets!<=0||now-frame.ets!>=15_000||frame.ets!>now+1000)return null;
  const value=frame.data as {b?:unknown;a?:unknown}|undefined;
  if(!value||!Array.isArray(value.b)||!Array.isArray(value.a)||!value.b.length||!value.a.length)return null;
  const convert=(levels:unknown[],bid:boolean)=>{
    let previous=bid?Infinity:-Infinity;
    return levels.map(level=>{if(!Array.isArray(level)||!positive(level[0])||!positive(level[1]))throw new Error('Bad level');const p=Number(level[0]);if(bid?p>=previous:p<=previous)throw new Error('Bad sort');previous=p;return {price:level[0],quantity:level[1]};});
  };
  try {const bids=convert(value.b,true),asks=convert(value.a,false);if(Number(bids[0].price)>=Number(asks[0].price))return null;return {instrumentId:id,bids,asks,timestamp:frame.ets!,sequence:frame.sq!};}catch{return null;}
}
export function parseStreamTrades(frame:Frame,id:number):Trade[]{
  if(frame.ch!==`trades::${id}`||!Array.isArray(frame.data))return [];
  return frame.data.flatMap((value:Record<string,unknown>)=>{
    if(!value||value.iid!==id||value.settlement===true||!positive(value.p)||!positive(value.qty)||!Number.isSafeInteger(value.tid)||!Number.isFinite(value.ts)||!['long','short'].includes(String(value.side)))return [];
    return [{id:String(value.tid),instrumentId:id,side:String(value.side),price:Number(value.p),quantity:Number(value.qty),timestamp:Number(value.ts)}];
  });
}
export function openPublicStream(instrumentId:number,handlers:StreamHandlers):{close:()=>void}{
  let socket:WebSocket|null=null,closed=false,attempt=0,lastMessage=0,lastSequence=-1;
  let reconnect:ReturnType<typeof setTimeout>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
  const clear=()=>{if(heartbeat)clearInterval(heartbeat);heartbeat=undefined;};
  const connect=()=>{
    if(closed)return;
    handlers.onState?.(attempt?'reconnecting':'connecting','REST remains available while connecting');
    try{socket=new WebSocket(VENUE_WS);}catch{schedule();return;}
    const current=socket;lastSequence=-1;
    current.onopen=()=>{
      lastMessage=Date.now();current.send(JSON.stringify({id:1,req:'sub',chs:[`book::${instrumentId}::50`,`trades::${instrumentId}`]}));
      heartbeat=setInterval(()=>{if(Date.now()-lastMessage>45_000){current.close();return;}if(current.readyState===WebSocket.OPEN)current.send(JSON.stringify({req:'post',op:{type:'ping'}}));},20_000);
    };
    current.onmessage=event=>{
      if(current!==socket||closed)return;lastMessage=Date.now();
      try{
        const frame=JSON.parse(String(event.data)) as Frame;
        if(frame.id===1&&Array.isArray(frame.data)&&frame.data.some((v:Record<string,unknown>)=>v.status==='err')){handlers.onState?.('reconnecting','Subscription rejected; using REST');current.close();return;}
        const book=parseStreamBook(frame,instrumentId);
        if(book&&book.sequence>lastSequence){lastSequence=book.sequence;attempt=0;handlers.onBook?.(book);handlers.onState?.('live','Official top-50 depth stream');}
        const trades=parseStreamTrades(frame,instrumentId);if(trades.length)handlers.onTrades?.(trades);
      }catch{/* Bad frames never replace a verified book. */}
    };
    current.onerror=()=>current.close();
    current.onclose=()=>{clear();if(current===socket&&!closed)schedule();};
  };
  function schedule(){if(closed)return;clear();handlers.onState?.('reconnecting','Connection interrupted; using REST');const delay=Math.min(30_000,1000*2**attempt++);reconnect=setTimeout(connect,delay);}
  connect();
  return {close(){closed=true;clear();if(reconnect)clearTimeout(reconnect);if(socket){socket.onclose=null;socket.close();socket=null;}handlers.onState?.('closed','Stream closed');}};
}
