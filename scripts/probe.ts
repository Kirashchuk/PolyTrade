import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { VENUE_REST } from '../src/shared/contracts';
await mkdir('artifacts',{recursive:true});
const now=Date.now();
const paths=['instruments','tickers','statistics','exchange','fees','leaderboard?limit=10',`exchange-stats?start_timestamp=${now-86400000}&end_timestamp=${now}`,'book?instrument_id=6&depth=100',`klines?instrument_id=6&interval=1h&start_timestamp=${now-86400000}`,'trades?instrument_id=6','funding?instrument_id=6'];
const results=[];
for(const path of paths){
  const url=`${VENUE_REST}/v1/info/${path}`;const started=Date.now();
  try {const r=await fetch(url,{signal:AbortSignal.timeout(15_000)});const text=await r.text();const name=path.split('?')[0];await Bun.write(`artifacts/official-${name}.json`,text);results.push({url,status:r.status,receivedAt:Date.now(),durationMs:Date.now()-started,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')});console.log(name,r.status,Buffer.byteLength(text),'bytes');}
  catch(error){results.push({url,status:null,error:String(error),receivedAt:Date.now()});console.log(path,String(error));}
}
await Bun.write('artifacts/probe.json',JSON.stringify({observedAt:new Date().toISOString(),results},null,2));
if(results.some(r=>r.status!==200))process.exitCode=1;
