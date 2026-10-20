import { afterAll, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { encode } from '@msgpack/msgpack';
import { keccak256, recoverTypedDataAddress, type Hex } from 'viem';
import { QuoterBot } from '../src/bot.ts';
import { parseSettings } from '../src/config.ts';
import type { Credentials } from '../src/credentials.ts';
import { EgressPool } from '../src/egress.ts';
import { parseInstrument } from '../src/instruments.ts';
import { Clock, RestClient } from '../src/rest.ts';
import { DOMAIN, OP_TYPES, compactOperation, proxySigner, type Operation } from '../src/signer.ts';
import { PLTR_ROW, silentLog } from './fixtures.ts';

/**
 * Local mock of the Perps REST + WebSocket API on loopback. It verifies every signature against the proxy
 * address, keeps an order book of the bot's orders and pushes `orders` events like the real private channel.
 * No request leaves the machine.
 */
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const signer = proxySigner(KEY);
type MockOrder = { oid: number; iid: number; buy: boolean; p: string; qty: string; rest: string; fill: string; status: string; coid: string; tif: string; po: boolean };
const exchange = {
  bid: '195.76', ask: '195.77', sq: 1_000, privateSq: 0, nextOid: 1,
  orders: new Map<string, MockOrder>(), writes: [] as { type: string; args: unknown; sigOk: boolean }[],
  autoCancel: 0, sockets: new Set<ServerWebSocket<{ authed: boolean; channels: Set<string> }>>(),
};
const push = (channel: string, data: unknown) => {
  for (const ws of exchange.sockets) if (ws.data.channels.has(channel)) ws.send(JSON.stringify({ ch: channel, ts: Date.now(), sq: channel.startsWith('book') ? ++exchange.sq : ++exchange.privateSq, data }));
};
const orderEvent = (o: MockOrder) => push('orders', o);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

async function verify(body: { op: Operation; sig: Hex; salt: number; ts: number }): Promise<boolean> {
  const op = body.op as Operation;
  const recovered = await recoverTypedDataAddress({ domain: DOMAIN, types: OP_TYPES, primaryType: 'Op', message: { data: keccak256(encode(compactOperation(op))), salt: BigInt(body.salt), ts: BigInt(body.ts) }, signature: body.sig });
  return recovered === signer.address && Number.isSafeInteger(body.salt) && Math.abs(body.ts - Date.now()) < 300_000;
}

const server = Bun.serve<{ authed: boolean; channels: Set<string> }>({
  hostname: '127.0.0.1', port: 0,
  async fetch(request, srv) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/ws') return srv.upgrade(request, { data: { authed: false, channels: new Set() } }) ? undefined : new Response('no', { status: 400 });
    const key = `${request.method} ${url.pathname}`;
    if (url.pathname.startsWith('/v1/account/') && request.headers.get('polymarket-proxy') !== signer.address) return json({ status: 'err', error: 'unauthorized' }, 401);
    switch (key) {
      case 'GET /v1/info/time': return json({ time: Date.now() });
      case 'GET /v1/info/exchange': return json({ cancel_only: false });
      case 'GET /v1/info/instruments': return json([PLTR_ROW]);
      case 'GET /v1/info/book': return json({ instrument_id: 45, bids: [[exchange.bid, '10']], asks: [[exchange.ask, '10']], timestamp: Date.now(), sequence: exchange.sq });
      case 'GET /v1/account/limits': return json({ actions_per_minute: 0, actions_per_minute_limit: 5000, open_orders: 0, open_orders_limit: 1000 });
      case 'GET /v1/account/auto-cancel': return json({ deadline: exchange.autoCancel, triggered: 0, daily_limit: 10, next_reset: 0 });
      case 'GET /v1/account/config': return json([{ instrument_id: 45, leverage: 5, cross: true }]);
      case 'GET /v1/account/portfolio': return json({ positions: [], margin: { total_account_value: '10000', available_order_margin: '9000' }, in_liquidation: false, timestamp: Date.now() });
      case 'GET /v1/account/stats': return json({ account_maker_share_7d: '0.012' });
      case 'GET /v1/account/rewards': return json({ data: [], more: false });
      case 'GET /v1/account/open-orders':
        return json([...exchange.orders.values()].filter((o) => o.status === 'open').map((o) => ({ order_id: o.oid, instrument_id: o.iid, buy: o.buy, price: o.p, quantity: o.qty, resting_quantity: o.rest, filled_quantity: o.fill, status: o.status, client_order_id: o.coid, tif: 'gtc', post_only: true, ro: false })));
    }
    const body = await request.json() as { op: Operation; sig: Hex; salt: number; ts: number };
    const sigOk = await verify(body);
    exchange.writes.push({ type: body.op.type, args: body.op.args, sigOk });
    if (!sigOk) return json([{ status: 'err', error: 'invalid signature' }], 400);
    const op = body.op;
    switch (op.type) {
      case 'createOrders': return json(op.args.map((a) => {
        const o: MockOrder = { oid: exchange.nextOid++, iid: a.iid, buy: a.buy, p: a.p, qty: a.qty, rest: a.qty, fill: '0', status: 'open', coid: a.c, tif: a.tif, po: a.po === true };
        exchange.orders.set(a.c, o); setTimeout(() => orderEvent(o), 5);
        return { status: 'ok', oid: o.oid, coid: a.c };
      }));
      case 'modifyOrdersCOID': return json(op.args.map((m) => {
        const o = exchange.orders.get(m.coid);
        if (!o || o.status !== 'open') return { status: 'err', coid: m.coid, error: 'order_unknown' };
        o.p = m.p; o.qty = m.qty; o.rest = String(Number(m.qty) - Number(o.fill));
        setTimeout(() => orderEvent(o), 5);
        return { status: 'ok', order: o };
      }));
      case 'cancelOrdersCOID': return json(op.args.map((coid) => {
        const o = exchange.orders.get(coid);
        if (!o || o.status !== 'open') return { status: 'err', coid, error: 'order_already_terminal', ts: Date.now() };
        o.status = 'cancelled'; o.rest = '0'; setTimeout(() => orderEvent(o), 5);
        return { status: 'ok', oid: o.oid, coid, ts: Date.now() };
      }));
      case 'cancelAll':
        for (const o of exchange.orders.values()) if (o.status === 'open') { o.status = 'cancelled'; o.rest = '0'; setTimeout(() => orderEvent(o), 5); }
        return json({ status: 'ok' });
      case 'autoCancel': exchange.autoCancel = op.args.time; return json({ status: 'ok', deadline: op.args.time });
      default: return json({ status: 'err', error: 'unsupported' }, 400);
    }
  },
  websocket: {
    open(ws) { exchange.sockets.add(ws); },
    close(ws) { exchange.sockets.delete(ws); },
    message(ws, raw) {
      const msg = JSON.parse(String(raw)) as { id?: number; req: string; chs?: string[]; op?: { type: string; args?: { proxy?: string; secret?: string } } };
      if (msg.req === 'post' && msg.op?.type === 'auth') {
        ws.data.authed = msg.op.args?.proxy === signer.address && msg.op.args?.secret === 'mock-secret';
        ws.send(JSON.stringify({ id: msg.id, data: ws.data.authed ? { status: 'ok', pod: 'mock-pod' } : { status: 'err', error: 'unauthorized' } }));
      } else if (msg.req === 'sub') {
        for (const ch of msg.chs ?? []) ws.data.channels.add(ch);
        ws.send(JSON.stringify({ id: msg.id, data: (msg.chs ?? []).map(() => ({ status: 'ok' })) }));
      } else if (msg.req === 'post' && msg.op?.type === 'ping') ws.send(JSON.stringify({ id: msg.id, data: { status: 'ok', ts: Date.now() } }));
    },
  },
});
const ticker = setInterval(() => push('book::45', { b: [[exchange.bid, '10']], a: [[exchange.ask, '10']] }), 50);
afterAll(() => { clearInterval(ticker); server.stop(true); });

