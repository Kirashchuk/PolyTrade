import { describe, expect, test } from 'bun:test';
import { AccountStore } from '../src/account.ts';
import { parseSettings } from '../src/config.ts';
import { Deadman } from '../src/deadman.ts';
import { D } from '../src/decimal.ts';
import { Executor, planActions, type WritePort } from '../src/executor.ts';
import { MarketBook, type Level } from '../src/marketData.ts';
import { Metrics } from '../src/metrics.ts';
import { computeLadder, slotKey, type SlotKey } from '../src/quoteEngine.ts';
import type { WriteOutcome } from '../src/rest.ts';
import type { Operation } from '../src/signer.ts';
import { StateStore, UNCONFIRMED_HOLD_MS } from '../src/state.ts';
import { exampleSettings, market, pltr, silentLog } from './fixtures.ts';

/** Regressions for docs/code-review-2026-10-20-8ab9520.md (findings re-checked against 3ed5056). */
const settings = await exampleSettings();
const instrument = pltr();
const SLOTS: SlotKey[] = [0, 1, 2].flatMap((i) => [slotKey('bid', i), slotKey('ask', i)]);
const opts = { thresholdBps: 0.5, refillRatio: 0.5, allowNew: true };
const ladderAt = (bid: string, ask: string) => computeLadder({ market: market(bid, ask), instrument, positionQty: new D(0), levels: settings.levels, requote: settings.requote, inventory: settings.inventory, session: { sizeMult: 1, bpsAdd: 0 }, sizeScale: 1, extraBps: 0, widenTicks: new Map() });
const port = (reply: (op: Operation) => Promise<WriteOutcome> | WriteOutcome) => {
  const sent: Operation[] = [];
  const p: WritePort = { write: async (op) => { sent.push(op); return reply(op); } };
  return { p, sent };
};
const C = 'c'.repeat(32);

describe('#2 stopping blocks later batches of a running cycle', () => {
  test('after the cancel batch returns into a stopping instrument, no modify or place batch is sent', async () => {
    const state = new StateStore(45, 'PLTR-USD');
    state.registerPlacement('bid:0', C, 'bid', new D('195.69'), new D('5.1101'));
    state.applyOrder({ iid: 45, coid: C, oid: 1, p: '195.69', qty: '5.1101', rest: '5.1101', fill: '0', status: 'open' });
    let active = true;
    const { p, sent } = port(() => { active = false; return { kind: 'ok', status: 200, body: [{ status: 'ok', oid: 1, coid: C, ts: 1 }] }; });
    const plan = planActions(ladderAt('195.76', '195.77'), new StateStore(45, 'PLTR-USD'), instrument, opts, SLOTS);
    const report = await new Executor(p, state, instrument, silentLog(), () => active).execute({ ...plan, cancels: [{ slot: 'bid:0', coid: C, reason: 'test' }] });
    expect(sent.map((op) => op.type)).toEqual(['cancelOrdersCOID']);
    expect(report.sent).toBe(1);
    expect([...state.orders.values()].filter((o) => o.status === 'submitting')).toHaveLength(0); // nothing registered
  });
});

describe('#3 an unconfirmed create keeps its slot until the exchange settles it', () => {
  test('absent from open orders after the grace period: slot stays reserved, nothing is re-placed', async () => {
    let now = 10_000;
    const state = new StateStore(45, 'PLTR-USD', () => now);
    state.resynced();
    const plan = planActions(ladderAt('195.76', '195.77'), state, instrument, opts, SLOTS);
    const { p } = port(() => ({ kind: 'indeterminate', status: null, error: 'socket hang up' }));
    await new Executor(p, state, instrument, silentLog()).execute(plan);
    expect(state.unconfirmed()).toHaveLength(6);
    now += 10_000;
    expect(state.applyOpenOrders([], now - 1)).toBe(0);       // not counted as unresolved: the instrument resumes
    expect(state.liveCoids()).toHaveLength(6);                  // ...but every slot stays reserved
    expect(state.ownLiveCount()).toBe(0);                       // not known to rest: a pull does not loop on them
    const next = planActions(ladderAt('195.76', '195.77'), state, instrument, opts, SLOTS);
    expect(next.places).toHaveLength(0);
    expect(next.waits).toHaveLength(6);
  });
  test('resolved by an exchange report (order history), or released once the signature can no longer execute', () => {
    let now = 10_000;
    const state = new StateStore(45, 'PLTR-USD', () => now);
    const D2 = 'd'.repeat(32);
    state.registerPlacement('bid:0', C, 'bid', new D('195.69'), new D('5'));
    state.registerPlacement('ask:0', D2, 'ask', new D('195.84'), new D('5'));
    state.markUnconfirmed(C); state.markUnconfirmed(D2);
    state.applyOrder({ order_id: 7, instrument_id: 45, client_order_id: C, price: '195.69', quantity: '5', resting_quantity: '0', filled_quantity: '0', status: 'cancelled', updated_timestamp: 10_500 });
    expect(state.unconfirmed().map((o) => o.coid)).toEqual([D2]);
    expect(state.forSlot('bid:0')).toBeNull();
    now += UNCONFIRMED_HOLD_MS + 1;
    state.applyOpenOrders([], now - 1);
    expect(state.unconfirmed()).toHaveLength(0);
    expect(state.liveCoids()).toHaveLength(0);
  });
});

