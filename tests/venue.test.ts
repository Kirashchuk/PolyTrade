import { describe, expect, test } from 'bun:test';
import { VenueClient } from '../src/server/venue.ts';

const NOW = 1_792_053_933_071;
const instrument = (id = 1) => ({
  instrument_id: id, instrument_type: 'perpetual', category: id === 1 ? 'index' : 'crypto',
  isolated_only: false, close_only: false, symbol: id === 1 ? 'SP500-USD' : 'BTC-USD',
  display_symbol: id === 1 ? 'USA500-USD' : 'BTC-USD', base_asset: id === 1 ? 'SP500' : 'BTC', quote_asset: 'pUSD',
  funding_interval: '1h', quantity_decimals: 5, price_decimals: 1, price_bounds: '0.02',
  min_notional: '10', max_market_notional: '1000000', max_limit_notional: '5000000',
  max_leverage: 50, max_order_count: 200, risk_tiers: [{ lower_bound: '0', max_leverage: 50 }],
});
const ticker = (id = 1) => ({ instrument_id: id, symbol: 'SP500-USD', index_price: '99', mark_price: '100', last_price: '110',
  open_interest: '2.5', funding_rate: '-0.0001', next_funding: NOW + 100_000, timestamp: NOW });
const statistic = (id = 1) => ({ instrument_id: id, symbol: 'SP500-USD', volume: '1234.56', open_price: '100',
  klines: [[NOW - 3_600_000, '100', '112', '99', '110', '2.5', 7]] });
type Route = (url: URL) => unknown | Response | Promise<unknown | Response>;
function fake(routes: Record<string, unknown | Route>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe('GET');
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    calls.push(url.pathname + url.search);
    const route = routes[url.pathname];
    if (route === undefined) throw new Error(`Unexpected endpoint ${url.pathname}`);
    const value = typeof route === 'function' ? await route(url) : route;
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
}
function marketRoutes(extra: Record<string, unknown | Route> = {}) {
  return {
    '/v1/info/instruments': [instrument()], '/v1/info/tickers': [ticker()], '/v1/info/statistics': [statistic()],
    '/v1/info/exchange': { cancel_only: false, version: '1.0.0' },
    '/v1/info/exchange-stats': (url: URL) => ({ start_timestamp: Number(url.searchParams.get('start_timestamp')), end_timestamp: Number(url.searchParams.get('end_timestamp')), fees: '12.34' }),
    ...extra,
  };
}

describe('official Polymarket metric normalization', () => {
  test('quote notional is not multiplied again; base OI is converted at mark; rates remain fractions', async () => {
    const client = new VenueClient({ fetch: fake(marketRoutes()), now: () => NOW });
    const result = await client.markets();
    expect(result.status).toBe('live');
    const market = result.data![0]!;
    expect(market.volume24h).toBe(1234.56);
    expect(market.openInterest).toBe(2.5);
    expect(market.openInterestUsd).toBe(250);
    expect(market.change24h).toBeCloseTo(0.1);
    expect(market.fundingRate).toBe(-0.0001);
    expect(market.fundingApr).toBeCloseTo(-0.876);
    expect(market.displaySymbol).toBe('USA500-USD');
    expect(market.sparkline).toEqual([110]);
    expect(market.minNotional).toBe('10');
    expect(market.maxOrderCount).toBe(200);
    expect(market.riskTiers).toEqual([{ lowerBound: '0', maxLeverage: 50 }]);
    expect(result.lastSuccessAt).toBe(NOW);
  });

  test('missing statistics and missing OI remain null and coverage is explicit', async () => {
    const client = new VenueClient({ fetch: fake(marketRoutes({
      '/v1/info/instruments': [instrument(), instrument(2)],
      '/v1/info/tickers': [ticker(), { ...ticker(2), mark_price: null, open_interest: null }],
    })), now: () => NOW });
    const markets = await client.markets();
    expect(markets.data![1]!.volume24h).toBeNull();
    expect(markets.data![1]!.change24h).toBeNull();
    expect(markets.data![1]!.openInterestUsd).toBeNull();
    const overview = await client.overview();
    expect(overview.data!.volume24h).toBe(1234.56);
    expect(overview.data!.openInterestUsd).toBe(250);
    expect(overview.data!.volumeCoverage).toBe(1);
    expect(overview.data!.oiCoverage).toBe(1);
    expect(overview.data!.fees24h).toBe(12.34);
    expect(overview.data!.categories).toEqual([{ name: 'index', volume: 1234.56, markets: 1 }]);
    expect(overview.error).toContain('partial subtotal');
  });

  test('optional statistics failure retains usable live tickers without fabricating volume', async () => {
    const client = new VenueClient({ fetch: fake(marketRoutes({ '/v1/info/statistics': () => new Response('unavailable', { status: 500 }) })), now: () => NOW, sleep: async () => {} });
    const result = await client.markets();
    expect(result.status).toBe('live');
    expect(result.data![0]!.markPrice).toBe(100);
    expect(result.data![0]!.volume24h).toBeNull();
    expect(result.error).toContain('500');
    expect(result.error).toContain('0/1');
  });

  test('malformed metrics fail, and unsupported funding intervals have no made-up APR', async () => {
    const malformed = new VenueClient({ fetch: fake(marketRoutes({ '/v1/info/tickers': [{ ...ticker(), mark_price: 'not-a-price' }] })), now: () => NOW });
    expect((await malformed.markets()).status).toBe('unavailable');
    const unsupported = new VenueClient({ fetch: fake(marketRoutes({ '/v1/info/instruments': [{ ...instrument(), funding_interval: 'unknown' }] })), now: () => NOW });
    expect((await unsupported.markets()).data![0]!.fundingApr).toBeNull();
  });

  test('zero reported volume is distinct from absent volume; zero rolling opening price has no change', async () => {
    const client = new VenueClient({ fetch: fake(marketRoutes({ '/v1/info/statistics': [{ ...statistic(), volume: '0', open_price: '0', klines: [] }] })), now: () => NOW });
    const result = await client.markets();
    expect(result.data![0]!.volume24h).toBe(0);
    expect(result.data![0]!.change24h).toBeNull();
  });

  test('missing instrument order cap fails metadata validation instead of inventing a default', async () => {
    const missing: Record<string, unknown> = { ...instrument() };
    delete missing.max_order_count;
    const client = new VenueClient({ fetch: fake(marketRoutes({ '/v1/info/instruments': [missing] })), now: () => NOW });
    const result = await client.markets();
    expect(result.status).toBe('unavailable');
    expect(result.error).toContain('max_order_count');
  });
});

