import type { LevelConfig, SessionProfile, Settings } from './config.ts';
import { D, type Dec } from './decimal.ts';
import { ceilPrice, ceilQty, floorPrice, floorQty, priceTick, type Instrument } from './instruments.ts';
import { bandEdge, bandOf, TIER_CAP_USD, type Side } from './rewards.ts';

export type SlotKey = `${Side}:${number}`;
export const slotKey = (side: Side, level: number): SlotKey => `${side}:${level}`;
export interface MarketView { bestBid: Dec; bestAsk: Dec; mid: Dec; }
export interface QuoteInputs {
  market: MarketView;
  instrument: Instrument;
  positionQty: Dec;
  levels: readonly LevelConfig[];
  requote: Settings['requote'];
  inventory: Settings['inventory'];
  session: SessionProfile;
  /** 0..1 size multiplier from the risk manager (margin). */
  sizeScale: number;
  /** Extra distance from the risk manager (volatility widen), clamped inside each target band. */
  extraBps: number;
  /** Per-slot widening after repeated post-only rejections. */
  widenTicks: ReadonlyMap<SlotKey, number>;
}
export interface TargetQuote { slot: SlotKey; side: Side; level: number; band: 1 | 2 | 3; price: Dec; qty: Dec; notional: number; distBps: number; }
export interface TargetLadder { mid: Dec; tick: Dec; skewBps: number; positionUsd: number; quotes: TargetQuote[]; warnings: string[]; }

/**
 * Pure quote computation (spec §5): ladder levels around the midpoint, inventory skew, post-only clamp,
 * band containment after rounding, sizes on the quantity grid and the position limit. No I/O.
 */
export function computeLadder(input: QuoteInputs): TargetLadder {
  const { market, instrument, inventory, requote, session } = input;
  const { mid, bestBid, bestAsk } = market;
  const warnings: string[] = [];
  const tick = priceTick(instrument, mid);
  const positionUsd = input.positionQty.mul(mid).toNumber();
  const skewBps = inventory.skewBpsPer10k * positionUsd / 10_000;
  const quotes: TargetQuote[] = [];
  if (!(bestBid.lt(bestAsk) && mid.gt(0))) return { mid, tick, skewBps, positionUsd, quotes, warnings: ['Book is crossed, locked or empty'] };

  const longStop = inventory.maxPositionUsd >= 0 && positionUsd >= inventory.maxPositionUsd && positionUsd > 0;
  const shortStop = inventory.maxPositionUsd >= 0 && -positionUsd >= inventory.maxPositionUsd && positionUsd < 0;

  input.levels.forEach((level, index) => {
    const base = level.bps + session.bpsAdd + input.extraBps;
    for (const side of ['bid', 'ask'] as const) {
      const slot = slotKey(side, index);
      const sideBps = Math.max(side === 'bid' ? base + skewBps : base - skewBps, requote.minEdgeBps);
      const widen = tick.mul(input.widenTicks.get(slot) ?? 0);
      const fraction = new D(sideBps).div(10_000);
      let price = side === 'bid' ? floorPrice(instrument, mid.mul(new D(1).minus(fraction))).minus(widen) : ceilPrice(instrument, mid.mul(fraction.plus(1))).plus(widen);
      // Post-only: never lock or cross the opposite best price.
      price = side === 'bid' ? D.min(price, bestAsk.minus(tick)) : D.max(price, bestBid.plus(tick));
      // Keep the order inside its target band with one tick of margin from the (outward-rounded) edge.
      const edge = bandEdge(side, level.band, mid, instrument.priceDecimals);
      if (side === 'bid' ? price.lte(edge) : price.gte(edge)) price = side === 'bid' ? edge.plus(tick) : edge.minus(tick);
      if (price.lte(0)) { warnings.push(`${slot}: nonpositive price`); continue; }
      const band = bandOf(side, price, mid, instrument.priceDecimals);
      if (band === 0 || band > level.band) { warnings.push(`${slot}: cannot stay inside band ${level.band} after rounding; level skipped`); continue; }
      if (side === 'bid' ? price.gte(bestAsk) : price.lte(bestBid)) { warnings.push(`${slot}: would cross; level skipped`); continue; }

      let qty = floorQty(instrument, new D(level.sizeUsd * session.sizeMult * input.sizeScale).div(price));
      const stopped = side === 'bid' ? longStop : shortStop;
      if (stopped) {
        if (inventory.stopSideMode === 'zero') continue;
        qty = ceilQty(instrument, instrument.minNotional.div(price));
      }
      if (qty.mul(price).gt(instrument.maxLimitNotional)) qty = floorQty(instrument, instrument.maxLimitNotional.div(price));
      if (qty.lte(0) || qty.mul(price).lt(instrument.minNotional)) { warnings.push(`${slot}: below min_notional; level skipped`); continue; }
      quotes.push({ slot, side, level: index, band: level.band, price, qty, notional: qty.mul(price).toNumber(), distBps: price.minus(mid).abs().div(mid).mul(10_000).toNumber() });
    }
  });

  for (const side of ['bid', 'ask'] as const) for (const band of [1, 2, 3] as const) {
    const total = quotes.filter((q) => q.side === side && bandOf(side, q.price, mid, instrument.priceDecimals) === band).reduce((sum, q) => sum + q.notional, 0);
    if (total > TIER_CAP_USD) warnings.push(`${side} band ${band}: $${Math.round(total)} exceeds the $${TIER_CAP_USD} scoring cap`);
  }
  return { mid, tick, skewBps, positionUsd, quotes, warnings };
}
