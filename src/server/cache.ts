import type { Snapshot } from '../shared/contracts.ts';

export interface CacheValue<T> {
  data: T;
  /** The exchange observation time, when the response supplies one. */
  observedAt?: number | null;
  warning?: string | null;
  stale?: boolean;
}

interface Entry<T> {
  value: Snapshot<T> | null;
  inflight: Promise<Snapshot<T>> | null;
  expiresAt: number;
}

/** Bounded, coalescing read cache. Failed refreshes never advance observation timestamps. */
export class SnapshotCache {
  private readonly entries = new Map<string, Entry<unknown>>();
  constructor(private readonly now: () => number = Date.now, private readonly maxEntries = 512) {}

  get<T>(key: string, ttlMs: number, source: string, load: () => Promise<CacheValue<T>>, maxAgeMs?: number): Promise<Snapshot<T>> {
    let entry = this.entries.get(key) as Entry<T> | undefined;
    if (!entry) {
      // Only evict idle entries; never discard an in-flight request that another caller is awaiting.
      if (this.entries.size >= this.maxEntries) {
        const idle = [...this.entries].find(([, value]) => !value.inflight);
        if (idle) this.entries.delete(idle[0]);
        else return Promise.resolve(unavailable<T>(source, this.now(), 'Read cache is busy; retry shortly.'));
      }
      entry = { value: null, inflight: null, expiresAt: 0 };
      this.entries.set(key, entry as Entry<unknown>);
    }
    if (entry.inflight) return entry.inflight;
    if (entry.value && this.now() < entry.expiresAt) {
      const observed = entry.value.lastSuccessAt;
      if (entry.value.status === 'live' && maxAgeMs !== undefined && observed !== null
        && (this.now() - observed > maxAgeMs || observed > this.now() + 5_000)) {
        entry.value = { ...entry.value, status: 'stale', error: [entry.value.error, 'Exchange observation is outside the freshness window.'].filter(Boolean).join(' ') };
      }
      return Promise.resolve(entry.value);
    }
    const target = entry;
    target.inflight = (async () => {
      try {
        const result = await load();
        const receivedAt = this.now();
        const observedAt = result.observedAt ?? receivedAt;
        const old = maxAgeMs !== undefined && (receivedAt - observedAt > maxAgeMs || observedAt > receivedAt + 5_000);
        const warning = [result.warning, old ? 'Exchange observation is outside the freshness window.' : null].filter(Boolean).join(' ') || null;
        const snapshot: Snapshot<T> = {
          status: result.stale || old ? 'stale' : 'live', data: result.data, source,
          receivedAt, lastSuccessAt: observedAt, error: warning,
        };
        target.value = snapshot;
        target.expiresAt = receivedAt + ttlMs;
        return snapshot;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const previous = target.value;
        const snapshot: Snapshot<T> = previous?.data !== null && previous?.data !== undefined
          ? { ...previous, status: 'stale', error: message }
          : unavailable<T>(source, this.now(), message);
        target.value = snapshot;
        // A failed endpoint is never hammered by repeated UI reads.
        target.expiresAt = this.now() + 2_000;
        return snapshot;
      } finally {
        target.inflight = null;
      }
    })();
    return target.inflight;
  }
}

export function unavailable<T>(source: string, receivedAt: number, error: string): Snapshot<T> {
  return { status: 'unavailable', data: null, source, receivedAt, lastSuccessAt: null, error };
}
