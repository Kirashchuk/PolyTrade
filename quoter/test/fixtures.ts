import { parseSettings, type Settings } from '../src/config.ts';
import { D } from '../src/decimal.ts';
import { parseInstrument, type Instrument } from '../src/instruments.ts';
import { createLogger } from '../src/log.ts';
import type { MarketView } from '../src/quoteEngine.ts';

/** PLTR-USD row as returned by /v1/info/instruments on 2026-10-19 (logo omitted). */
export const PLTR_ROW = {
  instrument_id: 45, instrument_type: 'perpetual', category: 'equity', isolated_only: false, symbol: 'PLTR-USD', close_only: false,
  base_asset: 'PLTR', quote_asset: 'pUSD', funding_interval: '1h', quantity_decimals: 4, price_decimals: 2, price_bounds: '0.10',
  liquidation_fee: '0.005', max_order_count: 200, min_notional: '10', max_market_notional: '500000', max_limit_notional: '2500000', max_leverage: 10,
  risk_tiers: [{ lower_bound: '0', max_leverage: 10 }, { lower_bound: '500000', max_leverage: 5 }, { lower_bound: '1000000', max_leverage: 3 }],
  ui_live_time: 1786966419000,
};
export const pltr = (): Instrument => parseInstrument(PLTR_ROW, 'fixture', 0);

export async function exampleSettings(): Promise<Settings> {
  const text = await Bun.file(new URL('../config/example.yaml', import.meta.url)).text();
  return parseSettings(Bun.YAML.parse(text)).settings;
}

export const market = (bid: string, ask: string): MarketView => ({ bestBid: new D(bid), bestAsk: new D(ask), mid: new D(bid).plus(ask).div(2) });
export const silentLog = () => createLogger({ level: 'error', sink: () => {} });
