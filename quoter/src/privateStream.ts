import { SequenceTracker } from './account.ts';
import type { EgressPool } from './egress.ts';
import type { Logger } from './log.ts';
import { WS_URL, type PrivateAuth } from './rest.ts';
import { ManagedSocket, type Frame } from './socket.ts';

/** Where private frames go. The hub routes them to the instrument quoters and the account store. */
export interface PrivateSink {
  /** State may have missed frames (reconnect, gap, server resync, fresh subscription): rebuild it from REST. */
  resync(reason: string): void;
  orders(items: unknown[]): void;
  fills(data: unknown): void;
  portfolio(data: unknown): void;
}

/** Authenticated `orders`, `fills`, `portfolio`, `balances` channels for the whole account (spec §7). */
export class PrivateStream {
  private readonly socket: ManagedSocket;
  private readonly sequence: SequenceTracker;
  private authorized = false;
  pod: string | null = null;

  constructor(egress: EgressPool, auth: PrivateAuth, private readonly sink: PrivateSink, log: Logger, url = WS_URL, now: () => number = Date.now) {
    this.sequence = new SequenceTracker(now);
    this.sequence.onDistrust = () => log.warn('private sq jumps are routine; gap detection disabled for this connection, periodic reconcile continues');
    this.socket = new ManagedSocket('private', egress, log, {
      onOpen: async (socket) => {
        this.authorized = false;
        this.sequence.reset();
        sink.resync('private stream (re)connected');
        const reply = await socket.request({ req: 'post', op: { type: 'auth', args: { proxy: auth.proxy, secret: auth.secret } } }) as { status?: string; error?: string; pod?: string } | null;
        if (reply?.status !== 'ok') throw new Error(`auth rejected: ${reply?.error ?? 'no status'}`);
        this.pod = reply.pod ?? null;
        log.info('private stream authenticated', { pod: this.pod });
        const sub = await socket.request({ req: 'sub', chs: ['orders', 'fills', 'portfolio', 'balances'] });
        if (Array.isArray(sub) && sub.some((item) => (item as { status?: string })?.status === 'err')) throw new Error(`private subscription rejected: ${JSON.stringify(sub)}`);
        this.authorized = true;
        // Frames before the subscription were not received: state must be rebuilt from REST after this point.
        sink.resync('private stream subscribed');
      },
      onFrame: (frame) => this.onFrame(frame),
      onState: (s, note) => { if (s !== 'open') this.authorized = false; log.info('private stream', { state: s, note }); },
    }, { url });
  }

  start(): void { this.socket.start(); }
  stop(): void { this.socket.stop(); }
  healthy(): boolean { return this.authorized && this.socket.isOpen(); }

  private onFrame(frame: Frame) {
    const channel = frame.ch;
    if (!channel || !['orders', 'fills', 'portfolio', 'balances', 'resync'].includes(channel)) return;
    if (channel === 'resync') { this.sink.resync('server resync'); return; }
    const gap = this.sequence.check(channel, frame.sq);
    if (gap) this.sink.resync(gap);
    if (channel === 'orders') this.sink.orders(Array.isArray(frame.data) ? frame.data : [frame.data]);
    else if (channel === 'fills') this.sink.fills(frame.data);
    else if (channel === 'portfolio') this.sink.portfolio(frame.data);
  }
}
