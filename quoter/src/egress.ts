import { errorText, registerSecret, type Logger } from './log.ts';

/**
 * Outbound HTTP(S)/WSS egress through operator-supplied HTTP proxies.
 * Reads and stream connections may fail over between proxies. Signed writes never do:
 * they get exactly one attempt on the current route (see RestClient.write).
 */
export interface EgressProxy { label: string; url: string; endpoint: string; }
export interface ProbeResult { label: string; ok: boolean; latencyMs: number | null; serverTime: number | null; error: string | null; }

const HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/i;

/** Accepts `label=host:port:user:pass`, `host:port:user:pass`, `host:port` or `http://user:pass@host:port`, separated by commas or newlines. */
export function parseEgressList(raw: string | undefined): EgressProxy[] {
  if (!raw?.trim()) return [];
  const result: EgressProxy[] = [];
  for (const [index, entry] of raw.split(/[,\n]/).map((part) => part.trim()).filter(Boolean).entries()) {
    const eq = entry.indexOf('=');
    const label = eq > 0 && !entry.slice(0, eq).includes(':') ? entry.slice(0, eq).trim() : `proxy${index + 1}`;
    const spec = eq > 0 && !entry.slice(0, eq).includes(':') ? entry.slice(eq + 1).trim() : entry;
    let host: string, port: string, user = '', pass = '';
    if (/^https?:\/\//i.test(spec)) {
      const url = new URL(spec);
      host = url.hostname; port = url.port; user = decodeURIComponent(url.username); pass = decodeURIComponent(url.password);
    } else {
      const parts = spec.split(':');
      if (parts.length !== 2 && parts.length !== 4) throw new Error(`Egress proxy ${label}: expected host:port or host:port:user:pass`);
      [host, port] = [parts[0]!, parts[1]!];
      if (parts.length === 4) [user, pass] = [parts[2]!, parts[3]!];
    }
    const portNumber = Number(port);
    if (!HOST.test(host) || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) throw new Error(`Egress proxy ${label}: invalid host or port`);
    if (!/^[\w.-]{1,40}$/.test(label)) throw new Error(`Egress proxy label "${label}" is invalid`);
    if (result.some((proxy) => proxy.label === label)) throw new Error(`Duplicate egress proxy label ${label}`);
    registerSecret(pass); registerSecret(user);
    const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
    result.push({ label, url: `http://${auth}${host}:${portNumber}`, endpoint: `${host}:${portNumber}` });
  }
  return result;
}

export interface EgressOptions { proxies: EgressProxy[]; allowDirect: boolean; timeoutMs: number; log: Logger; fetch?: typeof fetch; now?: () => number; cooldownMs?: number; }
type Route = EgressProxy | null; // null = direct connection

export class EgressPool {
  private order: Route[];
  private index = 0;
  private readonly failedUntil = new Map<string, number>();
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly cooldownMs: number;

  constructor(private readonly options: EgressOptions) {
    if (!options.proxies.length && !options.allowDirect) throw new Error('No egress proxy configured (QUOTER_EGRESS_PROXIES) and direct egress is disabled');
    this.order = [...options.proxies, ...(options.allowDirect ? [null] : [])];
    this.doFetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.cooldownMs = options.cooldownMs ?? 60_000;
  }

  private key = (route: Route) => route?.label ?? 'direct';
  describe(route: Route = this.current()): string { return route ? `${route.label} (${route.endpoint})` : 'direct'; }
  current(): Route { return this.order[this.index] ?? null; }
  routes(): Route[] { return [...this.order]; }

  private init(route: Route, init: RequestInit = {}): RequestInit {
    const signal = init.signal ?? AbortSignal.timeout(this.options.timeoutMs);
    return route ? { ...init, signal, proxy: route.url } as RequestInit : { ...init, signal };
  }

  /** Measure every route against the official server-time endpoint; with `reorder`, the fastest healthy route becomes current. */
  async probe(baseUrl: string, reorder: boolean): Promise<ProbeResult[]> {
    const results = await Promise.all(this.order.map(async (route) => {
      const started = performance.now();
      try {
        const response = await this.doFetch(`${baseUrl}/v1/info/time`, this.init(route));
        const body = await response.json() as { time?: unknown };
        if (!response.ok || typeof body.time !== 'number') throw new Error(`HTTP ${response.status}`);
        return { route, result: { label: this.key(route), ok: true, latencyMs: Math.round(performance.now() - started), serverTime: body.time, error: null } };
      } catch (error) {
        return { route, result: { label: this.key(route), ok: false, latencyMs: null, serverTime: null, error: errorText(error) } };
      }
    }));
    if (reorder) {
      const healthy = results.filter((r) => r.result.ok).sort((a, b) => a.result.latencyMs! - b.result.latencyMs!).map((r) => r.route);
      const failed = results.filter((r) => !r.result.ok).map((r) => r.route);
      // Direct egress, when allowed, stays a last resort regardless of latency.
      this.order = [...healthy.filter((r) => r !== null), ...failed.filter((r) => r !== null), ...(this.options.allowDirect ? [null] : [])];
      this.index = 0;
    }
    for (const { route, result } of results) if (!result.ok) this.failedUntil.set(this.key(route), this.now() + this.cooldownMs);
    return results.map((r) => r.result);
  }

  /** Mark the current route failed and move to the next one that is not cooling down. */
  failover(reason: string): Route {
    const failed = this.current();
    this.failedUntil.set(this.key(failed), this.now() + this.cooldownMs);
    for (let step = 1; step <= this.order.length; step++) {
      const next = (this.index + step) % this.order.length;
      if ((this.failedUntil.get(this.key(this.order[next] ?? null)) ?? 0) <= this.now()) { this.index = next; break; }
      if (step === this.order.length) this.index = (this.index + 1) % this.order.length;
    }
    this.options.log.warn('egress failover', { from: this.describe(failed), to: this.describe(), reason });
    return this.current();
  }

  /** Idempotent reads: network failures fail over to the next route, at most once per route. */
  async read(url: string, init: RequestInit = {}): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.order.length; attempt++) {
      const route = this.current();
      try { return await this.doFetch(url, this.init(route, init)); }
      catch (error) { lastError = error; if (this.order.length > 1) this.failover(errorText(error)); }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Signed writes: exactly one attempt on the current route, no failover, no retry. */
  async writeOnce(url: string, init: RequestInit): Promise<Response> {
    return await this.doFetch(url, this.init(this.current(), init));
  }

  /** Route `offset` positions after the current one (redundant streams use distinct routes). */
  routeAt(offset: number): Route { return this.order[(this.index + offset) % this.order.length] ?? null; }
  size(): number { return this.order.length; }

  /** WebSocket constructor options (Bun supports `proxy`). */
  socketOptions(offset = 0): Record<string, unknown> {
    const route = this.routeAt(offset);
    return route ? { proxy: route.url } : {};
  }
}
