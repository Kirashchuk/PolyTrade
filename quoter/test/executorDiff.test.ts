import { describe, expect, test } from 'bun:test';
import { D } from '../src/decimal.ts';
import { Executor, planActions, prioritize, TokenBucket, type WritePort } from '../src/executor.ts';
import { computeLadder, slotKey, type SlotKey } from '../src/quoteEngine.ts';
import type { WriteOutcome } from '../src/rest.ts';
import type { Operation } from '../src/signer.ts';
import { StateStore } from '../src/state.ts';
import { exampleSettings, market, pltr, silentLog } from './fixtures.ts';

const settings = await exampleSettings();
const instrument = pltr();
const SLOTS: SlotKey[] = [0, 1, 2].flatMap((i) => [slotKey('bid', i), slotKey('ask', i)]);
const ladderAt = (bid: string, ask: string) => computeLadder({ market: market(bid, ask), instrument, positionQty: new D(0), levels: settings.levels, requote: settings.requote, inventory: settings.inventory, session: { sizeMult: 1, bpsAdd: 0 }, sizeScale: 1, extraBps: 0, widenTicks: new Map() });
const opts = { thresholdBps: 0.5, refillRatio: 0.5, allowNew: true };

/** Mark every planned placement as resting on the book, as an `orders` event would. */
function rest(state: StateStore, ladder: ReturnType<typeof ladderAt>) {
  const plan = planActions(ladder, state, instrument, opts, SLOTS);
  for (const p of plan.places) {
    state.registerPlacement(p.slot, p.coid, p.target.side, p.target.price, p.target.qty);
    state.applyOrder({ iid: 45, coid: p.coid, oid: Math.floor(Math.random() * 1e9), p: p.target.price.toFixed(), qty: p.target.qty.toFixed(), rest: p.target.qty.toFixed(), fill: '0', status: 'open' });
  }
}

describe('planActions', () => {
  test('empty book → place every slot; unchanged market → nothing to do', () => {
    const state = new StateStore(45, 'PLTR-USD');
    const ladder = ladderAt('195.76', '195.77');
    expect(planActions(ladder, state, instrument, opts, SLOTS).places).toHaveLength(6);
    rest(state, ladder);
    const again = planActions(ladder, state, instrument, opts, SLOTS);
    expect(again.places.length + again.modifies.length + again.cancels.length).toBe(0);
  });
  test('mid move beyond threshold → modify keeping the client id; qty total includes fills', () => {
    const state = new StateStore(45, 'PLTR-USD');
    rest(state, ladderAt('195.76', '195.77'));
    const bid0 = state.forSlot('bid:0')!;
    state.applyOrder({ iid: 45, coid: bid0.coid, fill: '1', rest: bid0.qty.minus(1).toFixed(), status: 'open' });
    const plan = planActions(ladderAt('195.80', '195.81'), state, instrument, opts, SLOTS);
    expect(plan.places).toHaveLength(0);
    const modify = plan.modifies.find((m) => m.slot === 'bid:0')!;
    expect(modify.coid).toBe(bid0.coid);
    expect(modify.qtyTotal.toFixed()).toBe(new D(1).plus(modify.target.qty).toFixed());
  });
  test('partial fill below the refill ratio → modify to top up at the same price', () => {
    const state = new StateStore(45, 'PLTR-USD');
    const ladder = ladderAt('195.76', '195.77');
    rest(state, ladder);
    const ask1 = state.forSlot('ask:1')!;
    state.applyOrder({ iid: 45, coid: ask1.coid, fill: '4', rest: ask1.qty.minus(4).toFixed(), status: 'open' });
    const plan = planActions(ladder, state, instrument, opts, SLOTS);
    expect(plan.modifies.map((m) => m.slot)).toEqual(['ask:1']);
  });
  test('no target → cancel; in-flight → wait; allowNew=false never places or modifies', () => {
    const state = new StateStore(45, 'PLTR-USD');
    rest(state, ladderAt('195.76', '195.77'));
    expect(planActions(null, state, instrument, opts, SLOTS).cancels).toHaveLength(6);
    state.forSlot('bid:0')!.inFlight = true;
    const plan = planActions(ladderAt('195.90', '195.91'), state, instrument, { ...opts, allowNew: false }, SLOTS);
    expect(plan.waits).toEqual(['bid:0']);
    expect(plan.modifies.length + plan.places.length).toBe(0);
  });
  test('budget keeps nearer bands first; cancels always pass', () => {
    const state = new StateStore(45, 'PLTR-USD');
    const plan = planActions(ladderAt('195.76', '195.77'), state, instrument, opts, SLOTS);
    const limited = prioritize({ ...plan, cancels: [{ slot: null, coid: 'a'.repeat(32), reason: 'x' }] }, 2);
    expect(limited.places.map((p) => p.target.band)).toEqual([1, 1]);
    expect(limited.cancels).toHaveLength(1);
  });
  test('token bucket refills at the configured rate', () => {
    let now = 0;
    const bucket = new TokenBucket(600, () => now);
    expect(bucket.available()).toBe(100);
    bucket.take(100);
    now += 1_000;
    expect(bucket.available()).toBe(10);
  });
});

