import { describe, expect, test } from 'bun:test';
import { D } from '../src/decimal.ts';
import { RiskManager, type RiskInputs } from '../src/risk.ts';
import { StateStore } from '../src/state.ts';
import { exampleSettings } from './fixtures.ts';

const settings = await exampleSettings();
const COID = 'a'.repeat(32);

describe('StateStore', () => {
  test('order events update price/rest; terminal statuses free the slot; post-only rejects are counted', () => {
    const state = new StateStore(45, 'PLTR-USD');
    state.registerPlacement('bid:0', COID, 'bid', new D('195.69'), new D('5.1101'));
    state.applyOrder({ iid: 45, coid: COID, oid: 7, p: '195.69', qty: '5.1101', rest: '5.1101', fill: '0', status: 'open' });
    expect(state.restingQuotes()).toHaveLength(1);
    state.applyOrder({ iid: 99, coid: COID, status: 'filled' }); // other instrument: ignored
    expect(state.liveCoids()).toEqual([COID]);
    state.applyOrder({ iid: 45, coid: COID, status: 'post_only_rejected', rest: '0' });
    expect(state.liveCoids()).toEqual([]);
    expect(state.postOnlyRejects.get('bid:0')).toBe(1);
  });
  test('private sequence gaps (contiguous per connection) require a resync; reconnect resets tracking', () => {
    const state = new StateStore(45, 'PLTR-USD');
    state.resynced();
    expect(state.checkSequence('orders', 10)).toBe(true);
    expect(state.checkSequence('fills', 11)).toBe(true);
    expect(state.checkSequence('portfolio', 12)).toBe(true);
    expect(state.checkSequence('orders', 12)).toBe(true); // duplicate / older: not a gap
    expect(state.checkSequence('orders', 14)).toBe(false);
    expect(state.needsResync()).toContain('gap');
    state.resynced(); state.resetSequences();
    expect(state.checkSequence('orders', 1)).toBe(true);
  });
  test('routine sequence jumps disable gap-triggered resyncs instead of freezing the quoter', () => {
    let now = 0, distrusted = false;
    const state = new StateStore(45, 'PLTR-USD', () => now);
    state.onSequenceDistrust = () => { distrusted = true; };
    state.checkSequence('orders', 0);
    for (let i = 1; i <= 5; i++) { now += 1_000; expect(state.checkSequence('orders', i * 100)).toBe(false); state.resynced(); }
    now += 1_000;
    expect(state.checkSequence('orders', 900)).toBe(true);
    expect(distrusted).toBe(true);
    expect(state.checkSequence('orders', 2_000)).toBe(true);
    expect(state.needsResync()).toBeNull();
  });
  test('order events without a client id are matched by exchange order id', () => {
    const state = new StateStore(45, 'PLTR-USD');
    state.registerPlacement('ask:1', COID, 'ask', new D('196'), new D('5'));
    state.applyOrder({ iid: 45, coid: COID, oid: 77, status: 'open', rest: '5' });
    state.applyOrder({ iid: 45, oid: 77, status: 'open', rest: '3', fill: '2' });
    expect(state.forSlot('ask:1')!.rest.toFixed()).toBe('3');
  });
  test('REST snapshot: missing own orders are released, unknown orders are foreign', () => {
    let now = 10_000;
    const state = new StateStore(45, 'PLTR-USD', () => now);
    state.registerPlacement('ask:0', COID, 'ask', new D('195.84'), new D('5'));
    state.applyOrder({ iid: 45, coid: COID, status: 'open', rest: '5' });
    now += 5_000;
    state.applyOpenOrders([{ order_id: 1, instrument_id: 45, buy: true, price: '190', quantity: '1', resting_quantity: '1', filled_quantity: '0', status: 'open', client_order_id: 'b'.repeat(32) }, { order_id: 2, instrument_id: 46 }], now);
    expect(state.liveCoids()).toEqual([]);
    expect(state.foreign).toHaveLength(1);
  });
  test('position = portfolio snapshot + newer own fills; fills are deduplicated', () => {
    const state = new StateStore(45, 'PLTR-USD');
    state.applyPortfolio({ positions: [{ instrument_id: 45, symbol: 'PLTR-USD', size: '-2.5', entry_price: '195', unrealized_pnl: '1' }], margin: { available_order_margin: '900', total_account_value: '1000' }, in_liquidation: false, timestamp: 1_000 });
    state.applyFills([{ tid: 1, oid: 7, iid: 45, side: 'long', p: '195.7', qty: '1', fee: '0.02', pnl: '0', ts: 900 }, { tid: 2, oid: 7, iid: 45, side: 'long', p: '195.7', qty: '0.5', fee: '0.01', pnl: '0', ts: 1_100 }]);
    state.applyFills({ tid: 2, oid: 7, iid: 45, side: 'long', p: '195.7', qty: '0.5', ts: 1_100 });
    expect(state.snapshot().positionQty.toFixed()).toBe('-2');
    expect(state.snapshot().availableMargin).toBe(900);
    expect(state.dailyPnl(0)).toBe(0);
    state.applyPortfolio({ positions: [], margin: { available_order_margin: '900', total_account_value: '960' }, timestamp: 2_000 });
    expect(state.dailyPnl(0)).toBe(-40);
  });
});

