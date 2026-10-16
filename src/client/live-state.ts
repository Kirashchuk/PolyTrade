import { createSignal } from 'solid-js';
import type { EIP1193Provider } from 'viem';
import type { Book, Market, Snapshot } from '../shared/contracts';
import type { BrowserLiveSession, LiveAccount, LiveSessionStatus, LiveAuditRow } from '../trading/live';
import type { LiveBotConfig, LiveBotState } from '../trading/live-bots';
import { request, session } from './api';

type LiveBotManager = ReturnType<typeof import('../trading/live-bots').createLiveBotManager>;
let activeSession: BrowserLiveSession | null = null;
let manager: LiveBotManager | null = null;
export const [liveStatus, setLiveStatus] = createSignal<LiveSessionStatus | null>(null);
export const [liveAccount, setLiveAccount] = createSignal<LiveAccount | null>(null);
export const [liveAccountAt, setLiveAccountAt] = createSignal<number | null>(null);
export const [liveAccountError, setLiveAccountError] = createSignal<string | null>(null);
export const [liveJournal, setLiveJournal] = createSignal<LiveAuditRow[]>([]);
export const [liveBotState, setLiveBotState] = createSignal<LiveBotState | null>(null);
export const [liveCancelId, setLiveCancelId] = createSignal('');
export const [liveAutomationError, setLiveAutomationError] = createSignal<string | null>(null);
export const getLiveSession = () => activeSession;
export const botControlsAccount = () => liveStatus()?.botControlled === true || ['starting', 'running', 'stopping'].includes(liveBotState()?.status ?? '');
export const botNeedsCleanup = () => liveBotState() !== null && !['completed', 'stopped'].includes(liveBotState()!.status);
export const refreshLiveState = () => { setLiveStatus(activeSession?.status() ?? null); setLiveJournal(activeSession?.journal() ?? []); setLiveBotState(manager?.state() ?? null); };
export async function connectLive(): Promise<void> {
  const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) throw new Error('No injected EVM wallet found. Open this workspace in a browser with an EVM wallet extension.');
  if (!activeSession) {
    const local = await session();
    if (!local.liveEnabled) throw new Error('The live relay is disabled in the local service configuration.');
    const { createLiveSession } = await import('../trading/live');
    activeSession = createLiveSession({ provider, token: local.token });
  }
  const previousOwner = activeSession.status().owner;
  const connected = await activeSession.connect();
  if (connected.owner !== previousOwner) { setLiveAccount(null); setLiveAccountAt(null); setLiveAccountError(null); setLiveCancelId(''); }
  await botManager(); refreshLiveState();
}
export async function loadLiveAccount(): Promise<LiveAccount> {
  if (!activeSession) throw new Error('Connect and authorize the exchange account first.');
  try { const account = await activeSession.readAccount(); setLiveAccount(account); setLiveAccountAt(Date.now()); setLiveAccountError(null); refreshLiveState(); return account; }
  catch (error) { setLiveAccountError((error as Error).message); throw error; }
}
export function acceptLiveAccount(account: LiveAccount): void { setLiveAccount(account); setLiveAccountAt(Date.now()); setLiveAccountError(null); refreshLiveState(); }
export async function disconnectLive(): Promise<void> { await activeSession?.disconnect(); setLiveAccount(null); setLiveAccountAt(null); setLiveAccountError(null); refreshLiveState(); }
export async function requireOpenExchange(): Promise<void> {
  const exchange = await request<Snapshot<{ cancelOnly: boolean; version: string }>>('/api/exchange');
  if (exchange.status !== 'live' || !exchange.data || exchange.data.cancelOnly !== false || Date.now() - (exchange.lastSuccessAt ?? 0) >= 15_000) throw new Error('Fresh exchange status with trading enabled is required. The exchange may be cancel-only.');
}
async function botManager(): Promise<LiveBotManager> {
  if (!activeSession) throw new Error('Connect and authorize the exchange account before starting a live strategy.');
  if (!manager) {
    const { createLiveBotManager } = await import('../trading/live-bots');
    manager = createLiveBotManager({ session: activeSession, load: async id => {
      const [markets, book, exchange] = await Promise.all([
        request<Snapshot<Market[]>>('/api/markets'), request<Snapshot<Book>>(`/api/book/${id}`), request<Snapshot<{cancelOnly:boolean;version:string}>>('/api/exchange'),
      ]);
      const market = markets.data?.find(m => m.id === id);
      if (markets.status !== 'live' || book.status !== 'live' || !market || !book.data) throw new Error('Fresh official market and book observations are required.');
      if (exchange.status !== 'live' || !exchange.data || exchange.data.cancelOnly !== false || Date.now() - (exchange.lastSuccessAt ?? 0) >= 15_000) throw new Error('Fresh exchange status with trading enabled is required.');
      return { market, book: book.data, cancelOnly: exchange.data.cancelOnly };
    } });
  }
  return manager;
}
export async function startLiveBot(config: LiveBotConfig, confirmed: boolean): Promise<void> { const bot = await botManager(); try { await bot.start(config, confirmed); } finally { refreshLiveState(); } }
export async function stopLiveBot(): Promise<void> { try { await manager?.stop(); } finally { refreshLiveState(); } }
export async function tickLiveBot(): Promise<void> { if (!manager) return; try { await manager.tick(); setLiveAutomationError(null); } catch (error) { setLiveAutomationError((error as Error).message); } finally { refreshLiveState(); } }

export const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const exact = (value: unknown): string | null => typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? value : null;
export const numberValue = (value: unknown): number | null => { const valueString = exact(value); if (valueString !== null && Number.isFinite(Number(valueString))) return Number(valueString); return typeof value === 'number' && Number.isFinite(value) ? value : null; };
export const livePositions = () => { const positions = record(liveAccount()?.portfolio).positions; return Array.isArray(positions) ? positions.map(record) : null; };
export const liveOrders = () => Array.isArray(liveAccount()?.orders) ? (liveAccount()!.orders as unknown[]).map(record) : null;
export const liveMargin = () => record(record(liveAccount()?.portfolio).margin);
