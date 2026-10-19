import { D, exact, exactSigned, type Dec } from './decimal.ts';
import type { SlotKey } from './quoteEngine.ts';
import type { RestingQuote, Side } from './rewards.ts';

/** Statuses that mean the order may still rest. Everything else is terminal. */
const ACTIVE = new Set(['open', 'accepted', 'pending', 'partial', 'partially_filled', 'new']);
export const isActive = (status: string): boolean => ACTIVE.has(status);

export interface OwnOrder {
  coid: string; oid: number | null; slot: SlotKey; side: Side;
  price: Dec; qty: Dec; filled: Dec; rest: Dec; status: string;
  updatedAt: number;
  /** Set while a write for this order is unacknowledged. */
  inFlight: boolean;
  /** Next action for the slot must be cancel + place (e.g. modify limit reached). */
  replace: boolean;
}
export interface ForeignOrder { oid: number; coid: string | null; side: Side; price: string; rest: string; }
export interface FillRecord { tid: number; oid: number; coid: string | null; side: 'long' | 'short'; price: Dec; qty: Dec; fee: number; pnl: number; taker: boolean; ts: number; }
export interface AccountSnapshot {
  positionQty: Dec; entryPrice: string | null; unrealizedPnl: number | null;
  availableMargin: number | null; accountValue: number | null; inLiquidation: boolean;
  portfolioAt: number | null;
}
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const money = (value: unknown): number | null => typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;

/**
 * Single source of truth for the bot's own orders, position and margin (spec §7).
 * Readers update it; only the executor creates intents.
 */
export class StateStore {
  readonly orders = new Map<string, OwnOrder>();
  readonly slots = new Map<SlotKey, string>();
  foreign: ForeignOrder[] = [];
  readonly fills: FillRecord[] = [];
  private readonly seenFills = new Set<number>();
  private portfolioQty = new D(0);
  private account: Omit<AccountSnapshot, 'positionQty'> = { entryPrice: null, unrealizedPnl: null, availableMargin: null, accountValue: null, inLiquidation: false, portfolioAt: null };
  private lastSequence: number | null = null;
  private gapTimes: number[] = [];
  private sequenceTrusted = true;
  private resyncReason: string | null = 'initial snapshot';
  readonly postOnlyRejects = new Map<SlotKey, number>();
  private equityAnchor: { periodStart: number; value: number } | null = null;

  constructor(readonly instrumentId: number, readonly symbol: string, private readonly now: () => number = Date.now) {}

  // ---------- intents ----------
  registerPlacement(slot: SlotKey, coid: string, side: Side, price: Dec, qty: Dec): void {
    this.orders.set(coid, { coid, oid: null, slot, side, price, qty, filled: new D(0), rest: new D(0), status: 'submitting', updatedAt: this.now(), inFlight: true, replace: false });
    this.slots.set(slot, coid);
  }
  /** The order left the slot (terminal or abandoned). */
  release(coid: string): void {
    const order = this.orders.get(coid);
    if (order && this.slots.get(order.slot) === coid) this.slots.delete(order.slot);
  }
  forSlot(slot: SlotKey): OwnOrder | null {
    const coid = this.slots.get(slot);
    return coid ? this.orders.get(coid) ?? null : null;
  }

  // ---------- updates ----------
  /** Order update from the private `orders` channel, a modify acknowledgement or a REST row. */
  applyOrder(data: unknown): OwnOrder | null {
    const r = row(data);
    const iid = r.iid ?? r.instrument_id;
    if (iid !== this.instrumentId) return null;
    const oidValue = r.oid ?? r.order_id;
    const coid = typeof r.coid === 'string' ? r.coid : typeof r.client_order_id === 'string' ? r.client_order_id
      : typeof oidValue === 'number' ? [...this.orders.values()].find((o) => o.oid === oidValue)?.coid ?? null : null;
    if (!coid) return null;
    const order = this.orders.get(coid);
    if (!order) return null;
    const status = String(r.status ?? order.status);
    const price = r.p ?? r.price, qty = r.qty ?? r.quantity, fill = r.fill ?? r.filled_quantity, rest = r.rest ?? r.resting_quantity;
    if (typeof price === 'string') order.price = exact(price, 'order price');
    if (typeof qty === 'string') order.qty = exact(qty, 'order quantity');
    if (typeof fill === 'string') order.filled = exact(fill, 'order fill');
    if (typeof rest === 'string') order.rest = exact(rest, 'order rest');
    const oid = r.oid ?? r.order_id;
    if (typeof oid === 'number') order.oid = oid;
    order.status = status;
    order.updatedAt = this.now();
    order.inFlight = false;
    if (status === 'post_only_rejected') this.postOnlyRejects.set(order.slot, (this.postOnlyRejects.get(order.slot) ?? 0) + 1);
    else if (isActive(status)) this.postOnlyRejects.delete(order.slot);
    if (!isActive(status) || (order.rest.isZero() && status !== 'accepted' && status !== 'pending')) { order.status = isActive(status) ? 'done' : status; this.release(coid); }
    return order;
  }

