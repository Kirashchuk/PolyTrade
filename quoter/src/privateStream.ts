import type { EgressPool } from './egress.ts';
import type { Logger } from './log.ts';
import { WS_URL, type PrivateAuth } from './rest.ts';
import { ManagedSocket, type Frame } from './socket.ts';
import type { FillRecord, StateStore } from './state.ts';

/** Authenticated `orders`, `fills`, `portfolio`, `balances` channels feeding the StateStore (spec §7). */
export class PrivateStream {
  private readonly socket: ManagedSocket;
  private authorized = false;
  pod: string | null = null;

  constructor(egress: EgressPool, auth: PrivateAuth, private readonly state: StateStore, log: Logger, private readonly hooks: { onOrder?: () => void; onFill?: (fills: FillRecord[]) => void } = {}, url = WS_URL) {
    this.socket = new ManagedSocket('private', egress, log, {
      onOpen: async (socket) => {
        this.authorized = false;
        state.resetSequences();
        state.markResync('private stream (re)connected');
        const reply = await socket.request({ req: 'post', op: { type: 'auth', args: { proxy: auth.proxy, secret: auth.secret } } }) as { status?: string; error?: string; pod?: string } | null;
        if (reply?.status !== 'ok') throw new Error(`auth rejected: ${reply?.error ?? 'no status'}`);
        this.pod = reply.pod ?? null;
        log.info('private stream authenticated', { pod: this.pod });
        const sub = await socket.request({ req: 'sub', chs: ['orders', 'fills', 'portfolio', 'balances'] });
        if (Array.isArray(sub) && sub.some((item) => (item as { status?: string })?.status === 'err')) throw new Error(`private subscription rejected: ${JSON.stringify(sub)}`);
        this.authorized = true;
        // Frames before the subscription were not received: state must be rebuilt from REST after this point.
        state.markResync('private stream subscribed');
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
    if (channel === 'resync') { this.state.markResync('server resync'); return; }
    this.state.checkSequence(channel, frame.sq);
    if (channel === 'orders') {
      for (const item of Array.isArray(frame.data) ? frame.data : [frame.data]) this.state.applyOrder(item);
      this.hooks.onOrder?.();
    } else if (channel === 'fills') {
      const fills = this.state.applyFills(frame.data);
      if (fills.length) this.hooks.onFill?.(fills);
    } else if (channel === 'portfolio') {
      this.state.applyPortfolio(frame.data);
    }
  }
}
