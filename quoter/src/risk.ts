import type { Settings } from './config.ts';
import type { SlotKey } from './quoteEngine.ts';

export interface RiskInputs {
  now: number;
  bookStatus: 'live' | 'stale' | 'unavailable';
  publicConnected: boolean;
  /** Private stream health (live mode only). */
  privateHealthy: boolean;
  resyncPending: string | null;
  moveBps: number;
  inLiquidation: boolean;
  dailyPnl: number | null;
  availableMargin: number | null;
  exchangeCancelOnly: boolean;
  instrumentHalted: string | null;
  postOnlyRejects: ReadonlyMap<SlotKey, number>;
  proxyExpiresAt: number | null;
  /** Live mode: last exchange-confirmed auto-cancel deadline (0 = none). Null in dry-run. */
  deadmanDeadline: number | null;
  killSwitch: boolean;
}
export type RiskAction =
  | { kind: 'quote'; sizeScale: number; extraBps: number; widenTicks: Map<SlotKey, number>; notes: string[] }
  /** Keep resting orders, send nothing (state is not trustworthy, or new orders are refused). */
  | { kind: 'freeze'; reason: string; allowCancel: boolean }
  /** Pull all quotes, resume automatically. */
  | { kind: 'pull'; reason: string }
  /** Pull all quotes and stop until a manual restart. */
  | { kind: 'halt'; reason: string; scope: 'account' | 'instrument' };

/** Spec §9. Stateful only for timers (volatility pause, post-only widen windows, alerts). */
export class RiskManager {
  private pausedUntil = 0;
  private widenUntil = new Map<SlotKey, number>();
  private haltReason: string | null = null;
  private haltScope: 'account' | 'instrument' = 'account';
  private lastAlert = new Map<string, number>();
  private frozenSince: number | null = null;

  constructor(private readonly settings: Settings, private readonly alert: (key: string, message: string) => void) {}

  halted(): string | null { return this.haltReason; }

  evaluate(input: RiskInputs): RiskAction {
    const risk = this.settings.risk;
    if (this.haltReason) return { kind: 'halt', reason: this.haltReason, scope: this.haltScope };
    // Account-wide halts stop the whole process; an instrument halt (settled, close-only) stops only that instrument.
    const halt = (reason: string, scope: 'account' | 'instrument' = 'account'): RiskAction => { this.haltReason = reason; this.haltScope = scope; this.alertOnce('halt', `HALT: ${reason}`, input.now, 0); return { kind: 'halt', reason, scope }; };

    if (input.killSwitch) return halt('kill switch');
    if (input.inLiquidation) return halt('account in liquidation');
    if (input.instrumentHalted) return halt(input.instrumentHalted, 'instrument');
    if (input.dailyPnl !== null && risk.maxDailyLossUsd > 0 && input.dailyPnl < -risk.maxDailyLossUsd) return halt(`daily PnL ${input.dailyPnl.toFixed(2)} below -${risk.maxDailyLossUsd}`);
    if (input.proxyExpiresAt !== null && input.proxyExpiresAt - input.now < 86_400_000) this.alertOnce('proxy-expiry', `Polymarket proxy credential expires at ${new Date(input.proxyExpiresAt).toISOString()}`, input.now, 3_600_000);
    if (input.proxyExpiresAt !== null && input.proxyExpiresAt - input.now < this.settings.deadman.timeoutS * 2_000) return halt('Polymarket proxy credential about to expire');

    if (!input.publicConnected || input.bookStatus !== 'live') return this.unfreeze({ kind: 'pull', reason: `market data ${input.publicConnected ? input.bookStatus : 'disconnected'}` });
    // Unprotected orders must not rest: two missed re-arms, or an expired deadline, pull everything.
    const rearmMs = this.settings.deadman.rearmEveryS * 1_000;
    if (input.deadmanDeadline === 0) return this.unfreeze({ kind: 'pull', reason: "waiting for the dead man's switch" });
    if (input.deadmanDeadline !== null && input.deadmanDeadline - input.now < rearmMs) {
      this.alertOnce('deadman-health', "Dead man's switch deadline not renewed; quotes pulled until it is", input.now, 60_000);
      return this.unfreeze({ kind: 'pull', reason: "dead man's switch not confirmed" });
    }

    // The volatility breaker is checked before any freeze so a frozen state never hides a fast market.
    const breaker = risk.volBreaker;
    let extraBps = 0;
    if (input.moveBps > breaker.moveBps) {
      this.pausedUntil = Math.max(this.pausedUntil, input.now + breaker.pauseS * 1_000);
      this.alertOnce('vol', `Volatility breaker: ${input.moveBps.toFixed(1)} bps in ${breaker.windowS}s`, input.now, 30_000);
    }
    if (input.now < this.pausedUntil) {
      if (breaker.action === 'pause') return this.unfreeze({ kind: 'pull', reason: `volatility pause until ${new Date(this.pausedUntil).toISOString()}` });
      extraBps = breaker.widenBps;
    }

    const freezeReason = input.resyncPending ? `resync: ${input.resyncPending}` : !input.privateHealthy ? 'private stream unhealthy' : input.exchangeCancelOnly ? 'exchange cancel-only mode' : null;
    if (freezeReason) {
      this.frozenSince ??= input.now;
      // A freeze is meant to last one reconcile; resting orders must not outlive an unverified state for long.
      if (input.now - this.frozenSince > risk.maxFreezeS * 1_000) return { kind: 'pull', reason: `frozen for more than ${risk.maxFreezeS}s (${freezeReason})` };
      return { kind: 'freeze', reason: freezeReason, allowCancel: input.exchangeCancelOnly && !input.resyncPending && input.privateHealthy };
    }
    this.frozenSince = null;

    const notes: string[] = [];
    let sizeScale = 1;
    if (input.availableMargin !== null && risk.minAvailableMarginUsd > 0 && input.availableMargin < risk.minAvailableMarginUsd) {
      sizeScale = Math.max(0, input.availableMargin / risk.minAvailableMarginUsd);
      notes.push(`margin ${input.availableMargin.toFixed(0)} < ${risk.minAvailableMarginUsd}: size ×${sizeScale.toFixed(2)}`);
    }

    const widen = risk.postOnlyRejectWiden, widenTicks = new Map<SlotKey, number>();
    for (const [slot, count] of input.postOnlyRejects) if (count >= widen.after) this.widenUntil.set(slot, input.now + widen.forS * 1_000);
    for (const [slot, until] of this.widenUntil) {
      if (until > input.now) widenTicks.set(slot, widen.ticks); else this.widenUntil.delete(slot);
    }
    return { kind: 'quote', sizeScale, extraBps, widenTicks, notes };
  }

  private unfreeze(action: RiskAction): RiskAction { this.frozenSince = null; return action; }

  private alertOnce(key: string, message: string, now: number, everyMs: number) {
    const last = this.lastAlert.get(key) ?? -Infinity;
    if (now - last < everyMs) return;
    this.lastAlert.set(key, now);
    this.alert(key, message);
  }
}
