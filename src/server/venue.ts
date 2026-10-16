import {
  VENUE_REST, type Book, type BookLevel, type Candle, type FundingPoint, type Leaderboard,
  type Market, type Overview, type Snapshot, type Trade,
} from '../shared/contracts.ts';
import { SnapshotCache, unavailable, type CacheValue } from './cache.ts';

type Row = Record<string, unknown>;
export interface VenueOptions {
  fetch?: typeof fetch;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** GETs only, capped at two attempts. Financial writes do not exist in this client. */
  readAttempts?: number;
}
interface Ticker {
  instrumentId: number; timestamp: number; markPrice: number | null; indexPrice: number | null;
  lastPrice: number | null; openInterest: number | null; fundingRate: number | null; nextFunding: number | null;
}
interface Statistics { instrumentId: number; volume: number | null; openPrice: number | null; candles: Candle[]; }

const INTERVAL_MS: Record<string, number> = {
  '1s': 1_000, '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '6h': 21_600_000, '12h': 43_200_000, '1d': 86_400_000, '1w': 604_800_000,
};
const WINDOWS = new Set(['day', 'week', 'month', 'all']);
const SORTS = new Set(['pnl', 'notional', 'account_value', 'roi']);
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const SOURCE = (path: string) => VENUE_REST + path;
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

function object(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Malformed ${label}: expected object.`);
  return value as Row;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Malformed ${label}: expected array.`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Malformed ${label}: expected nonempty string.`);
  return value;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Malformed ${label}: expected boolean.`);
  return value;
}
function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Malformed ${label}: expected safe integer.`);
  return value;
}
/** Missing metrics remain null; a present but corrupt value fails normalization. */
function metric(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if ((typeof value !== 'string' || !DECIMAL.test(value)) && typeof value !== 'number') throw new Error(`Malformed ${label}: expected numeric value.`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Malformed ${label}: nonfinite value.`);
  return number;
}
function requiredMetric(value: unknown, label: string): number {
  const number = metric(value, label);
  if (number === null) throw new Error(`Malformed ${label}: numeric value is missing.`);
  return number;
}
function nonnegative(value: unknown, label: string): number | null {
  const number = metric(value, label);
  if (number !== null && number < 0) throw new Error(`Malformed ${label}: negative value.`);
  return number;
}
function decimal(value: unknown, label: string, strictlyPositive = false): string {
  const exact = text(value, label);
  if (!DECIMAL.test(exact) || !Number.isFinite(Number(exact)) || Number(exact) < 0 || (strictlyPositive && Number(exact) <= 0)) throw new Error(`Malformed ${label}: expected ${strictlyPositive ? 'positive' : 'nonnegative'} decimal string.`);
  return exact;
}
function timestamp(value: unknown, label: string): number { return integer(value, label, 1); }
function nullableTimestamp(value: unknown, label: string): number | null { return value == null ? null : timestamp(value, label); }
function instrumentId(value: unknown): number { return integer(value, 'instrument_id', 0, 4_294_967_295); }
function minimumTime(times: (number | null | undefined)[]): number | null {
  const valid = times.filter((time): time is number => typeof time === 'number' && Number.isFinite(time));
  return valid.length ? Math.min(...valid) : null;
}
function partialSum(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null;
}
function fundingHours(value: unknown): number | null {
  const interval = text(value, 'funding_interval');
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(interval);
  if (!match) return null;
  const hours = Number(match[1]) * ({ s: 1 / 3600, m: 1 / 60, h: 1, d: 24 }[match[2]!] ?? 0);
  return hours > 0 ? hours : null;
}
function candle(value: unknown): Candle {
  const row = array(value, 'candle tuple');
  if (row.length !== 7) throw new Error('Malformed candle: expected seven tuple fields.');
  const result: Candle = {
    timestamp: timestamp(row[0], 'candle timestamp'), open: requiredMetric(row[1], 'candle open'),
    high: requiredMetric(row[2], 'candle high'), low: requiredMetric(row[3], 'candle low'), close: requiredMetric(row[4], 'candle close'),
    volume: requiredMetric(row[5], 'candle base volume'), trades: integer(row[6], 'candle trades'),
  };
  if ([result.open, result.high, result.low, result.close].some((price) => price <= 0)
    || result.volume < 0 || result.high < Math.max(result.open, result.close, result.low) || result.low > Math.min(result.open, result.close)) throw new Error('Malformed candle: invalid OHLC or volume.');
  return result;
}
function tickers(value: unknown): Ticker[] {
  return array(value, 'tickers').map((value) => {
    const row = object(value, 'ticker');
    return {
      instrumentId: instrumentId(row.instrument_id), timestamp: timestamp(row.timestamp, 'ticker timestamp'),
      markPrice: nonnegative(row.mark_price, 'mark_price'), indexPrice: nonnegative(row.index_price, 'index_price'),
      lastPrice: nonnegative(row.last_price, 'last_price'), openInterest: nonnegative(row.open_interest, 'open_interest'),
      fundingRate: metric(row.funding_rate, 'funding_rate'), nextFunding: nullableTimestamp(row.next_funding, 'next_funding'),
    };
  });
}
function statistics(value: unknown): Statistics[] {
  return array(value, 'statistics').map((value) => {
    const row = object(value, 'statistics row');
    return { instrumentId: instrumentId(row.instrument_id), volume: nonnegative(row.volume, '24h quote volume'), openPrice: nonnegative(row.open_price, 'open_price'), candles: row.klines == null ? [] : array(row.klines, 'statistics klines').map(candle) };
  });
}

