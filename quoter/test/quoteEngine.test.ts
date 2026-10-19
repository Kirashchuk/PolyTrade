import { describe, expect, test } from 'bun:test';
import type { Settings } from '../src/config.ts';
import { D, onGrid, significantDigits } from '../src/decimal.ts';
import { computeLadder, type QuoteInputs } from '../src/quoteEngine.ts';
import { bandOf } from '../src/rewards.ts';
import { exampleSettings, market, pltr } from './fixtures.ts';

const settings = await exampleSettings();
const inputs = (over: Partial<QuoteInputs> = {}, inventory: Partial<Settings['inventory']> = {}): QuoteInputs => ({
  market: market('195.76', '195.77'), instrument: pltr(), positionQty: new D(0), levels: settings.levels, requote: settings.requote,
  inventory: { ...settings.inventory, ...inventory }, session: { sizeMult: 1, bpsAdd: 0 }, sizeScale: 1, extraBps: 0, widenTicks: new Map(), ...over,
});
const find = (ladder: ReturnType<typeof computeLadder>, slot: string) => ladder.quotes.find((q) => q.slot === slot);

describe('QuoteEngine', () => {
  test('symmetric ladder at the configured distances, on the exchange grid, inside its band', () => {
    const ladder = computeLadder(inputs());
    expect(ladder.quotes).toHaveLength(6);
    expect(find(ladder, 'bid:0')!.price.toFixed()).toBe('195.69'); // 195.765 × (1 − 3.5 bps) = 195.6965 → floor
    expect(find(ladder, 'ask:0')!.price.toFixed()).toBe('195.84'); // 195.8335 → ceil
    expect(find(ladder, 'bid:0')!.qty.toFixed()).toBe('5.1101');   // floor(1000 / 195.69) on the 0.0001 grid
    for (const q of ladder.quotes) {
      expect(bandOf(q.side, q.price, ladder.mid, 2)).toBe(q.band);
      expect(onGrid(q.price, 2)).toBe(true);
      expect(significantDigits(q.price)).toBeLessThanOrEqual(5);
      expect(significantDigits(q.qty)).toBeLessThanOrEqual(5);
      expect(q.notional).toBeGreaterThanOrEqual(10);
      expect(q.notional).toBeLessThanOrEqual(1000);
    }
    expect(ladder.warnings).toEqual([]);
  });

  test('long inventory pushes bids away and asks closer, but never out of the band', () => {
    const qty = new D(20_000).div('195.765');
    const mild = computeLadder(inputs({ positionQty: qty }, { maxPositionUsd: 1_000_000 })); // +1 bps skew
    expect(mild.skewBps).toBeCloseTo(1, 6);
    expect(find(mild, 'bid:0')!.price.toFixed()).toBe('195.67');
    expect(find(mild, 'ask:0')!.price.toFixed()).toBe('195.82');
    const strong = computeLadder(inputs({ positionQty: qty.mul(3) }, { maxPositionUsd: 1_000_000 })); // +3 bps: bid would leave band 1
    expect(find(strong, 'bid:0')!.price.toFixed()).toBe('195.67'); // band-1 edge 195.66 + one tick
    expect(bandOf('bid', find(strong, 'bid:0')!.price, strong.mid, 2)).toBe(1);
  });

  test('position limit removes (zero) or shrinks the side that would grow the position', () => {
    const long = new D(6_000).div('195.765');
    const zero = computeLadder(inputs({ positionQty: long }));
    expect(zero.quotes.filter((q) => q.side === 'bid')).toHaveLength(0);
    expect(zero.quotes.filter((q) => q.side === 'ask')).toHaveLength(3);
    const shrink = computeLadder(inputs({ positionQty: long }, { stopSideMode: 'shrink' }));
    for (const q of shrink.quotes.filter((x) => x.side === 'bid')) { expect(q.notional).toBeGreaterThanOrEqual(10); expect(q.notional).toBeLessThan(10.1); }
    const short = computeLadder(inputs({ positionQty: long.neg() }));
    expect(short.quotes.filter((q) => q.side === 'ask')).toHaveLength(0);
  });

  test('session widening is clamped inside each band; size multiplier applies', () => {
    const ladder = computeLadder(inputs({ session: { sizeMult: 0.3, bpsAdd: 3 } }));
    for (const q of ladder.quotes) expect(bandOf(q.side, q.price, ladder.mid, 2)).toBe(q.band);
    expect(find(ladder, 'bid:0')!.notional).toBeLessThanOrEqual(300);
  });

  test('post-only: bids stay below the best ask and asks above the best bid on any book', () => {
    for (const [bid, ask] of [['195.76', '195.77'], ['100', '100.02'], ['64999', '65001']] as const) {
      const ladder = computeLadder(inputs({ market: market(bid, ask), requote: { ...settings.requote, minEdgeBps: 0 } }));
      for (const q of ladder.quotes) expect(q.side === 'bid' ? q.price.lt(ask) : q.price.gt(bid)).toBe(true);
    }
  });

  test('below min notional and crossed books produce no quotes', () => {
    const tiny = computeLadder(inputs({ sizeScale: 0.001 }));
    expect(tiny.quotes).toHaveLength(0);
    expect(tiny.warnings.some((w) => w.includes('min_notional'))).toBe(true);
    expect(computeLadder(inputs({ market: market('195.77', '195.77') })).quotes).toHaveLength(0);
  });

  test('warns when a band exceeds the $100k scoring cap', () => {
    const ladder = computeLadder(inputs({ levels: [{ band: 1, bps: 3.5, sizeUsd: 150_000 }] }));
    expect(ladder.warnings.some((w) => w.includes('scoring cap'))).toBe(true);
  });

  test('post-only reject widening moves only the affected slot', () => {
    const base = computeLadder(inputs());
    const widened = computeLadder(inputs({ widenTicks: new Map([['ask:2', 1]]) }));
    expect(find(widened, 'ask:2')!.price.minus(find(base, 'ask:2')!.price).toFixed()).toBe('0.01');
    expect(find(widened, 'bid:2')!.price.eq(find(base, 'bid:2')!.price)).toBe(true);
  });
});
