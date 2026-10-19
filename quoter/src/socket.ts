import type { EgressPool } from './egress.ts';
import { errorText, type Logger } from './log.ts';

export interface Frame { id?: number; ch?: string; ts?: number; ets?: number; sq?: number; data?: unknown; }
export type SocketState = 'connecting' | 'open' | 'reconnecting' | 'closed';
export interface SocketHandlers {
  /** Called on every (re)connect; subscribe / authenticate here. A throw closes and reconnects. */
  onOpen(socket: ManagedSocket): Promise<void> | void;
  onFrame(frame: Frame): void;
  onState?(state: SocketState, note: string): void;
}
export interface SocketOptions { url: string; pingMs?: number; staleMs?: number; connectTimeoutMs?: number; failoverAfter?: number; now?: () => number;
  /** 0 follows the pool primary and fails the pool over; >0 pins a redundant stream to another route. */
  routeOffset?: number; }
type BunWebSocket = new (url: string, options: Record<string, unknown>) => WebSocket;

/**
 * Reconnecting WebSocket over the egress pool: application ping every ~25 s, stale after ~65 s
 * without messages (official keepalive guidance), exponential backoff, proxy failover after repeated failures.
 */
export class ManagedSocket {
  private socket: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private lastMessage = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 100;
  private shift = 0;
  private readonly pending = new Map<number, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly now: () => number;
  state: SocketState = 'closed';

  constructor(readonly name: string, private readonly egress: EgressPool, private readonly log: Logger, private readonly handlers: SocketHandlers, private readonly options: SocketOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void { if (!this.stopped) return; this.stopped = false; this.connect(); }
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearTimer();
    this.rejectPending(new Error(`${this.name} closed`));
    const socket = this.socket; this.socket = null;
    if (socket) { socket.onclose = null; try { socket.close(1000); } catch { /* already closed */ } }
    this.setState('closed', 'stopped');
  }
  isOpen(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  lastMessageAt(): number { return this.lastMessage; }

  send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error(`${this.name} is not open`);
    this.socket.send(JSON.stringify(payload));
  }

  /** Request/response over the socket by `id` (auth, subscribe). */
  request(payload: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name}: request ${id} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ ...payload, id }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error); }
    });
  }

  private offset(): number { return (this.options.routeOffset ?? 0) + this.shift; }
  route(): string { return this.egress.describe(this.egress.routeAt(this.offset())); }

  private setState(state: SocketState, note: string) {
    if (this.state === state && state !== 'reconnecting') return;
    this.state = state;
    this.handlers.onState?.(state, note);
  }
  private clearTimer() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private rejectPending(error: Error) {
    for (const [id, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(error); this.pending.delete(id); }
  }

  private connect() {
    if (this.stopped) return;
    this.setState(this.attempt ? 'reconnecting' : 'connecting', `via ${this.route()}`);
    let socket: WebSocket;
    try { socket = new (WebSocket as unknown as BunWebSocket)(this.options.url, this.egress.socketOptions(this.offset())); }
    catch (error) { this.log.warn('socket construct failed', { socket: this.name, error: errorText(error) }); this.schedule(); return; }
    this.socket = socket;
    // A proxy CONNECT or TLS handshake can hang without an error; abandon it and reconnect.
    const connectTimer = setTimeout(() => {
      if (socket !== this.socket || socket.readyState === WebSocket.OPEN) return;
      this.log.warn('socket connect timeout', { socket: this.name, via: this.route() });
      socket.onopen = null; socket.onmessage = null; socket.onclose = null;
      try { socket.close(); } catch { /* not open yet */ }
      this.socket = null;
      this.schedule();
    }, this.options.connectTimeoutMs ?? 10_000);
    socket.onopen = async () => {
      clearTimeout(connectTimer);
      if (socket !== this.socket) return;
      this.lastMessage = this.now();
      this.clearTimer();
      this.timer = setInterval(() => {
        if (socket !== this.socket) return;
        if (this.now() - this.lastMessage > (this.options.staleMs ?? 65_000)) { this.log.warn('socket stale; reconnecting', { socket: this.name }); socket.close(4000, 'stale'); return; }
        try { socket.send(JSON.stringify({ id: 0, req: 'post', op: { type: 'ping' } })); } catch { /* close handler reconnects */ }
      }, this.options.pingMs ?? 25_000);
      try {
        await this.handlers.onOpen(this);
        this.attempt = 0;
        this.setState('open', `via ${this.route()}`);
      } catch (error) {
        this.log.warn('socket open handler failed', { socket: this.name, error: errorText(error) });
        socket.close(4001, 'open handler failed');
      }
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      this.lastMessage = this.now();
      let frame: Frame;
      try { frame = JSON.parse(String(event.data)) as Frame; } catch { return; }
      if (typeof frame.id === 'number' && this.pending.has(frame.id)) {
        const entry = this.pending.get(frame.id)!;
        clearTimeout(entry.timer); this.pending.delete(frame.id); entry.resolve(frame.data);
        return;
      }
      try { this.handlers.onFrame(frame); } catch (error) { this.log.warn('frame handler failed', { socket: this.name, error: errorText(error) }); }
    };
    socket.onerror = () => { /* onclose follows */ };
    socket.onclose = (event) => {
      clearTimeout(connectTimer);
      if (socket !== this.socket) return;
      this.clearTimer();
      this.rejectPending(new Error(`${this.name} closed`));
      this.socket = null;
      if (!this.stopped) { this.log.warn('socket closed', { socket: this.name, code: event.code, reason: event.reason }); this.schedule(); }
    };
  }

  private schedule() {
    if (this.stopped) return;
    this.attempt++;
    const every = this.options.failoverAfter ?? 2;
    if (this.attempt % every === 0) {
      if (this.options.routeOffset) this.shift++;
      else this.egress.failover(`${this.name} reconnect #${this.attempt}`);
    }
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempt - 1, 6));
    this.setState('reconnecting', `retry in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
