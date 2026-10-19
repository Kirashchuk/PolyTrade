import { D, toGrid, type Dec } from './decimal.ts';

/** Official liquidity-rewards parameters: https://docs.polymarket.com/perps/liquidity-rewards */
export const BANDS = [
  { band: 1, maxBps: 5, weight: 1.0 },
  { band: 2, maxBps: 10, weight: 0.25 },
  { band: 3, maxBps: 20, weight: 0.10 },
] as const;
export type Band = 0 | 1 | 2 | 3;
export const TIER_CAP_USD = 100_000;
export const DAILY_PROGRAM_USD = 75_000;
export const MAKER_SHARE_MIN_PCT = 1;
export const MAKER_SHARE_CAP_PCT = 25;
export type Side = 'bid' | 'ask';

export const bandWeight = (band: Band): number => band === 0 ? 0 : BANDS[band - 1]!.weight;

/** Band edge price. Each boundary is rounded outward to the next valid tick, as the program states. */
export function bandEdge(side: Side, band: 1 | 2 | 3, mid: Dec, priceDecimals: number): Dec {
  const bps = new D(BANDS[band - 1]!.maxBps).div(10_000);
  return side === 'bid' ? toGrid(mid.mul(new D(1).minus(bps)), priceDecimals, false) : toGrid(mid.mul(bps.plus(1)), priceDecimals, true);
}

/** Scoring band of a resting price relative to the midpoint; 0 means it does not score. */
export function bandOf(side: Side, price: Dec, mid: Dec, priceDecimals: number): Band {
  if (side === 'bid' ? price.gte(mid) : price.lte(mid)) return 0;
  for (const { band } of BANDS) {
    const edge = bandEdge(side, band, mid, priceDecimals);
    if (side === 'bid' ? price.gte(edge) : price.lte(edge)) return band;
  }
  return 0;
}

export type BandNotional = [number, number, number];
export const sideScore = (notional: BandNotional): number => notional.reduce((sum, value, index) => sum + Math.min(value, TIER_CAP_USD) * BANDS[index]!.weight, 0);
export const harmonic = (bid: number, ask: number): number => bid > 0 && ask > 0 ? 2 * bid * ask / (bid + ask) : 0;
export const snapshotScore = (bid: BandNotional, ask: BandNotional): number => harmonic(sideScore(bid), sideScore(ask));
export function makerScore(sharePct: number): number {
  if (!Number.isFinite(sharePct) || sharePct < MAKER_SHARE_MIN_PCT) return 0;
  return Math.log(1 + Math.min(sharePct, MAKER_SHARE_CAP_PCT)) / Math.log(1 + MAKER_SHARE_CAP_PCT);
}
export const rawScore = (maker: number, liquidity: number, uptime: number): number =>
  maker > 0 && liquidity > 0 && uptime > 0 ? maker ** 0.35 * liquidity ** 0.65 * uptime : 0;

export interface RestingQuote { side: Side; price: Dec; rest: Dec; }
/** Per-band resting notional of one account; uncapped totals so waste above the cap stays visible. */
export function bandNotional(quotes: readonly RestingQuote[], mid: Dec, priceDecimals: number): { bid: BandNotional; ask: BandNotional } {
  const bid: BandNotional = [0, 0, 0], ask: BandNotional = [0, 0, 0];
  for (const quote of quotes) {
    if (quote.rest.lte(0)) continue;
    const band = bandOf(quote.side, quote.price, mid, priceDecimals);
    if (band === 0) continue;
    const target = quote.side === 'bid' ? bid : ask;
    target[band - 1] = target[band - 1]! + quote.price.mul(quote.rest).toNumber();
  }
  return { bid, ask };
}

/** Reward period runs 12:00–12:00 UTC. Returns the period start in ms. */
export function rewardPeriodStart(nowMs: number): number {
  const date = new Date(nowMs);
  const noon = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12);
  return nowMs >= noon ? noon : noon - 86_400_000;
}
