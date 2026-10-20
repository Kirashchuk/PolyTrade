import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AccountStore, type EquityAnchor } from './account.ts';
import { normalSymbol, profileFor, type Settings } from './config.ts';
import type { Credentials } from './credentials.ts';
import type { CatalogRow, DashboardState, RunStatus } from './dashboard/types.ts';
import { Deadman, type AutoCancelStatus } from './deadman.ts';
import type { EgressPool } from './egress.ts';
import { TokenBucket } from './executor.ts';
import { InstrumentQuoter, type AccountInputs, type QuoterContext } from './instrumentQuoter.ts';
import { parseInstrument, type Instrument } from './instruments.ts';
import { errorText, type Logger } from './log.ts';
import { PublicFeed } from './marketData.ts';
import { PrivateStream } from './privateStream.ts';
import type { Clock, RestClient, WriteOutcome } from './rest.ts';
import { rewardPeriodStart } from './rewards.ts';
import { signOperation, type Operation } from './signer.ts';

export interface BotOptions {
  settings: Settings;
  /** Instruments to quote at startup (resolved from config or the saved dashboard selection). */
  instruments: Instrument[];
  egress: EgressPool; rest: RestClient; clock: Clock; log: Logger;
  /** Present only in live mode. Dry-run has no signer and therefore no upstream write path. */
  credentials: Credentials | null;
  stopFile: string;
  /** Where the dashboard selection is saved; null disables persistence. */
  selectionFile?: string | null;
  selectionSource?: 'config' | 'dashboard';
  now?: () => number;
  /** Override for tests against a local mock exchange. */
  wsUrl?: string;
}

/**
 * Process lifecycle (spec §4, §10) for several instruments on one account. Account-wide pieces are shared:
 * credentials, private stream, dead man's switch, action budget, daily-loss anchor and the public sockets.
 * Each instrument has its own book, orders, risk timers, metrics and quote cycle.
 */
export class QuoterBot {
  readonly mode: 'dry_run' | 'live';
  readonly account: AccountStore;
  readonly feed: PublicFeed;
  private readonly quoters = new Map<number, InstrumentQuoter>();
  private readonly bucket: TokenBucket;
  private readonly deadman: Deadman | null = null;
  private privateStream: PrivateStream | null = null;
  private catalogRows: Instrument[] = [];
  private exchangeCancelOnly = false;
  private readonly failed: { symbol: string; reason: string; at: number }[] = [];
  private readonly pending = new Set<string>();
  private selectionSource: 'config' | 'dashboard';
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private running = false;
  private savedAnchor: string | null = null;
  private status: RunStatus = 'starting';
  private statusReason = '';
  private readonly startedAt: number;
  private stopping: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly ctx: QuoterContext;
  done: Promise<string>;
  private finish!: (reason: string) => void;

  constructor(private readonly o: BotOptions) {
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
    this.mode = o.credentials ? 'live' : 'dry_run';
    this.selectionSource = o.selectionSource ?? 'config';
    this.account = new AccountStore(this.now);
    this.feed = new PublicFeed(o.egress, o.log.child('market'), { feeds: o.settings.egress.publicFeeds, url: o.wsUrl });
    this.bucket = new TokenBucket(5_000 * o.settings.budget.actionShare, this.now);
    if (o.credentials) this.deadman = new Deadman({ write: (op) => this.write(op), readStatus: () => this.readAutoCancel(), nowMs: () => o.clock.nowMs() }, o.settings.deadman, o.log.child('deadman'), (message) => o.log.warn('ALERT', { key: 'deadman', message }));
    this.ctx = {
      mode: this.mode, settings: o.settings, rest: o.rest, clock: o.clock, log: o.log.child(this.mode === 'live' ? 'live' : 'dry'), now: this.now,
      feed: this.feed, bucket: this.bucket,
      write: (op) => this.write(op), auth: () => this.auth(), inputs: () => this.inputs(),
      applyAccountPortfolio: (data) => this.account.applyPortfolio(data),
      accountHalt: (reason) => { void this.stop(reason); },
    };
    this.done = new Promise((resolve) => { this.finish = resolve; });
  }

