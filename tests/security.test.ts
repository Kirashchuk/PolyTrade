import { describe, expect, test } from 'bun:test';
import { localHost, requireControl } from '../src/server/guard';
import { relay, validateRelayPath } from '../src/server/relay';
const config = {port:4310,token:'test-session-token'};
function req(headers:Record<string,string>={}) { return new Request('http://127.0.0.1:4310/api/paper/orders',{method:'POST',headers:{host:'127.0.0.1:4310',origin:'http://127.0.0.1:4310','content-type':'application/json',...headers},body:'{}'}); }
describe('local control boundary',()=>{
  test('rejects rebinding and cross-site requests',()=>{
    expect(()=>localHost(req({host:'evil.example:4310'}),config)).toThrow();
    expect(()=>localHost(req({origin:'https://evil.example'}),config)).toThrow();
    expect(()=>localHost(req({'sec-fetch-site':'cross-site'}),config)).toThrow();
  });
  test('requires session token and accepts only local origin',()=>{
    expect(()=>requireControl(req(),config)).toThrow();
    expect(()=>requireControl(req({authorization:'Bearer test-session-token'}),config)).not.toThrow();
  });
  test('cannot relay withdrawals or arbitrary destinations',()=>{
    for(const path of ['https://evil.example','//evil.example/v1/trade/orders','/v1/account/withdraw','/v1/account/internal-transfer','/v1/account/orders?secret=oops']) expect(()=>validateRelayPath(path,'POST')).toThrow();
    expect(validateRelayPath('/v1/account/open-orders?instrument_id=6','GET').hostname).toBe('api.perpetuals.polymarket.com');
  });
  test('live is off by default',async()=>{ await expect(relay(req(),false)).rejects.toThrow('disabled'); });
  test('unknown write outcomes are never retried',async()=>{
    let calls=0;const fetcher=(async()=>{calls++;throw new Error('connection lost');}) as unknown as typeof fetch;
    const r=new Request('http://127.0.0.1:4310/api/live?path=%2Fv1%2Ftrade%2Forders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:{type:'createOrders',args:[]},sig:'0x'+'a'.repeat(130),salt:1,ts:Date.now()})});
    const result=await relay(r,true,fetcher); expect(calls).toBe(1);expect(result.status).toBe(502);expect((await result.json()).indeterminate).toBe(true);
  });
  test('signed body reaches the allow-listed venue byte for byte',async()=>{
    const body = `{\n  "op": {"type":"cancelAll","args":{}},\n  "sig":"0x${'a'.repeat(130)}", "salt":1, "ts":${Date.now()}\n}`;
    const forwarded: {body: string | null} = {body:null};
    const fetcher = (async (_input:unknown, init?:RequestInit)=>{forwarded.body=init?.body as string;return Response.json({status:'ok'});}) as typeof fetch;
    const request = new Request('http://127.0.0.1:4310/api/live?path=%2Fv1%2Ftrade%2Forders%2Fall', {method:'DELETE',headers:{'content-type':'application/json'},body});
    expect((await relay(request,true,fetcher)).status).toBe(200);
    expect(forwarded.body).toBe(body);
  });
});