describe('#4 every acknowledgement item is validated', () => {
  test('`{}` items leave the creates unconfirmed instead of rejected', async () => {
    const state = new StateStore(45, 'PLTR-USD');
    state.resynced();
    const plan = planActions(ladderAt('195.76', '195.77'), state, instrument, opts, SLOTS);
    const { p } = port(() => ({ kind: 'ok', status: 200, body: plan.places.map(() => ({})) }));
    const report = await new Executor(p, state, instrument, silentLog()).execute(plan);
    expect(report.indeterminate).toBe(true);
    expect(state.needsResync()).toContain('malformed');
    expect(state.liveCoids()).toHaveLength(6);
    expect(state.unconfirmed()).toHaveLength(6);
  });
  test('an echoed client id in the wrong position is not trusted', async () => {
    const state = new StateStore(45, 'PLTR-USD');
    const plan = planActions(ladderAt('195.76', '195.77'), state, instrument, opts, SLOTS);
    const body = plan.places.map((x, i) => ({ status: 'ok', oid: i, coid: plan.places[(i + 1) % plan.places.length]!.coid }));
    const report = await new Executor(port(() => ({ kind: 'ok', status: 200, body })).p, state, instrument, silentLog()).execute(plan);
    expect(report.indeterminate).toBe(true);
    expect(state.unconfirmed()).toHaveLength(6);
  });
});

describe('#5 book freshness uses the exchange timestamp', () => {
  test('a book whose event time is 99 s old is stale even if it just arrived; ets=0 falls back to receive time', () => {
    const t = 1_000_000;
    const book = new MarketBook(45, { staleMs: 2_000, now: () => t, exchangeNow: () => t });
    book.ingest({ ch: 'book::45', ts: t, ets: t - 99_000, sq: 1, data: { b: [['195.76', '1']], a: [['195.77', '1']] } });
    expect(book.snapshot().status).toBe('stale');
    book.ingest({ ch: 'book::45', ts: t, ets: t - 100, sq: 2, data: { b: [['195.76', '1']], a: [['195.77', '1']] } });
    expect(book.snapshot().status).toBe('live');
    book.ingest({ ch: 'book::45', ts: t - 99_000, ets: 0, sq: 3, data: { b: [['195.76', '1']], a: [['195.77', '1']] } });
    expect(book.snapshot().status).toBe('live');
  });
});

describe('#6 an older portfolio snapshot never replaces newer data', () => {
  test('a late REST reply does not roll back position and equity from a newer stream frame', () => {
    const state = new StateStore(45, 'PLTR-USD'), account = new AccountStore();
    const ws = { positions: [{ instrument_id: 45, symbol: 'PLTR-USD', size: '30', entry_price: '195', unrealized_pnl: '0' }], margin: { available_order_margin: '500', total_account_value: '700' }, in_liquidation: false, timestamp: 2_000 };
    const rest = { positions: [], margin: { available_order_margin: '900', total_account_value: '1000' }, in_liquidation: false, timestamp: 1_000 };
    for (const frame of [ws, rest]) { state.applyPortfolio(frame); account.applyPortfolio(frame); }
    expect(state.snapshot().positionQty.toFixed()).toBe('30');
    expect(state.snapshot().accountValue).toBe(700);
    expect(account.snapshot()).toMatchObject({ accountValue: 700, availableMargin: 500, portfolioAt: 2_000 });
    state.applyPortfolio({ ...rest, timestamp: 3_000 });
    expect(state.snapshot().positionQty.toFixed()).toBe('0');
  });
});