  // ---------- signed writes (one attempt each; see RestClient.write) ----------
  private async write(op: Operation): Promise<WriteOutcome> {
    const credentials = this.o.credentials;
    if (!credentials) throw new Error('Dry-run has no write access');
    const request = await signOperation(op, credentials.signer, this.o.clock.nowMs());
    const outcome = await this.o.rest.write(request);
    this.o.log.debug('write', { op: op.type, n: Array.isArray(op.args) ? op.args.length : 1, kind: outcome.kind, ...(outcome.kind !== 'ok' ? { error: outcome.error } : {}) });
    return outcome;
  }
  private auth() { if (!this.o.credentials) throw new Error('No credentials'); return this.o.credentials.auth; }
  private async readAutoCancel(): Promise<AutoCancelStatus> {
    const s = await this.o.rest.getPrivate<{ deadline: number; triggered: number; daily_limit: number; next_reset: number }>('/v1/account/auto-cancel', this.auth());
    return { deadline: s.deadline, triggered: s.triggered, dailyLimit: s.daily_limit, nextReset: s.next_reset };
  }
  private inputs(): AccountInputs {
    return {
      privateHealthy: this.mode === 'dry_run' || (this.privateStream?.healthy() ?? false),
      exchangeCancelOnly: this.exchangeCancelOnly,
      deadmanDeadline: this.deadman ? this.deadman.deadline() : null,
      proxyExpiresAt: this.o.credentials?.expiresAt ?? null,
      killSwitch: existsSync(this.o.stopFile),
      dailyPnl: this.mode === 'live' ? this.account.dailyPnl(rewardPeriodStart(this.now())) : null,
      account: this.account.snapshot(),
    };
  }

  // ---------- lifecycle ----------
  async start(): Promise<void> {
    const { settings, log, rest } = this.o;
    await this.refreshExchange();
    if (this.mode === 'live') {
      if (this.exchangeCancelOnly) throw new Error('Exchange is in cancel-only mode; not starting');
      const limits = await rest.getPrivate<{ actions_per_minute_limit: number; open_orders_limit: number }>('/v1/account/limits', this.auth());
      this.bucket.setRate(limits.actions_per_minute_limit * settings.budget.actionShare);
      const autoCancel = await this.readAutoCancel();
      log.info('account limits', { actionsPerMinute: limits.actions_per_minute_limit, openOrders: limits.open_orders_limit, autoCancelDailyLimit: autoCancel.dailyLimit, autoCancelTriggered: autoCancel.triggered });
      if (autoCancel.dailyLimit > 0 && autoCancel.triggered >= autoCancel.dailyLimit) throw new Error('Auto-cancel daily trigger limit is exhausted; the dead man\'s switch could not protect orders');
      this.privateStream = new PrivateStream(this.o.egress, this.auth(), {
        resync: (reason) => { for (const q of this.quoters.values()) q.markResync(reason); },
        orders: (items) => { for (const q of this.quoters.values()) q.onOrders(items); },
        fills: (data) => { for (const q of this.quoters.values()) q.onFills(data); },
        portfolio: (data) => { this.account.applyPortfolio(data); for (const q of this.quoters.values()) q.onPortfolio(data); },
      }, log.child('private'), this.o.wsUrl, this.now);
      this.privateStream.start();
      this.account.restoreAnchor(await this.loadAnchor());
    }
    this.feed.start();
    this.running = true;
    this.status = 'running';
    // Instruments take ownership of their books first. Until the dead man's switch is confirmed their risk check
    // keeps them paused, so no order can rest unprotected; a refused startup never touches the account-wide timer.
    for (const instrument of this.o.instruments) await this.launch(instrument).catch(() => undefined);
    if (!this.quoters.size) throw new Error(`No instrument could start: ${this.failed.map((f) => `${f.symbol}: ${f.reason}`).join('; ')}`);
    if (this.mode === 'live') {
      await this.deadman!.arm();
      this.deadman!.start();
      log.info('dead man\'s switch armed', { deadline: new Date(this.deadman!.deadline()).toISOString() });
    }

    this.timers.push(setInterval(() => { if (existsSync(this.o.stopFile)) void this.stop('STOP file'); }, 1_000));
    this.timers.push(setInterval(() => { void this.refreshExchange().catch((error) => log.warn('exchange poll failed', { error: errorText(error) })); }, 60_000));
    this.timers.push(setInterval(() => { void this.o.clock.sync().catch((error) => log.warn('clock sync failed', { error: errorText(error) })); }, 300_000));
    if (this.mode === 'live') {
      this.timers.push(setInterval(() => { void this.saveAnchor(); }, 5_000));
      this.timers.push(setInterval(() => { void this.pollLimits(); }, 60_000));
      this.timers.push(setInterval(() => { void this.pollRewards(); }, 3_600_000));
      void this.pollRewards();
    }
    log.info('quoter running', { mode: this.mode, instruments: [...this.quoters.values()].map((q) => q.instrument.symbol), egress: this.o.egress.describe(), publicFeeds: this.feed.routes() });
  }

