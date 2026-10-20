import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Settings } from './config.ts';
import type { Credentials } from './credentials.ts';
import { Deadman, type AutoCancelStatus } from './deadman.ts';
import { bpsBetween, D, type Dec } from './decimal.ts';
import type { EgressPool } from './egress.ts';
import { Executor, planActions, prioritize, TokenBucket } from './executor.ts';
import { parseInstrument, type Instrument } from './instruments.ts';
import { errorText, type Logger } from './log.ts';
import { MarketData, type MarketState } from './marketData.ts';
import { Metrics } from './metrics.ts';
import { PrivateStream } from './privateStream.ts';
import { computeLadder, slotKey, type SlotKey, type TargetLadder } from './quoteEngine.ts';
import { acknowledged, type Clock, type RestClient, type WriteOutcome } from './rest.ts';
import { rewardPeriodStart, type RestingQuote } from './rewards.ts';
import { RiskManager } from './risk.ts';
import { currentSession } from './sessions.ts';
import type { SessionName } from './config.ts';
import type { DashboardState, HistoryPoint, LadderRow, RunStatus } from './dashboard/types.ts';
import { signOperation, type Operation } from './signer.ts';
import { StateStore, type EquityAnchor } from './state.ts';

export interface BotOptions {
  settings: Settings; instrument: Instrument; egress: EgressPool; rest: RestClient; clock: Clock; log: Logger;
  /** Present only in live mode. Dry-run has no signer and therefore no upstream write path. */
  credentials: Credentials | null;
  stopFile: string;
  now?: () => number;
  /** Override for tests against a local mock exchange. */
  wsUrl?: string;
}

/** Process lifecycle (spec §4, §10). `quoteCycle` is the only writer of orders. */
export class QuoterBot {
  readonly mode: 'dry_run' | 'live';
  readonly state: StateStore;
  readonly market: MarketData;
  readonly risk: RiskManager;
  readonly metrics: Metrics;
  private readonly bucket: TokenBucket;
  private readonly executor: Executor | null = null;
  private readonly deadman: Deadman | null = null;
  private privateStream: PrivateStream | null = null;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private busy = false;
  private dirty = false;
  private lastCycle = 0;
  private lastWriteAt = 0;
  private reconciling = false;
  private exchangeCancelOnly = false;
  private instrumentHalted: string | null = null;
  private ladder: TargetLadder | null = null;
  /** Set once startup has checked (or cleared) the instrument's book; only then does shutdown cancel on it. */
  private ownsBook = false;
  private lastPullCancelAt = 0;
  private savedAnchor: string | null = null;
  private runStatus: RunStatus = 'starting';
  private statusReason = '';
  private notes: string[] = [];
  private session: SessionName = 'regular';
  private readonly startedAt: number;
  private readonly history: HistoryPoint[] = [];
  private lastPrinted = 0;
  private stopping: Promise<void> | null = null;
  private readonly now: () => number;
  done: Promise<string>;
  private finish!: (reason: string) => void;

  constructor(private readonly o: BotOptions) {
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
    this.mode = o.credentials ? 'live' : 'dry_run';
    const { settings, instrument, log } = o;
    this.state = new StateStore(instrument.id, instrument.symbol, this.now);
    this.market = new MarketData(instrument.id, o.egress, o.rest, log.child('market'), { staleMs: settings.risk.staleBookMs, feeds: settings.egress.publicFeeds, onUpdate: () => this.requestCycle(), now: this.now, url: o.wsUrl });
    this.risk = new RiskManager(settings, (key, message) => log.warn('ALERT', { key, message }));
    this.metrics = new Metrics(instrument, { dir: settings.metrics.dir, flushS: settings.metrics.flushS, mode: this.mode }, log.child('metrics'), this.now);
    this.bucket = new TokenBucket(5_000 * settings.budget.actionShare, this.now);
    if (o.credentials) {
      const port = { write: (op: Operation) => this.write(op) };
      this.executor = new Executor(port, this.state, instrument, log.child('executor'));
      this.deadman = new Deadman({ write: (op) => this.write(op), readStatus: () => this.readAutoCancel(), nowMs: () => o.clock.nowMs() }, settings.deadman, log.child('deadman'), (message) => log.warn('ALERT', { key: 'deadman', message }));
    }
    this.done = new Promise((resolve) => { this.finish = resolve; });
  }

