import type { AccountView } from './account.ts';
import type { InstrumentConfig, SessionName, Settings } from './config.ts';
import type { InstrumentDetail, InstrumentSummary, HistoryPoint, LadderRow, RunStatus } from './dashboard/types.ts';
import { bpsBetween, D, type Dec } from './decimal.ts';
import { Executor, planActions, prioritize, type TokenBucket } from './executor.ts';
import { checkAgainstInstrument, type Instrument } from './instruments.ts';
import { errorText, type Logger } from './log.ts';
import { MarketBook, type PublicFeed } from './marketData.ts';
import { Metrics } from './metrics.ts';
import { computeLadder, slotKey, type SlotKey, type TargetLadder } from './quoteEngine.ts';
import { acknowledged, type Clock, type PrivateAuth, type RestClient, type WriteOutcome } from './rest.ts';
import type { RestingQuote } from './rewards.ts';
import { RiskManager } from './risk.ts';
import { currentSession } from './sessions.ts';
import type { Operation } from './signer.ts';
import { StateStore } from './state.ts';

/** Account-level inputs every instrument's risk evaluation needs. */
export interface AccountInputs {
  privateHealthy: boolean; exchangeCancelOnly: boolean; deadmanDeadline: number | null;
  proxyExpiresAt: number | null; killSwitch: boolean; dailyPnl: number | null; account: AccountView;
}
/** What the hub provides to each instrument quoter. */
export interface QuoterContext {
  mode: 'dry_run' | 'live';
  settings: Settings;
  rest: RestClient; clock: Clock; log: Logger; now: () => number;
  feed: PublicFeed; bucket: TokenBucket;
  write(op: Operation): Promise<WriteOutcome>;
  auth(): PrivateAuth;
  inputs(): AccountInputs;
  applyAccountPortfolio(data: unknown): void;
  /** An account-wide risk halt: the hub stops every instrument and the process. */
  accountHalt(reason: string): void;
}

/**
 * Quotes one instrument (spec §4–§7): its order book, own orders, risk timers, metrics and quote cycle.
 * `quoteCycle` is the only writer of its orders; reconciles never overlap a cycle.
 */
export class InstrumentQuoter {
  readonly state: StateStore;
  readonly book: MarketBook;
  readonly risk: RiskManager;
  readonly metrics: Metrics;
  private readonly executor: Executor | null;
  private readonly log: Logger;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private busy = false;
  private dirty = false;
  private reconciling = false;
  private reconcileTask: Promise<void> | null = null;
  private lastCycle = 0;
  private lastWriteAt = 0;
  private lastReconcile: number | null = null;
  private lastPullCancelAt = 0;
  private lastPrinted = 0;
  /** Set once startup has checked (or cleared) this instrument's book; only then does stopping cancel on it. */
  private ownsBook = false;
  private startTask: Promise<void> | null = null;
  private stopTask: Promise<boolean> | null = null;
  /** Set by the first stop: startup aborts at its next step and no new order or modify is sent. */
  private stopRequested = false;
  private stopVerified = false;
  private lastConfirmCheck = 0;
  private halted: string | null = null;
  private ladder: TargetLadder | null = null;
  private readonly history: HistoryPoint[] = [];
  private session: SessionName = 'regular';
  status: RunStatus = 'starting';
  statusReason = '';
  private notes: string[] = [];
  readonly startedAt: number;

  constructor(private readonly ctx: QuoterContext, readonly instrument: Instrument, readonly profile: InstrumentConfig) {
    this.log = ctx.log.child(instrument.symbol);
    this.startedAt = ctx.now();
    this.state = new StateStore(instrument.id, instrument.symbol, ctx.now);
    this.book = new MarketBook(instrument.id, { staleMs: ctx.settings.risk.staleBookMs, onUpdate: () => this.requestCycle(), now: ctx.now, exchangeNow: () => ctx.clock.nowMs() });
    this.risk = new RiskManager(ctx.settings, (key, message) => this.log.warn('ALERT', { key, message, instrument: instrument.symbol }));
    this.metrics = new Metrics(instrument, { dir: ctx.settings.metrics.dir, flushS: ctx.settings.metrics.flushS, mode: ctx.mode }, this.log.child('metrics'), ctx.now);
    this.executor = ctx.mode === 'live' ? new Executor({ write: (op) => this.write(op) }, this.state, instrument, this.log.child('executor'), () => !this.stopRequested) : null;
  }