  /** Start quoting one instrument. A failure is recorded and leaves the other instruments running. */
  private async launch(instrument: Instrument): Promise<InstrumentQuoter> {
    const key = normalSymbol(instrument.symbol);
    if (this.quoters.has(instrument.id) || this.pending.has(key)) throw new Error(`${instrument.symbol} is already quoted`);
    this.pending.add(key);
    const quoter = new InstrumentQuoter(this.ctx, instrument, profileFor(this.o.settings, instrument.symbol));
    this.quoters.set(instrument.id, quoter);
    try {
      await quoter.start();
      this.dropFailure(instrument.symbol);
      return quoter;
    } catch (error) {
      const reason = errorText(error);
      this.o.log.error('instrument failed to start', { instrument: instrument.symbol, reason });
      await quoter.stop(`start failed: ${reason}`).catch(() => undefined);
      this.quoters.delete(instrument.id);
      this.dropFailure(instrument.symbol);
      this.failed.unshift({ symbol: instrument.symbol, reason, at: this.now() });
      if (this.failed.length > 20) this.failed.pop();
      throw new Error(reason);
    } finally { this.pending.delete(key); }
  }
  private dropFailure(symbol: string) { const i = this.failed.findIndex((f) => f.symbol === symbol); if (i >= 0) this.failed.splice(i, 1); }

  /** Dashboard: start quoting a listed instrument. */
  async addInstrument(symbolOrId: string): Promise<void> {
    if (!this.running || this.stopping) throw new Error('Quoter is not running');
    const wanted = symbolOrId.trim();
    const instrument = this.catalogRows.find((i) => String(i.id) === wanted || normalSymbol(i.symbol) === normalSymbol(wanted));
    if (!instrument) throw new Error(`${wanted} is not listed on Polymarket Perps`);
    if (instrument.settled || instrument.closeOnly) throw new Error(`${instrument.symbol} is ${instrument.settled ? 'settled' : 'close-only'}`);
    await this.launch(instrument);
    this.selectionSource = 'dashboard';
    await this.saveSelection();
    this.o.log.info('instrument added from dashboard', { instrument: instrument.symbol });
  }

  /** Dashboard: stop quoting one instrument (live: its orders are cancelled and verified). */
  async removeInstrument(symbolOrId: string): Promise<void> {
    const wanted = symbolOrId.trim();
    const quoter = [...this.quoters.values()].find((q) => String(q.instrument.id) === wanted || normalSymbol(q.instrument.symbol) === normalSymbol(wanted));
    if (!quoter) throw new Error(`${wanted} is not being quoted`);
    if (this.quoters.size === 1) throw new Error('At least one instrument must stay quoted; use Stop to end the process');
    const verified = await quoter.stop('removed from dashboard');
    if (!verified) throw new Error(`${quoter.instrument.symbol}: cancel not verified; it stays listed until its orders are gone`);
    this.quoters.delete(quoter.instrument.id);
    this.selectionSource = 'dashboard';
    await this.saveSelection();
    this.o.log.info('instrument removed from dashboard', { instrument: quoter.instrument.symbol });
  }

  stop(reason: string): Promise<void> {
    this.stopping ??= this.shutdown(reason);
    return this.stopping;
  }

  private async shutdown(reason: string): Promise<void> {
    const { log } = this.o;
    log.warn('stopping', { reason });
    this.status = 'stopping'; this.statusReason = reason;
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.deadman?.stop();
    const results = await Promise.all([...this.quoters.values()].map((q) => q.stop(reason).catch(() => false)));
    if (this.mode === 'live') {
      // Only clear a schedule this process armed, and only once every instrument's orders are verified gone.
      if (this.deadman?.armed() && results.every(Boolean)) await this.deadman.disarm().catch((error) => log.warn('disarm failed', { error: errorText(error) }));
      await this.saveAnchor();
    }
    this.feed.stop();
    this.privateStream?.stop();
    this.status = 'stopped'; this.statusReason = reason;
    this.finish(reason);
  }

