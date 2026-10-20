/** Read-only view of the quoter for the local dashboard. Never contains keys, secrets or proxy credentials. */
export type RunStatus = 'starting' | 'running' | 'paused' | 'frozen' | 'halted' | 'stopping' | 'stopped';

export interface LadderRow {
  slot: string; side: 'bid' | 'ask'; level: number; band: number;
  target: { price: string; qty: string; notional: number; distBps: number } | null;
  /** Live mode: the order the exchange holds for this slot. */
  live: { price: string; rest: string; filled: string; status: string; inFlight: boolean; distBps: number | null } | null;
}
export interface HistoryPoint { t: number; mid: number | null; bid: number | null; ask: number | null; ourBid: number | null; ourAsk: number | null; q: 0 | 1; }
export interface AlertRow { t: string; level: string; msg: string; detail: string; }

export interface DashboardState {
  now: number;
  mode: 'dry_run' | 'live';
  instrument: { id: number; symbol: string; category: string };
  status: RunStatus; statusReason: string; notes: string[];
  startedAt: number; session: string;
  egress: { primary: string; feeds: string[] };
  market: { status: string; bid: string | null; ask: string | null; mid: string | null; spreadBps: number | null; ageMs: number | null; source: string };
  ladder: LadderRow[];
  skewBps: number | null;
  account: null | {
    positionQty: string; positionUsd: number | null; entryPrice: string | null; unrealizedPnl: number | null;
    availableMargin: number | null; accountValue: number | null; dailyPnl: number | null; inLiquidation: boolean;
  };
  limits: { maxPositionUsd: number; maxDailyLossUsd: number; minAvailableMarginUsd: number };
  metrics: Record<string, unknown>;
  history: HistoryPoint[];
  fills: { t: number; side: string; price: string; qty: string; fee: number | null; taker: boolean }[];
  deadmanDeadline: number | null;
  credentialExpiresAt: number | null;
}
