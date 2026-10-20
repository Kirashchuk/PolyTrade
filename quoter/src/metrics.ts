import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Dec } from './decimal.ts';
import type { Instrument } from './instruments.ts';
import type { Logger } from './log.ts';
import type { Level } from './marketData.ts';
import { bandNotional, bandOf, makerScore, rawScore, rewardPeriodStart, sideScore, snapshotScore, TIER_CAP_USD, type BandNotional, type RestingQuote } from './rewards.ts';
import type { FillRecord } from './state.ts';

interface Accumulator {
  periodStart: number; samples: number; qualifying: number; scoreSum: number;
  bid: BandNotional; ask: BandNotional; bookBid: BandNotional; bookAsk: BandNotional;
  makerVolume: number; takerVolume: number; fees: number; realizedPnl: number; fills: number;
  /** Fills whose fee or PnL the exchange did not report: those totals are then incomplete, not zero. */
  feesUnknown: number; pnlUnknown: number;
}
const zero = (): BandNotional => [0, 0, 0];
const add = (into: BandNotional, value: BandNotional) => { for (let i = 0; i < 3; i++) into[i]! += value[i]!; };
const avg = (value: BandNotional, n: number): BandNotional => value.map((v) => n ? Math.round(v / n) : 0) as BandNotional;

/**
 * Reward metrics (spec §14). Uptime = share of 1 s samples with own liquidity on both sides within 20 bps.
 * The liquidity score averages qualifying samples, as in the official definition. Book depth by band
 * (excluding own orders) approximates competing liquidity, like the calculator's "from order book" mode.
 */
export class Metrics {
  private acc: Accumulator;
  private makerSharePct: number | null = null;
  private lastFlush: number;

  constructor(private readonly instrument: Instrument, private readonly options: { dir: string; flushS: number; mode: 'dry_run' | 'live' }, private readonly log: Logger, private readonly now: () => number = Date.now) {
    this.acc = this.fresh(rewardPeriodStart(now()));
    this.lastFlush = now();
  }

  private fresh(periodStart: number): Accumulator {
    return { periodStart, samples: 0, qualifying: 0, scoreSum: 0, bid: zero(), ask: zero(), bookBid: zero(), bookAsk: zero(), makerVolume: 0, takerVolume: 0, fees: 0, realizedPnl: 0, fills: 0, feesUnknown: 0, pnlUnknown: 0 };
  }
  setMakerShare(pct: number | null): void { this.makerSharePct = pct; }

  /** Records one snapshot and returns its two-sided score (0 = not qualifying). */
  sample(mid: Dec | null, quotes: readonly RestingQuote[], bids: readonly Level[], asks: readonly Level[]): number {
    const t = this.now(), period = rewardPeriodStart(t);
    if (period !== this.acc.periodStart) { void this.flush(true); this.acc = this.fresh(period); }
    this.acc.samples++;
    if (!mid) return 0;
    const own = bandNotional(quotes, mid, this.instrument.priceDecimals);
    const score = snapshotScore(own.bid, own.ask);
    if (score > 0) { this.acc.qualifying++; this.acc.scoreSum += score; }
    add(this.acc.bid, own.bid); add(this.acc.ask, own.ask);
    // Dry-run quotes are simulated and not in the exchange book, so nothing is subtracted for them.
    const ownAt = new Map(this.options.mode === 'live' ? quotes.map((q) => [`${q.side}:${q.price.toFixed()}`, q.rest]) : []);
    const depth = (levels: readonly Level[], side: 'bid' | 'ask'): BandNotional => {
      const out = zero();
      for (const [price, quantity] of levels) {
        const band = bandOf(side, price, mid, this.instrument.priceDecimals);
        if (!band) continue;
        const mine = ownAt.get(`${side}:${price.toFixed()}`);
        const others = mine ? quantity.minus(mine) : quantity;
        if (others.gt(0)) out[band - 1]! += others.mul(price).toNumber();
      }
      return out;
    };
    add(this.acc.bookBid, depth(bids, 'bid')); add(this.acc.bookAsk, depth(asks, 'ask'));
    return score;
  }

  recordFills(fills: readonly FillRecord[]): void {
    for (const fill of fills) {
      const notional = fill.price.mul(fill.qty).toNumber();
      if (fill.taker) this.acc.takerVolume += notional; else this.acc.makerVolume += notional;
      if (fill.fee === null) this.acc.feesUnknown++; else this.acc.fees += fill.fee;
      if (fill.pnl === null) this.acc.pnlUnknown++; else this.acc.realizedPnl += fill.pnl;
      this.acc.fills++;
    }
  }

  summary() {
    const a = this.acc, uptime = a.samples ? a.qualifying / a.samples : 0;
    const liquidity = a.qualifying ? a.scoreSum / a.qualifying : 0;
    const bid = avg(a.bid, a.samples), ask = avg(a.ask, a.samples);
    return {
      mode: this.options.mode, simulated: this.options.mode === 'dry_run', instrument: this.instrument.symbol,
      periodStart: new Date(a.periodStart).toISOString(), samples: a.samples, uptime: Number(uptime.toFixed(4)),
      avgLiquidityScore: Math.round(liquidity), avgBidByBand: bid, avgAskByBand: ask,
      wastedAboveCap: [...bid, ...ask].reduce((w, v) => w + Math.max(0, v - TIER_CAP_USD), 0),
      avgOtherBookBidByBand: avg(a.bookBid, a.samples), avgOtherBookAskByBand: avg(a.bookAsk, a.samples),
      otherBookScoreIfOneMaker: Math.round(snapshotScore(avg(a.bookBid, a.samples), avg(a.bookAsk, a.samples))),
      sideScores: { bid: Math.round(sideScore(bid)), ask: Math.round(sideScore(ask)) },
      makerSharePct: this.makerSharePct,
      estRawScore: this.makerSharePct === null ? null : Number(rawScore(makerScore(this.makerSharePct), liquidity, uptime).toFixed(2)),
      makerVolume: Math.round(a.makerVolume), takerVolume: Math.round(a.takerVolume), fees: a.fills && a.feesUnknown === a.fills ? null : Number(a.fees.toFixed(4)), feesUnknown: a.feesUnknown,
      realizedPnl: a.fills && a.pnlUnknown === a.fills ? null : Number(a.realizedPnl.toFixed(4)), pnlUnknown: a.pnlUnknown, fills: a.fills,
    };
  }

  async flush(force = false): Promise<void> {
    const t = this.now();
    if (!force && t - this.lastFlush < this.options.flushS * 1_000) return;
    this.lastFlush = t;
    const line = { t: new Date(t).toISOString(), ...this.summary() };
    this.log.info('metrics', line);
    try {
      await mkdir(this.options.dir, { recursive: true });
      await appendFile(join(this.options.dir, `metrics-${this.options.mode}-${this.instrument.symbol}-${new Date(t).toISOString().slice(0, 10)}.jsonl`), JSON.stringify(line) + '\n');
    } catch (error) { this.log.warn('metrics file write failed', { error: String(error) }); }
  }
}
