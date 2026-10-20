import Decimal from 'decimal.js';

/** Exact arithmetic for every price and quantity that reaches a signed operation. */
export const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -40, toExpPos: 40 });
export type Dec = Decimal;

const EXACT = /^(0|[1-9]\d*)(\.\d+)?$/;
const SIGNED = /^-?(0|[1-9]\d*)(\.\d+)?$/;
export const MAX_SIGNIFICANT = 5;

export function exact(value: unknown, name: string): Dec {
  if (typeof value !== 'string' || value.length > 64 || !EXACT.test(value)) throw new Error(`${name}: expected an exact nonnegative decimal string`);
  return new D(value);
}
export function exactSigned(value: unknown, name: string): Dec {
  if (typeof value !== 'string' || value.length > 64 || !SIGNED.test(value)) throw new Error(`${name}: expected an exact decimal string`);
  return new D(value);
}
export function positive(value: unknown, name: string): Dec {
  const result = exact(value, name);
  if (result.lte(0)) throw new Error(`${name}: must be positive`);
  return result;
}

/** Smallest valid increment at this magnitude: `decimals` places and at most five significant digits. */
export function gridStep(magnitude: Decimal.Value, decimals: number): Dec {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid decimal precision');
  const value = new D(magnitude);
  if (value.lte(0)) throw new Error('Grid magnitude must be positive');
  return D.max(new D(10).pow(-decimals), new D(10).pow(value.e - (MAX_SIGNIFICANT - 1)));
}

/** Round down (or up) onto the valid grid. A carry into the next decade re-rounds with the coarser step. */
export function toGrid(value: Decimal.Value, decimals: number, up = false): Dec {
  const raw = new D(value);
  if (raw.lte(0)) return new D(0);
  let step = gridStep(raw, decimals);
  let result = (up ? raw.div(step).ceil() : raw.div(step).floor()).mul(step);
  if (result.gt(0) && !gridStep(result, decimals).eq(step)) {
    step = gridStep(result, decimals);
    result = (up ? raw.div(step).ceil() : raw.div(step).floor()).mul(step);
  }
  return result;
}

/**
 * Nearest grid point strictly above (or below) `value`. Across a decade boundary the step changes
 * (999.99 → 1000.0 → 1000.1), so neighbours are found on the grid itself, never by adding a fixed tick.
 */
export function gridNeighbor(value: Decimal.Value, decimals: number, up: boolean): Dec {
  const nudge = new D(10).pow(-(decimals + 2));
  return toGrid(up ? new D(value).plus(nudge) : new D(value).minus(nudge), decimals, up);
}
export function gridShift(value: Decimal.Value, decimals: number, steps: number, up: boolean): Dec {
  let result = new D(value);
  for (let i = 0; i < steps; i++) result = gridNeighbor(result, decimals, up);
  return result;
}

export function onGrid(value: Decimal.Value, decimals: number): boolean {
  const raw = new D(value);
  return raw.gt(0) && raw.mod(gridStep(raw, decimals)).isZero();
}

export function significantDigits(value: Decimal.Value): number { return new D(value).sd(false); }

/** Wire format: plain notation, no exponent, no trailing zeros. */
export const wire = (value: Decimal.Value): string => new D(value).toFixed();

/** |a − b| in basis points of `reference`. */
export const bpsBetween = (a: Decimal.Value, b: Decimal.Value, reference: Decimal.Value): number => new D(a).minus(b).abs().div(reference).mul(10_000).toNumber();
