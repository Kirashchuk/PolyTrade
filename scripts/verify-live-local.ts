// Read-only local smoke test. Never signs or sends an upstream financial operation.
import { readdir } from 'node:fs/promises';

const origin = 'http://127.0.0.1:4310';
const headers = { origin, 'sec-fetch-site': 'same-origin' };
const observations: { path: string; status: number; state?: string; count?: number }[] = [];
const read = async (path: string, init?: RequestInit) => {
  const response = await fetch(origin + path, { ...init, headers: { ...headers, ...init?.headers }, signal: AbortSignal.timeout(30_000) });
  return { response, body: await response.json() };
};
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const health = await read('/api/health');
assert(health.response.ok, 'Local service is unavailable');
assert(health.body.liveEnabled === true, 'Run bun run start:live before this smoke check');
observations.push({ path: '/api/health', status: health.response.status, state: 'live relay opted in' });

let selected = 6;
for (const path of ['/api/markets', '/api/overview', '/api/exchange']) {
  const { response, body } = await read(path);
  assert(response.ok, `${path} failed`);
  assert(body.source?.startsWith('https://api.perpetuals.polymarket.com/'), `${path} lacks official provenance`);
  observations.push({ path, status: response.status, state: body.status, ...(Array.isArray(body.data) ? { count: body.data.length } : {}) });
  if (path === '/api/markets' && Array.isArray(body.data)) selected = body.data.find((row: {baseAsset:string}) => row.baseAsset === 'BTC')?.id ?? selected;
}
for (const path of [`/api/book/${selected}`, `/api/candles/${selected}?interval=5m`, `/api/trades/${selected}`]) {
  const { response, body } = await read(path);
  assert(response.ok, `${path} failed`);
  observations.push({ path, status: response.status, state: body.status });
}
const local = await read('/api/session');
assert(local.response.ok && typeof local.body.token === 'string', 'Session bootstrap failed');
const time = await read('/api/live?path=%2Fv1%2Finfo%2Ftime', { headers: { 'x-polytrade-token': local.body.token } });
assert(time.response.ok, 'Enabled relay did not return official server time');
observations.push({ path: '/api/live → /v1/info/time (GET)', status: time.response.status });

const unauthorized = await read('/api/live?path=%2Fv1%2Ftrade%2Forders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert(unauthorized.response.status === 401, 'Unsigned unauthenticated local write was not blocked');
const crossOrigin = await read('/api/session', { headers: { origin: 'https://example.invalid', 'sec-fetch-site': 'cross-site' } });
assert(crossOrigin.response.status === 403, 'Cross-origin bootstrap was not blocked');
const withdrawal = await read('/api/live?path=%2Fv1%2Faccount%2Fwithdraw', { headers: { 'x-polytrade-token': local.body.token } });
assert(withdrawal.response.status === 403, 'Relay boundary admitted an unsupported withdrawal path');

for (const filename of await readdir('dist/assets')) if (filename.endsWith('.js')) {
  const script = await Bun.file(`dist/assets/${filename}`).text();
  assert(!script.includes('/api/paper') && !script.includes('/api/bots'), `Simulator endpoint remains in active browser asset ${filename}`);
}
const result = { checkedAt: new Date().toISOString(), origin, observations, guards: { unauthorizedWrite: unauthorized.response.status, crossOrigin: crossOrigin.response.status, withdrawalPath: withdrawal.response.status }, simulatorEndpointsInBrowserAssets: false, financialWrites: 0 };
await Bun.write('artifacts/live-only-http.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
