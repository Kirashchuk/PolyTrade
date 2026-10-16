import Decimal from 'decimal.js';
import type { Book, Market, OrderInput } from '../shared/contracts';

export const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_DOWN });
export const BOOK_MAX_AGE_MS = 15_000;
export interface DepthFill { price: string; quantity: string; }
export interface ExecutionQuote { limitPrice: string; filledQuantity: string; averagePrice: string | null; notional: string; unfilledQuantity: string; fills: DepthFill[]; slippageBps: number | null; }
export interface ValidatedOrder { quantity: string; limitPrice: string; notional: string; maxLeverage: number; }
export interface RiskOrder { side:'buy'|'sell'; remainingQuantity:string; reduceOnly:boolean; price?:string; }
export interface OrderRiskContext { openOrders:readonly RiskOrder[]; }

export function decimal(value: unknown, name = 'Value'): Decimal {
  if (typeof value !== 'string' || value.length > 100 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) throw new Error(`${name} must be an exact positive decimal string`);
  const result = new D(value);
  if (!result.isFinite() || result.lte(0)) throw new Error(`${name} must be positive`);
  return result;
}
export function signedDecimal(value:unknown,name='Position quantity'):Decimal{
  if(typeof value!=='string'||value.length>100||! /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value))throw new Error(`${name} must be a finite exact decimal string`);
  const result=new D(value);if(!result.isFinite())throw new Error(`${name} must be finite`);return result;
}
export function roundGrid(value: Decimal.Value, decimals: number, up = false): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid decimal precision');
  return new D(value).toDecimalPlaces(decimals, up ? Decimal.ROUND_CEIL : Decimal.ROUND_FLOOR).toFixed();
}
function precision(value: string, places: number, name: string) {
  decimal(value, name);
  if ((value.split('.')[1]?.length ?? 0) > places) throw new Error(`${name} exceeds ${places} decimal places`);
}
export function validateBook(book: Book, instrumentId: number, now = Date.now()): void {
  if (book.instrumentId !== instrumentId || !Number.isFinite(book.timestamp) || now - book.timestamp >= BOOK_MAX_AGE_MS || book.timestamp > now + 1000) throw new Error('Order book is stale or belongs to another instrument');
  if (!Array.isArray(book.bids) || !Array.isArray(book.asks) || !book.bids.length || !book.asks.length) throw new Error('Order book is empty');
  for (const [levels, bid] of [[book.bids, true], [book.asks, false]] as const) {
    let previous: Decimal | undefined;
    for (const level of levels) {
      const price = decimal(level.price, 'Book price'); decimal(level.quantity, 'Book quantity');
      if (previous && (bid ? price.gte(previous) : price.lte(previous))) throw new Error('Order book is unsorted or contains duplicate prices');
      previous = price;
    }
  }
  if (new D(book.bids[0]!.price).gte(book.asks[0]!.price)) throw new Error('Order book is locked or crossed');
}
export function validateMetadata(market: Market): void {
  if (!Number.isSafeInteger(market.id) || market.id < 0 || !market.symbol || !Number.isInteger(market.priceDecimals) || market.priceDecimals < 0 || market.priceDecimals > 18 || !Number.isInteger(market.quantityDecimals) || market.quantityDecimals < 0 || market.quantityDecimals > 18) throw new Error('Instrument metadata is incomplete');
  decimal(market.minNotional, 'Minimum notional'); decimal(market.maxMarketNotional, 'Market notional cap'); decimal(market.maxLimitNotional, 'Limit notional cap');
  const bounds = decimal(market.priceBounds, 'Price bounds');
  if (bounds.gt(1) || !Number.isFinite(market.maxLeverage) || market.maxLeverage < 1 || !market.riskTiers.length || !Number.isSafeInteger(market.maxOrderCount) || market.maxOrderCount < 1) throw new Error('Instrument risk metadata is invalid');
  for (const tier of market.riskTiers) if (!/^\d+(\.\d+)?$/.test(tier.lowerBound) || !new D(tier.lowerBound).isFinite() || !Number.isFinite(tier.maxLeverage) || tier.maxLeverage < 1) throw new Error('Instrument leverage tiers are invalid');
}
export function leverageLimit(market: Market, positionNotional: Decimal.Value): number {
  let limit = market.maxLeverage;
  for (const tier of [...market.riskTiers].sort((a, b) => new D(a.lowerBound).cmp(b.lowerBound))) if (new D(positionNotional).gte(tier.lowerBound)) limit = Math.min(limit, tier.maxLeverage);
  return limit;
}
export function validateOrder(input: OrderInput, market: Market, book: Book, positionQuantity = '0', now = Date.now(), risk:OrderRiskContext={openOrders:[]}): ValidatedOrder {
  validateMetadata(market); validateBook(book, market.id, now);
  if(market.timestamp===null||!Number.isFinite(market.timestamp)||now-market.timestamp>=BOOK_MAX_AGE_MS||market.timestamp>now+1000)throw new Error('Instrument mark-price observation is stale or unavailable');
  if (input.instrumentId !== market.id || !['buy', 'sell'].includes(input.side) || !['market', 'limit'].includes(input.type) || typeof input.reduceOnly !== 'boolean' || typeof input.postOnly !== 'boolean') throw new Error('Invalid order fields');
  if (!/^[0-9a-f]{32}$/.test(input.clientOrderId)) throw new Error('Client order ID must be 32 lowercase hexadecimal characters');
  if (market.settled) throw new Error('Instrument has permanently settled');
  if (market.closeOnly && !input.reduceOnly) throw new Error('Instrument is close-only; use reduce-only');
  if (!Number.isSafeInteger(input.leverage) || input.leverage < 1) throw new Error('Leverage must be a positive integer');
  if (!Number.isFinite(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 500) throw new Error('Slippage must be between 0 and 500 bps');
  if (input.type === 'market' && input.postOnly) throw new Error('Market IOC cannot be post-only');
  precision(input.quantity, market.quantityDecimals, 'Quantity');
  const quantity = decimal(input.quantity, 'Quantity'), position = signedDecimal(positionQuantity), signed = input.side === 'buy' ? quantity : quantity.neg();
  if (input.reduceOnly && (position.isZero() || position.mul(signed).gte(0) || quantity.gt(position.abs()))) throw new Error('Reduce-only quantity must reduce the existing position without reversing it');
  if (market.markPrice === null || !Number.isFinite(market.markPrice) || market.markPrice <= 0) throw new Error('A current mark price is required for price bounds');
  const mark = new D(market.markPrice), bound = new D(market.priceBounds), low = mark.mul(new D(1).minus(bound)), high = mark.mul(bound.plus(1));
  let price: Decimal;
  if (input.type === 'limit') {
    if (!input.price) throw new Error('Limit price is required');
    precision(input.price, market.priceDecimals, 'Price'); price = decimal(input.price, 'Price');
    if (price.lt(low) || price.gt(high)) throw new Error('Limit price is outside instrument mark-price bounds');
    if (input.postOnly && (input.side === 'buy' ? price.gte(book.asks[0]!.price) : price.lte(book.bids[0]!.price))) throw new Error('Post-only order would cross the book');
  } else {
    const top = new D(input.side === 'buy' ? book.asks[0]!.price : book.bids[0]!.price), fraction = new D(input.slippageBps).div(10000);
    const raw = input.side === 'buy' ? D.min(top.mul(fraction.plus(1)), high) : D.max(top.mul(new D(1).minus(fraction)), low);
    price = new D(roundGrid(raw, market.priceDecimals, input.side === 'sell'));
    if (price.lte(0) || (input.side === 'buy' ? price.lt(top) : price.gt(top))) throw new Error('No liquidity within the instrument price bound');
  }
  const notional = price.mul(quantity), cap = input.type === 'market' ? market.maxMarketNotional : market.maxLimitNotional;
  if (notional.lt(market.minNotional) && !input.reduceOnly) throw new Error('Order is below the instrument minimum notional');
  if (notional.gt(cap)) throw new Error('Order exceeds the instrument maximum notional');
  if(risk.openOrders.length>=market.maxOrderCount)throw new Error(`Instrument maximum open-order count ${market.maxOrderCount} reached`);
  let buys=new D(0),sells=new D(0),riskPrice=D.max(price,mark);
  for(const open of risk.openOrders){
    if(!['buy','sell'].includes(open.side)||typeof open.reduceOnly!=='boolean'||! /^(0|[1-9]\d*)(\.\d+)?$/.test(open.remainingQuantity))throw new Error('Open-order risk snapshot is invalid');
    const outstanding=new D(open.remainingQuantity);
    if(open.price!==undefined)riskPrice=D.max(riskPrice,decimal(open.price,'Open-order price'));
    if(open.reduceOnly)continue;
    if(open.side==='buy')buys=buys.plus(outstanding);else sells=sells.plus(outstanding);
  }
  if(!input.reduceOnly){if(input.side==='buy')buys=buys.plus(quantity);else sells=sells.plus(quantity);}
  // Opposing resting orders can fill independently. Do not net away either contingent side.
  const worstPosition = D.max(position.abs(), position.plus(buys).abs(), position.minus(sells).abs()).mul(riskPrice);
  const maxLeverage = leverageLimit(market, worstPosition);
  if (input.leverage > maxLeverage) throw new Error(`Leverage exceeds the applicable ${maxLeverage}x risk tier`);
  return { quantity: quantity.toFixed(), limitPrice: price.toFixed(), notional: notional.toFixed(), maxLeverage };
}

/** Sweeps only displayed opposing depth inside the explicit limit. It never invents hidden liquidity. */
export function quoteDepth(input: Pick<OrderInput, 'side'|'quantity'>, book: Book, limitPrice: string, consumed = new Map<string, string>(), strictThrough = false): ExecutionQuote {
  const levels = input.side === 'buy' ? book.asks : book.bids;
  let remaining = new D(input.quantity), notional = new D(0), filled = new D(0);
  const limit = new D(limitPrice), fills: DepthFill[] = [];
  for (const level of levels) {
    const p = new D(level.price), crosses = input.side === 'buy' ? (strictThrough ? p.lt(limit) : p.lte(limit)) : (strictThrough ? p.gt(limit) : p.gte(limit));
    if (!crosses || remaining.lte(0)) break;
    const available = D.max(0, new D(level.quantity).minus(consumed.get(`${input.side}:${p.toFixed()}`) ?? '0'));
    const take = D.min(remaining, available);
    if (take.gt(0)) { fills.push({ price: p.toFixed(), quantity: take.toFixed() }); filled = filled.plus(take); remaining = remaining.minus(take); notional = notional.plus(take.mul(p)); }
  }
  const average = filled.gt(0) ? notional.div(filled) : null, top = levels[0] ? new D(levels[0].price) : null;
  return { limitPrice, filledQuantity: filled.toFixed(), averagePrice: average?.toFixed() ?? null, notional: notional.toFixed(), unfilledQuantity: remaining.toFixed(), fills, slippageBps: average && top ? average.div(top).minus(1).mul(input.side === 'buy' ? 10000 : -10000).toNumber() : null };
}

export function estimateOrder(input: OrderInput, market: Market, book: Book, positionQuantity = '0', now = Date.now()): ExecutionQuote {
  const validated = validateOrder(input, market, book, positionQuantity, now);
  return quoteDepth(input, book, validated.limitPrice);
}