describe('RiskManager', () => {
  const base = (over: Partial<RiskInputs> = {}): RiskInputs => ({
    now: 1_000_000, bookStatus: 'live', publicConnected: true, privateHealthy: true, resyncPending: null, moveBps: 0, inLiquidation: false,
    dailyPnl: 0, availableMargin: 10_000, exchangeCancelOnly: false, instrumentHalted: null, postOnlyRejects: new Map(), proxyExpiresAt: null, deadmanDeadline: null, killSwitch: false, ...over,
  });
  const make = () => { const alerts: string[] = []; return { risk: new RiskManager(settings, (_k, m) => alerts.push(m)), alerts }; };

  test('healthy inputs quote at full size', () => {
    const action = make().risk.evaluate(base());
    expect(action).toMatchObject({ kind: 'quote', sizeScale: 1, extraBps: 0 });
  });
  test('stale or disconnected market data pulls quotes; unreliable private state freezes', () => {
    expect(make().risk.evaluate(base({ bookStatus: 'stale' })).kind).toBe('pull');
    expect(make().risk.evaluate(base({ publicConnected: false })).kind).toBe('pull');
    expect(make().risk.evaluate(base({ resyncPending: 'gap' }))).toMatchObject({ kind: 'freeze', allowCancel: false });
    expect(make().risk.evaluate(base({ privateHealthy: false })).kind).toBe('freeze');
    expect(make().risk.evaluate(base({ exchangeCancelOnly: true }))).toMatchObject({ kind: 'freeze', allowCancel: true });
  });
  test('liquidation, daily loss, settled instrument and kill switch halt permanently', () => {
    for (const over of [{ inLiquidation: true }, { dailyPnl: -201 }, { instrumentHalted: 'instrument settled' }, { killSwitch: true }]) {
      const { risk, alerts } = make();
      expect(risk.evaluate(base(over)).kind).toBe('halt');
      expect(risk.evaluate(base()).kind).toBe('halt');
      expect(alerts.some((a) => a.startsWith('HALT'))).toBe(true);
    }
  });
  test('volatility breaker pauses for pause_s', () => {
    const { risk } = make();
    expect(risk.evaluate(base({ moveBps: 16 })).kind).toBe('pull');
    expect(risk.evaluate(base({ now: 1_000_000 + 29_000 })).kind).toBe('pull');
    expect(risk.evaluate(base({ now: 1_000_000 + 31_000 })).kind).toBe('quote');
  });
  test('low margin scales sizes; repeated post-only rejects widen that slot for for_s', () => {
    const { risk } = make();
    expect(risk.evaluate(base({ availableMargin: 250 }))).toMatchObject({ kind: 'quote', sizeScale: 0.5 });
    const widened = risk.evaluate(base({ postOnlyRejects: new Map([['ask:0', 3]]) }));
    expect(widened.kind === 'quote' && widened.widenTicks.get('ask:0')).toBe(1);
    const later = risk.evaluate(base({ now: 1_000_000 + 11_000 }));
    expect(later.kind === 'quote' && later.widenTicks.size).toBe(0);
  });
  test('proxy credential expiry alerts within 24 h and halts before the deadman window', () => {
    const { risk, alerts } = make();
    expect(risk.evaluate(base({ proxyExpiresAt: 1_000_000 + 3_600_000 })).kind).toBe('quote');
    expect(alerts.some((a) => a.includes('expires'))).toBe(true);
    expect(make().risk.evaluate(base({ proxyExpiresAt: 1_000_000 + 60_000 })).kind).toBe('halt');
  });
});

