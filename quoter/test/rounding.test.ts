import { describe, expect, test } from 'bun:test';
import { D, gridStep, onGrid, significantDigits, toGrid, wire } from '../src/decimal.ts';
import { bandEdge, bandOf, harmonic, makerScore, rawScore, rewardPeriodStart, sideScore, snapshotScore } from '../src/rewards.ts';

describe('price/quantity grid (decimals + 5 significant digits)', () => {
  test('step follows magnitude', () => {
    expect(gridStep('195.77', 2).toFixed()).toBe('0.01');
    expect(gridStep('65000', 2).toFixed()).toBe('1');
    expect(gridStep('1234.5', 2).toFixed()).toBe('0.1');
    expect(gridStep('0.123456', 6).toFixed()).toBe('0.00001');
    expect(gridStep('5.1234', 4).toFixed()).toBe('0.0001');
  });
  test('floor/ceil stay exact and on grid', () => {
    expect(wire(toGrid('195.6969', 2))).toBe('195.69');
    expect(wire(toGrid('195.6901', 2, true))).toBe('195.7');
    expect(wire(toGrid('65012.7', 2))).toBe('65012');
    expect(wire(toGrid('0.1', 2).plus(toGrid('0.2', 2)))).toBe('0.3');
  });
  test('carry into the next decade re-rounds with the coarser step', () => {
    const up = toGrid('9.99996', 4, true);
    expect(wire(up)).toBe('10');
    expect(significantDigits(up)).toBeLessThanOrEqual(5);
    expect(wire(toGrid('99999.5', 2, true))).toBe('100000');
    expect(onGrid(toGrid('99999.5', 2, true), 2)).toBe(true);
  });
  test('quantities never exceed 5 significant digits', () => {
    for (const raw of ['512.8205128', '5.10204', '0.0516789', '12345.678']) {
      const q = toGrid(raw, 4);
      expect(significantDigits(q)).toBeLessThanOrEqual(5);
      expect(q.lte(raw)).toBe(true);
    }
  });
});

describe('reward bands', () => {
  const mid = new D('195.765');
  test('edges round outward to a valid tick', () => {
    expect(bandEdge('bid', 1, mid, 2).toFixed()).toBe('195.66'); // 195.6671… floored
    expect(bandEdge('ask', 1, mid, 2).toFixed()).toBe('195.87'); // 195.8628… ceiled
  });
  test('band classification uses the rounded edges', () => {
    expect(bandOf('bid', new D('195.70'), mid, 2)).toBe(1);
    expect(bandOf('bid', new D('195.66'), mid, 2)).toBe(1);
    expect(bandOf('bid', new D('195.65'), mid, 2)).toBe(2);
    expect(bandOf('ask', new D('196.16'), mid, 2)).toBe(3);
    expect(bandOf('ask', new D('196.20'), mid, 2)).toBe(0);
    expect(bandOf('bid', new D('195.80'), mid, 2)).toBe(0); // above mid: not a resting bid quote
  });
  test('score formulas match the official definition and the calculator', () => {
    expect(makerScore(0.99)).toBe(0);
    expect(makerScore(1)).toBeCloseTo(Math.log(2) / Math.log(26), 12);
    expect(makerScore(25)).toBe(1);
    expect(makerScore(40)).toBe(1);
    expect(sideScore([100_000, 100_000, 100_000])).toBeCloseTo(135_000);
    expect(sideScore([250_000, 0, 0])).toBe(100_000); // capped
    expect(harmonic(100, 0)).toBe(0);
    expect(snapshotScore([100_000, 0, 0], [50_000, 0, 0])).toBeCloseTo(2 * 100_000 * 50_000 / 150_000);
    // Calculator defaults: maker share 1%, all bands $100k both sides, uptime 99%.
    expect(rawScore(makerScore(1), 135_000, 0.99)).toBeCloseTo(makerScore(1) ** 0.35 * 135_000 ** 0.65 * 0.99, 9);
  });
  test('reward period starts at 12:00 UTC', () => {
    expect(new Date(rewardPeriodStart(Date.UTC(2026, 9, 19, 15))).toISOString()).toBe('2026-10-19T12:00:00.000Z');
    expect(new Date(rewardPeriodStart(Date.UTC(2026, 9, 19, 11, 59))).toISOString()).toBe('2026-10-18T12:00:00.000Z');
  });
});
