import { createEffect, createSignal, onCleanup, onMount, type Accessor } from 'solid-js';
import type { Snapshot } from '../shared/contracts';

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, signal: init.signal ?? AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? body?.message ?? `Request failed (${response.status})`);
  if (body === null) throw new Error('The service returned an invalid response.');
  return body as T;
}

export function useSnapshot<T>(path: Accessor<string>, every = 15_000) {
  const [snapshot, setSnapshot] = createSignal<Snapshot<T> | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  let latestPath = '';
  let generation = 0;
  let inFlightPath: string | null = null;
  const refresh = async () => {
    const nextPath = path();
    if (nextPath !== latestPath) { latestPath = nextPath; setSnapshot(null); setError(null); setLoading(true); }
    if (inFlightPath === nextPath) return;
    inFlightPath = nextPath;
    const current = ++generation;
    try {
      const next = await request<Snapshot<T>>(nextPath);
      if (current !== generation) return;
      setSnapshot((old) => next.data === null && old?.data !== null && old !== null ? { ...old, status: 'stale', error: next.error ?? 'Upstream unavailable.' } : next);
      setError(next.status === 'live' ? null : next.error);
    } catch (e) {
      if (current !== generation) return;
      setError((e as Error).message);
      setSnapshot((old) => old ? { ...old, status: 'stale' } : null);
    } finally { if (current === generation) { inFlightPath = null; setLoading(false); } }
  };
  createEffect(() => { path(); void refresh(); });
  onMount(() => { const timer = setInterval(() => { void refresh(); }, every); onCleanup(() => { generation++; clearInterval(timer); }); });
  return { snapshot, data: () => snapshot()?.data ?? null, error, loading, refresh, get path() { return path(); } };
}

let sessionToken: string | null = null;
export async function session(): Promise<{ token: string; liveEnabled: boolean }> {
  const value = await request<{ token: string; liveEnabled: boolean }>('/api/session');
  sessionToken = value.token;
  return value;
}
export async function mutate<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  if (!sessionToken) await session();
  return request<T>(path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

export const num = (n: number | null | undefined, digits = 2) => n === null || n === undefined || !Number.isFinite(n) ? 'Unavailable' : new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(n);
export const usd = (n: number | null | undefined, compact = false) => n === null || n === undefined || !Number.isFinite(n) ? 'Unavailable' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: compact ? 2 : 2, notation: compact ? 'compact' : 'standard' }).format(n);
export const pct = (n: number | null | undefined, digits = 2) => n === null || n === undefined || !Number.isFinite(n) ? 'Unavailable' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(digits)}%`;
export const price = (n: number | null | undefined) => n === null || n === undefined || !Number.isFinite(n) ? 'Unavailable' : new Intl.NumberFormat('en-US', { maximumFractionDigits: n < 1 ? 6 : n < 100 ? 4 : 2, minimumFractionDigits: 2 }).format(n);
export const stamp = (n: number | null | undefined) => n ? new Date(n).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Not observed';
export const shortAddress = (s: string) => s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
