import { BANDS, TIER_CAP_USD } from './rewards.ts';

export interface LevelConfig { band: 1 | 2 | 3; bps: number; sizeUsd: number; }
export interface SessionProfile { sizeMult: number; bpsAdd: number; }
export type SessionName = 'regular' | 'overnight' | 'weekend';
export interface Settings {
  instrument: string;
  mode: 'dry_run' | 'live';
  leverage: number | null;
  operator: { jurisdiction: string; region: string };
  egress: { select: 'fastest' | 'ordered'; allowDirect: boolean; timeoutMs: number; publicFeeds: number };
  credentials: { proxyTtlHours: number };
  levels: LevelConfig[];
  requote: { thresholdBps: number; minIntervalMs: number; refillRatio: number; minEdgeBps: number };
  inventory: { maxPositionUsd: number; skewBpsPer10k: number; stopSideMode: 'zero' | 'shrink' };
  risk: {
    staleBookMs: number;
    volBreaker: { moveBps: number; windowS: number; pauseS: number; action: 'pause' | 'widen'; widenBps: number };
    maxDailyLossUsd: number;
    minAvailableMarginUsd: number;
    postOnlyRejectWiden: { after: number; ticks: number; forS: number };
    startupCancelAll: boolean;
    reconcileEveryS: number;
  };
  deadman: { timeoutS: number; rearmEveryS: number };
  sessions: Record<SessionName, SessionProfile> & { schedule: 'auto' | 'regular' };
  budget: { actionShare: number };
  metrics: { dir: string; flushS: number };
}

type Obj = Record<string, unknown>;
const obj = (value: unknown, path: string): Obj => {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected a mapping`);
  return value as Obj;
};
function num(o: Obj, key: string, path: string, fallback: number | undefined, min: number, max: number): number {
  const value = o[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${path}.${key}: expected a number in [${min}, ${max}]`);
  return value;
}
function str<T extends string>(o: Obj, key: string, path: string, fallback: T, allowed?: readonly T[]): T {
  const value = o[key] ?? fallback;
  if (typeof value !== 'string' || (allowed && !allowed.includes(value as T))) throw new Error(`${path}.${key}: expected ${allowed ? allowed.join(' | ') : 'a string'}`);
  return value as T;
}
function bool(o: Obj, key: string, path: string, fallback: boolean): boolean {
  const value = o[key] ?? fallback;
  if (typeof value !== 'boolean') throw new Error(`${path}.${key}: expected true or false`);
  return value;
}
const unknownKeys = (o: Obj, allowed: string[], path: string) => {
  for (const key of Object.keys(o)) if (!allowed.includes(key)) throw new Error(`${path}: unknown key "${key}"`);
};

export interface ConfigReport { settings: Settings; warnings: string[]; }

