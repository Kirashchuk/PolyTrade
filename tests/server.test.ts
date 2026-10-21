import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/server/app';
import { VenueClient } from '../src/server/venue';
import { PaperEngine } from '../src/trading/paper';
import { BotManager } from '../src/trading/bots';

const PORT = 4310;
const TOKEN = 'integration-control-token';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function harness(options: { staleBook?: boolean; cancelOnly?: boolean } = {}) {
  const now = Date.now(), calls: { path: string; method: string }[] = [];
  const venue = new VenueClient({ now: () => now, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    calls.push({ path: url.pathname, method: init?.method ?? 'GET' });
    const payloads: Record<string, unknown> = {
      '/v1/info/instruments': [{ instrument_id: 6, instrument_type: 'perpetual', category: 'crypto', isolated_only: false, close_only: false,
        symbol: 'BTC-USD', display_symbol: 'BTC-USD', base_asset: 'BTC', quote_asset: 'pUSD', funding_interval: '1h',
        quantity_decimals: 2, price_decimals: 1, price_bounds: '0.1', min_notional: '10', max_market_notional: '1000000', max_limit_notional: '5000000', max_leverage: 50, max_order_count: 200,
        risk_tiers: [{ lower_bound: '0', max_leverage: 50 }] }],
      '/v1/info/tickers': [{ instrument_id: 6, mark_price: '100', index_price: '100', last_price: '100', open_interest: '1000', funding_rate: '0.00001', next_funding: now + 3_600_000, timestamp: now }],
      '/v1/info/statistics': [{ instrument_id: 6, volume: '1000000', open_price: '99', klines: [] }],
      '/v1/info/book': { instrument_id: 6, bids: [['99.0', '50.00']], asks: [['101.0', '50.00']], timestamp: options.staleBook ? now - 60_000 : now, sequence: 1 },
      '/v1/info/exchange': { cancel_only: options.cancelOnly ?? false, version: '1' },
      '/v1/info/time': { time: now + 2_900 },
    };
    if (!(url.pathname in payloads)) throw new Error(`Unexpected venue request ${url.pathname}`);
    return Response.json(payloads[url.pathname]);
  }) as typeof fetch });
  const paper = new PaperEngine(':memory:', { now: () => now });
  const bots = new BotManager(paper, ':memory:', { now: () => now });
  const app = createApp({ port: PORT, token: TOKEN, liveEnabled: false, venue, paper, bots });
  cleanup.push(() => { bots.close(); paper.close(); });
  return { app, calls };
}