const base = `http://127.0.0.1:${server.port}`;
const until = async (check: () => boolean, ms = 8_000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('condition not reached'); await Bun.sleep(20); } };

describe('live path against a local mock exchange', () => {
  test('arms the deadman, places a signed post-only ladder, modifies on a mid move, cancels and disarms on stop', async () => {
    const { settings } = parseSettings(Bun.YAML.parse(await Bun.file(new URL('../config/example.yaml', import.meta.url)).text()));
    settings.mode = 'live';
    settings.egress.allowDirect = true;
    settings.metrics.dir = `${import.meta.dir}/.tmp-metrics`;
    settings.sessions.schedule = 'regular';
    const log = silentLog();
    const egress = new EgressPool({ proxies: [], allowDirect: true, timeoutMs: 2_000, log });
    const rest = new RestClient(egress, log, base);
    const clock = new Clock(rest);
    await clock.sync();
    const credentials: Credentials = { auth: { proxy: signer.address, secret: 'mock-secret' }, signer, expiresAt: Date.now() + 86_400_000 * 2, owner: null, origin: 'environment' };
    const bot = new QuoterBot({ settings, instrument: parseInstrument(PLTR_ROW, base, Date.now()), egress, rest, clock, log, credentials, stopFile: `${import.meta.dir}/.no-stop-file`, wsUrl: `ws://127.0.0.1:${server.port}/v1/ws` });
    await bot.start();
    expect(exchange.autoCancel).toBeGreaterThan(Date.now());

    await until(() => [...exchange.orders.values()].filter((o) => o.status === 'open').length === 6);
    const placed = exchange.writes.filter((w) => w.type === 'createOrders');
    expect(placed).toHaveLength(1); // one batch for the whole ladder
    for (const o of exchange.orders.values()) { expect(o.tif).toBe('gtc'); expect(o.po).toBe(true); }
    const bids = [...exchange.orders.values()].filter((o) => o.buy).map((o) => o.p).sort();
    expect(bids).toEqual(['195.43', '195.6', '195.69']);
    await until(() => bot.dashboardState().ladder.filter((row) => row.live?.status === 'open').length === 6);
    const view = bot.dashboardState();
    expect(view.mode).toBe('live');
    expect(view.ladder.filter((row) => row.live?.status === 'open')).toHaveLength(6);
    expect(view.account?.accountValue).toBe(10_000);
    expect(view.deadmanDeadline).toBeGreaterThan(Date.now());
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('mock-secret');
    expect(serialized.toLowerCase()).not.toContain(KEY.slice(2));

    exchange.bid = '195.86'; exchange.ask = '195.87'; // ~5 bps move
    await until(() => exchange.writes.some((w) => w.type === 'modifyOrdersCOID'));
    await until(() => [...exchange.orders.values()].some((o) => o.buy && o.p === '195.79'));
    expect(exchange.writes.filter((w) => w.type === 'createOrders')).toHaveLength(1); // modified in place, not re-placed

    await bot.stop('test');
    expect(await bot.done).toBe('test');
    expect([...exchange.orders.values()].filter((o) => o.status === 'open')).toHaveLength(0);
    expect(exchange.writes.some((w) => w.type === 'cancelAll')).toBe(true);
    expect(exchange.autoCancel).toBe(0); // disarmed after verified cancel
    expect(exchange.writes.every((w) => w.sigOk)).toBe(true);
    await import('node:fs/promises').then((fs) => fs.rm(settings.metrics.dir, { recursive: true, force: true }));
  }, 30_000);

  test('a refused startup leaves foreign orders and another session\'s auto-cancel deadline untouched', async () => {
    exchange.orders.clear(); exchange.writes.length = 0;
    const foreignDeadline = Date.now() + 45_000;
    exchange.autoCancel = foreignDeadline;
    const manual = 'd'.repeat(32);
    exchange.orders.set(manual, { oid: 999, iid: 45, buy: true, p: '190', qty: '1', rest: '1', fill: '0', status: 'open', coid: manual, tif: 'gtc', po: true });
    const { settings } = parseSettings(Bun.YAML.parse(await Bun.file(new URL('../config/example.yaml', import.meta.url)).text()));
    settings.mode = 'live'; settings.egress.allowDirect = true; settings.risk.startupCancelAll = false;
    settings.metrics.dir = `${import.meta.dir}/.tmp-metrics-2`;
    const log = silentLog();
    const egress = new EgressPool({ proxies: [], allowDirect: true, timeoutMs: 2_000, log });
    const rest = new RestClient(egress, log, base);
    const clock = new Clock(rest);
    await clock.sync();
    const credentials: Credentials = { auth: { proxy: signer.address, secret: 'mock-secret' }, signer, expiresAt: Date.now() + 86_400_000 * 2, owner: null, origin: 'environment' };
    const bot = new QuoterBot({ settings, instrument: parseInstrument(PLTR_ROW, base, Date.now()), egress, rest, clock, log, credentials, stopFile: `${import.meta.dir}/.no-stop-file`, wsUrl: `ws://127.0.0.1:${server.port}/v1/ws` });
    await expect(bot.start()).rejects.toThrow('not owned by this process');
    await bot.stop('startup failure');
    expect(exchange.writes).toHaveLength(0);              // no cancelAll, no autoCancel
    expect(exchange.orders.get(manual)!.status).toBe('open');
    expect(exchange.autoCancel).toBe(foreignDeadline);
    await import('node:fs/promises').then((fs) => fs.rm(settings.metrics.dir, { recursive: true, force: true }));
  }, 30_000);
});