/** Read-only official Polymarket Perps adapter. It cannot submit any trade or account mutation. */
export class VenueClient {
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache: SnapshotCache;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private backoffUntil = 0;

  constructor(options: VenueOptions = {}) {
    this.doFetch = options.fetch ?? options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.attempts = Math.max(1, Math.min(2, options.readAttempts ?? 2));
    this.cache = new SnapshotCache(this.now);
  }

  private async read(path: string): Promise<unknown> {
    if (this.now() < this.backoffUntil) throw new Error(`Polymarket read backoff until ${new Date(this.backoffUntil).toISOString()}.`);
    let lastError: unknown = new Error('Read failed.');
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      try {
        const response = await this.doFetch(SOURCE(path), { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
        if (response.status === 429 || response.status === 503) {
          const header = response.headers.get('retry-after');
          const seconds = header === null ? NaN : Number(header);
          const requested = Number.isFinite(seconds) ? seconds * 1_000 : header ? Date.parse(header) - this.now() : NaN;
          this.backoffUntil = this.now() + Math.min(300_000, Math.max(2_000, Number.isFinite(requested) ? requested : 5_000));
          throw new Error(`Polymarket HTTP ${response.status}; reads paused until ${new Date(this.backoffUntil).toISOString()}.`);
        }
        if (!response.ok) {
          const error = new Error(`Polymarket HTTP ${response.status} at ${path.split('?')[0]}.`);
          if (response.status < 500) throw Object.assign(error, { permanent: true });
          throw error;
        }
        try { return await response.json(); }
        catch { throw Object.assign(new Error(`Malformed JSON at ${path.split('?')[0]}.`), { permanent: true }); }
      } catch (error) {
        lastError = error;
        if (this.now() < this.backoffUntil || (error as { permanent?: boolean }).permanent || attempt + 1 >= this.attempts) break;
        await this.sleep(200 * (attempt + 1));
      }
    }
    throw lastError;
  }

  private cached<T>(key: string, ttlMs: number, path: string, load: () => Promise<CacheValue<T>>, maxAgeMs?: number): Promise<Snapshot<T>> {
    return this.cache.get(key, ttlMs, SOURCE(path), load, maxAgeMs);
  }
  private invalid<T>(path: string, error: string): Promise<Snapshot<T>> { return Promise.resolve(unavailable<T>(SOURCE(path), this.now(), error)); }
  private validId(id: number): boolean { return Number.isSafeInteger(id) && id >= 0 && id <= 4_294_967_295; }

  markets(): Promise<Snapshot<Market[]>> {
    const path = '/v1/info/instruments + /v1/info/tickers + /v1/info/statistics';
    return this.cached('markets', 3_000, path, async () => {
      const [instruments, tickerSnapshot, statsSnapshot] = await Promise.all([
        this.cached('instruments', 60_000, '/v1/info/instruments', async () => ({ data: array(await this.read('/v1/info/instruments'), 'instruments') })),
        this.cached('tickers', 3_000, '/v1/info/tickers', async () => {
          const data = tickers(await this.read('/v1/info/tickers'));
          return { data, observedAt: minimumTime(data.map((row) => row.timestamp)) };
        }, 15_000),
        this.cached('statistics', 15_000, '/v1/info/statistics', async () => ({ data: statistics(await this.read('/v1/info/statistics')) })),
      ]);
      if (!instruments.data) throw new Error(instruments.error ?? 'Instrument metadata unavailable.');
      if (!tickerSnapshot.data) throw new Error(tickerSnapshot.error ?? 'Tickers unavailable.');
      const byTicker = new Map(tickerSnapshot.data.map((row) => [row.instrumentId, row]));
      const byStats = new Map((statsSnapshot.data ?? []).map((row) => [row.instrumentId, row]));
      const data = instruments.data.map((value): Market => {
        const row = object(value, 'instrument');
        const id = instrumentId(row.instrument_id), ticker = byTicker.get(id), stats = byStats.get(id);
        const hours = fundingHours(row.funding_interval);
        const mark = ticker?.markPrice ?? null, interest = ticker?.openInterest ?? null;
        const last = ticker?.lastPrice ?? null, opening = stats?.openPrice ?? null;
        const rates = array(row.risk_tiers, 'risk_tiers').map((value) => {
          const tier = object(value, 'risk tier');
          return { lowerBound: decimal(tier.lower_bound, 'risk lower_bound'), maxLeverage: integer(tier.max_leverage, 'risk max_leverage', 1) };
        });
        return {
          id, symbol: text(row.symbol, 'symbol'), displaySymbol: row.display_symbol == null ? text(row.symbol, 'symbol') : text(row.display_symbol, 'display_symbol'),
          baseAsset: text(row.base_asset, 'base_asset'), quoteAsset: text(row.quote_asset, 'quote_asset'), category: text(row.category, 'category'),
          priceDecimals: integer(row.price_decimals, 'price_decimals', 0, 30), quantityDecimals: integer(row.quantity_decimals, 'quantity_decimals', 0, 30),
          priceBounds: decimal(row.price_bounds, 'price_bounds'), minNotional: decimal(row.min_notional, 'min_notional'),
          maxMarketNotional: decimal(row.max_market_notional, 'max_market_notional', true), maxLimitNotional: decimal(row.max_limit_notional, 'max_limit_notional', true),
          maxLeverage: integer(row.max_leverage, 'max_leverage', 1), maxOrderCount: integer(row.max_order_count, 'max_order_count', 1), riskTiers: rates,
          closeOnly: bool(row.close_only, 'close_only'), isolatedOnly: bool(row.isolated_only, 'isolated_only'), settled: row.settlement != null,
          fundingIntervalHours: hours, markPrice: mark, indexPrice: ticker?.indexPrice ?? null, lastPrice: last, openInterest: interest,
          openInterestUsd: mark !== null && mark > 0 && interest !== null ? mark * interest : null,
          volume24h: stats?.volume ?? null, change24h: last !== null && opening !== null && opening > 0 ? (last - opening) / opening : null,
          fundingRate: ticker?.fundingRate ?? null,
          fundingApr: ticker?.fundingRate != null && hours !== null ? ticker.fundingRate * 24 * 365 / hours : null,
          nextFunding: ticker?.nextFunding ?? null, timestamp: ticker?.timestamp ?? null,
          sparkline: stats?.candles.map((row) => row.close) ?? [],
        };
      });
      if (new Set(data.map((row) => row.id)).size !== data.length) throw new Error('Malformed instruments: duplicate instrument_id.');
      const missingTickers = data.filter((row) => row.timestamp === null).length;
      const missingStats = data.filter((row) => row.volume24h === null).length;
      const warnings = [instruments.error, tickerSnapshot.error, statsSnapshot.error,
        missingTickers ? `${missingTickers}/${data.length} instruments have no ticker observation.` : null,
        missingStats ? `24h statistics cover ${data.length - missingStats}/${data.length} instruments; missing values are unavailable.` : null,
        data.some((row) => row.fundingIntervalHours === null) ? 'Some funding intervals are unsupported; their APR is unavailable.' : null,
      ].filter(Boolean);
      return { data, observedAt: minimumTime(data.map((row) => row.timestamp)), warning: warnings.join(' ') || null,
        stale: instruments.status === 'stale' || tickerSnapshot.status === 'stale' || statsSnapshot.status === 'stale' };
    }, 15_000);
  }

  overview(): Promise<Snapshot<Overview>> {
    return this.cached('overview', 5_000, '/v1/info/statistics + /v1/info/tickers + /v1/info/exchange-stats + /v1/info/exchange', async () => {
      const [markets, exchange, aggregate] = await Promise.all([
        this.markets(), this.exchange(), this.cached('exchange-stats', 300_000, '/v1/info/exchange-stats', async () => {
          const end = Math.floor(this.now() / 60_000) * 60_000;
          const row = object(await this.read(`/v1/info/exchange-stats?start_timestamp=${end - 86_400_000}&end_timestamp=${end}`), 'exchange statistics');
          return { data: { fees: nonnegative(row.fees, 'gross trading fees'), start: timestamp(row.start_timestamp, 'statistics start'), end: timestamp(row.end_timestamp, 'statistics end') }, observedAt: timestamp(row.end_timestamp, 'statistics end') };
        }),
      ]);
      if (!markets.data) throw new Error(markets.error ?? 'Markets unavailable.');
      const rows = markets.data;
      const categories = [...new Set(rows.map((row) => row.category))].flatMap((name) => {
        const members = rows.filter((row) => row.category === name), volume = partialSum(members.map((row) => row.volume24h));
        // Category contract has no nullable volume: omit an unobserved category rather than invent zero.
        return volume === null ? [] : [{ name, volume, markets: members.length }];
      });
      const volumeCoverage = rows.filter((row) => row.volume24h !== null).length;
      const oiCoverage = rows.filter((row) => row.openInterestUsd !== null).length;
      const warnings = [markets.error, exchange.error, aggregate.error,
        volumeCoverage < rows.length ? `Volume is a partial subtotal (${volumeCoverage}/${rows.length} markets).` : null,
        oiCoverage < rows.length ? `Open interest is a partial subtotal (${oiCoverage}/${rows.length} markets).` : null,
        'OI USD is one-sided base open interest × mark price. Fees are gross positive maker/taker fees, excluding rebates and incentives, for the 24h window ending at the preceding minute.',
      ].filter(Boolean).join(' ');
      return { data: {
        volume24h: partialSum(rows.map((row) => row.volume24h)), openInterestUsd: partialSum(rows.map((row) => row.openInterestUsd)),
        fees24h: aggregate.data?.fees ?? null, markets: rows.length, volumeCoverage, oiCoverage, categories, exchange: exchange.data,
      }, observedAt: markets.lastSuccessAt, warning: warnings,
        stale: markets.status === 'stale' || exchange.status === 'stale' || aggregate.status === 'stale' };
    }, 15_000);
  }

  book(id: number): Promise<Snapshot<Book>> {
    if (!this.validId(id)) return this.invalid('/v1/info/book', 'Invalid instrument ID.');
    const path = `/v1/info/book?instrument_id=${id}&depth=100`;
    return this.cached(`book:${id}`, 1_000, path, async () => {
      const row = object(await this.read(path), 'book');
      if (instrumentId(row.instrument_id) !== id) throw new Error('Book instrument does not match the request.');
      const levels = (value: unknown, side: string): BookLevel[] => array(value, `${side} levels`).map((value) => {
        const tuple = array(value, `${side} tuple`);
        if (tuple.length !== 2) throw new Error(`Malformed ${side} level: expected price and quantity.`);
        return { price: decimal(tuple[0], 'level price', true), quantity: decimal(tuple[1], 'level quantity', true) };
      });
      const bids = levels(row.bids, 'bid').sort((a, b) => Number(b.price) - Number(a.price));
      const asks = levels(row.asks, 'ask').sort((a, b) => Number(a.price) - Number(b.price));
      if (new Set(bids.map((level) => Number(level.price))).size !== bids.length || new Set(asks.map((level) => Number(level.price))).size !== asks.length) throw new Error('Malformed book: duplicate price levels.');
      if (bids.length && asks.length && Number(bids[0]!.price) >= Number(asks[0]!.price)) throw new Error('Malformed book: crossed or locked best prices.');
      const at = timestamp(row.timestamp, 'book timestamp');
      return { data: { instrumentId: id, bids, asks, timestamp: at, sequence: integer(row.sequence, 'book sequence') }, observedAt: at };
    }, 15_000);
  }

  candles(id: number, interval = '1h'): Promise<Snapshot<Candle[]>> {
    if (!this.validId(id) || !INTERVAL_MS[interval]) return this.invalid('/v1/info/klines', 'Invalid instrument ID or candle interval.');
    const path = '/v1/info/klines';
    return this.cached(`candles:${id}:${interval}`, 15_000, `${path}?instrument_id=${id}&interval=${interval}`, async () => {
      const end = this.now(), start = end - INTERVAL_MS[interval]! * 240;
      const row = object(await this.read(`${path}?instrument_id=${id}&interval=${interval}&start_timestamp=${start}&end_timestamp=${end}`), 'klines response');
      const data = array(row.data, 'klines data').map(candle).sort((a, b) => a.timestamp - b.timestamp);
      const more = bool(row.more, 'klines more');
      return { data, warning: more ? 'Historical candles are truncated; more history is available (maximum 1000 rows per request).' : null };
    });
  }

  trades(id: number): Promise<Snapshot<Trade[]>> {
    if (!this.validId(id)) return this.invalid('/v1/info/trades', 'Invalid instrument ID.');
    const path = `/v1/info/trades?instrument_id=${id}`;
    return this.cached(`trades:${id}`, 3_000, path, async () => {
      const row = object(await this.read(path), 'trades response');
      const data = array(row.data, 'trades data').map((value): Trade => {
        const trade = object(value, 'trade');
        const iid = instrumentId(trade.instrument_id);
        if (iid !== id) throw new Error('Trade instrument does not match the request.');
        const side = text(trade.side, 'trade side');
        if (side !== 'long' && side !== 'short') throw new Error('Malformed trade side.');
        const tradeId = typeof trade.trade_id === 'number' ? String(integer(trade.trade_id, 'trade ID')) : text(trade.trade_id, 'trade ID');
        const price = requiredMetric(trade.price, 'trade price'), quantity = requiredMetric(trade.quantity, 'trade quantity');
        if (price <= 0 || quantity <= 0) throw new Error('Malformed trade: price and quantity must be positive.');
        return { id: tradeId, instrumentId: iid, side, price, quantity, timestamp: timestamp(trade.timestamp, 'trade timestamp') };
      });
      const more = bool(row.more, 'trades more');
      return { data, warning: more ? 'Recent trades are limited to the latest 100 entries; this is not complete exchange history.' : null };
    });
  }

  funding(id: number): Promise<Snapshot<FundingPoint[]>> {
    if (!this.validId(id)) return this.invalid('/v1/info/funding', 'Invalid instrument ID.');
    const path = `/v1/info/funding?instrument_id=${id}`;
    return this.cached(`funding:${id}`, 60_000, path, async () => {
      const row = object(await this.read(path), 'funding response');
      const data = array(row.data, 'funding data').map((value): FundingPoint => {
        const point = object(value, 'funding point');
        return { timestamp: timestamp(point.timestamp, 'funding timestamp'), rate: requiredMetric(point.funding_rate, 'funding rate') };
      }).sort((a, b) => a.timestamp - b.timestamp);
      const more = bool(row.more, 'funding more');
      return { data, warning: more ? 'Funding history is limited to the latest 100 entries.' : null };
    });
  }

  leaderboard(window = 'day', sort = 'pnl'): Promise<Snapshot<Leaderboard>> {
    if (!WINDOWS.has(window) || !SORTS.has(sort)) return this.invalid('/v1/info/leaderboard', 'Invalid leaderboard window or ranking metric.');
    const path = `/v1/info/leaderboard?window=${window}&sort_by=${sort}&limit=100`;
    return this.cached(`leaderboard:${window}:${sort}`, 15_000, path, async () => {
      const row = object(await this.read(path), 'leaderboard');
      if (row.window !== window || row.sort_by !== sort) throw new Error('Leaderboard window or ranking does not match the request.');
      const at = timestamp(row.timestamp, 'leaderboard timestamp');
      const entries = array(row.entries, 'leaderboard entries').map((value) => {
        const entry = object(value, 'leaderboard entry');
        return { rank: integer(entry.rank, 'rank', 1), account: text(entry.account, 'account'), pnl: requiredMetric(entry.pnl, 'PnL'),
          notional: requiredMetric(entry.notional, 'notional'), accountValue: requiredMetric(entry.account_value, 'account value'), roi: metric(entry.roi, 'ROI') };
      });
      const total = integer(row.total, 'leaderboard total');
      return { data: { window, sortBy: sort, timestamp: at, total, entries }, observedAt: at,
        warning: `${entries.length} published rows of ${total} ranked accounts. Windows use calendar UTC boundaries. PnL excludes unrealized PnL; ROI is a decimal fraction.` };
    }, 180_000);
  }

  exchange(): Promise<Snapshot<{ cancelOnly: boolean; version: string }>> {
    const path = '/v1/info/exchange';
    return this.cached('exchange', 10_000, path, async () => {
      const row = object(await this.read(path), 'exchange');
      return { data: { cancelOnly: bool(row.cancel_only, 'cancel_only'), version: text(row.version, 'version') } };
    });
  }

  fees(): Promise<Snapshot<unknown>> {
    const path = '/v1/info/fees';
    return this.cached('fees', 300_000, path, async () => {
      const row = object(await this.read(path), 'fees');
      const schedule = array(row.fee_schedule, 'fee schedule').map((value) => {
        const entry = object(value, 'fee schedule entry');
        text(entry.instrument_type, 'fee instrument type'); text(entry.category, 'fee category');
        requiredMetric(entry.taker_fee_rate, 'taker fee'); requiredMetric(entry.maker_fee_rate, 'maker fee');
        for (const value of array(entry.tiers, 'fee tiers')) {
          const tier = object(value, 'fee tier');
          requiredMetric(tier.min_volume_30d, 'fee tier volume'); requiredMetric(tier.taker_fee_rate, 'tier taker fee'); requiredMetric(tier.maker_fee_rate, 'tier maker fee');
        }
        return entry;
      });
      return { data: { fee_schedule: schedule }, warning: 'Fee schedules apply only to the instrument type and category explicitly returned; absent categories are unavailable.' };
    });
  }
}
