export interface EquityAnchor { periodStart: number; value: number; }
export interface AccountView { availableMargin: number | null; accountValue: number | null; inLiquidation: boolean; portfolioAt: number | null; }
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const money = (value: unknown): number | null => typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;

/**
 * Account-wide portfolio fields shared by every quoted instrument: margin, account value, liquidation flag and the
 * daily-loss anchor. Partial frames update only the fields they carry.
 */
export class AccountStore {
  private view: AccountView = { availableMargin: null, accountValue: null, inLiquidation: false, portfolioAt: null };
  private equityAnchor: EquityAnchor | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  applyPortfolio(data: unknown): void {
    const r = row(data), next = { ...this.view };
    if (r.margin !== undefined) {
      const margin = row(r.margin);
      if (margin.available_order_margin !== undefined) next.availableMargin = money(margin.available_order_margin);
      if (margin.total_account_value !== undefined) next.accountValue = money(margin.total_account_value);
    }
    if (typeof r.in_liquidation === 'boolean') next.inLiquidation = r.in_liquidation;
    if (Array.isArray(r.positions)) next.portfolioAt = typeof r.timestamp === 'number' ? r.timestamp : this.now();
    this.view = next;
  }

  snapshot(): AccountView { return { ...this.view }; }

  /** PnL since the start of the current reward period, from account value (no transfers are made by the bot). */
  dailyPnl(periodStart: number): number | null {
    const value = this.view.accountValue;
    if (value === null) return null;
    if (!this.equityAnchor || this.equityAnchor.periodStart !== periodStart) this.equityAnchor = { periodStart, value };
    return value - this.equityAnchor.value;
  }
  anchor(): EquityAnchor | null { return this.equityAnchor; }
  /** Restore the period anchor saved by an earlier process so a restart does not reset the daily-loss limit. */
  restoreAnchor(anchor: EquityAnchor | null): void { if (anchor && Number.isFinite(anchor.value) && Number.isSafeInteger(anchor.periodStart)) this.equityAnchor = anchor; }
}

/**
 * Private frames carry `sq`. Official examples number them contiguously per connection across channels, so a jump
 * past the highest value seen means a missed frame and state must be rebuilt from REST. If jumps turn out to be routine
 * (more than 5 a minute), gap detection is disabled for the connection and the periodic reconcile remains.
 */
export class SequenceTracker {
  private last: number | null = null;
  private gapTimes: number[] = [];
  private trusted = true;
  onDistrust: (() => void) | null = null;
  constructor(private readonly now: () => number = Date.now) {}

  /** Returns a gap description, or null when the frame is in order (or detection is disabled). */
  check(channel: string, sq: unknown): string | null {
    if (typeof sq !== 'number') return null;
    const last = this.last;
    this.last = last === null ? sq : Math.max(last, sq);
    if (last === null || sq <= last + 1 || !this.trusted) return null;
    const t = this.now();
    this.gapTimes = [...this.gapTimes.filter((time) => time > t - 60_000), t];
    if (this.gapTimes.length > 5) { this.trusted = false; this.onDistrust?.(); return null; }
    return `${channel} sequence gap ${last}→${sq}`;
  }
  reset(): void { this.last = null; this.gapTimes = []; this.trusted = true; }
}
