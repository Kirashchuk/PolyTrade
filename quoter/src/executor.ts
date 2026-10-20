import { bpsBetween, D, wire, type Dec } from './decimal.ts';
import { floorQty, type Instrument } from './instruments.ts';
import { errorText, type Logger } from './log.ts';
import type { SlotKey, TargetLadder, TargetQuote } from './quoteEngine.ts';
import type { WriteOutcome } from './rest.ts';
import { bandOf } from './rewards.ts';
import { newClientOrderId, type CreateOrderArgs, type ModifyArgs, type Operation } from './signer.ts';
import { isActive, type OwnOrder, type StateStore } from './state.ts';

export interface PlannedPlace { slot: SlotKey; coid: string; target: TargetQuote; }
export interface PlannedModify { slot: SlotKey; coid: string; target: TargetQuote; qtyTotal: Dec; }
export interface PlannedCancel { slot: SlotKey | null; coid: string; reason: string; }
export interface Plan { cancels: PlannedCancel[]; modifies: PlannedModify[]; places: PlannedPlace[]; waits: SlotKey[]; }
export interface PlanOptions { thresholdBps: number; refillRatio: number; allowNew: boolean; }

/**
 * Pure diff between the target ladder and live slots (spec §6). One live order per (side, level).
 * Prefers modify over cancel+place so the order never leaves the book.
 */
export function planActions(ladder: TargetLadder | null, state: StateStore, instrument: Instrument, options: PlanOptions, slotsInUse: Iterable<SlotKey>): Plan {
  const plan: Plan = { cancels: [], modifies: [], places: [], waits: [] };
  const targets = new Map<SlotKey, TargetQuote>((ladder?.quotes ?? []).map((q) => [q.slot, q]));
  const slots = new Set<SlotKey>([...slotsInUse, ...targets.keys()]);
  for (const slot of slots) {
    const target = targets.get(slot) ?? null;
    const live = state.forSlot(slot);
    if (live?.inFlight) { plan.waits.push(slot); continue; }
    const resting = live && isActive(live.status) ? live : null;
    if (!target) { if (resting) plan.cancels.push({ slot, coid: resting.coid, reason: 'no target' }); continue; }
    if (!resting) { if (options.allowNew) plan.places.push({ slot, coid: newClientOrderId(), target }); continue; }
    if (resting.replace) { plan.cancels.push({ slot, coid: resting.coid, reason: 'replace' }); continue; }
    if (!options.allowNew) continue;
    if (!needsModify(resting, target, ladder!, instrument, options)) continue;
    // The modify carries the total quantity; filled + target can exceed five significant digits, so round it down.
    const qtyTotal = floorQty(instrument, resting.filled.plus(target.qty));
    if (qtyTotal.lte(resting.filled)) plan.cancels.push({ slot, coid: resting.coid, reason: 'replace' });
    else plan.modifies.push({ slot, coid: resting.coid, target, qtyTotal });
  }
  // Own orders resting outside their slot (a slot was re-placed before the old order surfaced) are always cancelled.
  for (const stray of state.strays()) if (!stray.inFlight) plan.cancels.push({ slot: null, coid: stray.coid, reason: 'stray' });
  return plan;
}

function needsModify(live: OwnOrder, target: TargetQuote, ladder: TargetLadder, instrument: Instrument, options: PlanOptions): boolean {
  if (live.price.eq(target.price) && live.rest.gte(target.qty.mul(options.refillRatio)) && live.rest.lte(target.qty)) return false;
  const moveBps = bpsBetween(live.price, target.price, ladder.mid);
  const liveBand = bandOf(live.side, live.price, ladder.mid, instrument.priceDecimals);
  return moveBps >= options.thresholdBps || liveBand === 0 || liveBand > target.band || live.rest.lt(target.qty.mul(options.refillRatio)) || live.rest.gt(target.qty);
}

