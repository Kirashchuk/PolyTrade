import { mkdirSync } from 'node:fs';
import { createApp } from './app';

const port=Number(process.env.POLYTRADE_PORT??4310);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('POLYTRADE_PORT must be between 1024 and 65535');
mkdirSync('data',{recursive:true});
const app=createApp({port,token:crypto.randomUUID()+crypto.randomUUID(),liveEnabled:process.env.POLYTRADE_LIVE_ENABLED==='1'});
const server=Bun.serve({hostname:'127.0.0.1',port,maxRequestBodySize:32_768,fetch:app.fetch});
console.log(`PolyTrade · http://127.0.0.1:${server.port} · ${process.env.POLYTRADE_LIVE_ENABLED==='1'?'live terminal and browser bots enabled':'live relay disabled; use bun run start:live'}`);
// Legacy simulation stays available as dormant source/API for regression work.
// The live-only product has no simulator scheduler; live bots run in the authorized browser.
let stopping=false;
const stop=()=>{if(stopping)return;stopping=true;void server.stop(true).then(()=>{app.close();process.exit(0);});};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
