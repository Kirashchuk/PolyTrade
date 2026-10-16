import { For, Show, type JSX } from 'solid-js';
import type { Snapshot } from '../shared/contracts';
import { stamp } from './api';

const paths: Record<string, () => JSX.Element> = {
  overview: () => <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7m-3.5-3.5v7"/></>,
  markets: () => <><path d="M4 19V9m5 10V4m6 15v-7m5 7V7"/></>,
  terminal: () => <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/></>,
  funding: () => <><path d="M3 15 8 9l5 4 8-10m0 0v6m0-6h-6M3 21h18"/></>,
  leaderboard: () => <><path d="M9 21h6m-3-5v5M8 3h8v8a4 4 0 0 1-8 0V3ZM8 5H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4"/></>,
  bots: () => <><rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4M1 12v4m22-4v4M8 16h8"/><circle cx="8" cy="11" r=".6"/><circle cx="16" cy="11" r=".6"/></>,
  system: () => <><path d="M3 12h4l3-8 4 16 3-8h4"/></>,
  arrow: () => <><path d="M5 19 19 5M6 5h13v13"/></>,
  search: () => <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></>,
  chevron: () => <path d="m9 5 7 7-7 7"/>,
  down: () => <path d="m6 9 6 6 6-6"/>,
  refresh: () => <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0 1 13-3l2 2M4 17l2 2a8 8 0 0 0 13-3"/></>,
  link: () => <><path d="m10 13 4-4m-6 6-2 2a3 3 0 0 1-4-4l5-5a3 3 0 0 1 4 0m2 8a3 3 0 0 0 4 0l5-5a3 3 0 0 0-4-4l-2 2"/></>,
  wallet: () => <><path d="M20 8V5a2 2 0 0 0-2-2L5 6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h15V8H5a2 2 0 0 1 0-4"/><path d="M20 12h-6v5h6"/><circle cx="16.5" cy="14.5" r=".5"/></>,
  alert: () => <><path d="m12 3 10 17H2L12 3Zm0 5v5m0 3v1"/></>,
  check: () => <path d="m5 12 4 4 10-10"/>,
  menu: () => <path d="M4 6h16M4 12h16M4 18h16"/>,
  close: () => <path d="m6 6 12 12M6 18 18 6"/>,
  stop: () => <rect x="5" y="5" width="14" height="14" rx="2"/>,
  play: () => <path d="m7 4 14 8-14 8V4Z"/>,
  clock: () => <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/></>,
};
export const Icon = (props: { name: string; size?: number; class?: string }) => <svg width={props.size ?? 19} height={props.size ?? 19} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class={props.class} aria-hidden="true">{(paths[props.name] ?? paths.overview)()}</svg>;
export function Logo() { return <div class="brand"><svg viewBox="0 0 40 40" width="37" height="37" aria-hidden="true"><rect x=".5" y=".5" width="39" height="39" rx="11" fill="var(--accent)"/><path d="M12 29V11h10l7 7-7 7h-6v-7h7" fill="none" stroke="#10160c" stroke-width="3" stroke-linejoin="round"/></svg><div>poly<span>trade</span><small>PERPETUAL INTELLIGENCE</small></div></div>; }
export const Panel = (p: { title?: string; eyebrow?: string; action?: JSX.Element; children: JSX.Element; class?: string }) => <section class={`panel ${p.class ?? ''}`}><Show when={p.title}><div class="panel-heading"><div><Show when={p.eyebrow}><span class="eyebrow">{p.eyebrow}</span></Show><h2>{p.title}</h2></div>{p.action}</div></Show>{p.children}</section>;
export const Empty = (p: { text?: string; loading?: boolean; compact?: boolean }) => <div class={`empty ${p.compact ? 'compact' : ''}`}><Icon name={p.loading ? 'refresh' : 'markets'} size={26}/><span>{p.loading ? 'Reading official market data…' : p.text ?? 'No observations available.'}</span></div>;
export const ErrorLine = (p: { error: string | null | undefined }) => <Show when={p.error}><div role="alert" class="error-line"><Icon name="alert" size={15}/><span>{p.error}</span></div></Show>;
export const Badge = (p: { children: JSX.Element; tone?: string }) => <span class={`badge ${p.tone ?? ''}`}>{p.children}</span>;
export function Source(p: { snapshot: Snapshot<unknown> | null; label?: string }) {
  const status = () => p.snapshot?.status ?? 'unavailable';
  const source = () => p.snapshot?.source;
  return <><Show when={p.snapshot?.status === 'live' && p.snapshot?.error}><p class="source-note">{p.snapshot?.error}</p></Show><div class="source-line"><span class={`status-dot ${status()}`}/><span>{p.label ?? (status() === 'live' ? 'Official API' : status() === 'stale' ? 'Retained observation' : 'Awaiting source')}</span><span class="source-time">{stamp(p.snapshot?.lastSuccessAt ?? p.snapshot?.receivedAt)}</span><Show when={source()}><a href={/^https?:\/\/\S+$/.test(source()!) ? source()! : 'https://docs.polymarket.com/perps/overview'} target="_blank" rel="noreferrer" title={source()} aria-label="View data source"><Icon name="link" size={12}/></a></Show></div></>;
}
export function Sparkline(p: { values: number[]; positive?: boolean; width?: number; height?: number }) {
  const points = () => { const v = p.values.filter(Number.isFinite); const min = Math.min(...v), max = Math.max(...v); return v.map((n, i) => `${v.length < 2 ? 0 : i / (v.length - 1) * 96},${27 - (n - min) / (max - min || 1) * 24}`).join(' '); };
  return <Show when={p.values.length > 1} fallback={<span class="spark-missing">No history</span>}><svg width={p.width ?? 96} height={p.height ?? 30} viewBox="0 0 96 30" class={`sparkline ${p.positive === false ? 'negative' : ''}`} aria-label="Observed price history"><polyline points={points()} fill="none" stroke="currentColor" stroke-width="1.8" vector-effect="non-scaling-stroke"/></svg></Show>;
}
export const Segmented = (p: { values: string[]; value: string; onChange: (s: string) => void; label: string }) => <div class="segmented" role="group" aria-label={p.label}><For each={p.values}>{value => <button classList={{ active: p.value === value }} onClick={() => p.onChange(value)}>{value}</button>}</For></div>;
export const Asset = (p: { symbol: string; small?: boolean }) => <span class={`asset-avatar ${p.small ? 'small' : ''}`} style={{ '--asset-color': ['#e8b36d', '#a9a2f5', '#89d0bd', '#a4c4ea'][p.symbol.charCodeAt(0) % 4] }}>{p.symbol.replace(/[^a-zA-Z]/g, '').slice(0, 1)}</span>;
