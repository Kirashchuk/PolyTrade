import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EIP1193Provider, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Market, Snapshot } from '../src/shared/contracts';

// Browser globals for the shared client live state: one wallet extension, one origin, locks and storage.
const ORIGIN = 'http://127.0.0.1:4310';
const wallets = { a: privateKeyToAccount(('0x' + '11'.repeat(32)) as Hex), b: privateKeyToAccount(('0x' + '33'.repeat(32)) as Hex) };
const accountValue: Record<string, string> = { [wallets.a.address]: '1111', [wallets.b.address]: '2222' };
const server = { token: 'token-before-restart', marketStatus: 'live' as Snapshot<Market[]>['status'], gate: null as Promise<void> | null, gatedReads: 0 };
let wallet = wallets.a;
const proxies = new Map<string, string>();
const provider = { request: async ({ method, params }: { method: string; params?: unknown }) => {
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address];
  if (method === 'eth_chainId') return '0x89';
  if (method === 'eth_signTypedData_v4') { const typed = JSON.parse((params as [string, string])[1]); delete typed.types.EIP712Domain; return wallet.signTypedData(typed); }
  throw new Error(`Unexpected wallet request ${method}`);
} } as unknown as EIP1193Provider;
const market = (): Market => ({ id: 1, symbol: 'TEST-USD', displaySymbol: 'TEST', baseAsset: 'TEST', quoteAsset: 'pUSD', category: 'crypto', priceDecimals: 2, quantityDecimals: 3, priceBounds: '0.2', minNotional: '1', maxMarketNotional: '100000', maxLimitNotional: '100000', maxOrderCount: 200, maxLeverage: 10, riskTiers: [{ lowerBound: '0', maxLeverage: 10 }], closeOnly: false, isolatedOnly: false, settled: false, fundingIntervalHours: 1, markPrice: 100, indexPrice: 100, lastPrice: 100, openInterest: null, openInterestUsd: null, volume24h: null, change24h: null, fundingRate: null, fundingApr: null, nextFunding: null, timestamp: Date.now(), sparkline: [] });
const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), ORIGIN), headers = new Headers(init?.headers);
  if (url.pathname === '/api/session') return Response.json({ token: server.token, liveEnabled: true, liveOrigin: ORIGIN });
  if (url.pathname === '/api/markets') return Response.json({ status: server.marketStatus, data: [market()], source: 'test', receivedAt: Date.now(), lastSuccessAt: Date.now(), error: null });
  if (url.pathname !== '/api/live') throw new Error(`Unexpected local request ${url.pathname}`);
  if (headers.get('x-polytrade-token') !== server.token) return Response.json({ error: 'A local control session is required' }, { status: 401 });
  const path = url.searchParams.get('path')!, owner = proxies.get(headers.get('polymarket-proxy') ?? '');
  if (path.startsWith('/v1/info/registered')) return Response.json({ registered: true });
  if (path === '/v1/account/proxy') { const op = JSON.parse(String(init?.body)).op.args; proxies.set(op.proxy, op.owner); return Response.json({ secret: 'memory-only-secret' }); }
  if (path === '/v1/account/portfolio') {
    if (server.gate && owner === wallets.a.address) { server.gatedReads++; await server.gate; }
    return Response.json({ positions: [], margin: { total_account_value: accountValue[owner!] }, in_liquidation: false, timestamp: Date.now() });
  }
  if (path === '/v1/account/open-orders' || path === '/v1/account/config') return Response.json([]);
  throw new Error(`Unexpected relay path ${path}`);
}) as typeof fetch;

const saved = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) { if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); }
beforeAll(() => {
  const values = new Map<string, string>(), held = new Set<string>();
  const locks = { request: async (name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => {
    if (held.has(name)) return callback(null);
    held.add(name); try { return await callback({ name }); } finally { held.delete(name); }
  } };
  install('window', { ethereum: provider });
  install('location', { origin: ORIGIN });
  install('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  install('navigator', { ...globalThis.navigator, locks });
  install('fetch', fetcher);
});
afterAll(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name]; } });
const until = async (condition: () => boolean) => { for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); expect(condition()).toBe(true); };

describe('shared browser live state', () => {
  test('a delayed private read for the previous wallet is discarded after a wallet change', async () => {
    const live = await import('../src/client/live-state');
    await live.connectLive(); await live.getLiveSession()!.authorize(60);
    let release!: () => void; server.gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = live.loadLiveAccount();
    await until(() => server.gatedReads === 1);
    await live.disconnectLive(); wallet = wallets.b; await live.connectLive(); await live.getLiveSession()!.authorize(60);
    server.gate = null; await live.loadLiveAccount();
    expect(live.liveMargin().total_account_value).toBe('2222');
    release(); await expect(previous).rejects.toThrow('wallet changed');
    expect(live.liveMargin().total_account_value).toBe('2222');expect(live.liveAccountError()).toBeNull();
  });

  test('reconnecting after a local service restart uses the new control token', async () => {
    const live = await import('../src/client/live-state');
    server.token = 'token-after-restart';
    await live.disconnectLive(); await live.connectLive();
    expect((await live.getLiveSession()!.authorize(60)).authorized).toBe(true);
  });

  test('manual execution accepts only a live official market snapshot', async () => {
    const live = await import('../src/client/live-state');
    server.marketStatus = 'stale';
    await expect(live.liveMarket(1)).rejects.toThrow('Fresh official market');
    server.marketStatus = 'live';
    expect((await live.liveMarket(1)).id).toBe(1);
    await expect(live.liveMarket(2)).rejects.toThrow('Fresh official market');
  });

  test('live trading refuses a page opened at another loopback origin', async () => {
    const live = await import('../src/client/live-state');
    install('location', { origin: 'http://localhost:4310' });
    await expect(live.connectLive()).rejects.toThrow(ORIGIN);
  });
});