/** Action-weight budget (spec §6): place and modify cost 1, cancel costs 0. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private perMinute: number, private readonly now: () => number = Date.now) { this.tokens = perMinute / 6; this.last = now(); }
  setRate(perMinute: number): void { this.perMinute = Math.max(1, perMinute); }
  private refill() { const t = this.now(); this.tokens = Math.min(this.perMinute / 6, this.tokens + (t - this.last) * this.perMinute / 60_000); this.last = t; }
  available(): number { this.refill(); return Math.floor(this.tokens); }
  take(count: number): void { this.refill(); this.tokens -= count; }
}

/** Fit modifies/places into the budget: nearer bands first, cancels always pass. */
export function prioritize(plan: Plan, budget: number): Plan {
  const weighted = [...plan.modifies.map((m) => ({ kind: 'modify' as const, band: m.target.band, item: m })), ...plan.places.map((p) => ({ kind: 'place' as const, band: p.target.band, item: p }))]
    .sort((a, b) => a.band - b.band);
  const kept = weighted.slice(0, Math.max(0, budget));
  return {
    cancels: plan.cancels,
    modifies: kept.filter((k) => k.kind === 'modify').map((k) => k.item as PlannedModify),
    places: kept.filter((k) => k.kind === 'place').map((k) => k.item as PlannedPlace),
    waits: plan.waits,
  };
}

export interface WritePort { write(op: Operation): Promise<WriteOutcome>; }
export interface ExecutionReport { sent: number; indeterminate: boolean; errors: string[]; }

const REPLACE_ERRORS = new Set(['order_not_modifiable', 'modify_limit_reached', 'modify_quantity_not_above_filled', 'order_has_tpsl']);
const GONE_ERRORS = new Set(['order_not_in_orderbook', 'order_already_terminal', 'order_not_found', 'order_unknown']);

/**
 * Sends one batch per operation type: cancels, then modifies, then places. Each signed batch gets exactly
 * one attempt. Any indeterminate outcome stops the cycle and requires a REST reconcile before more writes.
 * Once `active()` turns false (the instrument is stopping) no further modify or place batch is sent.
 */
export class Executor {
  constructor(private readonly port: WritePort, private readonly state: StateStore, private readonly instrument: Instrument, private readonly log: Logger, private readonly active: () => boolean = () => true) {}

  async execute(plan: Plan): Promise<ExecutionReport> {
    const report: ExecutionReport = { sent: 0, indeterminate: false, errors: [] };
    if (plan.cancels.length) {
      const coids = plan.cancels.map((c) => c.coid);
      for (const coid of coids) { const o = this.state.orders.get(coid); if (o) { o.inFlight = true; this.state.touch(coid); } }
      const outcome = await this.port.write({ type: 'cancelOrdersCOID', args: coids });
      report.sent++;
      if (!this.settle('cancel', outcome, coids, report, (coid, result) => {
        const order = this.state.orders.get(coid);
        if (!order) return;
        order.inFlight = false;
        this.state.touch(coid);
        if (result.status === 'ok' || GONE_ERRORS.has(String(result.error))) { order.status = 'cancelled'; order.rest = new D(0); this.state.release(coid); }
        else report.errors.push(`cancel ${coid}: ${result.error}`);
      })) return report;
    }
    if (plan.modifies.length && this.active()) {
      const args: ModifyArgs[] = plan.modifies.map((m) => ({ coid: m.coid, p: wire(m.target.price), qty: wire(m.qtyTotal) }));
      for (const m of plan.modifies) { const o = this.state.orders.get(m.coid); if (o) { o.inFlight = true; this.state.touch(m.coid); } }
      const outcome = await this.port.write({ type: 'modifyOrdersCOID', args });
      report.sent++;
      if (!this.settle('modify', outcome, args.map((a) => a.coid), report, (coid, result) => {
        const order = this.state.orders.get(coid);
        if (!order) return;
        order.inFlight = false;
        if (result.status === 'ok') { if (result.order) this.state.applyOrder(result.order); return; }
        const error = String(result.error);
        if (REPLACE_ERRORS.has(error)) order.replace = true;
        else if (GONE_ERRORS.has(error)) { order.status = 'absent'; this.state.release(coid); }
        else if (error !== 'modify_would_cross' && error !== 'modify_no_op' && error !== 'order_in_flight' && error !== 'modify_already_pending') report.errors.push(`modify ${coid}: ${error}`);
      })) return report;
    }
    if (plan.places.length && this.active()) {
      const args: CreateOrderArgs[] = plan.places.map((p) => ({ iid: this.instrument.id, buy: p.target.side === 'bid', p: wire(p.target.price), qty: wire(p.target.qty), tif: 'gtc', po: true, c: p.coid }));
      for (const p of plan.places) this.state.registerPlacement(p.slot, p.coid, p.target.side, p.target.price, p.target.qty);
      const outcome = await this.port.write({ type: 'createOrders', args });
      report.sent++;
      const settled = this.settle('place', outcome, args.map((a) => a.c), report, (coid, result) => {
        const order = this.state.orders.get(coid);
        if (!order) return;
        order.inFlight = false;
        if (result.status === 'ok') {
          this.state.touch(coid);
          if (typeof result.oid === 'number') order.oid = result.oid;
          if (order.status === 'submitting') { order.status = 'accepted'; order.rest = order.qty; }
        } else { order.status = `rejected:${result.error}`; this.state.release(coid); report.errors.push(`place ${coid}: ${result.error}`); }
      });
      // Unknown outcome: the orders may still be created, so their slots stay reserved until the exchange says.
      if (!settled) for (const coid of args.map((a) => a.c)) this.state.markUnconfirmed(coid);
    }
    return report;
  }