  // ---------- account-level polling ----------
  private async refreshExchange(): Promise<void> {
    const { rest, clock } = this.o;
    const [exchange, rows] = await Promise.all([
      rest.getPublic<{ cancel_only?: boolean }>('/v1/info/exchange'),
      rest.getPublic<unknown[]>('/v1/info/instruments'),
    ]);
    this.exchangeCancelOnly = exchange.cancel_only === true;
    const parsed: Instrument[] = [];
    for (const row of Array.isArray(rows) ? rows : []) { try { parsed.push(parseInstrument(row, `${rest.base}/v1/info/instruments`, clock.nowMs())); } catch { /* malformed row: not offered */ } }
    if (parsed.length) this.catalogRows = parsed;
    for (const quoter of this.quoters.values()) {
      const fresh = parsed.find((i) => i.id === quoter.instrument.id);
      quoter.setInstrumentStatus(!fresh ? 'instrument no longer listed' : fresh.settled ? 'instrument settled' : fresh.closeOnly ? 'instrument close-only' : null);
    }
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
      const pct = share !== undefined && Number.isFinite(Number(share)) ? Number(share) * 100 : null;
      for (const quoter of this.quoters.values()) quoter.setMakerShare(pct);
      const rewards = await this.o.rest.getPrivate<{ data?: { date: string; breakdown?: { instrument_id?: number; reward_amount?: string }[] }[] }>('/v1/account/rewards', this.auth(), { limit: 3 });
      const recent = (rewards.data ?? []).map((day) => ({ date: day.date, byInstrument: Object.fromEntries([...this.quoters.values()].map((q) => [q.instrument.symbol, day.breakdown?.find((b) => b.instrument_id === q.instrument.id)?.reward_amount ?? null])) }));
      this.o.log.info('rewards', { makerShare7d: share ?? null, makerVolume7d: stats.maker_volume_7d ?? null, recent, source: `${this.o.rest.base}/v1/account/rewards` });
    } catch (error) { this.o.log.warn('rewards poll failed', { error: errorText(error) }); }
  }

  // ---------- persistence (non-secret) ----------
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
    const anchor = this.account.anchor();
    if (this.mode !== 'live' || !anchor) return;
    const text = JSON.stringify({ account: this.accountKey(), ...anchor });
    if (text === this.savedAnchor) return;
    try { await mkdir(this.o.settings.metrics.dir, { recursive: true }); await Bun.write(this.anchorFile(), text); this.savedAnchor = text; }
    catch (error) { this.o.log.warn('daily PnL anchor not saved', { error: errorText(error) }); }
  }
  /** The dashboard selection is restored at the next start (see main.ts). */
  private async saveSelection(): Promise<void> {
    const file = this.o.selectionFile;
    if (!file) return;
    try { await Bun.write(file, JSON.stringify({ instruments: [...this.quoters.values()].map((q) => q.instrument.symbol), updatedAt: new Date(this.now()).toISOString() }, null, 2)); }
    catch (error) { this.o.log.warn('instrument selection not saved', { error: errorText(error) }); }
  }

  // ---------- dashboard ----------
  quoted(): InstrumentQuoter[] { return [...this.quoters.values()]; }
  catalog(): CatalogRow[] {
    return this.catalogRows.map((i) => ({ id: i.id, symbol: i.symbol, category: i.category, closeOnly: i.closeOnly, settled: i.settled, quoted: this.quoters.has(i.id) }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  /** Read-only snapshot for the local dashboard. Contains no keys, secrets or proxy credentials. */
  dashboardState(selectedId?: number): DashboardState {
    const t = this.now(), quoters = this.quoted();
    const selected = (selectedId !== undefined ? this.quoters.get(selectedId) : undefined) ?? quoters[0] ?? null;
    const account = this.account.snapshot();
    return {
      now: t, mode: this.mode, status: this.status, statusReason: this.statusReason, startedAt: this.startedAt,
      egress: { primary: this.o.egress.describe(), feeds: this.feed.routes() },
      exchangeCancelOnly: this.exchangeCancelOnly,
      account: this.mode === 'live' ? { availableMargin: account.availableMargin, accountValue: account.accountValue, dailyPnl: this.account.dailyPnl(rewardPeriodStart(t)), inLiquidation: account.inLiquidation } : null,
      limits: { maxDailyLossUsd: this.o.settings.risk.maxDailyLossUsd, minAvailableMarginUsd: this.o.settings.risk.minAvailableMarginUsd },
      deadmanDeadline: this.deadman?.deadline() || null,
      credentialExpiresAt: this.o.credentials?.expiresAt ?? null,
      instruments: quoters.map((q) => q.summary()),
      failed: [...this.failed],
      selectionSource: this.selectionSource,
      selected: selected ? selected.detail() : null,
    };
  }
}