describe('official tuple and history shapes', () => {
  test('book preserves exact decimal strings and source time, sorts sides, and empty book is explicit', async () => {
    const routes = { '/v1/info/book': { instrument_id: 1, bids: [['98.00', '1.00000001'], ['99.0', '2']], asks: [['101', '3'], ['100.10', '0.005']], timestamp: NOW - 500, sequence: 72_798_927_998 } };
    const client = new VenueClient({ fetch: fake(routes), now: () => NOW });
    const result = await client.book(1);
    expect(result.status).toBe('live');
    expect(result.lastSuccessAt).toBe(NOW - 500);
    expect(result.data!.bids[0]).toEqual({ price: '99.0', quantity: '2' });
    expect(result.data!.asks[0]).toEqual({ price: '100.10', quantity: '0.005' });
    expect(result.data!.bids[1]!.quantity).toBe('1.00000001');
    const empty = new VenueClient({ fetch: fake({ '/v1/info/book': { instrument_id: 1, bids: [], asks: [], timestamp: NOW, sequence: 1 } }), now: () => NOW });
    expect((await empty.book(1)).data!.bids).toEqual([]);
  });

  test('malformed/crossed book cannot become a valid execution book', async () => {
    for (const bids of [[['101', '1']], [['99', 'garbage']], [['99', '1', 'extra']]]) {
      const client = new VenueClient({ fetch: fake({ '/v1/info/book': { instrument_id: 1, bids, asks: [['100', '1']], timestamp: NOW, sequence: 1 } }), now: () => NOW });
      expect((await client.book(1)).status).toBe('unavailable');
    }
  });

  test('candle OHLC and base volume use all seven tuple fields, funding preserves negative values', async () => {
    const client = new VenueClient({ fetch: fake({
      '/v1/info/klines': { data: statistic().klines, more: true },
      '/v1/info/funding': { data: [{ funding_rate: '-0.0000125', timestamp: NOW }], more: false },
      '/v1/info/trades': { data: [{ trade_id: 8_591_207_242_945_735, instrument_id: 1, side: 'short', price: '110', quantity: '0.005', timestamp: NOW }], more: true },
    }), now: () => NOW });
    const candles = await client.candles(1);
    expect(candles.data).toEqual([{ timestamp: NOW - 3_600_000, open: 100, high: 112, low: 99, close: 110, volume: 2.5, trades: 7 }]);
    expect(candles.error).toContain('truncated');
    expect((await client.funding(1)).data![0]!.rate).toBe(-0.0000125);
    expect((await client.trades(1)).data![0]).toEqual({ id: '8591207242945735', instrumentId: 1, side: 'short', price: 110, quantity: 0.005, timestamp: NOW });
  });

  test('leaderboard uses calendar window and source time; ROI is a fraction', async () => {
    const client = new VenueClient({ fetch: fake({ '/v1/info/leaderboard': {
      window: 'week', sort_by: 'roi', timestamp: NOW - 5_000, total: 4_000,
      entries: [{ rank: 1, account: '0x123', pnl: '-1.5', notional: '500', account_value: '100', roi: '-0.015' }],
    } }), now: () => NOW });
    const result = await client.leaderboard('week', 'roi');
    expect(result.data!.entries[0]!.pnl).toBe(-1.5);
    expect(result.data!.entries[0]!.roi).toBe(-0.015);
    expect(result.data!.total).toBe(4000);
    expect(result.lastSuccessAt).toBe(NOW - 5_000);
    expect(result.error).toContain('calendar UTC');
  });
});

