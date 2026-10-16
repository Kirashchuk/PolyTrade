import { expect, test } from 'bun:test';
import { recoverTypedDataAddress, type EIP1193Provider, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Book, Market } from '../src/shared/contracts';
import { createLiveSession, operationTypedData, type SignedOperation } from '../src/trading/live';
import { createLiveBotManager } from '../src/trading/live-bots';

test('real signer and live TWAP reconcile partial IOC fills without retrying unfilled slices', async () => {
  let now = 1_800_000_000_000, deadline = 0, proxyAddress = '', nextId = 1;
  const owner = privateKeyToAccount(('0x' + '31'.repeat(32)) as Hex);
  const provider = { request: async ({ method, params }: { method: string; params?: unknown }) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [owner.address];
    if (method === 'eth_chainId') return '0x89';
    if (method === 'eth_signTypedData_v4') {
      const typed = JSON.parse((params as [string, string])[1]); delete typed.types.EIP712Domain;
      return owner.signTypedData(typed);
    }
    throw new Error(`Unexpected wallet request ${method}`);
  } } as unknown as EIP1193Provider;
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const events: string[] = [], signed: SignedOperation[] = [], history: Record<string, unknown>[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').searchParams.get('path')!;
    const url = new URL(path, 'https://api.perpetuals.polymarket.com');
    if (url.pathname === '/v1/info/registered') return Response.json({ registered: true });
    if (url.pathname === '/v1/account/proxy') { proxyAddress = JSON.parse(String(init?.body)).op.args.proxy; return Response.json({ secret: 'test-only-proxy-secret' }); }
    if (url.pathname === '/v1/account/portfolio') return Response.json({ positions: [], margin: { available_order_margin: '10000' }, in_liquidation: false, timestamp: now });
    if (url.pathname === '/v1/account/config') return Response.json([{ instrument_id: 1, leverage: 2, cross: false }]);
    if (url.pathname === '/v1/account/open-orders') return Response.json([]);
    if (url.pathname === '/v1/account/auto-cancel') { events.push('deadline-read'); return Response.json({ deadline, triggered: 0, daily_limit: 1000, next_reset: now + 86_400_000 }); }
    if (url.pathname === '/v1/account/orders') {
      events.push('order-read');
      return Response.json(history.filter(row => url.searchParams.has('order_id') ? row.order_id === Number(url.searchParams.get('order_id')) : row.client_order_id === url.searchParams.get('client_order_id')));
    }
    if (url.pathname === '/v1/trade/auto-cancel' || url.pathname === '/v1/trade/orders') {
      const request = JSON.parse(String(init?.body)) as SignedOperation;
      expect(await recoverTypedDataAddress({ ...operationTypedData(request.op, request.salt, request.ts), signature: request.sig })).toBe(proxyAddress as Hex);
      signed.push(request);
      if (request.op.type === 'autoCancel') { deadline = request.op.args.time; events.push(deadline ? 'arm' : 'disarm'); return Response.json({ status: 'ok', deadline }); }
      if (request.op.type === 'createOrders') {
        events.push('order-write');
        expect(deadline).toBeGreaterThan(now);
        const wire = request.op.args[0]!;
        const orderId = nextId++;
        history.push({ order_id: orderId, client_order_id: wire.c, instrument_id: wire.iid, buy: wire.buy, ro: wire.ro, price: wire.p, quantity: wire.qty, filled_quantity: '0.5', resting_quantity: '0', status: 'ioc_expired', created_timestamp: now, updated_timestamp: now });
        return Response.json([{ status: 'ok', oid: orderId }]);
      }
    }
    throw new Error(`Unexpected mocked request ${path}`);
  }) as typeof fetch;
  const lock = async <T>(operation: () => Promise<T>) => operation();
  const session = createLiveSession({ provider, token: 'test-control', now: () => now, storage, fetcher, withLock: lock });
  await session.connect(); await session.authorize();
  const market: Market = { id: 1, symbol: 'TEST-PERP', displaySymbol: 'TEST', baseAsset: 'TEST', quoteAsset: 'pUSD', category: 'crypto', priceDecimals: 2, quantityDecimals: 3, priceBounds: '0.2', minNotional: '1', maxMarketNotional: '100000', maxLimitNotional: '100000', maxOrderCount: 200, maxLeverage: 10, riskTiers: [{ lowerBound: '0', maxLeverage: 10 }], closeOnly: false, isolatedOnly: false, settled: false, fundingIntervalHours: 1, markPrice: 100, indexPrice: 100, lastPrice: 100, openInterest: null, openInterestUsd: null, volume24h: null, change24h: null, fundingRate: null, fundingApr: null, nextFunding: null, timestamp: now, sparkline: [] };
  const book: Book = { instrumentId: 1, bids: [{ price: '99', quantity: '10' }], asks: [{ price: '100', quantity: '10' }], timestamp: now, sequence: 1 };
  const bot = createLiveBotManager({ session, storage, now: () => now, load: async () => ({ market: { ...market, timestamp: now }, book: { ...book, timestamp: now } }) });
  await bot.start({ instrumentId: 1, strategy: 'twap', side: 'buy', totalQuantity: '2', slices: 2, intervalSeconds: 5, spreadBps: 20, leverage: 2, slippageBps: 25, maxDurationSeconds: 60 }, true);
  expect(session.status().botControlled).toBe(true);
  await bot.tick(); now += 5000; await bot.tick(); now += 5000; await bot.tick();
  expect(bot.state()?.status).toBe('completed');
  expect(bot.state()?.filledQuantity).toBe('1');
  expect(bot.state()?.scheduledQuantity).toBe('2');
  const creates = signed.filter(row => row.op.type === 'createOrders');
  expect(creates).toHaveLength(2);
  for (const row of creates) if (row.op.type === 'createOrders') { expect(row.op.args[0]!.tif).toBe('ioc'); expect(row.op.args[0]!.qty).toBe('1'); expect(row.op.args[0]!.p).toBe('100.25'); }
  expect(events.indexOf('deadline-read')).toBeLessThan(events.indexOf('order-write'));
  expect(events.at(-1)).toBe('deadline-read');
  expect(deadline).toBe(0);
  expect(session.status().pending).toBeNull();
  expect(session.status().botControlled).toBe(false);
  expect(JSON.stringify([...values.values()])).not.toContain('test-only-proxy-secret');
});
