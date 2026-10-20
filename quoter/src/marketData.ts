import { exact, type Dec } from './decimal.ts';
import type { EgressPool } from './egress.ts';
import type { Logger } from './log.ts';
import { WS_URL, type RestClient } from './rest.ts';
import { ManagedSocket, type Frame } from './socket.ts';

export type Level = [price: Dec, quantity: Dec];
export type DataStatus = 'live' | 'stale' | 'unavailable';
export interface MarketState {
  instrumentId: number;
  bestBid: Dec | null; bestAsk: Dec | null; mid: Dec | null;
  bids: Level[]; asks: Level[];
  /** Local receive time and exchange event time of the latest accepted update. */
  receivedAt: number | null; exchangeTs: number | null; sequence: number | null;
  source: string; status: DataStatus;
}

function levels(value: unknown, bid: boolean): Level[] | null {
  if (!Array.isArray(value)) return null;
  const out: Level[] = [];
  for (const row of value) {
    if (!Array.isArray(row)) return null;
    let price: Dec, quantity: Dec;
    try { price = exact(row[0], 'book price'); quantity = exact(row[1], 'book quantity'); } catch { return null; }
    if (price.lte(0) || quantity.lte(0)) return null;
    const previous = out[out.length - 1];
    if (previous && (bid ? price.gte(previous[0]) : price.lte(previous[0]))) return null;
    out.push([price, quantity]);
  }
  return out;
}

/** One instrument's order book: `book::<iid>` (top-20 snapshot every 100 ms) and `bbo::<iid>` frames routed by the feed. */
export class MarketBook {
  private bestBid: Dec | null = null;
  private bestAsk: Dec | null = null;
  private bids: Level[] = [];
  private asks: Level[] = [];
  private receivedAt: number | null = null;
  private exchangeTs: number | null = null;
  private sequence: number | null = null;
  private source = 'none';
  private readonly history: { t: number; mid: Dec }[] = [];
  private readonly now: () => number;

  constructor(readonly instrumentId: number, private readonly options: { staleMs: number; onUpdate?: (state: MarketState) => void; now?: () => number }) {
    this.now = options.now ?? Date.now;
  }

  async seedFromRest(rest: RestClient): Promise<void> {
    const body = await rest.getPublic<{ instrument_id: number; bids: unknown; asks: unknown; timestamp: number; sequence: number }>('/v1/info/book', { instrument_id: this.instrumentId, depth: 100 });
    const bids = levels(body.bids, true), asks = levels(body.asks, false);
    if (!bids || !asks || body.instrument_id !== this.instrumentId) throw new Error('/v1/info/book: malformed book');
    this.apply(bids, asks, body.timestamp, body.sequence, `${rest.base}/v1/info/book`);
  }

  ingest(frame: Frame): void {
    // `sq` is exchange-global: drop duplicates from the redundant feed and anything older, unless the book went stale
    // (a sequence reset upstream must not freeze the book forever).
    const fresh = this.receivedAt !== null && this.now() - this.receivedAt <= this.options.staleMs;
    if (typeof frame.sq === 'number' && this.sequence !== null && frame.sq <= this.sequence && fresh) return;
    if (frame.ch === `book::${this.instrumentId}`) {
      const data = frame.data as { b?: unknown; a?: unknown } | undefined;
      const bids = levels(data?.b, true), asks = levels(data?.a, false);
      if (!bids || !asks) return;
      this.apply(bids, asks, frame.ets ?? frame.ts ?? null, frame.sq ?? null, `${WS_URL} book::${this.instrumentId}`);
    } else if (frame.ch === `bbo::${this.instrumentId}`) {
      const data = frame.data as { bp?: unknown; bq?: unknown; ap?: unknown; aq?: unknown } | undefined;
      const bid = levels([[data?.bp, data?.bq]], true), ask = levels([[data?.ap, data?.aq]], false);
      if (!bid?.[0] || !ask?.[0]) return;
      // Keep deeper levels that remain consistent with the new top of book.
      const bids = [bid[0], ...this.bids.filter(([p]) => p.lt(bid[0]![0]))];
      const asks = [ask[0], ...this.asks.filter(([p]) => p.gt(ask[0]![0]))];
      this.apply(bids, asks, frame.ts ?? null, frame.sq ?? null, `${WS_URL} bbo::${this.instrumentId}`);
    }
  }

