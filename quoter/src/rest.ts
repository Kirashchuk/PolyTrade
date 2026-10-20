import type { Address } from 'viem';
import type { EgressPool } from './egress.ts';
import { errorText, type Logger } from './log.ts';
import { requestBody, ROUTES, type SignedRequest } from './signer.ts';

export const REST_BASE = 'https://api.perpetuals.polymarket.com';
export const WS_URL = 'wss://ws.perpetuals.polymarket.com/v1/ws';

export interface PrivateAuth { proxy: Address; secret: string; }
export type WriteOutcome =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'rejected'; status: number; error: string; body: unknown }
  | { kind: 'indeterminate'; status: number | null; error: string };

/** Statuses that prove the request was not executed. Anything else that is not 2xx is indeterminate. */
const DEFINITE_REJECTION = new Set([400, 401, 403, 404, 405, 409, 413, 415, 422, 429]);

/** A single-object acknowledgement counts only with an explicit `status: "ok"` in the body. */
export const acknowledged = (outcome: WriteOutcome): boolean =>
  outcome.kind === 'ok' && typeof outcome.body === 'object' && outcome.body !== null && (outcome.body as { status?: unknown }).status === 'ok';

export class HttpError extends Error {
  constructor(readonly status: number, readonly path: string, readonly code: string) { super(`${path}: HTTP ${status} ${code}`); }
}

export class RestClient {
  constructor(private readonly egress: EgressPool, private readonly log: Logger, readonly base = REST_BASE) {}

  url(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(path, this.base);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
  }

  private async readJson<T>(path: string, response: Response): Promise<T> {
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    if (!response.ok) {
      const code = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : text.slice(0, 120);
      throw new HttpError(response.status, path, code);
    }
    if (body === null) throw new Error(`${path}: empty or invalid JSON response`);
    return body as T;
  }

  async getPublic<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.readJson<T>(path, await this.egress.read(this.url(path, query)));
  }

  /** Private reads authenticate with proxy address + secret headers (never logged). */
  async getPrivate<T>(path: string, auth: PrivateAuth, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.readJson<T>(path, await this.egress.read(this.url(path, query), { headers: { 'polymarket-proxy': auth.proxy, 'polymarket-secret': auth.secret } }));
  }

  /** One attempt, no retry, no failover. Transport ambiguity is reported, never resolved here. */
  async sendOnce(method: string, path: string, body: string): Promise<WriteOutcome> {
    let response: Response;
    try {
      response = await this.egress.writeOnce(this.url(path), { method, headers: { 'content-type': 'application/json' }, body });
    } catch (error) {
      this.log.warn('write transport failure', { path, error: errorText(error) });
      return { kind: 'indeterminate', status: null, error: errorText(error) };
    }
    let parsed: unknown = null, text = '';
    try { text = await response.text(); parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (response.ok) {
      if (parsed === null) return { kind: 'indeterminate', status: response.status, error: 'unreadable acknowledgement' };
      return { kind: 'ok', status: response.status, body: parsed };
    }
    const error = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed ? String((parsed as { error: unknown }).error)
      : Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object' && 'error' in parsed[0] ? String((parsed[0] as { error: unknown }).error) : text.slice(0, 120);
    if (DEFINITE_REJECTION.has(response.status)) return { kind: 'rejected', status: response.status, error, body: parsed };
    return { kind: 'indeterminate', status: response.status, error };
  }

  async write(request: SignedRequest): Promise<WriteOutcome> {
    const route = ROUTES[request.op.type];
    return this.sendOnce(route.method, route.path, requestBody(request));
  }
}

/** Server-time offset (spec §3 Clock). Signatures expire after 5 minutes, so `ts` uses server time. */
export class Clock {
  private offsetMs = 0;
  private syncedAt: number | null = null;
  constructor(private readonly rest: RestClient, private readonly local: () => number = Date.now) {}
  async sync(): Promise<{ offsetMs: number; rttMs: number }> {
    const t0 = this.local();
    const body = await this.rest.getPublic<{ time: unknown }>('/v1/info/time');
    const t1 = this.local();
    if (typeof body.time !== 'number' || !Number.isSafeInteger(body.time)) throw new Error('/v1/info/time: malformed time');
    this.offsetMs = body.time - Math.round((t0 + t1) / 2);
    this.syncedAt = t1;
    return { offsetMs: this.offsetMs, rttMs: t1 - t0 };
  }
  nowMs(): number { return this.local() + this.offsetMs; }
  offset(): number { return this.offsetMs; }
  lastSync(): number | null { return this.syncedAt; }
}
