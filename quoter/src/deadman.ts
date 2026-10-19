import { errorText, type Logger } from './log.ts';
import type { WriteOutcome } from './rest.ts';
import type { Operation } from './signer.ts';

export interface AutoCancelStatus { deadline: number; triggered: number; dailyLimit: number; nextReset: number; }
export interface DeadmanPort {
  write(op: Operation): Promise<WriteOutcome>;
  readStatus(): Promise<AutoCancelStatus>;
  nowMs(): number;
}

/**
 * Exchange-side dead man's switch (spec §3 DeadMan): re-arm `autoCancel` every `rearmEveryS` with a deadline
 * `timeoutS` ahead. A crashed process stops re-arming and the exchange cancels every open order of the account.
 * Each arm is a new signed operation (one attempt); an unclear outcome is resolved by reading the deadline back.
 */
export class Deadman {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastDeadline = 0;
  failures = 0;

  constructor(private readonly port: DeadmanPort, private readonly options: { timeoutS: number; rearmEveryS: number }, private readonly log: Logger, private readonly alert: (message: string) => void) {}

  async arm(): Promise<number> {
    const deadline = this.port.nowMs() + this.options.timeoutS * 1_000;
    const outcome = await this.port.write({ type: 'autoCancel', args: { time: deadline } });
    if (outcome.kind === 'ok') {
      const confirmed = (outcome.body as { deadline?: unknown }).deadline;
      this.lastDeadline = typeof confirmed === 'number' ? confirmed : deadline;
      this.failures = 0;
      return this.lastDeadline;
    }
    this.failures++;
    if (outcome.kind === 'indeterminate') {
      try { const status = await this.port.readStatus(); this.lastDeadline = status.deadline; } catch (error) { this.log.warn('auto-cancel readback failed', { error: errorText(error) }); }
    }
    this.alert(`auto-cancel re-arm ${outcome.kind}: ${outcome.error}; last confirmed deadline ${this.lastDeadline ? new Date(this.lastDeadline).toISOString() : 'none'}`);
    throw new Error(`auto-cancel ${outcome.kind}: ${outcome.error}`);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.arm().catch(() => { /* alerted */ }); }, this.options.rearmEveryS * 1_000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Clear the schedule at a clean shutdown: triggers are limited per day. */
  async disarm(): Promise<void> {
    this.stop();
    const outcome = await this.port.write({ type: 'autoCancel', args: { time: 0 } });
    if (outcome.kind !== 'ok') this.log.warn('auto-cancel disarm not confirmed; the deadline will still fire', { kind: outcome.kind, error: outcome.error });
    else this.lastDeadline = 0;
  }
  deadline(): number { return this.lastDeadline; }
}