describe('#7 a stale modify acknowledgement does not undo a newer order event', () => {
  test('an ack older (uts) than the applied fill event is ignored', () => {
    const state = new StateStore(45, 'PLTR-USD');
    state.registerPlacement('bid:0', C, 'bid', new D('195.69'), new D('5'));
    state.applyOrder({ iid: 45, coid: C, oid: 1, p: '195.70', qty: '5', rest: '0', fill: '5', status: 'filled', uts: 200 });
    state.applyOrder({ iid: 45, coid: C, oid: 1, p: '195.70', qty: '5', rest: '5', fill: '0', status: 'open', uts: 150 });
    const order = state.orders.get(C)!;
    expect(order.status).toBe('filled');
    expect(order.filled.toFixed()).toBe('5');
    expect(state.forSlot('bid:0')).toBeNull();
  });
});

describe('#8 the modify total stays on the quantity grid', () => {
  test('filled 5.0001 + target 5.109 is sent as 10.109 (five significant digits)', () => {
    const state = new StateStore(45, 'PLTR-USD');
    const ladder = ladderAt('195.80', '195.81');
    const target = ladder.quotes.find((q) => q.slot === 'bid:0')!;
    const qty = new D('5.109');
    state.registerPlacement('bid:0', C, 'bid', new D('195.60'), qty.plus('5.0001'));
    state.applyOrder({ iid: 45, coid: C, oid: 1, p: '195.60', qty: qty.plus('5.0001').toFixed(), rest: '5.109', fill: '5.0001', status: 'open' });
    const plan = planActions({ ...ladder, quotes: [{ ...target, qty }] }, state, instrument, opts, ['bid:0']);
    expect(plan.modifies).toHaveLength(1);
    expect(plan.modifies[0]!.qtyTotal.toFixed()).toBe('10.109');
  });
});

describe('#11 disarm waits for an in-flight re-arm', () => {
  test('a slow re-arm cannot land after the disarm', async () => {
    let applied = null as number | null;
    const deadman = new Deadman({
      write: async (op) => {
        const time = (op.args as { time: number }).time;
        await Bun.sleep(time ? 80 : 5);
        applied = time;
        return { kind: 'ok', status: 200, body: { status: 'ok', deadline: time } };
      },
      readStatus: async () => ({ deadline: applied ?? 0, triggered: 0, dailyLimit: 10, nextReset: 0 }),
      nowMs: () => Date.now(),
    }, { timeoutS: 60, rearmEveryS: 20 }, silentLog(), () => {});
    void deadman.arm();
    await Bun.sleep(5);
    await deadman.disarm();
    await Bun.sleep(120); // past the moment the re-arm would have landed
    expect(applied).toBe(0);
    expect(deadman.deadline()).toBe(0);
  });
});

describe('#12 nested config keys are checked', () => {
  test('a misspelt risk parameter is an error, not the default', async () => {
    const base = Bun.YAML.parse(await Bun.file(new URL('../config/example.yaml', import.meta.url)).text()) as Record<string, Record<string, unknown>>;
    expect(() => parseSettings({ ...base, risk: { ...base.risk, max_daily_losss_usd: 1 } })).toThrow('risk: unknown key "max_daily_losss_usd"');
    expect(() => parseSettings({ ...base, sessions: { ...base.sessions, weekend: { size_mult: 0.3, bps_ad: 3 } } })).toThrow('sessions.weekend: unknown key');
    expect(() => parseSettings({ ...base, deadman: { timeout_s: 60, rearm_every: 20 } })).toThrow('deadman: unknown key');
    expect(parseSettings(base).settings.risk.maxDailyLossUsd).toBe(200);
  });
});

describe('#13 simulated quotes are not subtracted from the real book', () => {
  test('dry-run keeps the full competing depth; live subtracts own resting size', () => {
    const quotes = [{ side: 'bid' as const, price: new D('195.70'), rest: new D('5') }];
    const bids: Level[] = [[new D('195.70'), new D('10')]], asks: Level[] = [[new D('195.80'), new D('10')]];
    const depth = (mode: 'dry_run' | 'live') => {
      const metrics = new Metrics(instrument, { dir: '.', flushS: 3_600, mode }, silentLog(), () => 0);
      metrics.sample(new D('195.75'), quotes, bids, asks);
      return metrics.summary().avgOtherBookBidByBand.reduce((a, b) => a + b, 0);
    };
    expect(depth('dry_run')).toBe(1957);
    expect(depth('live')).toBe(979);
  });
});
