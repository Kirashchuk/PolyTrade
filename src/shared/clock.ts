/** Exchange time estimate. Exchange timestamps are judged against it, so local clock skew never counts as data age. */
let offsetMs = 0;
export const exchangeNow = (): number => Date.now() + offsetMs;
/** Offsets beyond 30 s are treated as a broken measurement; the local clock is used and freshness checks fail closed. */
export function setExchangeClockOffset(value: number | null | undefined): void {
  offsetMs = typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 30_000 ? Math.round(value) : 0;
}
