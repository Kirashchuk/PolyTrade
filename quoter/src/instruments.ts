import { D, gridStep, positive, toGrid, type Dec } from './decimal.ts';
import type { Settings } from './config.ts';

export interface RiskTier { lowerBound: Dec; maxLeverage: number; }
export interface Instrument {
  id: number; symbol: string; category: string; baseAsset: string;
  priceDecimals: number; quantityDecimals: number; priceBounds: Dec;
  minNotional: Dec; maxLimitNotional: Dec; maxOrderCount: number; maxLeverage: number;
  riskTiers: RiskTier[]; closeOnly: boolean; settled: boolean;
  source: string; observedAt: number;
}
type Row = Record<string, unknown>;
const int = (value: unknown, name: string, min = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error(`Instrument ${name}: expected integer ≥ ${min}`);
  return value;
};

export function parseInstrument(value: unknown, source: string, observedAt: number): Instrument {
  if (!value || typeof value !== 'object') throw new Error('Instrument row is not an object');
  const row = value as Row;
  if (typeof row.symbol !== 'string' || !row.symbol) throw new Error('Instrument symbol is missing');
  if (!Array.isArray(row.risk_tiers) || !row.risk_tiers.length) throw new Error(`${row.symbol}: risk tiers are missing`);
  return {
    id: int(row.instrument_id, 'instrument_id'), symbol: row.symbol, category: String(row.category ?? 'unknown'), baseAsset: String(row.base_asset ?? ''),
    priceDecimals: int(row.price_decimals, 'price_decimals'), quantityDecimals: int(row.quantity_decimals, 'quantity_decimals'),
    priceBounds: positive(row.price_bounds, 'price_bounds'), minNotional: positive(row.min_notional, 'min_notional'),
    maxLimitNotional: positive(row.max_limit_notional, 'max_limit_notional'), maxOrderCount: int(row.max_order_count, 'max_order_count', 1),
    maxLeverage: int(row.max_leverage, 'max_leverage', 1),
    riskTiers: row.risk_tiers.map((tier: Row) => ({ lowerBound: new D(String(tier.lower_bound)), maxLeverage: int(tier.max_leverage, 'risk tier leverage', 1) })),
    closeOnly: row.close_only === true, settled: row.settlement !== undefined && row.settlement !== null,
    source, observedAt,
  };
}

export function findInstrument(rows: unknown, wanted: string, source: string, observedAt: number): Instrument {
  if (!Array.isArray(rows)) throw new Error('Instrument list is not an array');
  const key = wanted.trim().toUpperCase();
  const match = rows.find((row: Row) => String(row.instrument_id) === key || String(row.symbol).toUpperCase() === key || String(row.symbol).toUpperCase() === `${key}-USD`);
  if (!match) throw new Error(`Instrument ${wanted} is not listed at ${source}`);
  return parseInstrument(match, source, observedAt);
}

export const priceTick = (instrument: Instrument, price: Dec): Dec => gridStep(price, instrument.priceDecimals);
export const floorPrice = (instrument: Instrument, price: Dec): Dec => toGrid(price, instrument.priceDecimals, false);
export const ceilPrice = (instrument: Instrument, price: Dec): Dec => toGrid(price, instrument.priceDecimals, true);
export const floorQty = (instrument: Instrument, quantity: Dec): Dec => toGrid(quantity, instrument.quantityDecimals, false);
export const ceilQty = (instrument: Instrument, quantity: Dec): Dec => toGrid(quantity, instrument.quantityDecimals, true);

export function leverageLimit(instrument: Instrument, notional: Dec): number {
  let limit = instrument.maxLeverage;
  for (const tier of instrument.riskTiers) if (notional.gte(tier.lowerBound)) limit = Math.min(limit, tier.maxLeverage);
  return limit;
}

/** Check the ladder against instrument limits before anything runs. Errors stop startup; warnings are logged. */
export function checkAgainstInstrument(settings: Settings, instrument: Instrument, mid: Dec | null): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  if (instrument.settled) errors.push(`${instrument.symbol} is settled`);
  if (instrument.closeOnly) errors.push(`${instrument.symbol} is close-only`);
  const ordersPerSide = settings.levels.length;
  if (ordersPerSide * 2 > instrument.maxOrderCount) errors.push(`Ladder needs ${ordersPerSide * 2} orders; instrument max_order_count is ${instrument.maxOrderCount}`);
  for (const level of settings.levels) {
    if (new D(level.sizeUsd).lt(instrument.minNotional)) errors.push(`Level band ${level.band} size $${level.sizeUsd} is below min_notional ${instrument.minNotional.toFixed()}`);
    if (new D(level.sizeUsd).gt(instrument.maxLimitNotional)) errors.push(`Level band ${level.band} size $${level.sizeUsd} exceeds max_limit_notional ${instrument.maxLimitNotional.toFixed()}`);
  }
  if (settings.leverage !== null) {
    const perSide = settings.levels.reduce((sum, level) => sum + level.sizeUsd, 0) + settings.inventory.maxPositionUsd;
    const allowed = leverageLimit(instrument, new D(perSide));
    if (settings.leverage > allowed) errors.push(`Leverage ${settings.leverage}x exceeds the ${allowed}x tier for $${perSide} worst-case side exposure`);
  }
  if (mid) {
    const tickBps = priceTick(instrument, mid).div(mid).mul(10_000).toNumber();
    for (const level of settings.levels) {
      const outer = [5, 10, 20][level.band - 1]!;
      if (outer - level.bps < tickBps) warnings.push(`Level band ${level.band} at ${level.bps} bps is within one tick (${tickBps.toFixed(2)} bps) of the band edge`);
    }
  }
  return { errors, warnings };
}
