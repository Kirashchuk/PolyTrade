import type { Book, BotConfig, Market, OrderInput } from '../shared/contracts';
import { D, roundGrid } from './math';

export type PaperOrderIntent = Omit<OrderInput, 'clientOrderId'>;

/** Pure planning over validated snapshots. Scheduling, ownership, IDs, persistence and execution belong to the manager. */
export function planPaperOrders(config: BotConfig, market: Market, book: Book, sliceQuantity: string): PaperOrderIntent[] {
  const input = (side: 'buy'|'sell', quantity: string): PaperOrderIntent => ({
    instrumentId: market.id, side, type: config.strategy === 'twap' ? 'market' : 'limit', quantity,
    leverage: config.leverage, reduceOnly: false, postOnly: config.strategy === 'maker', slippageBps: 25,
  });
  if (config.strategy === 'twap') return [input(config.side, roundGrid(sliceQuantity, market.quantityDecimals))];
  const half = roundGrid(new D(sliceQuantity).div(2), market.quantityDecimals);
  const mid = new D(book.bids[0]!.price).plus(book.asks[0]!.price).div(2);
  const spread = new D(config.spreadBps).div(20000);
  const bid = roundGrid(D.min(new D(book.bids[0]!.price), mid.mul(new D(1).minus(spread))), market.priceDecimals);
  const ask = roundGrid(D.max(new D(book.asks[0]!.price), mid.mul(spread.plus(1))), market.priceDecimals, true);
  return [{...input('buy', half), price: bid}, {...input('sell', half), price: ask}];
}