  // ---------- signed writes ----------
  private async write(op: Operation): Promise<WriteOutcome> {
    const credentials = this.o.credentials;
    if (!credentials) throw new Error('Dry-run has no write access');
    const request = await signOperation(op, credentials.signer, this.o.clock.nowMs());
    this.lastWriteAt = this.now();
    const outcome = await this.o.rest.write(request);
    this.o.log.debug('write', { op: op.type, n: Array.isArray(op.args) ? op.args.length : 1, kind: outcome.kind, ...(outcome.kind !== 'ok' ? { error: outcome.error } : {}) });
    return outcome;
  }
  private auth() { if (!this.o.credentials) throw new Error('No credentials'); return this.o.credentials.auth; }
  private async readAutoCancel(): Promise<AutoCancelStatus> {
    const s = await this.o.rest.getPrivate<{ deadline: number; triggered: number; daily_limit: number; next_reset: number }>('/v1/account/auto-cancel', this.auth());
    return { deadline: s.deadline, triggered: s.triggered, dailyLimit: s.daily_limit, nextReset: s.next_reset };
  }

  // ---------- lifecycle ----------
  async start(): Promise<void> {
    const { settings, instrument, log, rest } = this.o;
    await this.refreshExchange();
    if (this.exchangeCancelOnly && this.mode === 'live') throw new Error('Exchange is in cancel-only mode; not starting');
    if (this.mode === 'live') {
      const limits = await rest.getPrivate<{ actions_per_minute_limit: number; open_orders_limit: number }>('/v1/account/limits', this.auth());
      this.bucket.setRate(limits.actions_per_minute_limit * settings.budget.actionShare);
      const autoCancel = await this.readAutoCancel();
      log.info('account limits', { actionsPerMinute: limits.actions_per_minute_limit, openOrders: limits.open_orders_limit, autoCancelDailyLimit: autoCancel.dailyLimit, autoCancelTriggered: autoCancel.triggered });
      if (autoCancel.dailyLimit > 0 && autoCancel.triggered >= autoCancel.dailyLimit) throw new Error('Auto-cancel daily trigger limit is exhausted; the dead man\'s switch could not protect orders');

      this.state.onSequenceDistrust = () => log.warn('private sq jumps are routine; gap detection disabled for this connection, periodic reconcile continues');
      this.privateStream = new PrivateStream(this.o.egress, this.auth(), this.state, log.child('private'), {
        onOrder: () => this.requestCycle(),
        onFill: (fills) => { this.metrics.recordFills(fills); log.info('fill', { fills: fills.map((f) => ({ side: f.side, p: f.price.toFixed(), qty: f.qty.toFixed(), taker: f.taker, fee: f.fee })) }); this.requestCycle(); },
      }, this.o.wsUrl);
      this.privateStream.start();
      await this.reconcile('startup');
      if (this.state.foreign.length) {
        if (!settings.risk.startupCancelAll) throw new Error(`${this.state.foreign.length} open order(s) not owned by this process on ${instrument.symbol}; cancel them or set risk.startup_cancel_all`);
        this.ownsBook = true;
        await this.cancelAllAndVerify('startup');
      }
      // From here on the bot owns the instrument's book: stopping cancels everything on it.
      this.ownsBook = true;
      this.state.restoreAnchor(await this.loadAnchor());
      await this.ensureLeverage();
      await this.deadman!.arm();
      this.deadman!.start();
      log.info('dead man\'s switch armed', { deadline: new Date(this.deadman!.deadline()).toISOString() });
    }

    await this.market.seedFromRest().catch((error) => log.warn('REST book seed failed', { error: errorText(error) }));
    this.market.start();
    await this.waitFor(() => this.market.connected() && this.market.snapshot().status === 'live', 45_000, 'first live order-book snapshot');
    this.running = true;
    this.timers.push(setInterval(() => this.requestCycle(), 1_000));
    this.timers.push(setInterval(() => this.sampleMetrics(), 1_000));
    this.timers.push(setInterval(() => { void this.metrics.flush(); this.state.prune(); void this.saveAnchor(); }, 5_000));
    this.timers.push(setInterval(() => { if (existsSync(this.o.stopFile)) void this.stop('STOP file'); }, 1_000));
    this.timers.push(setInterval(() => { void this.refreshExchange().catch((error) => log.warn('exchange poll failed', { error: errorText(error) })); }, 60_000));
    this.timers.push(setInterval(() => { void this.o.clock.sync().catch((error) => log.warn('clock sync failed', { error: errorText(error) })); }, 300_000));
    if (this.mode === 'live') {
      this.timers.push(setInterval(() => { void this.maybeReconcile(); }, 1_000));
      this.timers.push(setInterval(() => { void this.pollLimits(); }, 60_000));
      this.timers.push(setInterval(() => { void this.pollRewards(); }, 3_600_000));
      void this.pollRewards();
    }
    log.info('quoter running', { mode: this.mode, instrument: instrument.symbol, egress: this.o.egress.describe(), publicFeeds: this.market.routes() });
    this.requestCycle();
  }

