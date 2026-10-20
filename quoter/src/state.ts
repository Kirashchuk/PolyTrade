import { D, exact, exactSigned, type Dec } from './decimal.ts';
import type { SlotKey } from './quoteEngine.ts';
import type { RestingQuote, Side } from './rewards.ts';

/** Statuses that mean the order may still rest. Everything else is terminal. */
const ACTIVE = new Set(['open', 'accepted', 'pending', 'partial', 'partially_filled', 'new']);
export const isActive = (status: string): boolean => ACTIVE.has(status);

export interface OwnOrder {
  coid: string; oid: number | null; slot: SlotKey; side: Side;
  price: Dec; qty: Dec; filled: Dec; rest: Dec; status: string;
  /** Last local write or exchange update; a REST snapshot older than this cannot judge the order. */
  updatedAt: number;
  /** Set while a write for this order is unacknowledged. */
  inFlight: boolean;
  /** Next action for the slot must be cancel + place (e.g. modify limit reached). */
  replace: boolean;
  /** Exchange update time (`uts`) of the newest order state applied; older reports are ignored. */
  uts: number | null;
  /**
   * Set when the create outcome is unknown (transport failure, malformed acknowledgement). Until the exchange reports
   * the order or its signature can no longer execute, the slot stays reserved and no replacement is placed.
   */
  unconfirmedUntil: number | null;
}
export interface ForeignOrder { oid: number; coid: string | null; side: Side; price: string; rest: string; }
/** Missing fee or PnL stays null, never 0. */
export interface FillRecord { tid: number; oid: number; coid: string | null; side: 'long' | 'short'; price: Dec; qty: Dec; fee: number | null; pnl: number | null; taker: boolean; ts: number; }
export interface AccountSnapshot {
  positionQty: Dec; entryPrice: string | null; unrealizedPnl: number | null;
  availableMargin: number | null; accountValue: number | null; inLiquidation: boolean;
  portfolioAt: number | null;
}
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const money = (value: unknown): number | null => typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
/** A signed operation expires 5 minutes after its `ts`; a margin covers clock offset and transit. */
export const UNCONFIRMED_HOLD_MS = 330_000;

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
  /** Exchange timestamps of the newest applied portfolio data: a slower, older snapshot never replaces it. */
  private positionsTs: number | null = null;
  private marginTs: number | null = null;
  private resyncReason: string | null = 'initial snapshot';
  readonly postOnlyRejects = new Map<SlotKey, number>();

  constructor(readonly instrumentId: number, readonly symbol: string, private readonly now: () => number = Date.now) {}

  // ---------- intents ----------
  registerPlacement(slot: SlotKey, coid: string, side: Side, price: Dec, qty: Dec): void {
    this.orders.set(coid, { coid, oid: null, slot, side, price, qty, filled: new D(0), rest: new D(0), status: 'submitting', updatedAt: this.now(), inFlight: true, replace: false, uts: null, unconfirmedUntil: null });
    this.slots.set(slot, coid);
  }
  /** A local write touched the order: snapshots requested before now cannot judge it. */
  touch(coid: string): void { const order = this.orders.get(coid); if (order) order.updatedAt = this.now(); }
  /** The create outcome is unknown: keep the slot until the exchange reports the order or it can no longer execute. */
  markUnconfirmed(coid: string): void { const order = this.orders.get(coid); if (order && order.status === 'submitting') order.unconfirmedUntil = this.now() + UNCONFIRMED_HOLD_MS; }
  unconfirmed(): OwnOrder[] { return [...this.orders.values()].filter((o) => o.unconfirmedUntil !== null); }
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
  /**
   * Order update from the private `orders` channel, a modify acknowledgement or a REST row.
   * An own order that turns out to rest after it left its slot is re-adopted when the slot is free,
   * otherwise it becomes a stray that the planner cancels; it is never left unmanaged.
   */
  applyOrder(data: unknown): OwnOrder | null {
    const r = row(data);
    if ((r.iid ?? r.instrument_id) !== this.instrumentId) return null;
    const oid = r.oid ?? r.order_id;
    const coid = typeof r.coid === 'string' ? r.coid : typeof r.client_order_id === 'string' ? r.client_order_id
      : typeof oid === 'number' ? [...this.orders.values()].find((o) => o.oid === oid)?.coid ?? null : null;
    const order = coid ? this.orders.get(coid) : undefined;
    if (!order) return null;
    const uts = typeof r.uts === 'number' ? r.uts : typeof r.updated_timestamp === 'number' ? r.updated_timestamp : null;
    if (uts !== null && order.uts !== null && uts < order.uts) return order; // e.g. a late modify ack after a newer fill event
    const status = String(r.status ?? order.status);
    const price = r.p ?? r.price, qty = r.qty ?? r.quantity, fill = r.fill ?? r.filled_quantity, rest = r.rest ?? r.resting_quantity;
    if (typeof price === 'string') order.price = exact(price, 'order price');
    if (typeof qty === 'string') order.qty = exact(qty, 'order quantity');
    if (typeof fill === 'string') order.filled = exact(fill, 'order fill');
    if (typeof rest === 'string') order.rest = exact(rest, 'order rest');
    if (typeof oid === 'number') order.oid = oid;
    if (uts !== null) order.uts = uts;
    order.status = status;
    order.updatedAt = this.now();
    order.inFlight = false;
    order.unconfirmedUntil = null; // the exchange knows the order: its creation is settled
    if (status === 'post_only_rejected') this.postOnlyRejects.set(order.slot, (this.postOnlyRejects.get(order.slot) ?? 0) + 1);
    else if (isActive(status)) this.postOnlyRejects.delete(order.slot);
    const resting = isActive(status) && (order.rest.gt(0) || status === 'accepted' || status === 'pending');
    if (!resting) {
      if (isActive(status)) order.status = 'done';
      order.rest = new D(0);
      this.release(order.coid);
    } else if (this.slots.get(order.slot) !== order.coid && !this.slots.has(order.slot)) {
      this.slots.set(order.slot, order.coid); // re-adopt into its free slot
    }
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
        fee: money(r.fee), pnl: money(r.pnl), taker: r.taker === true, ts: Number(r.ts ?? r.timestamp),
      };
      this.seenFills.add(tid);
      this.fills.push(fill);
      added.push(fill);
    }
    while (this.fills.length > 5_000) this.seenFills.delete(this.fills.shift()!.tid);
    return added;
  }

  /**
   * Portfolio snapshot or partial frame: only the fields present are applied; nothing is reset by omission.
   * Data older (by exchange `timestamp`) than what is already applied is ignored, so a slow REST reply cannot
   * roll back a newer stream frame.
   */
  applyPortfolio(data: unknown): void {
    const r = row(data), margin = r.margin === undefined ? null : row(r.margin);
    const at = typeof r.timestamp === 'number' ? r.timestamp : null;
    const newer = (last: number | null) => at === null || last === null || at >= last;
    const next = { ...this.account };
    if (Array.isArray(r.positions) && newer(this.positionsTs)) {
      if (at !== null) this.positionsTs = at;
      const mine = r.positions.map(row).find((p) => p.instrument_id === this.instrumentId || p.symbol === this.symbol);
      this.portfolioQty = mine ? exactSigned(mine.size, 'position size') : new D(0);
      next.entryPrice = mine && typeof mine.entry_price === 'string' ? mine.entry_price : null;
      next.unrealizedPnl = mine ? money(mine.unrealized_pnl) : 0;
      next.portfolioAt = typeof r.timestamp === 'number' ? r.timestamp : this.now();
    }
    if ((margin || typeof r.in_liquidation === 'boolean') && newer(this.marginTs)) {
      if (at !== null) this.marginTs = at;
      if (margin?.available_order_margin !== undefined) next.availableMargin = money(margin.available_order_margin);
      if (margin?.total_account_value !== undefined) next.accountValue = money(margin.total_account_value);
      if (typeof r.in_liquidation === 'boolean') next.inLiquidation = r.in_liquidation;
    }
    this.account = next;
  }

  /**
   * REST snapshot requested at `asOf`: open orders are authoritative for own orders the bot did not touch since.
   * Orders written or updated after `asOf` (or just submitted) cannot be judged by it and count as unresolved.
   */
  applyOpenOrders(rows: unknown, asOf: number, graceMs = 3_000): number {
    if (!Array.isArray(rows)) throw new Error('open-orders snapshot is not an array');
    let unresolved = 0;
    const seen = new Set<string>();
    this.foreign = [];
    for (const value of rows.map(row)) {
      if (value.instrument_id !== this.instrumentId) continue;
      const coid = typeof value.client_order_id === 'string' ? value.client_order_id : null;
      if (coid && this.orders.has(coid)) {
        seen.add(coid);
        if (this.orders.get(coid)!.updatedAt < asOf) this.applyOrder(value);
        continue;
      }
      this.foreign.push({ oid: Number(value.order_id), coid, side: value.buy ? 'bid' : 'ask', price: String(value.price), rest: String(value.resting_quantity) });
    }
    for (const order of this.orders.values()) {
      if (seen.has(order.coid) || !isActive(order.status) && order.status !== 'submitting') continue;
      // Newer than the snapshot: stream data wins; only an unacknowledged write stays unresolved.
      if (order.updatedAt >= asOf) { if (order.inFlight || order.status === 'submitting') unresolved++; continue; }
      // Absence from open orders does not prove an unconfirmed create will not execute: its slot stays reserved.
      if (order.unconfirmedUntil !== null && this.now() < order.unconfirmedUntil) continue;
      if (order.status === 'submitting' && order.unconfirmedUntil === null && this.now() - order.updatedAt < graceMs) { unresolved++; continue; }
      order.status = 'absent'; order.rest = new D(0); order.inFlight = false; order.unconfirmedUntil = null; this.release(order.coid);
    }
    return unresolved;
  }

  // ---------- resync ----------
  private resyncGen = 0;
  markResync(reason: string): void { this.resyncGen++; this.resyncReason ??= reason; }
  needsResync(): string | null { return this.resyncReason; }
  resyncGeneration(): number { return this.resyncGen; }
  /** Clears the pending resync, unless something asked for another one after `generation` was read. */
  resynced(generation?: number): void { if (generation === undefined || generation === this.resyncGen) this.resyncReason = null; }

  // ---------- views ----------
  /** Position = last portfolio snapshot plus own fills newer than it. */
  snapshot(): AccountSnapshot {
    let quantity = this.portfolioQty;
    const since = this.account.portfolioAt ?? 0;
    for (const fill of this.fills) if (fill.ts > since) quantity = fill.side === 'long' ? quantity.plus(fill.qty) : quantity.minus(fill.qty);
    return { positionQty: quantity, ...this.account };
  }

  private activeOrders(): OwnOrder[] { return [...this.orders.values()].filter((o) => isActive(o.status) && (o.rest.gt(0) || o.status === 'accepted')); }
  /** Every own order that may rest, in a slot or not (score and exposure count both). */
  restingQuotes(): RestingQuote[] {
    return this.activeOrders().filter((o) => o.rest.gt(0)).map((o) => ({ side: o.side, price: o.price, rest: o.rest }));
  }
  liveCoids(): string[] { return [...this.slots.values()]; }
  /** Own orders that rest outside their slot (a duplicate of a re-placed slot): to be cancelled. */
  strays(): OwnOrder[] { return this.activeOrders().filter((o) => this.slots.get(o.slot) !== o.coid); }
  /** Own orders known to rest or be acknowledged; an unconfirmed create is not known to exist (see `unconfirmed`). */
  ownLiveCount(): number { return this.liveCoids().filter((coid) => this.orders.get(coid)?.unconfirmedUntil === null).length + this.strays().length; }

  /** Drop finished orders older than `maxAgeMs`; resting and in-flight orders are always kept. */
  prune(maxAgeMs = 600_000): void {
    const cutoff = this.now() - maxAgeMs, keep = new Set([...this.liveCoids(), ...this.activeOrders().map((o) => o.coid)]);
    for (const [coid, order] of this.orders) if (!keep.has(coid) && !order.inFlight && order.updatedAt < cutoff) this.orders.delete(coid);
  }
}
