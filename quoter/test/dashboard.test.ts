import { describe, expect, test } from 'bun:test';
import { createDashboardHandler, startDashboard } from '../src/dashboard/server.ts';
import type { DashboardState } from '../src/dashboard/types.ts';
import { createLogger } from '../src/log.ts';
import { parseEgressList } from '../src/egress.ts';
import { silentLog } from './fixtures.ts';

const TOKEN = 'f'.repeat(64);
const fakeState = { now: 1, mode: 'dry_run', instrument: { id: 45, symbol: 'PLTR-USD', category: 'equity' }, status: 'running' } as unknown as DashboardState;
function harness(port = 4320) {
  const stops: string[] = [];
  const handler = createDashboardHandler({ port: () => port, token: TOKEN, source: { dashboardState: () => fakeState, stop: async (reason) => { stops.push(reason); } }, alerts: () => [], assets: new Map([['/', '<html></html>']]) });
  const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => handler(new Request(`http://127.0.0.1:${port}${path}`, { ...init, headers: { host: `127.0.0.1:${port}`, ...init.headers } }));
  return { call, stops };
}
const stopInit = (headers: Record<string, string>, body = '{"confirm":true}'): RequestInit & { headers: Record<string, string> } => ({ method: 'POST', headers, body });

describe('dashboard guard', () => {
  test('reads need a loopback Host and same-origin fetch metadata', async () => {
    const { call } = harness();
    expect((await call('/api/state')).status).toBe(200);
    expect((await call('/', {})).headers.get('content-security-policy')).toContain("script-src 'self'");
    expect((await call('/api/state', { headers: { host: 'evil.example:4320' } })).status).toBe(403); // DNS rebinding
    expect((await call('/api/state', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await call('/api/session', { headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await call('/nope')).status).toBe(404);
  });

  test('Stop requires the control token, a same-origin JSON body and explicit confirmation', async () => {
    const { call, stops } = harness();
    expect((await call('/api/stop', stopInit({ 'content-type': 'application/json' }))).status).toBe(401);
    expect((await call('/api/stop', stopInit({ 'content-type': 'application/json', 'x-quoter-token': 'e'.repeat(64) }))).status).toBe(401);
    expect((await call('/api/stop', stopInit({ 'content-type': 'text/plain', 'x-quoter-token': TOKEN }))).status).toBe(415);
    expect((await call('/api/stop', stopInit({ 'content-type': 'application/json', 'x-quoter-token': TOKEN, origin: 'http://localhost:9999' }))).status).toBe(403);
    expect((await call('/api/stop', stopInit({ 'content-type': 'application/json', 'x-quoter-token': TOKEN }, '{}'))).status).toBe(400);
    expect((await call('/api/stop', { method: 'GET', headers: { 'x-quoter-token': TOKEN } })).status).toBe(404);
    expect(stops).toEqual([]);
    const ok = await call('/api/stop', stopInit({ 'content-type': 'application/json', 'x-quoter-token': TOKEN, origin: 'http://127.0.0.1:4320' }));
    expect(ok.status).toBe(200);
    expect(stops).toEqual(['dashboard stop']);
  });
});

describe('dashboard server', () => {
  test('binds to loopback, serves the page and a redacted event feed', async () => {
    parseEgressList('x=192.0.2.5:8080:FEEDUSER:FEEDPASS99');
    const handle = await startDashboard({ port: 0, log: silentLog(), source: { dashboardState: () => fakeState, stop: async () => {} } });
    try {
      expect(handle.url).toStartWith('http://127.0.0.1:');
      const page = await fetch(handle.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('/app.js');
      expect((await fetch(`${handle.url}/app.js`)).headers.get('content-type')).toContain('javascript');
      createLogger({ sink: () => {} }).warn('egress failover', { from: 'http://FEEDUSER:FEEDPASS99@192.0.2.5:8080' });
      const state = await (await fetch(`${handle.url}/api/state`)).json() as { alerts: { msg: string; detail: string }[] };
      const alert = state.alerts.find((a) => a.msg === 'egress failover')!;
      expect(alert).toBeDefined();
      expect(alert.detail).not.toContain('FEEDPASS99');
      expect(alert.detail).not.toContain('FEEDUSER');
      const session = await (await fetch(`${handle.url}/api/session`)).json() as { token: string };
      expect(session.token).toBe(handle.token);
    } finally { handle.stop(); }
  });
});