describe('Executor (mocked transport)', () => {
  const port = (outcomes: WriteOutcome[]) => {
    const sent: Operation[] = [];
    const p: WritePort = { write: async (op) => { sent.push(op); return outcomes.shift() ?? { kind: 'ok', status: 200, body: [] }; } };
    return { p, sent };
  };
  test('places post-only GTC orders and records exchange ids per item', async () => {
    const state = new StateStore(45, 'PLTR-USD');
    const plan = planActions(ladderAt('195.76', '195.77'), state, instrument, opts, SLOTS);
    const body = plan.places.map((x, i) => i === 2 ? { status: 'err', coid: x.coid, error: 'insufficient_margin' } : { status: 'ok', oid: 1000 + i, coid: x.coid });
    const { p, sent } = port([{ kind: 'ok', status: 200, body }]);
    const report = await new Executor(p, state, instrument, silentLog()).execute(plan);
    expect(sent).toHaveLength(1);
    const op = sent[0]!;
    expect(op.type).toBe('createOrders');
    if (op.type === 'createOrders') for (const o of op.args) { expect(o.tif).toBe('gtc'); expect(o.po).toBe(true); expect(o.iid).toBe(45); }
    expect(state.liveCoids()).toHaveLength(5);
    expect(report.errors).toHaveLength(1);
    expect(state.forSlot(plan.places[0]!.slot)!.oid).toBe(1000);
  });
  test('indeterminate write: one attempt, later batches are not sent, resync required', async () => {
    const state = new StateStore(45, 'PLTR-USD');
    state.resynced();
    rest(state, ladderAt('195.76', '195.77'));
    const plan = planActions(null, state, instrument, opts, SLOTS);
    plan.places.push(...planActions(ladderAt('195.76', '195.77'), new StateStore(45, 'PLTR-USD'), instrument, opts, SLOTS).places);
    const { p, sent } = port([{ kind: 'indeterminate', status: null, error: 'socket hang up' }]);
    const report = await new Executor(p, state, instrument, silentLog()).execute(plan);
    expect(sent).toHaveLength(1);
    expect(report.indeterminate).toBe(true);
    expect(state.needsResync()).toContain('indeterminate');
    expect(planActions(ladderAt('195.80', '195.81'), state, instrument, opts, SLOTS).waits).toHaveLength(6); // in flight until reconciled
  });
  test('modify errors: replace-class errors schedule cancel+place, would-cross is skipped', async () => {
    const state = new StateStore(45, 'PLTR-USD');
    rest(state, ladderAt('195.76', '195.77'));
    const plan = planActions(ladderAt('195.90', '195.91'), state, instrument, opts, SLOTS);
    const body = plan.modifies.map((m, i) => i === 0 ? { status: 'err', coid: m.coid, error: 'modify_limit_reached' } : i === 1 ? { status: 'err', coid: m.coid, error: 'modify_would_cross' } : { status: 'ok', order: { iid: 45, coid: m.coid, p: m.target.price.toFixed(), qty: m.qtyTotal.toFixed(), rest: m.target.qty.toFixed(), fill: '0', status: 'open' } });
    const { p } = port([{ kind: 'ok', status: 200, body }]);
    const report = await new Executor(p, state, instrument, silentLog()).execute(plan);
    expect(report.errors).toHaveLength(0);
    expect(state.orders.get(plan.modifies[0]!.coid)!.replace).toBe(true);
    const next = planActions(ladderAt('195.90', '195.91'), state, instrument, opts, SLOTS);
    expect(next.cancels.map((c) => c.coid)).toEqual([plan.modifies[0]!.coid]);
    expect(state.forSlot(plan.modifies[2]!.slot)!.price.toFixed()).toBe(plan.modifies[2]!.target.price.toFixed());
  });
  test('whole-request rejection (one element, no id) applies to every item', async () => {
    const state = new StateStore(45, 'PLTR-USD');
    const plan = planActions(ladderAt('195.76', '195.77'), state, instrument, opts, SLOTS);
    const { p } = port([{ kind: 'ok', status: 200, body: [{ status: 'err', error: 'invalid signature' }] }]);
    const report = await new Executor(p, state, instrument, silentLog()).execute(plan);
    expect(report.errors).toHaveLength(6);
    expect(state.liveCoids()).toHaveLength(0);
  });
});
