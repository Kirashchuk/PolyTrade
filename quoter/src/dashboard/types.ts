/** Read-only views of the quoter for the local dashboard. Never contain keys, secrets or proxy credentials. */
export type RunStatus = 'starting' | 'running' | 'paused' | 'frozen' | 'halted' | 'stopping' | 'stopped';

export interface LadderRow {
  slot: string; side: 'bid' | 'ask'; level: number; band: number;
  target: { price: string; qty: string; notional: number; distBps: number } | null;
  /** Live mode: the order the exchange holds for this slot. */
  live: { price: string; rest: string; filled: string; status: string; inFlight: boolean; distBps: number | null } | null;
}
export interface HistoryPoint { t: number; mid: number | null; bid: number | null; ask: number | null; ourBid: number | null; ourAsk: number | null; q: 0 | 1; }
export interface AlertRow { t: string; level: string; msg: string; detail: string; }

/** One row of the instrument tabs. */
export interface InstrumentSummary {
  id: number; symbol: string; category: string;
  status: RunStatus; statusReason: string;
  mid: string | null; spreadBps: number | null;
  uptime: number | null; liquidityScore: number | null;
  positionUsd: number | null; ownOrders: number;
}

/** Everything the panel shows for the selected instrument. */
export interface InstrumentDetail {
  instrument: { id: number; symbol: string; category: string };
  status: RunStatus; statusReason: string; notes: string[];
  startedAt: number; session: string;
  market: { status: string; bid: string | null; ask: string | null; mid: string | null; spreadBps: number | null; ageMs: number | null; source: string };
  ladder: LadderRow[];
  skewBps: number | null;
  /** Live mode only. */
  position: null | { qty: string; usd: number | null; entryPrice: string | null; unrealizedPnl: number | null };
  limits: { maxPositionUsd: number };
  metrics: Record<string, unknown>;
  history: HistoryPoint[];
  fills: { t: number; side: string; price: string; qty: string; fee: number | null; taker: boolean }[];
}

export interface CatalogRow { id: number; symbol: string; category: string; closeOnly: boolean; settled: boolean; quoted: boolean; }

export interface DashboardState {
  now: number;
  mode: 'dry_run' | 'live';
  status: RunStatus; statusReason: string; startedAt: number;
  egress: { primary: string; feeds: string[] };
  exchangeCancelOnly: boolean;
  /** Live mode only: account-wide figures shared by all instruments. */
  account: null | { availableMargin: number | null; accountValue: number | null; dailyPnl: number | null; inLiquidation: boolean };
  limits: { maxDailyLossUsd: number; minAvailableMarginUsd: number };
  deadmanDeadline: number | null;
  credentialExpiresAt: number | null;
  instruments: InstrumentSummary[];
  /** Instruments that could not start (startup or dashboard add) and why. */
  failed: { symbol: string; reason: string; at: number }[];
  selectionSource: 'config' | 'dashboard';
  selected: InstrumentDetail | null;
}
