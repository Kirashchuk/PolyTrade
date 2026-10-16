import { HttpError } from './guard';
import { VENUE_REST } from '../shared/contracts';

const reads = new Set(['/v1/account/balances','/v1/account/portfolio','/v1/account/open-orders','/v1/account/orders','/v1/account/fills','/v1/account/stats','/v1/account/limits','/v1/account/auto-cancel','/v1/account/config','/v1/info/registered','/v1/info/time']);
const operations: Record<string, string[]> = {
  'POST /v1/account/proxy': ['createProxy'], 'DELETE /v1/account/proxy': ['deleteProxy'],
  'POST /v1/trade/orders': ['createOrders'], 'DELETE /v1/trade/orders': ['cancelOrders'],
  'DELETE /v1/trade/orders-coid': ['cancelOrdersCOID'], 'DELETE /v1/trade/orders/all': ['cancelAll'],
  'PATCH /v1/trade/auto-cancel': ['autoCancel'], 'PATCH /v1/trade/leverage': ['updateLeverage'],
};
const queryKeys = new Set(['instrument_id','client_order_id','order_id','start_timestamp','end_timestamp','cursor','limit','address']);
export function validateRelayPath(path: string, method: string): URL {
  if (!path.startsWith('/v1/') || path.includes('\\') || path.includes('#')) throw new HttpError(400, 'Invalid venue path');
  const url = new URL(path, VENUE_REST);
  if (url.origin !== VENUE_REST || (method === 'GET' ? !reads.has(url.pathname) : !operations[`${method} ${url.pathname}`])) throw new HttpError(403, 'Venue operation is not allowed');
  for (const [key, value] of url.searchParams) if (!queryKeys.has(key) || value.length > 256) throw new HttpError(400, 'Unsupported venue query');
  return url;
}
export async function relay(request: Request, enabled: boolean, fetcher: typeof fetch = fetch): Promise<Response> {
  if (!enabled) throw new HttpError(403, 'Live trading is disabled. Start with POLYTRADE_LIVE_ENABLED=1 to enable the local relay.');
  const path = new URL(request.url).searchParams.get('path') ?? '';
  const url = validateRelayPath(path, request.method);
  let body: string | undefined;
  if (request.method !== 'GET') {
    const raw = await request.text();
    if (Buffer.byteLength(raw)>16_384) throw new HttpError(413,'Request body too large');
    let value: {op?: {type?: string}; sig?: string; salt?: number; ts?: number};
    try { value=JSON.parse(raw); } catch { throw new HttpError(400,'Invalid signed JSON'); }
    const allowed = operations[`${request.method} ${url.pathname}`];
    if (!value || typeof value !== 'object' || !allowed.includes(value.op?.type ?? '') || !/^0x[\da-fA-F]{130}$/.test(value.sig ?? '') || !Number.isSafeInteger(value.salt) || !Number.isSafeInteger(value.ts) || Math.abs(Date.now() - (value.ts ?? 0)) > 60_000) throw new HttpError(400, 'Invalid or expired signed operation');
    // Inspect, but forward the original signed bytes without numeric reserialization.
    body = raw;
  }
  const headers = new Headers({'accept':'application/json'});
  if (body) headers.set('content-type','application/json');
  for (const name of ['polymarket-proxy','polymarket-secret']) {
    const value = request.headers.get(name);
    if (value && value.length <= 1024 && !/[\r\n]/.test(value)) headers.set(name,value);
  }
  try {
    // Signed writes are deliberately attempted exactly once, including timeouts.
    const upstream = await fetcher(url, {method:request.method,headers,body,redirect:'error',signal:AbortSignal.timeout(12_000)});
    return new Response(await upstream.text(), {status:upstream.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  } catch {
    return Response.json({error:request.method === 'GET' ? 'Venue account read failed' : 'Write outcome is unknown. Reconcile open orders and history before submitting again.',indeterminate:request.method !== 'GET'}, {status:502,headers:{'cache-control':'no-store'}});
  }
}