describe('review regressions', () => {
  const B = 'b'.repeat(32), C = 'c'.repeat(32);
  const open = (coid: string, rest = '5') => ({ order_id: 9, instrument_id: 45, buy: false, price: '195.84', quantity: '5', resting_quantity: rest, filled_quantity: '0', status: 'open', client_order_id: coid });

  test('a snapshot requested before an acknowledged placement cannot drop it', () => {
    let now = 10_000;
    const state = new StateStore(45, 'PLTR-USD', () => now);
    const asOf = now;            // REST request leaves
    now += 200;
    state.registerPlacement('ask:0', B, 'ask', new D('195.84'), new D('5'));
    state.orders.get(B)!.status = 'accepted'; state.orders.get(B)!.rest = new D(5); state.orders.get(B)!.inFlight = false; state.touch(B);
    now += 600;                  // snapshot (taken at asOf) arrives without the order
    state.applyOpenOrders([], asOf);
    expect(state.liveCoids()).toEqual([B]);
  });

  test('an order dropped by a stale view is re-adopted, or cancelled as a stray when its slot was re-placed', () => {
    let now = 10_000;
    const state = new StateStore(45, 'PLTR-USD', () => now);
    state.registerPlacement('ask:0', B, 'ask', new D('195.84'), new D('5'));
    state.applyOrder({ iid: 45, coid: B, status: 'accepted', rest: '5' });
    now += 5_000;
    state.applyOpenOrders([], now - 1);          // B not visible yet → released
    expect(state.liveCoids()).toEqual([]);
    state.applyOpenOrders([open(B)], now);       // B surfaces, slot free → re-adopted
    expect(state.liveCoids()).toEqual([B]);

    now += 5_000;
    state.applyOpenOrders([], now - 1);          // dropped again
    state.registerPlacement('ask:0', C, 'ask', new D('195.85'), new D('5'));
    state.applyOrder({ iid: 45, coid: C, status: 'open', rest: '5' });
    state.applyOrder({ iid: 45, coid: B, status: 'open', rest: '5' });   // the old order still rests
    expect(state.liveCoids()).toEqual([C]);
    expect(state.strays().map((o) => o.coid)).toEqual([B]);
    expect(state.restingQuotes()).toHaveLength(2);
    expect(state.ownLiveCount()).toBe(2);
  });

  test('a portfolio frame without positions or margin keeps the last known values', () => {
    const state = new StateStore(45, 'PLTR-USD');
    state.applyPortfolio({ positions: [{ instrument_id: 45, size: '10', entry_price: '195', unrealized_pnl: '1' }], margin: { available_order_margin: '900', total_account_value: '1000' }, in_liquidation: false, timestamp: 1 });
    state.applyPortfolio({ margin: { available_order_margin: '880' } });
    expect(state.snapshot().positionQty.toFixed()).toBe('10');
    expect(state.snapshot().availableMargin).toBe(880);
    expect(state.snapshot().accountValue).toBe(1000);
    state.applyPortfolio({ withdrawable: '1' });
    expect(state.snapshot().positionQty.toFixed()).toBe('10');
  });

  test('missing fee and PnL stay null', () => {
    const state = new StateStore(45, 'PLTR-USD');
    const [fill] = state.applyFills({ tid: 5, oid: 1, iid: 45, side: 'short', p: '195', qty: '1', ts: 1 });
    expect(fill!.fee).toBeNull();
    expect(fill!.pnl).toBeNull();
  });

  test('a resync requested during a reconcile survives it', () => {
    const state = new StateStore(45, 'PLTR-USD');
    const generation = state.resyncGeneration();
    state.markResync('private stream subscribed');
    state.resynced(generation);
    expect(state.needsResync()).not.toBeNull();
    state.resynced(state.resyncGeneration());
    expect(state.needsResync()).toBeNull();
  });

  test('restored equity anchor keeps the daily loss across restarts', () => {
    const state = new StateStore(45, 'PLTR-USD');
    state.restoreAnchor({ periodStart: 0, value: 1_000 });
    state.applyPortfolio({ margin: { total_account_value: '700' } });
    expect(state.dailyPnl(0)).toBe(-300);
  });
});

describe('risk review regressions', () => {
  const base = (over: Partial<RiskInputs> = {}): RiskInputs => ({
    now: 1_000_000, bookStatus: 'live', publicConnected: true, privateHealthy: true, resyncPending: null, moveBps: 0, inLiquidation: false,
    dailyPnl: 0, availableMargin: 10_000, exchangeCancelOnly: false, instrumentHalted: null, postOnlyRejects: new Map(), proxyExpiresAt: null, deadmanDeadline: null, killSwitch: false, ...over,
  });
  test('a freeze longer than max_freeze_s pulls quotes', () => {
    const risk = new RiskManager(settings, () => {});
    expect(risk.evaluate(base({ resyncPending: 'gap' })).kind).toBe('freeze');
    expect(risk.evaluate(base({ resyncPending: 'gap', now: 1_000_000 + 14_000 })).kind).toBe('freeze');
    expect(risk.evaluate(base({ resyncPending: 'gap', now: 1_000_000 + 16_000 })).kind).toBe('pull');
    expect(risk.evaluate(base({ now: 1_000_000 + 17_000 })).kind).toBe('quote');
    expect(risk.evaluate(base({ resyncPending: 'gap', now: 1_000_000 + 18_000 })).kind).toBe('freeze'); // timer restarted
  });
  test('the volatility breaker is not hidden by a freeze', () => {
    const risk = new RiskManager(settings, () => {});
    expect(risk.evaluate(base({ resyncPending: 'gap', moveBps: 30 })).kind).toBe('pull');
  });
  test('an unrenewed dead man deadline pulls quotes until it is renewed', () => {
    const alerts: string[] = [];
    const risk = new RiskManager(settings, (_k, m) => alerts.push(m));
    expect(risk.evaluate(base({ deadmanDeadline: 1_000_000 + 45_000 })).kind).toBe('quote');
    expect(risk.evaluate(base({ deadmanDeadline: 1_000_000 + 15_000 })).kind).toBe('pull');
    expect(risk.evaluate(base({ deadmanDeadline: 0 })).kind).toBe('pull');
    expect(alerts.some((a) => a.includes('not renewed'))).toBe(true);
    expect(risk.evaluate(base({ deadmanDeadline: 1_000_000 + 60_000 })).kind).toBe('quote');
  });
});