describe('read cache and failure behavior', () => {
  test('concurrent identical reads coalesce, retain stale snapshots and do not refresh source timestamps', async () => {
    let clock = NOW, fail = false;
    const calls: string[] = [];
    const client = new VenueClient({ fetch: fake({ '/v1/info/book': () => fail ? new Response('', { status: 500 }) : { instrument_id: 1, bids: [['99', '1']], asks: [['100', '1']], timestamp: NOW - 500, sequence: 1 } }, calls), now: () => clock, sleep: async () => {} });
    const first = await Promise.all([client.book(1), client.book(1), client.book(1)]);
    expect(calls).toHaveLength(1);
    expect(first[0]).toBe(first[1]);
    clock += 2_000; fail = true;
    const stale = await client.book(1);
    expect(stale.status).toBe('stale');
    expect(stale.receivedAt).toBe(first[0]!.receivedAt);
    expect(stale.lastSuccessAt).toBe(NOW - 500);
    expect(stale.data).toEqual(first[0]!.data);
    expect(calls).toHaveLength(3); // Initial GET + two bounded refresh attempts.
    await client.book(1);
    expect(calls).toHaveLength(3); // Failed refresh also has a cooldown.
  });

  test('429 backs off the entire client, does not immediately retry and honors Retry-After', async () => {
    let clock = NOW;
    const calls: string[] = [];
    const client = new VenueClient({ fetch: fake({
      '/v1/info/book': () => new Response('', { status: 429, headers: { 'retry-after': '10' } }),
      '/v1/info/exchange': { cancel_only: false, version: '1' },
    }, calls), now: () => clock, sleep: async () => {} });
    expect((await client.book(1)).status).toBe('unavailable');
    expect((await client.exchange()).status).toBe('unavailable');
    expect(calls).toHaveLength(1);
    clock += 11_000;
    expect((await client.exchange()).status).toBe('live');
    expect(calls).toHaveLength(2);
  });

  test('old and far-future source book observations are stale even after a successful HTTP response', async () => {
    for (const sourceTime of [NOW - 60_000, NOW + 60_000]) {
      const client = new VenueClient({ fetch: fake({ '/v1/info/book': { instrument_id: 1, bids: [], asks: [], timestamp: sourceTime, sequence: 1 } }), now: () => NOW });
      const result = await client.book(1);
      expect(result.status).toBe('stale');
      expect(result.lastSuccessAt).toBe(sourceTime);
      expect(result.error).toContain('freshness');
    }
  });

  test('source freshness expires on a cache hit without changing successful observation times', async () => {
    let clock = NOW;
    const calls: string[] = [];
    const client = new VenueClient({ fetch: fake({ '/v1/info/book': { instrument_id: 1, bids: [], asks: [], timestamp: NOW - 14_500, sequence: 1 } }, calls), now: () => clock });
    const fresh = await client.book(1);
    expect(fresh.status).toBe('live');
    clock += 600;
    const stale = await client.book(1);
    expect(stale.status).toBe('stale');
    expect(stale.lastSuccessAt).toBe(NOW - 14_500);
    expect(stale.receivedAt).toBe(NOW);
    expect(calls).toHaveLength(1);
  });

  test('invalid query parameters do not issue upstream reads', async () => {
    const calls: string[] = [];
    const client = new VenueClient({ fetch: fake({}, calls), now: () => NOW });
    expect((await client.book(-1)).status).toBe('unavailable');
    expect((await client.candles(1, '2years')).status).toBe('unavailable');
    expect((await client.leaderboard('rolling24h')).status).toBe('unavailable');
    expect(calls).toHaveLength(0);
  });
});