function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: { host: `127.0.0.1:${PORT}`, origin: ORIGIN, 'sec-fetch-site': 'same-origin',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const order = () => ({ instrumentId: 6, side: 'buy', type: 'market', quantity: '1.00', leverage: 2,
  reduceOnly: false, postOnly: false, slippageBps: 200, clientOrderId: crypto.randomUUID().replaceAll('-', '') });

describe('loopback API integration', () => {
  test('market snapshots reach HTTP with provenance and security headers', async () => {
    const { app, calls } = harness();
    const response = await app.fetch(request('/api/markets'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('live');
    expect(body.data[0].openInterestUsd).toBe(100_000);
    expect(body.source).toContain('api.perpetuals.polymarket.com');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  test('session bootstrap rejects hostile hosts and cross-origin pages', async () => {
    const { app } = harness();
    expect((await app.fetch(request('/api/session', 'GET', undefined, { host: 'attacker.example:4310' }))).status).toBe(403);
    expect((await app.fetch(request('/api/session', 'GET', undefined, { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    const trusted = await app.fetch(request('/api/session'));
    expect((await trusted.json()).token).toBe(TOKEN);
  });

  test('health reports the measured exchange clock offset for browser freshness checks', async () => {
    const { app } = harness();
    expect((await (await app.fetch(request('/api/health'))).json()).exchangeClockOffsetMs).toBe(2_900);
  });

  test('live relay and wallet bootstrap have one canonical browser origin', async () => {
    const { app, calls } = harness();
    expect((await (await app.fetch(request('/api/session'))).json()).liveOrigin).toBe(ORIGIN);
    const alias = { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, 'x-polytrade-token': TOKEN };
    const live = await app.fetch(request('/api/live?path=%2Fv1%2Finfo%2Ftime', 'GET', undefined, alias));
    expect(live.status).toBe(403);
    expect((await live.json()).error).toContain(ORIGIN);
    const page = await app.fetch(request('/terminal?x=1', 'GET', undefined, { host: `localhost:${PORT}` }));
    expect(page.status).toBe(308);
    expect(page.headers.get('location')).toBe(`${ORIGIN}/terminal?x=1`);
    expect(calls).toHaveLength(0);
  });

  test('paper mutations require token, JSON and same origin', async () => {
    const { app } = harness();
    expect((await app.fetch(request('/api/paper/orders', 'POST', order()))).status).toBe(401);
    expect((await app.fetch(request('/api/paper/orders', 'POST', order(), { 'x-polytrade-token': TOKEN, 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await app.fetch(request('/api/paper/orders', 'POST', order(), { 'x-polytrade-token': TOKEN, origin: 'https://attacker.example' }))).status).toBe(403);
  });

  test('paper execution produces a labelled account and no upstream writes', async () => {
    const { app, calls } = harness();
    const response = await app.fetch(request('/api/paper/orders', 'POST', order(), { 'x-polytrade-token': TOKEN }));
    expect(response.status).toBe(200);
    const account = await response.json();
    expect(account.mode).toBe('paper');
    expect(account.positions).toHaveLength(1);
    expect(account.positions[0].quantity).toBe('1');
    expect(account.orders[0].status).toBe('filled');
    expect(calls.every((call) => call.method === 'GET' && call.path.startsWith('/v1/info/'))).toBe(true);
  });

  test('stale official books and exchange cancel-only state block paper execution', async () => {
    for (const options of [{ staleBook: true }, { cancelOnly: true }]) {
      const { app } = harness(options);
      const response = await app.fetch(request('/api/paper/orders', 'POST', order(), { 'x-polytrade-token': TOKEN }));
      expect(response.status).toBe(503);
      const account = await (await app.fetch(request('/api/paper'))).json();
      expect(account.orders).toHaveLength(0);
    }
  });

  test('disabled live relay rejects reviewed signed writes without touching the venue', async () => {
    const { app, calls } = harness();
    const response = await app.fetch(request('/api/live?path=%2Fv1%2Ftrade%2Forders', 'POST', {
      op: { type: 'createOrders', args: [] }, sig: '0x' + 'a'.repeat(130), salt: 1, ts: Date.now(),
    }, { 'x-polytrade-token': TOKEN }));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('disabled');
    expect(calls).toHaveLength(0);
  });

  test('idle paper scheduler performs no venue reads', async () => {
    const { app, calls } = harness();
    await app.tick();
    expect(calls).toHaveLength(0);
  });

  test('unavailable markets halt a running bot immediately, including before its next due tick', async () => {
    const { app } = harness();
    const markets = (await app.venue.markets()).data!, book = (await app.venue.book(6)).data!;
    const bot = app.bots.start({ instrumentId: 6, strategy: 'maker', side: 'buy', totalQuantity: '4', slices: 2, intervalSeconds: 60, spreadBps: 20, leverage: 2 }, markets, new Map([[6, book]]));
    app.bots.tick(markets, new Map([[6, book]]));
    expect(app.bots.list().find((state) => state.id === bot.id)!.ticks).toBe(1);
    expect(app.paper.account(markets).orders.some((order) => order.status === 'open')).toBe(true);
    app.venue.markets = async () => ({ status: 'unavailable', data: null, source: 'test transport', receivedAt: Date.now(), lastSuccessAt: null, error: 'upstream unavailable' });
    await app.tick();
    expect(app.bots.list().find((state) => state.id === bot.id)!.status).toBe('halted');
    expect(app.paper.account(markets).orders.every((order) => order.status !== 'open')).toBe(true);
  });

  test('encoded Windows traversal cannot escape the static asset directory', async () => {
    const { app } = harness();
    expect((await app.fetch(request('/..%5c..%5cpackage.json'))).status).toBe(403);
  });

  test('in-memory app shutdown closes both stores in order and is idempotent', () => {
    const app = createApp({ port: PORT, token: TOKEN, liveEnabled: false, dataPath: ':memory:' });
    const closed: string[] = [];
    const closeBots = app.bots.close.bind(app.bots), closePaper = app.paper.close.bind(app.paper);
    app.bots.close = () => { closed.push('bots'); closeBots(); };
    app.paper.close = () => { closed.push('paper'); closePaper(); };
    app.close(); app.close();
    expect(closed).toEqual(['bots', 'paper']);
  });
});
