export type SnapshotStatus = 'live' | 'stale' | 'unavailable';
export interface Snapshot<T> { status: SnapshotStatus; data: T | null; source: string; receivedAt: number; lastSuccessAt: number | null; error: string | null; }
export interface RiskTier { lowerBound: string; maxLeverage: number; }
export interface Market {
  id: number; symbol: string; displaySymbol: string; baseAsset: string; quoteAsset: string; category: string;
  priceDecimals: number; quantityDecimals: number; priceBounds: string; minNotional: string; maxMarketNotional: string; maxLimitNotional: string;
  maxLeverage: number; maxOrderCount: number; riskTiers: RiskTier[]; closeOnly: boolean; isolatedOnly: boolean; settled: boolean; fundingIntervalHours: number | null;
  markPrice: number | null; indexPrice: number | null; lastPrice: number | null; openInterest: number | null; openInterestUsd: number | null;
  volume24h: number | null; change24h: number | null; fundingRate: number | null; fundingApr: number | null; nextFunding: number | null;
  timestamp: number | null; sparkline: number[];
}
export interface BookLevel { price: string; quantity: string; }
export interface Book { instrumentId: number; bids: BookLevel[]; asks: BookLevel[]; timestamp: number; sequence: number; }
export interface Candle { timestamp: number; open: number; high: number; low: number; close: number; volume: number; trades: number; }
export interface Trade { id: string; instrumentId: number; side: string; price: number; quantity: number; timestamp: number; }
export interface FundingPoint { timestamp: number; rate: number; }
export interface Overview { volume24h: number | null; openInterestUsd: number | null; fees24h: number | null; markets: number; volumeCoverage: number; oiCoverage: number; categories: {name: string; volume: number; markets: number}[]; exchange: {cancelOnly: boolean; version: string} | null; }
export interface LeaderboardEntry { rank: number; account: string; pnl: number; notional: number; accountValue: number; roi: number | null; }
export interface Leaderboard { window: string; sortBy: string; timestamp: number; total: number; entries: LeaderboardEntry[]; }
export interface Health { now: number; liveEnabled: boolean; mode: 'local'; venue: string; database: string; }
export interface OrderInput { instrumentId: number; side: 'buy'|'sell'; type: 'market'|'limit'; quantity: string; price?: string; leverage: number; reduceOnly: boolean; postOnly: boolean; slippageBps: number; clientOrderId: string; }
export interface PaperOrder { id: string; input: OrderInput; status: 'open'|'filled'|'partial'|'cancelled'|'rejected'; filledQuantity: string; averagePrice: string | null; createdAt: number; reason: string | null; }
export interface PaperPosition { instrumentId: number; symbol: string; quantity: string; entryPrice: string; markPrice: number | null; unrealizedPnl: number | null; leverage: number; }
export interface AuditRow { id: string; timestamp: number; action: string; instrumentId: number | null; detail: string; }
export interface PaperAccount { mode: 'paper'; initialBalance: number; balance: number; equity: number; realizedPnl: number; fees: number; marginUsed: number; availableMargin: number; positions: PaperPosition[]; orders: PaperOrder[]; journal: AuditRow[]; }
export interface BotConfig { instrumentId: number; strategy: 'twap'|'maker'; side: 'buy'|'sell'; totalQuantity: string; slices: number; intervalSeconds: number; spreadBps: number; leverage: number; }
export interface BotState { id: string; config: BotConfig; status: 'running'|'stopped'|'completed'|'halted'; createdAt: number; nextRunAt: number; ticks: number; note: string; }
export const VENUE_REST = 'https://api.perpetuals.polymarket.com';
export const VENUE_WS = 'wss://ws.perpetuals.polymarket.com/v1/ws';