  private async waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const until = this.now() + timeoutMs;
    while (!check()) {
      if (this.now() > until) throw new Error(`Timed out waiting for ${what}`);
      await Bun.sleep(100);
    }
  }

  stop(reason: string): Promise<void> {
    this.stopping ??= this.shutdown(reason);
    return this.stopping;
  }

  private async shutdown(reason: string): Promise<void> {
    const { log } = this.o;
    log.warn('stopping', { reason });
    this.runStatus = 'stopping'; this.statusReason = reason;
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    await this.waitFor(() => !this.busy, 10_000, 'in-flight quote cycle').catch(() => undefined);
    if (this.mode === 'live') {
      this.deadman?.stop();
      // Before the bot took ownership (e.g. startup refused foreign orders) nothing on the book is touched.
      let verified = false;
      if (this.ownsBook) {
        try { await this.cancelAllAndVerify('shutdown'); verified = true; } catch (error) { log.error('shutdown cancel not verified; auto-cancel deadline remains armed', { error: errorText(error) }); }
      }
      // Only clear a schedule this process armed, and only once its orders are verified gone.
      if (this.deadman?.armed() && verified) await this.deadman.disarm().catch((error) => log.warn('disarm failed', { error: errorText(error) }));
      await this.saveAnchor();
    }
    this.market.stop();
    this.privateStream?.stop();
    await this.metrics.flush(true);
    this.runStatus = 'stopped'; this.statusReason = reason;
    this.finish(reason);
  }

  private async cancelAllAndVerify(reason: string): Promise<void> {
    const outcome = await this.write({ type: 'cancelAll', args: { iid: this.o.instrument.id } });
    this.o.log.info('cancelAll', { reason, kind: outcome.kind, ...(outcome.kind !== 'ok' ? { error: outcome.error } : {}) });
    if (outcome.kind === 'rejected') throw new Error(`cancelAll rejected: ${outcome.error}`);
    await Bun.sleep(outcome.kind === 'ok' ? 300 : 2_000);
    await this.reconcile(`after cancelAll (${reason})`);
    if (this.state.ownLiveCount() || this.state.foreign.length) {
      await Bun.sleep(1_000);
      await this.reconcile(`after cancelAll (${reason}), second check`);
      if (this.state.ownLiveCount() || this.state.foreign.length) throw new Error('Open orders remain after cancelAll');
    }
  }

  private async ensureLeverage(): Promise<void> {
    const { settings, instrument, rest, log } = this.o;
    if (settings.leverage === null) return;
    const rows = await rest.getPrivate<{ instrument_id: number; leverage: number; cross: boolean }[]>('/v1/account/config', this.auth(), { instrument_id: instrument.id });
    const current = rows.find((row) => row.instrument_id === instrument.id);
    if (current?.leverage === settings.leverage) { log.info('leverage confirmed', { leverage: current.leverage, cross: current.cross }); return; }
    const outcome = await this.write({ type: 'updateLeverage', args: { iid: instrument.id, lev: settings.leverage, cross: current?.cross ?? true } });
    if (outcome.kind !== 'ok') throw new Error(`Leverage update ${outcome.kind}: ${outcome.error}`);
    log.info('leverage set', { leverage: settings.leverage });
  }

  // ---------- reconciliation ----------
  private async maybeReconcile(): Promise<void> {
    const pending = this.state.needsResync();
    const periodic = this.now() - (this.lastReconcile ?? 0) > this.o.settings.risk.reconcileEveryS * 1_000;
    if ((!pending && !periodic) || this.reconciling || this.busy) return;
    if (pending?.startsWith('indeterminate') && this.now() - this.lastWriteAt < 2_000) return; // let the exchange settle first
    await this.reconcile(pending ?? 'periodic').catch((error) => this.o.log.warn('reconcile failed', { error: errorText(error) }));
  }
  private lastReconcile: number | null = null;

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
  private reconcileTask: Promise<void> | null = null;

  private async runReconcile(reason: string): Promise<void> {
    this.reconciling = true;
    try {
      await this.waitFor(() => !this.busy, 15_000, 'quote cycle to finish before reconcile');
      const auth = this.auth(), asOf = this.now(), generation = this.state.resyncGeneration();
      const [open, portfolio] = await Promise.all([
        this.o.rest.getPrivate<unknown[]>('/v1/account/open-orders', auth, { instrument_id: this.o.instrument.id }),
        this.o.rest.getPrivate<unknown>('/v1/account/portfolio', auth),
      ]);
      const unresolved = this.state.applyOpenOrders(open, asOf);
      this.state.applyPortfolio(portfolio);
      if (unresolved) this.state.markResync(`${unresolved} submitted order(s) not yet visible`); else this.state.resynced(generation);
      this.lastReconcile = this.now();
      if (reason !== 'periodic') this.o.log.info('reconciled', { reason, ownLive: this.state.liveCoids().length, strays: this.state.strays().length, foreign: this.state.foreign.length, position: this.state.snapshot().positionQty.toFixed() });
    } finally {
      this.reconciling = false;
      if (this.running) this.requestCycle();
    }
  }

  // ---------- quoting ----------
  requestCycle(): void {
    if (!this.running) return;
    if (this.busy || this.reconciling) { this.dirty = true; return; }
    const wait = this.o.settings.requote.minIntervalMs - (this.now() - this.lastCycle);
    if (wait > 0) { this.cycleTimer ??= setTimeout(() => { this.cycleTimer = null; this.requestCycle(); }, wait); return; }
    void this.cycle();
  }

  private async cycle(): Promise<void> {
    this.busy = true; this.dirty = false;
    try { await this.quoteCycle(); }
    catch (error) { this.o.log.error('quote cycle failed', { error: errorText(error) }); }
    finally {
      this.busy = false; this.lastCycle = this.now();
      if (this.dirty && this.running) this.requestCycle();
    }
  }

  private async quoteCycle(): Promise<void> {
    const { settings, instrument, log } = this.o;
    const market = this.market.snapshot();
    const account = this.state.snapshot();
    const action = this.risk.evaluate({
      now: this.now(), bookStatus: market.status, publicConnected: this.market.connected(),
      privateHealthy: this.mode === 'dry_run' || (this.privateStream?.healthy() ?? false),
      resyncPending: this.mode === 'live' ? this.state.needsResync() : null,
      moveBps: this.market.maxMoveBps(settings.risk.volBreaker.windowS * 1_000),
      inLiquidation: account.inLiquidation,
      dailyPnl: this.mode === 'live' ? this.state.dailyPnl(rewardPeriodStart(this.now())) : null,
      availableMargin: account.availableMargin,
      exchangeCancelOnly: this.exchangeCancelOnly, instrumentHalted: this.instrumentHalted,
      postOnlyRejects: this.state.postOnlyRejects,
      proxyExpiresAt: this.o.credentials?.expiresAt ?? null,
      deadmanDeadline: this.deadman ? this.deadman.deadline() : null,
      killSwitch: existsSync(this.o.stopFile),
    });

    this.runStatus = { quote: 'running', pull: 'paused', freeze: 'frozen', halt: 'halted' }[action.kind] as RunStatus;
    this.statusReason = action.kind === 'quote' ? '' : action.reason;
    this.notes = action.kind === 'quote' ? action.notes : [];
    if (action.kind === 'halt') { this.ladder = null; void this.stop(action.reason === 'kill switch' ? 'kill switch' : `risk halt: ${action.reason}`); return; }
    if (action.kind === 'pull') {
      this.ladder = null;
      // One cancelAll per pull, then a REST check; no resend while an earlier one is unverified.
      const settling = this.now() - this.lastPullCancelAt < 3_000 || (/^(indeterminate|cancelAll)/.test(this.state.needsResync() ?? '') && this.now() - this.lastWriteAt < 3_000);
      if (this.mode === 'live' && !settling && (this.state.ownLiveCount() || this.state.foreign.length)) {
        this.lastPullCancelAt = this.now();
        const outcome = await this.write({ type: 'cancelAll', args: { iid: instrument.id } });
        log.warn('quotes pulled', { reason: action.reason, kind: outcome.kind });
        if (acknowledged(outcome)) {
          for (const order of this.state.orders.values()) if (order.rest.gt(0) || order.status === 'accepted') { order.status = 'cancelled'; order.rest = new D(0); order.inFlight = false; this.state.release(order.coid); }
          this.state.foreign = [];
        }
        this.state.markResync(`cancelAll ${outcome.kind}: verify`);
      }
      this.printThrottled(`PAUSED: ${action.reason}`);
      return;
    }
    if (action.kind === 'freeze') {
      if (action.allowCancel && this.mode === 'live' && this.executor) {
        const plan = planActions(null, this.state, instrument, { thresholdBps: settings.requote.thresholdBps, refillRatio: settings.requote.refillRatio, allowNew: false }, this.slots());
        if (plan.cancels.length) await this.executor.execute({ ...plan, modifies: [], places: [] });
      }
      this.printThrottled(`FROZEN: ${action.reason}`);
      return;
    }

    const session = currentSession(this.now(), instrument.category, settings.sessions.schedule);
    this.session = session;
    const ladder = computeLadder({
      market: { bestBid: market.bestBid!, bestAsk: market.bestAsk!, mid: market.mid! }, instrument,
      positionQty: account.positionQty, levels: settings.levels, requote: settings.requote, inventory: settings.inventory,
      session: settings.sessions[session], sizeScale: action.sizeScale, extraBps: action.extraBps, widenTicks: action.widenTicks,
    });
    this.ladder = ladder;
    for (const warning of ladder.warnings) log.debug('ladder', { warning });
    if (this.mode === 'dry_run' || !this.executor) { this.printThrottled(this.describe(ladder, session, action.notes)); return; }

    let plan = planActions(ladder, this.state, instrument, { thresholdBps: settings.requote.thresholdBps, refillRatio: settings.requote.refillRatio, allowNew: true }, this.slots());
    const budget = this.bucket.available();
    if (plan.modifies.length + plan.places.length > budget) { plan = prioritize(plan, budget); log.warn('action budget limits this cycle', { budget }); }
    if (!plan.cancels.length && !plan.modifies.length && !plan.places.length) { this.printThrottled(this.describe(ladder, session, action.notes)); return; }
    this.bucket.take(plan.modifies.length + plan.places.length);
    const report = await this.executor.execute(plan);
    if (report.errors.length) log.warn('execution errors', { errors: report.errors.slice(0, 10) });
    this.printThrottled(this.describe(ladder, session, action.notes));
  }

  private slots(): SlotKey[] {
    return this.o.settings.levels.flatMap((_, index) => [slotKey('bid', index), slotKey('ask', index)]);
  }

  // ---------- daily-loss anchor ----------
  /** Account value at the reward-period start survives restarts, so a restart does not reset the daily-loss limit. */
  private anchorFile(): string { return join(this.o.settings.metrics.dir, 'equity-anchor.json'); }
  private accountKey(): string { return (this.o.credentials?.owner ?? this.o.credentials?.auth.proxy ?? 'dry-run').toLowerCase(); }
  private async loadAnchor(): Promise<EquityAnchor | null> {
    try {
      const file = Bun.file(this.anchorFile());
      if (!(await file.exists())) return null;
      const saved = await file.json() as { account?: string; periodStart?: number; value?: number };
      if (saved.account !== this.accountKey() || saved.periodStart !== rewardPeriodStart(this.now()) || typeof saved.value !== 'number') return null;
      this.o.log.info('daily PnL anchor restored', { periodStart: new Date(saved.periodStart).toISOString(), value: saved.value });
      return { periodStart: saved.periodStart, value: saved.value };
    } catch (error) { this.o.log.warn('daily PnL anchor unreadable', { error: errorText(error) }); return null; }
  }
  private async saveAnchor(): Promise<void> {
    const anchor = this.state.anchor();
    if (this.mode !== 'live' || !anchor) return;
    const text = JSON.stringify({ account: this.accountKey(), ...anchor });
    if (text === this.savedAnchor) return;
    try { await mkdir(this.o.settings.metrics.dir, { recursive: true }); await Bun.write(this.anchorFile(), text); this.savedAnchor = text; }
    catch (error) { this.o.log.warn('daily PnL anchor not saved', { error: errorText(error) }); }
  }

  // ---------- monitoring ----------
  private sampleMetrics(): void {
    const market: MarketState = this.market.snapshot();
    const quotes: RestingQuote[] = this.mode === 'live' ? this.state.restingQuotes()
      : market.status === 'live' && this.ladder ? this.ladder.quotes.map((q) => ({ side: q.side, price: q.price, rest: q.qty })) : [];
    const score = this.metrics.sample(market.status === 'live' ? market.mid : null, quotes, market.bids, market.asks);
    const num = (value: { toNumber(): number } | null) => value ? value.toNumber() : null;
    const best = (side: 'bid' | 'ask') => quotes.filter((q) => q.side === side).reduce<number | null>((acc, q) => { const p = q.price.toNumber(); return acc === null ? p : side === 'bid' ? Math.max(acc, p) : Math.min(acc, p); }, null);
    this.history.push({ t: this.now(), mid: market.status === 'live' ? num(market.mid) : null, bid: num(market.bestBid), ask: num(market.bestAsk), ourBid: best('bid'), ourAsk: best('ask'), q: score > 0 ? 1 : 0 });
    if (this.history.length > 600) this.history.shift();
  }

  private async refreshExchange(): Promise<void> {
    const { rest, instrument, clock } = this.o;
    const [exchange, rows] = await Promise.all([
      rest.getPublic<{ cancel_only?: boolean }>('/v1/info/exchange'),
      rest.getPublic<unknown[]>('/v1/info/instruments', { instrument_id: instrument.id }),
    ]);
    this.exchangeCancelOnly = exchange.cancel_only === true;
    const match = Array.isArray(rows) ? rows.find((row) => (row as { instrument_id?: unknown })?.instrument_id === instrument.id) : undefined;
    const fresh = match ? parseInstrument(match, `${rest.base}/v1/info/instruments`, clock.nowMs()) : null;
    this.instrumentHalted = !fresh ? 'instrument no longer listed' : fresh.settled ? 'instrument settled' : fresh.closeOnly ? 'instrument close-only' : null;
  }

  private async pollLimits(): Promise<void> {
    try {
      const limits = await this.o.rest.getPrivate<{ actions_per_minute: number; actions_per_minute_limit: number; open_orders: number; open_orders_limit: number }>('/v1/account/limits', this.auth());
      this.bucket.setRate(limits.actions_per_minute_limit * this.o.settings.budget.actionShare);
      if (limits.actions_per_minute > limits.actions_per_minute_limit * 0.8) this.o.log.warn('action rate near limit', limits);
    } catch (error) { this.o.log.warn('limits poll failed', { error: errorText(error) }); }
  }

  private async pollRewards(): Promise<void> {
    try {
      const stats = await this.o.rest.getPrivate<{ account_maker_share_7d?: string; entity_maker_share_7d?: string; maker_volume_7d?: string }>('/v1/account/stats', this.auth());
      const share = stats.entity_maker_share_7d ?? stats.account_maker_share_7d;
      this.metrics.setMakerShare(share !== undefined && Number.isFinite(Number(share)) ? Number(share) * 100 : null);
      const rewards = await this.o.rest.getPrivate<{ data?: { date: string; breakdown?: { instrument_id?: number; reward_amount?: string }[] }[] }>('/v1/account/rewards', this.auth(), { limit: 3 });
      const mine = (rewards.data ?? []).map((day) => ({ date: day.date, reward: day.breakdown?.find((b) => b.instrument_id === this.o.instrument.id)?.reward_amount ?? null }));
      this.o.log.info('rewards', { makerShare7d: share ?? null, makerVolume7d: stats.maker_volume_7d ?? null, recent: mine, source: `${this.o.rest.base}/v1/account/rewards` });
    } catch (error) { this.o.log.warn('rewards poll failed', { error: errorText(error) }); }
  }

  /** Read-only snapshot for the local dashboard. Contains no keys, secrets or proxy credentials. */
  dashboardState(): DashboardState {
    const market = this.market.snapshot(), ladder = this.ladder, account = this.state.snapshot();
    const mid = market.mid, t = this.now();
    const bps = (price: Dec) => mid ? bpsBetween(price, mid, mid) : null;
    const rows: LadderRow[] = this.slots().map((slot) => {
      const [side, level] = slot.split(':') as ['bid' | 'ask', string];
      const target = ladder?.quotes.find((q) => q.slot === slot) ?? null;
      const live = this.mode === 'live' ? this.state.forSlot(slot) : null;
      return {
        slot, side, level: Number(level), band: this.o.settings.levels[Number(level)]!.band,
        target: target ? { price: target.price.toFixed(), qty: target.qty.toFixed(), notional: target.notional, distBps: target.distBps } : null,
        live: live ? { price: live.price.toFixed(), rest: live.rest.toFixed(), filled: live.filled.toFixed(), status: live.status, inFlight: live.inFlight, distBps: bps(live.price) } : null,
      };
    });
    const { settings, instrument, credentials } = this.o;
    return {
      now: t, mode: this.mode, instrument: { id: instrument.id, symbol: instrument.symbol, category: instrument.category },
      status: this.runStatus, statusReason: this.statusReason, notes: this.notes, startedAt: this.startedAt, session: this.session,
      egress: { primary: this.o.egress.describe(), feeds: this.market.routes() },
      market: {
        status: market.status, bid: market.bestBid?.toFixed() ?? null, ask: market.bestAsk?.toFixed() ?? null, mid: mid?.toFixed() ?? null,
        spreadBps: mid && market.bestBid && market.bestAsk ? market.bestAsk.minus(market.bestBid).div(mid).mul(10_000).toNumber() : null,
        ageMs: market.receivedAt === null ? null : t - market.receivedAt, source: market.source,
      },
      ladder: rows, skewBps: ladder?.skewBps ?? null,
      account: this.mode === 'live' ? {
        positionQty: account.positionQty.toFixed(), positionUsd: mid ? account.positionQty.mul(mid).toNumber() : null, entryPrice: account.entryPrice,
        unrealizedPnl: account.unrealizedPnl, availableMargin: account.availableMargin, accountValue: account.accountValue,
        dailyPnl: this.state.dailyPnl(rewardPeriodStart(t)), inLiquidation: account.inLiquidation,
      } : null,
      limits: { maxPositionUsd: settings.inventory.maxPositionUsd, maxDailyLossUsd: settings.risk.maxDailyLossUsd, minAvailableMarginUsd: settings.risk.minAvailableMarginUsd },
      metrics: this.metrics.summary(),
      history: [...this.history],
      fills: this.state.fills.slice(-20).reverse().map((f) => ({ t: f.ts, side: f.side, price: f.price.toFixed(), qty: f.qty.toFixed(), fee: f.fee, taker: f.taker })),
      deadmanDeadline: this.deadman?.deadline() || null,
      credentialExpiresAt: credentials?.expiresAt ?? null,
    };
  }

  private describe(ladder: TargetLadder, session: string, notes: string[]): string {
    const quotes = [...ladder.quotes].sort((a, b) => b.price.cmp(a.price)).map((q) => `${q.side === 'bid' ? 'BID' : 'ASK'} L${q.level} b${q.band} ${q.price.toFixed()} × ${q.qty.toFixed()} ($${Math.round(q.notional)}, ${q.distBps.toFixed(2)} bps)`);
    return [`mid ${ladder.mid.toFixed()} tick ${ladder.tick.toFixed()} session ${session} pos $${ladder.positionUsd.toFixed(0)} skew ${ladder.skewBps.toFixed(2)} bps${notes.length ? ' | ' + notes.join('; ') : ''}`, ...quotes].join('\n  ');
  }
  private printThrottled(text: string): void {
    if (this.now() - this.lastPrinted < 5_000) return;
    this.lastPrinted = this.now();
    this.o.log.info(this.mode === 'dry_run' ? 'ladder (DRY-RUN, simulated, nothing sent)' : 'ladder', { view: text.split('\n  ') });
  }
}