  private async write(op: Operation): Promise<WriteOutcome> {
    // Last line of defence: once stopping, only cancels reach the exchange.
    if (this.stopRequested && op.type !== 'cancelAll' && op.type !== 'cancelOrdersCOID') throw new Error(`${this.instrument.symbol} is stopping; ${op.type} not sent`);
    this.lastWriteAt = this.ctx.now();
    return this.ctx.write(op);
  }
  private slots(): SlotKey[] { return this.profile.levels.flatMap((_, index) => [slotKey('bid', index), slotKey('ask', index)]); }

  private async waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const until = this.ctx.now() + timeoutMs;
    while (!check()) {
      if (this.ctx.now() > until) throw new Error(`Timed out waiting for ${what}`);
      await Bun.sleep(100);
    }
  }

  // ---------- lifecycle ----------
  /** Validates the instrument, takes ownership of its book (live), subscribes market data and starts quoting. */
  start(): Promise<void> {
    this.startTask ??= this.boot();
    return this.startTask;
  }
  /** Startup checkpoint: a stop requested meanwhile ends startup before its next exchange call. */
  private alive(): void { if (this.stopRequested) throw new Error(`${this.instrument.symbol}: stopped during startup`); }

  private async boot(): Promise<void> {
    const { settings, rest, log } = { ...this.ctx, log: this.log };
    this.alive();
    const top = await rest.getPublic<{ bids: [string, string][]; asks: [string, string][] }>('/v1/info/book', { instrument_id: this.instrument.id, depth: 10 });
    this.alive();
    const mid = top.bids[0] && top.asks[0] ? new D(top.bids[0][0]).plus(top.asks[0][0]).div(2) : null;
    const check = checkAgainstInstrument(this.profile, this.instrument, mid);
    for (const warning of check.warnings) log.warn('instrument check', { warning });
    if (check.errors.length) throw new Error(check.errors.join('; '));

    if (this.ctx.mode === 'live') {
      await this.reconcile('startup');
      this.alive();
      if (this.state.foreign.length) {
        if (!settings.risk.startupCancelAll) throw new Error(`${this.state.foreign.length} open order(s) not owned by this process on ${this.instrument.symbol}; cancel them or set risk.startup_cancel_all`);
        this.ownsBook = true;
        await this.cancelAllAndVerify('startup');
        this.alive();
      }
      // From here on this quoter owns the instrument's book: stopping cancels everything on it.
      this.ownsBook = true;
      await this.ensureLeverage();
      this.alive();
    }

    await this.book.seedFromRest(rest).catch((error) => log.warn('REST book seed failed', { error: errorText(error) }));
    this.alive();
    await this.ctx.feed.add(this.book);
    await this.waitFor(() => this.stopRequested || (this.ctx.feed.connected() && this.book.snapshot().status === 'live'), 45_000, `first live order book for ${this.instrument.symbol}`);
    this.alive();
    this.running = true;
    this.timers.push(setInterval(() => this.requestCycle(), 1_000));
    this.timers.push(setInterval(() => this.sampleMetrics(), 1_000));
    this.timers.push(setInterval(() => { void this.metrics.flush(); this.state.prune(); }, 5_000));
    if (this.ctx.mode === 'live') this.timers.push(setInterval(() => { void this.maybeReconcile(); }, 1_000));
    log.info('instrument quoting', { mode: this.ctx.mode, levels: this.profile.levels, leverage: this.profile.leverage });
    this.requestCycle();
  }

  /**
   * Stops quoting; in live mode cancels this instrument's book. Returns whether the cancel was verified (or not needed).
   * Concurrent calls share one run; after an unverified cancel a later call tries again.
   */
  stop(reason: string): Promise<boolean> {
    this.stopTask ??= this.shutdown(reason).finally(() => { this.stopTask = null; });
    return this.stopTask;
  }

  private async shutdown(reason: string): Promise<boolean> {
    this.stopRequested = true;
    if (this.stopVerified) return true;
    this.log.warn('instrument stopping', { reason });
    this.status = 'stopping'; this.statusReason = reason;
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    // Startup aborts at its next checkpoint; a running cycle sends no further batch after its current write.
    await this.startTask?.catch(() => undefined);
    await this.waitFor(() => !this.busy, this.ctx.settings.egress.timeoutMs + 5_000, 'in-flight quote cycle')
      .catch((error) => this.log.error('quote cycle still writing; cancelling anyway', { error: errorText(error) }));
    let verified = true;
    if (this.ctx.mode === 'live' && this.ownsBook) {
      try { await this.cancelAllAndVerify(reason); } catch (error) { verified = false; this.log.error('cancel on stop not verified; auto-cancel deadline stays armed', { error: errorText(error) }); }
    }
    await this.ctx.feed.remove(this.instrument.id);
    await this.metrics.flush(true);
    this.status = 'stopped'; this.statusReason = reason;
    this.stopVerified = verified;
    return verified;
  }

  private async cancelAllAndVerify(reason: string): Promise<void> {
    const outcome = await this.write({ type: 'cancelAll', args: { iid: this.instrument.id } });
    this.log.info('cancelAll', { reason, kind: outcome.kind, ...(outcome.kind !== 'ok' ? { error: outcome.error } : {}) });
    if (outcome.kind === 'rejected') throw new Error(`cancelAll rejected: ${outcome.error}`);
    await Bun.sleep(outcome.kind === 'ok' ? 300 : 2_000);
    await this.reconcile(`after cancelAll (${reason})`);
    if (this.state.ownLiveCount() || this.state.foreign.length) {
      await Bun.sleep(1_000);
      await this.reconcile(`after cancelAll (${reason}), second check`);
      if (this.state.ownLiveCount() || this.state.foreign.length) throw new Error('Open orders remain after cancelAll');
    }
    // A create with an unknown outcome may still execute after the cancel; the auto-cancel deadline must stay armed.
    const unconfirmed = this.state.unconfirmed().length;
    if (unconfirmed) throw new Error(`${unconfirmed} order create(s) with unknown outcome may still execute`);
  }

  private async ensureLeverage(): Promise<void> {
    const leverage = this.profile.leverage;
    if (leverage === null) return;
    const rows = await this.ctx.rest.getPrivate<{ instrument_id: number; leverage: number; cross: boolean }[]>('/v1/account/config', this.ctx.auth(), { instrument_id: this.instrument.id });
    const current = rows.find((row) => row.instrument_id === this.instrument.id);
    if (current?.leverage === leverage) { this.log.info('leverage confirmed', { leverage, cross: current.cross }); return; }
    const outcome = await this.write({ type: 'updateLeverage', args: { iid: this.instrument.id, lev: leverage, cross: current?.cross ?? true } });
    if (outcome.kind !== 'ok') throw new Error(`Leverage update ${outcome.kind}: ${outcome.error}`);
    // The response is the effective configuration after the update; only that confirms the change.
    const body = outcome.body as { leverage?: unknown; cross?: unknown } | null;
    if (!acknowledged(outcome) || body?.leverage !== leverage) throw new Error(`Leverage update not confirmed: ${JSON.stringify(outcome.body).slice(0, 160)}`);
    this.log.info('leverage set', { leverage, cross: body.cross });
  }

  // ---------- inputs from the hub ----------
  onOrders(items: unknown[]): void { let mine = false; for (const item of items) if (this.state.applyOrder(item)) mine = true; if (mine) this.requestCycle(); }
  onFills(data: unknown): void {
    const fills = this.state.applyFills(data);
    if (!fills.length) return;
    this.metrics.recordFills(fills);
    this.log.info('fill', { fills: fills.map((f) => ({ side: f.side, p: f.price.toFixed(), qty: f.qty.toFixed(), taker: f.taker, fee: f.fee })) });
    this.requestCycle();
  }
  onPortfolio(data: unknown): void { this.state.applyPortfolio(data); }
  markResync(reason: string): void { this.state.markResync(reason); }
  setInstrumentStatus(halted: string | null): void { this.halted = halted; }
  setMakerShare(pct: number | null): void { this.metrics.setMakerShare(pct); }

  // ---------- reconciliation ----------
  private async maybeReconcile(): Promise<void> {
    const pending = this.state.needsResync();
    const periodic = this.ctx.now() - (this.lastReconcile ?? 0) > this.ctx.settings.risk.reconcileEveryS * 1_000;
    const confirming = this.state.unconfirmed().length > 0 && this.ctx.now() - this.lastConfirmCheck > 5_000;
    if ((!pending && !periodic && !confirming) || this.reconciling || this.busy) return;
    if (pending?.startsWith('indeterminate') && this.ctx.now() - this.lastWriteAt < 2_000) return; // let the exchange settle first
    await this.reconcile(pending ?? (confirming ? 'unconfirmed create' : 'periodic')).catch((error) => this.log.warn('reconcile failed', { error: errorText(error) }));
  }

  /**
   * REST reconcile. Reconciles are queued (a caller always gets a snapshot taken after it asked) and never overlap a
   * quote cycle: the snapshot is requested only once no write is in progress, and no cycle starts until it is applied.
   */
  async reconcile(reason: string): Promise<void> {
    while (this.reconcileTask) await this.reconcileTask.catch(() => undefined);
    const task = this.runReconcile(reason);
    this.reconcileTask = task;
    try { await task; } finally { if (this.reconcileTask === task) this.reconcileTask = null; }
  }

  private async runReconcile(reason: string): Promise<void> {
    this.reconciling = true;
    try {
      await this.waitFor(() => !this.busy, 15_000, 'quote cycle to finish before reconcile');
      const auth = this.ctx.auth(), asOf = this.ctx.now(), generation = this.state.resyncGeneration();
      const [open, portfolio] = await Promise.all([
        this.ctx.rest.getPrivate<unknown[]>('/v1/account/open-orders', auth, { instrument_id: this.instrument.id }),
        this.ctx.rest.getPrivate<unknown>('/v1/account/portfolio', auth),
      ]);
      const unresolved = this.state.applyOpenOrders(open, asOf);
      this.state.applyPortfolio(portfolio);
      this.ctx.applyAccountPortfolio(portfolio);
      await this.confirmCreates(auth);
      if (unresolved) this.state.markResync(`${unresolved} submitted order(s) not yet visible`); else this.state.resynced(generation);
      this.lastReconcile = this.ctx.now();
      if (reason !== 'periodic') this.log.info('reconciled', { reason, ownLive: this.state.liveCoids().length, strays: this.state.strays().length, foreign: this.state.foreign.length, position: this.state.snapshot().positionQty.toFixed() });
    } finally {
      this.reconciling = false;
      if (this.running) this.requestCycle();
    }
  }

  /**
   * Creates with an unknown outcome that are not resting: the order history says whether they executed (filled,
   * cancelled, rejected). Not found there, the slot stays reserved until the signature can no longer execute.
   */
  private async confirmCreates(auth: PrivateAuth): Promise<void> {
    const pending = this.state.unconfirmed();
    if (!pending.length) return;
    this.lastConfirmCheck = this.ctx.now();
    for (const order of pending.slice(0, 5)) {
      try {
        const rows = await this.ctx.rest.getPrivate<unknown[]>('/v1/account/orders', auth, { client_order_id: order.coid, instrument_id: this.instrument.id });
        const match = Array.isArray(rows) ? rows.find((r) => (r as { client_order_id?: unknown } | null)?.client_order_id === order.coid) : undefined;
        if (match) { this.state.applyOrder(match); this.log.info('unconfirmed create resolved', { coid: order.coid, status: order.status }); }
      } catch (error) { this.log.warn('order history lookup failed', { coid: order.coid, error: errorText(error) }); }
    }
  }

  // ---------- quoting ----------
  requestCycle(): void {
    if (!this.running) return;
    if (this.busy || this.reconciling) { this.dirty = true; return; }
    const wait = this.ctx.settings.requote.minIntervalMs - (this.ctx.now() - this.lastCycle);
    if (wait > 0) { this.cycleTimer ??= setTimeout(() => { this.cycleTimer = null; this.requestCycle(); }, wait); return; }
    void this.cycle();
  }

  private async cycle(): Promise<void> {
    this.busy = true; this.dirty = false;
    try { await this.quoteCycle(); }
    catch (error) { this.log.error('quote cycle failed', { error: errorText(error) }); }
    finally {
      this.busy = false; this.lastCycle = this.ctx.now();
      if (this.dirty && this.running) this.requestCycle();
    }
  }

  private async quoteCycle(): Promise<void> {
    const { settings } = this.ctx, instrument = this.instrument, log = this.log;
    const market = this.book.snapshot();
    const position = this.state.snapshot();
    const inputs = this.ctx.inputs();
    const live = this.ctx.mode === 'live';
    const action = this.risk.evaluate({
      now: this.ctx.now(), bookStatus: market.status, publicConnected: this.ctx.feed.connected(),
      privateHealthy: !live || inputs.privateHealthy,
      resyncPending: live ? this.state.needsResync() : null,
      moveBps: this.book.maxMoveBps(settings.risk.volBreaker.windowS * 1_000),
      inLiquidation: inputs.account.inLiquidation, dailyPnl: live ? inputs.dailyPnl : null,
      availableMargin: inputs.account.availableMargin,
      exchangeCancelOnly: inputs.exchangeCancelOnly, instrumentHalted: this.halted,
      postOnlyRejects: this.state.postOnlyRejects,
      proxyExpiresAt: inputs.proxyExpiresAt, deadmanDeadline: inputs.deadmanDeadline, killSwitch: inputs.killSwitch,
    });

    this.status = { quote: 'running', pull: 'paused', freeze: 'frozen', halt: 'halted' }[action.kind] as RunStatus;
    this.statusReason = action.kind === 'quote' ? '' : action.reason;
    this.notes = action.kind === 'quote' ? action.notes : [];
    if (action.kind === 'halt') {
      this.ladder = null;
      if (action.scope === 'account') { this.ctx.accountHalt(action.reason === 'kill switch' ? 'kill switch' : `risk halt: ${action.reason}`); return; }
      // Instrument-only halt (settled, close-only, delisted): pull this book and keep the others running.
      await this.pull(action.reason);
      return;
    }
    if (action.kind === 'pull') {
      this.ladder = null;
      await this.pull(action.reason);
      this.printThrottled(`PAUSED: ${action.reason}`);
      return;
    }
    if (action.kind === 'freeze') {
      if (action.allowCancel && live && this.executor) {
        const plan = planActions(null, this.state, instrument, { thresholdBps: settings.requote.thresholdBps, refillRatio: settings.requote.refillRatio, allowNew: false }, this.slots());
        if (plan.cancels.length) await this.executor.execute({ ...plan, modifies: [], places: [] });
      }
      this.printThrottled(`FROZEN: ${action.reason}`);
      return;
    }

    const session = currentSession(this.ctx.now(), instrument.category, settings.sessions.schedule);
    this.session = session;
    const ladder = computeLadder({
      market: { bestBid: market.bestBid!, bestAsk: market.bestAsk!, mid: market.mid! }, instrument,
      positionQty: position.positionQty, levels: this.profile.levels, requote: settings.requote, inventory: this.profile.inventory,
      session: settings.sessions[session], sizeScale: action.sizeScale, extraBps: action.extraBps, widenTicks: action.widenTicks,
    });
    this.ladder = ladder;
    for (const warning of ladder.warnings) log.debug('ladder', { warning });
    if (!live || !this.executor) { this.printThrottled(this.describe(ladder, session, action.notes)); return; }

    let plan = planActions(ladder, this.state, instrument, { thresholdBps: settings.requote.thresholdBps, refillRatio: settings.requote.refillRatio, allowNew: true }, this.slots());
    const budget = this.ctx.bucket.available();
    if (plan.modifies.length + plan.places.length > budget) { plan = prioritize(plan, budget); log.warn('action budget limits this cycle', { budget }); }
    if (!plan.cancels.length && !plan.modifies.length && !plan.places.length) { this.printThrottled(this.describe(ladder, session, action.notes)); return; }
    this.ctx.bucket.take(plan.modifies.length + plan.places.length);
    const report = await this.executor.execute(plan);
    if (report.errors.length) log.warn('execution errors', { errors: report.errors.slice(0, 10) });
    this.printThrottled(this.describe(ladder, session, action.notes));
  }

  /** One cancelAll per pull, then a REST check; no resend while an earlier one is unverified. */
  private async pull(reason: string): Promise<void> {
    if (this.ctx.mode !== 'live') return;
    const settling = this.ctx.now() - this.lastPullCancelAt < 3_000 || (/^(indeterminate|cancelAll)/.test(this.state.needsResync() ?? '') && this.ctx.now() - this.lastWriteAt < 3_000);
    if (settling || !(this.state.ownLiveCount() || this.state.foreign.length)) return;
    this.lastPullCancelAt = this.ctx.now();
    const outcome = await this.write({ type: 'cancelAll', args: { iid: this.instrument.id } });
    this.log.warn('quotes pulled', { reason, kind: outcome.kind });
    if (acknowledged(outcome)) {
      for (const order of this.state.orders.values()) if (order.rest.gt(0) || order.status === 'accepted') { order.status = 'cancelled'; order.rest = new D(0); order.inFlight = false; this.state.release(order.coid); }
      this.state.foreign = [];
    }
    this.state.markResync(`cancelAll ${outcome.kind}: verify`);
  }

  // ---------- monitoring ----------
  private sampleMetrics(): void {
    const market = this.book.snapshot();
    const quotes: RestingQuote[] = this.ctx.mode === 'live' ? this.state.restingQuotes()
      : market.status === 'live' && this.ladder ? this.ladder.quotes.map((q) => ({ side: q.side, price: q.price, rest: q.qty })) : [];
    const score = this.metrics.sample(market.status === 'live' ? market.mid : null, quotes, market.bids, market.asks);
    const num = (value: { toNumber(): number } | null) => value ? value.toNumber() : null;
    const best = (side: 'bid' | 'ask') => quotes.filter((q) => q.side === side).reduce<number | null>((acc, q) => { const p = q.price.toNumber(); return acc === null ? p : side === 'bid' ? Math.max(acc, p) : Math.min(acc, p); }, null);
    this.history.push({ t: this.ctx.now(), mid: market.status === 'live' ? num(market.mid) : null, bid: num(market.bestBid), ask: num(market.bestAsk), ourBid: best('bid'), ourAsk: best('ask'), q: score > 0 ? 1 : 0 });
    if (this.history.length > 600) this.history.shift();
  }

  summary(): InstrumentSummary {
    const market = this.book.snapshot(), mt = this.metrics.summary(), mid = market.mid;
    return {
      id: this.instrument.id, symbol: this.instrument.symbol, category: this.instrument.category,
      status: this.status, statusReason: this.statusReason,
      mid: mid?.toFixed() ?? null,
      spreadBps: mid && market.bestBid && market.bestAsk ? bpsBetween(market.bestAsk, market.bestBid, mid) : null,
      uptime: mt.samples ? mt.uptime : null, liquidityScore: mt.samples ? mt.avgLiquidityScore : null,
      positionUsd: this.ctx.mode === 'live' && mid ? this.state.snapshot().positionQty.mul(mid).toNumber() : null,
      ownOrders: this.ctx.mode === 'live' ? this.state.ownLiveCount() : (this.ladder?.quotes.length ?? 0),
    };
  }

  /** Read-only detail for the dashboard. Contains no keys, secrets or proxy credentials. */
  detail(): InstrumentDetail {
    const market = this.book.snapshot(), ladder = this.ladder, t = this.ctx.now(), mid = market.mid;
    const bps = (price: Dec) => mid ? bpsBetween(price, mid, mid) : null;
    const rows: LadderRow[] = this.slots().map((slot) => {
      const [side, level] = slot.split(':') as ['bid' | 'ask', string];
      const target = ladder?.quotes.find((q) => q.slot === slot) ?? null;
      const live = this.ctx.mode === 'live' ? this.state.forSlot(slot) : null;
      return {
        slot, side, level: Number(level), band: this.profile.levels[Number(level)]!.band,
        target: target ? { price: target.price.toFixed(), qty: target.qty.toFixed(), notional: target.notional, distBps: target.distBps } : null,
        live: live ? { price: live.price.toFixed(), rest: live.rest.toFixed(), filled: live.filled.toFixed(), status: live.status, inFlight: live.inFlight, distBps: bps(live.price) } : null,
      };
    });
    const position = this.state.snapshot();
    return {
      instrument: { id: this.instrument.id, symbol: this.instrument.symbol, category: this.instrument.category },
      status: this.status, statusReason: this.statusReason, notes: this.notes, startedAt: this.startedAt, session: this.session,
      market: {
        status: market.status, bid: market.bestBid?.toFixed() ?? null, ask: market.bestAsk?.toFixed() ?? null, mid: mid?.toFixed() ?? null,
        spreadBps: mid && market.bestBid && market.bestAsk ? bpsBetween(market.bestAsk, market.bestBid, mid) : null,
        ageMs: market.receivedAt === null ? null : Math.max(t - market.receivedAt, market.exchangeTs ? this.ctx.clock.nowMs() - market.exchangeTs : 0), source: market.source,
      },
      ladder: rows, skewBps: ladder?.skewBps ?? null,
      position: this.ctx.mode === 'live' ? { qty: position.positionQty.toFixed(), usd: mid ? position.positionQty.mul(mid).toNumber() : null, entryPrice: position.entryPrice, unrealizedPnl: position.unrealizedPnl } : null,
      limits: { maxPositionUsd: this.profile.inventory.maxPositionUsd },
      metrics: this.metrics.summary(),
      history: [...this.history],
      fills: this.state.fills.slice(-20).reverse().map((f) => ({ t: f.ts, side: f.side, price: f.price.toFixed(), qty: f.qty.toFixed(), fee: f.fee, taker: f.taker })),
    };
  }

  private describe(ladder: TargetLadder, session: string, notes: string[]): string {
    const quotes = [...ladder.quotes].sort((a, b) => b.price.cmp(a.price)).map((q) => `${q.side === 'bid' ? 'BID' : 'ASK'} L${q.level} b${q.band} ${q.price.toFixed()} × ${q.qty.toFixed()} ($${Math.round(q.notional)}, ${q.distBps.toFixed(2)} bps)`);
    return [`mid ${ladder.mid.toFixed()} tick ${ladder.tick.toFixed()} session ${session} pos $${ladder.positionUsd.toFixed(0)} skew ${ladder.skewBps.toFixed(2)} bps${notes.length ? ' | ' + notes.join('; ') : ''}`, ...quotes].join('\n  ');
  }
  private printThrottled(text: string): void {
    if (this.ctx.now() - this.lastPrinted < 5_000) return;
    this.lastPrinted = this.ctx.now();
    this.log.info(this.ctx.mode === 'dry_run' ? 'ladder (DRY-RUN, simulated, nothing sent)' : 'ladder', { view: text.split('\n  ') });
  }
}