export function parseSettings(input: unknown): ConfigReport {
  const root = obj(input, 'config'), warnings: string[] = [];
  unknownKeys(root, ['instrument', 'mode', 'leverage', 'operator', 'egress', 'credentials', 'levels', 'requote', 'inventory', 'risk', 'deadman', 'sessions', 'budget', 'metrics'], 'config');
  const instrument = root.instrument;
  if ((typeof instrument !== 'string' || !instrument.trim()) && !(typeof instrument === 'number' && Number.isSafeInteger(instrument))) throw new Error('config.instrument: expected a symbol (e.g. PLTR-USD) or instrument id');

  const operator = obj(root.operator, 'operator'), egress = obj(root.egress, 'egress'), credentials = obj(root.credentials, 'credentials');
  const requote = obj(root.requote, 'requote'), inventory = obj(root.inventory, 'inventory'), risk = obj(root.risk, 'risk');
  const vol = obj(risk.vol_breaker, 'risk.vol_breaker'), widen = obj(risk.post_only_reject_widen, 'risk.post_only_reject_widen');
  const deadman = obj(root.deadman, 'deadman'), sessions = obj(root.sessions, 'sessions'), budget = obj(root.budget, 'budget'), metrics = obj(root.metrics, 'metrics');

  if (!Array.isArray(root.levels) || !root.levels.length) throw new Error('config.levels: expected a nonempty list');
  const levels = root.levels.map((raw, index): LevelConfig => {
    const level = obj(raw, `levels[${index}]`), path = `levels[${index}]`;
    unknownKeys(level, ['band', 'bps', 'size_usd'], path);
    const band = num(level, 'band', path, undefined, 1, 3);
    if (!Number.isInteger(band)) throw new Error(`${path}.band: expected 1, 2 or 3`);
    const inner = band === 1 ? 0 : BANDS[band - 2]!.maxBps, outer = BANDS[band - 1]!.maxBps;
    const bps = num(level, 'bps', path, undefined, 0, 100);
    if (bps <= inner || bps >= outer) throw new Error(`${path}.bps: ${bps} is outside band ${band} (${inner}–${outer} bps, exclusive)`);
    return { band: band as 1 | 2 | 3, bps, sizeUsd: num(level, 'size_usd', path, undefined, 1, 10_000_000) };
  });
  for (const band of [1, 2, 3] as const) {
    const total = levels.filter((level) => level.band === band).reduce((sum, level) => sum + level.sizeUsd, 0);
    if (total > TIER_CAP_USD) warnings.push(`Band ${band}: $${total} per side exceeds the $${TIER_CAP_USD} scoring cap; the excess uses margin without score`);
  }

  const profile = (name: SessionName, fallback: SessionProfile): SessionProfile => {
    const value = obj(sessions[name], `sessions.${name}`);
    return { sizeMult: num(value, 'size_mult', `sessions.${name}`, fallback.sizeMult, 0, 1), bpsAdd: num(value, 'bps_add', `sessions.${name}`, fallback.bpsAdd, 0, 15) };
  };

  const settings: Settings = {
    instrument: String(instrument).trim(),
    mode: str(root, 'mode', 'config', 'dry_run', ['dry_run', 'live'] as const),
    leverage: root.leverage === undefined || root.leverage === null ? null : num(root, 'leverage', 'config', undefined, 1, 100),
    operator: { jurisdiction: str(operator, 'jurisdiction', 'operator', ''), region: str(operator, 'region', 'operator', '') },
    egress: {
      select: str(egress, 'select', 'egress', 'fastest', ['fastest', 'ordered'] as const),
      allowDirect: bool(egress, 'allow_direct', 'egress', false),
      timeoutMs: num(egress, 'timeout_ms', 'egress', 8_000, 1_000, 60_000),
      publicFeeds: num(egress, 'public_feeds', 'egress', 2, 1, 3),
    },
    credentials: { proxyTtlHours: num(credentials, 'proxy_ttl_hours', 'credentials', 168, 1, 168) },
    levels,
    requote: {
      thresholdBps: num(requote, 'threshold_bps', 'requote', 0.5, 0, 20),
      minIntervalMs: num(requote, 'min_interval_ms', 'requote', 250, 50, 60_000),
      refillRatio: num(requote, 'refill_ratio', 'requote', 0.5, 0, 1),
      minEdgeBps: num(requote, 'min_edge_bps', 'requote', 1, 0, 20),
    },
    inventory: {
      maxPositionUsd: num(inventory, 'max_position_usd', 'inventory', 5_000, 0, 100_000_000),
      skewBpsPer10k: num(inventory, 'skew_bps_per_10k', 'inventory', 0.5, 0, 100),
      stopSideMode: str(inventory, 'stop_side_mode', 'inventory', 'zero', ['zero', 'shrink'] as const),
    },
    risk: {
      staleBookMs: num(risk, 'stale_book_ms', 'risk', 2_000, 200, 60_000),
      volBreaker: {
        moveBps: num(vol, 'move_bps', 'risk.vol_breaker', 15, 1, 10_000),
        windowS: num(vol, 'window_s', 'risk.vol_breaker', 5, 1, 600),
        pauseS: num(vol, 'pause_s', 'risk.vol_breaker', 30, 1, 3_600),
        action: str(vol, 'action', 'risk.vol_breaker', 'pause', ['pause', 'widen'] as const),
        widenBps: num(vol, 'widen_bps', 'risk.vol_breaker', 0, 0, 20),
      },
      maxDailyLossUsd: num(risk, 'max_daily_loss_usd', 'risk', 200, 0, 100_000_000),
      minAvailableMarginUsd: num(risk, 'min_available_margin_usd', 'risk', 500, 0, 100_000_000),
      postOnlyRejectWiden: {
        after: num(widen, 'after', 'risk.post_only_reject_widen', 3, 1, 100),
        ticks: num(widen, 'ticks', 'risk.post_only_reject_widen', 1, 1, 100),
        forS: num(widen, 'for_s', 'risk.post_only_reject_widen', 10, 1, 3_600),
      },
      startupCancelAll: bool(risk, 'startup_cancel_all', 'risk', true),
      reconcileEveryS: num(risk, 'reconcile_every_s', 'risk', 30, 5, 3_600),
    },
    deadman: { timeoutS: num(deadman, 'timeout_s', 'deadman', 60, 10, 3_600), rearmEveryS: num(deadman, 'rearm_every_s', 'deadman', 20, 5, 1_800) },
    sessions: {
      schedule: str(sessions, 'schedule', 'sessions', 'auto', ['auto', 'regular'] as const),
      regular: profile('regular', { sizeMult: 1, bpsAdd: 0 }),
      overnight: profile('overnight', { sizeMult: 0.5, bpsAdd: 1.5 }),
      weekend: profile('weekend', { sizeMult: 0.3, bpsAdd: 3 }),
    },
    budget: { actionShare: num(budget, 'action_share', 'budget', 0.7, 0.05, 1) },
    metrics: { dir: str(metrics, 'dir', 'metrics', 'data'), flushS: num(metrics, 'flush_s', 'metrics', 60, 5, 3_600) },
  };
  if (settings.deadman.rearmEveryS * 2 > settings.deadman.timeoutS) throw new Error('deadman.rearm_every_s must be at most half of deadman.timeout_s');
  if (settings.mode === 'live' && settings.risk.maxDailyLossUsd <= 0) warnings.push('risk.max_daily_loss_usd is 0: the daily loss stop is disabled');
  for (const name of ['regular', 'overnight', 'weekend'] as const) for (const level of levels) {
    const bps = level.bps + settings.sessions[name].bpsAdd;
    if (bps >= BANDS[level.band - 1]!.maxBps) warnings.push(`Session ${name}: level band ${level.band} at ${level.bps}+${settings.sessions[name].bpsAdd} bps leaves its band and will be clamped inside`);
  }
  return { settings, warnings };
}

export async function loadSettings(path: string): Promise<ConfigReport> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Config file not found: ${path}`);
  return parseSettings(Bun.YAML.parse(await file.text()));
}