  /**
   * Map a batch outcome onto its items. Returns false when the cycle must stop.
   * Indeterminate: items stay in flight until the REST reconcile resolves them.
   */
  private settle(kind: BatchKind, outcome: WriteOutcome, coids: string[], report: ExecutionReport, apply: (coid: string, result: ItemResult) => void): boolean {
    if (outcome.kind === 'indeterminate') {
      report.indeterminate = true;
      this.state.markResync(`indeterminate write: ${outcome.error}`);
      this.log.error('indeterminate write; halting writes until reconcile', { error: outcome.error, status: outcome.status, coids });
      return false;
    }
    if (outcome.kind === 'rejected') {
      for (const coid of coids) apply(coid, { status: 'err', error: outcome.error });
      return true;
    }
    const results = Array.isArray(outcome.body) ? outcome.body as ItemResult[] : null;
    if (!results) { // single-object acknowledgement (cancelAll-like) or malformed
      report.indeterminate = true; this.state.markResync('unexpected acknowledgement shape');
      return false;
    }
    if (results.length !== coids.length) {
      // Whole-request rejection is a one-element array without an order identifier.
      const whole = results.length === 1 && results[0]?.status === 'err' && !results[0].coid && results[0].oid === undefined;
      if (whole) { for (const coid of coids) apply(coid, { status: 'err', error: results[0]!.error ?? 'rejected' }); return true; }
      report.indeterminate = true; this.state.markResync('acknowledgement count mismatch');
      return false;
    }
    const malformed = results.findIndex((result, index) => !validItem(kind, result, coids[index]!));
    if (malformed >= 0) {
      report.indeterminate = true; this.state.markResync('malformed acknowledgement item');
      this.log.error('malformed acknowledgement; outcome unknown until reconcile', { kind, index: malformed, item: JSON.stringify(results[malformed]).slice(0, 200) });
      return false;
    }
    results.forEach((result, index) => {
      try { apply(coids[index]!, result); } catch (error) { report.errors.push(errorText(error)); }
    });
    return true;
  }
}

export interface ItemResult { status: 'ok' | 'err'; oid?: number; coid?: string; error?: string; order?: unknown; }
type BatchKind = 'cancel' | 'modify' | 'place';

/** An item counts only in the documented shape for its position; anything else leaves the outcome unknown. */
function validItem(kind: BatchKind, value: unknown, coid: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.coid !== undefined && item.coid !== coid) return false;
  if (item.status === 'err') return typeof item.error === 'string' && item.error.length > 0;
  if (item.status !== 'ok') return false;
  if (kind === 'place') return typeof item.oid === 'number';
  if (kind === 'modify') {
    const order = item.order;
    return !!order && typeof order === 'object' && !Array.isArray(order) && ((order as { coid?: unknown }).coid === undefined || (order as { coid?: unknown }).coid === coid);
  }
  return true;
}