  applyFills(data: unknown): FillRecord[] {
    const added: FillRecord[] = [];
    for (const value of Array.isArray(data) ? data : [data]) {
      const r = row(value);
      if (r.iid !== this.instrumentId && r.instrument_id !== this.instrumentId) continue;
      const tid = r.tid ?? r.trade_id;
      if (typeof tid !== 'number' || this.seenFills.has(tid)) continue;
      const side = r.side === 'long' || r.side === 'short' ? r.side : null;
      if (!side || typeof r.p !== 'string' && typeof r.price !== 'string') continue;
      const fill: FillRecord = {
        tid, oid: Number(r.oid ?? r.order_id), coid: typeof r.coid === 'string' ? r.coid : null, side,
        price: exact(r.p ?? r.price, 'fill price'), qty: exact(r.qty ?? r.quantity, 'fill quantity'),
        fee: money(r.fee) ?? 0, pnl: money(r.pnl) ?? 0, taker: r.taker === true, ts: Number(r.ts ?? r.timestamp),
      };
      this.seenFills.add(tid);
      this.fills.push(fill);
      added.push(fill);
    }
    while (this.fills.length > 5_000) this.seenFills.delete(this.fills.shift()!.tid);
    return added;
  }

  applyPortfolio(data: unknown): void {
    const r = row(data), margin = row(r.margin);
    const positions = Array.isArray(r.positions) ? r.positions.map(row) : [];
    const mine = positions.find((p) => p.instrument_id === this.instrumentId || p.symbol === this.symbol);
    this.portfolioQty = mine ? exactSigned(mine.size, 'position size') : new D(0);
    const timestamp = typeof r.timestamp === 'number' ? r.timestamp : this.now();
    this.account = {
      entryPrice: mine && typeof mine.entry_price === 'string' ? mine.entry_price : null,
      unrealizedPnl: mine ? money(mine.unrealized_pnl) : 0,
      availableMargin: money(margin.available_order_margin),
      accountValue: money(margin.total_account_value),
      inLiquidation: r.in_liquidation === true,
      portfolioAt: timestamp,
    };
  }

  /**
   * REST snapshot: open orders are authoritative. Own orders missing from it are no longer resting.
   * Returns how many just-submitted orders are still too young to judge; the caller keeps the resync pending.
   */
  applyOpenOrders(rows: unknown, graceMs = 3_000): number {
    let unresolved = 0;
    if (!Array.isArray(rows)) throw new Error('open-orders snapshot is not an array');
    const seen = new Set<string>();
    this.foreign = [];
    for (const value of rows.map(row)) {
      if (value.instrument_id !== this.instrumentId) continue;
      const coid = typeof value.client_order_id === 'string' ? value.client_order_id : null;
      if (coid && this.orders.has(coid)) { seen.add(coid); this.applyOrder(value); continue; }
      this.foreign.push({ oid: Number(value.order_id), coid, side: value.buy ? 'bid' : 'ask', price: String(value.price), rest: String(value.resting_quantity) });
    }
    for (const order of this.orders.values()) {
      if (seen.has(order.coid) || !this.slots.has(order.slot) || this.slots.get(order.slot) !== order.coid) continue;
      if (this.now() - order.updatedAt < graceMs && order.status === 'submitting') { unresolved++; continue; }
      order.status = 'absent'; order.inFlight = false; this.release(order.coid);
    }
    return unresolved;
  }

  // ---------- sequencing ----------
  /**
   * Private frames carry `sq`. Official examples number them contiguously per connection across channels, so a jump
   * past the highest value seen means a missed frame and the caller must resync from REST. If jumps turn out to be
   * routine (more than 5 a minute), gap detection is disabled for the connection and the periodic reconcile remains.
   */
  checkSequence(channel: string, sq: unknown): boolean {
    if (typeof sq !== 'number') return true;
    const last = this.lastSequence;
    this.lastSequence = last === null ? sq : Math.max(last, sq);
    if (last === null || sq <= last + 1 || !this.sequenceTrusted) return true;
    const t = this.now();
    this.gapTimes = [...this.gapTimes.filter((time) => time > t - 60_000), t];
    if (this.gapTimes.length > 5) { this.sequenceTrusted = false; this.onSequenceDistrust?.(); return true; }
    this.markResync(`${channel} sequence gap ${last}→${sq}`);
    return false;
  }
  onSequenceDistrust: (() => void) | null = null;
  resetSequences(): void { this.lastSequence = null; this.gapTimes = []; this.sequenceTrusted = true; }
  markResync(reason: string): void { this.resyncReason ??= reason; }
  needsResync(): string | null { return this.resyncReason; }
  resynced(): void { this.resyncReason = null; }

  // ---------- views ----------
  /** Position = last portfolio snapshot plus own fills newer than it. */
  snapshot(): AccountSnapshot {
    let quantity = this.portfolioQty;
    const since = this.account.portfolioAt ?? 0;
    for (const fill of this.fills) if (fill.ts > since) quantity = fill.side === 'long' ? quantity.plus(fill.qty) : quantity.minus(fill.qty);
    return { positionQty: quantity, ...this.account };
  }

  restingQuotes(): RestingQuote[] {
    const out: RestingQuote[] = [];
    for (const coid of this.slots.values()) {
      const order = this.orders.get(coid);
      if (order && isActive(order.status) && order.rest.gt(0)) out.push({ side: order.side, price: order.price, rest: order.rest });
    }
    return out;
  }
  liveCoids(): string[] { return [...this.slots.values()]; }

  /** PnL since the start of the current reward period, from account value (no transfers are made by the bot). */
  dailyPnl(periodStart: number): number | null {
    const value = this.account.accountValue;
    if (value === null) return null;
    if (!this.equityAnchor || this.equityAnchor.periodStart !== periodStart) this.equityAnchor = { periodStart, value };
    return value - this.equityAnchor.value;
  }

  prune(maxAgeMs = 3_600_000): void {
    const cutoff = this.now() - maxAgeMs;
    for (const [coid, order] of this.orders) if (!this.liveCoids().includes(coid) && order.updatedAt < cutoff) this.orders.delete(coid);
  }
}