  private apply(bids: Level[], asks: Level[], exchangeTs: number | null, sequence: number | null, source: string) {
    const bid = bids[0]?.[0] ?? null, ask = asks[0]?.[0] ?? null;
    if (bid && ask && bid.gte(ask)) return; // crossed/locked frames never replace a valid book
    const t = this.now();
    this.bids = bids; this.asks = asks; this.bestBid = bid; this.bestAsk = ask;
    this.receivedAt = t; this.exchangeTs = exchangeTs; this.sequence = sequence; this.source = source;
    if (bid && ask) {
      const mid = bid.plus(ask).div(2);
      const last = this.history[this.history.length - 1];
      if (!last || !last.mid.eq(mid) || t - last.t >= 1_000) this.history.push({ t, mid });
      while (this.history.length && this.history[0]!.t < t - 600_000) this.history.shift();
    }
    this.options.onUpdate?.(this.snapshot());
  }

  snapshot(): MarketState {
    const t = this.now();
    const age = this.receivedAt === null ? Infinity : t - this.receivedAt;
    const complete = this.bestBid !== null && this.bestAsk !== null;
    const status: DataStatus = !complete || this.receivedAt === null ? 'unavailable' : age > this.options.staleMs ? 'stale' : 'live';
    return {
      instrumentId: this.instrumentId, bestBid: this.bestBid, bestAsk: this.bestAsk,
      mid: complete ? this.bestBid!.plus(this.bestAsk!).div(2) : null,
      bids: this.bids, asks: this.asks, receivedAt: this.receivedAt, exchangeTs: this.exchangeTs, sequence: this.sequence, source: this.source, status,
    };
  }

  /** Largest absolute midpoint move (bps) between now and any sample in the last `windowMs`. */
  maxMoveBps(windowMs: number): number {
    const t = this.now(), current = this.history[this.history.length - 1];
    if (!current) return 0;
    let worst = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const sample = this.history[i]!;
      if (sample.t < t - windowMs) break;
      worst = Math.max(worst, current.mid.minus(sample.mid).abs().div(sample.mid).mul(10_000).toNumber());
    }
    return worst;
  }
}

/**
 * Public market data for every quoted instrument over shared sockets. Redundant connections run over distinct egress
 * routes so one proxy dropping its tunnel does not stale the books. Instruments can be added and removed at runtime;
 * each (re)connect subscribes to the current set.
 */
export class PublicFeed {
  private readonly books = new Map<number, MarketBook>();
  private readonly sockets: ManagedSocket[];

  constructor(egress: EgressPool, private readonly log: Logger, options: { feeds: number; url?: string }) {
    const feeds = Math.max(1, Math.min(options.feeds, egress.size()));
    this.sockets = Array.from({ length: feeds }, (_, index) => new ManagedSocket(`public${index + 1}`, egress, log, {
      onOpen: async (socket) => { if (this.books.size) await this.subscribe(socket, [...this.books.keys()], 'sub'); },
      onFrame: (frame) => {
        const id = Number(frame.ch?.split('::')[1]);
        if (Number.isSafeInteger(id)) this.books.get(id)?.ingest(frame);
      },
      onState: (state, note) => log.info('public stream', { feed: index + 1, state, note }),
    }, { url: options.url ?? WS_URL, routeOffset: index }));
  }

  private async subscribe(socket: ManagedSocket, ids: number[], req: 'sub' | 'unsub'): Promise<void> {
    const reply = await socket.request({ req, chs: ids.flatMap((id) => [`bbo::${id}`, `book::${id}`]) });
    if (req === 'sub' && Array.isArray(reply) && reply.some((item) => (item as { status?: string })?.status === 'err')) throw new Error(`subscription rejected: ${JSON.stringify(reply)}`);
  }

  start(): void { for (const socket of this.sockets) socket.start(); }
  stop(): void { for (const socket of this.sockets) socket.stop(); }
  connected(): boolean { return this.sockets.some((socket) => socket.isOpen()); }
  routes(): string[] { return this.sockets.map((socket) => `${socket.name}:${socket.state}:${socket.route()}`); }

  /** Route frames for `book` and subscribe it on every open socket (closed ones subscribe on reconnect). */
  async add(book: MarketBook): Promise<void> {
    this.books.set(book.instrumentId, book);
    await Promise.all(this.sockets.filter((s) => s.isOpen()).map((s) => this.subscribe(s, [book.instrumentId], 'sub').catch((error) => {
      this.log.warn('subscribe failed; reconnecting feed', { feed: s.name, instrument: book.instrumentId, error: String(error) });
      s.reconnect('subscribe failed');
    })));
  }

  async remove(instrumentId: number): Promise<void> {
    if (!this.books.delete(instrumentId)) return;
    await Promise.all(this.sockets.filter((s) => s.isOpen()).map((s) => this.subscribe(s, [instrumentId], 'unsub').catch(() => undefined)));
  }
}
