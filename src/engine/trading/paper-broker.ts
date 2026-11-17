// Paper fills: the price a market order would have got against the quote in hand. The live Dhan
// adapter will take the same orders; only this file differs between paper and live.
//
//   - With a book (Full mode on the feed): a buy pays the ask, a sell gets the bid, each worsened
//     by `slippage`.
//   - With only a last price: that price worsened by `looseSlippage`, which stands in for the
//     spread.
//   - Against a 1-minute candle (a replay of a day whose options weren't recorded): a stop or
//     target is filled at its level if the minute crossed it, or at the minute's open if the
//     minute started beyond it; anything else at the last closed minute's close. Also worsened by
//     `looseSlippage`.
//
// Prices are rounded to the contract's tick against the trader: up for a buy, down for a sell.

import { orderCharges } from "../../lib/trading/charges.ts";
import type { Order, PriceSource, TradingConfig } from "../../lib/engine/trading.ts";
import type { MarketQuote } from "./market.ts";

export interface Fill {
  price: number;
  source: PriceSource;
}

function roundToTick(price: number, tick: number, side: "BUY" | "SELL") {
  if (!(tick > 0)) return price;
  const steps = price / tick;
  // The epsilon keeps 85.2 / 0.05 = 1703.9999… from rounding a whole tick away.
  const rounded = side === "BUY" ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9);
  return Math.round(rounded * tick * 100) / 100;
}

/** The price `order` fills at against `quote`. */
export function fillPrice(order: Pick<Order, "side" | "reason" | "trigger" | "contract">, quote: MarketQuote, fills: TradingConfig["fills"]): Fill {
  const tick = order.contract.tickSize;
  const buy = order.side === "BUY";
  let price: number;
  let source: PriceSource;

  if (quote.candleOpen !== null) {
    source = "candle";
    price = quote.ltp;
    if (order.trigger !== null && order.reason === "stop") price = Math.max(quote.ltp, Math.min(order.trigger, quote.candleOpen));
    else if (order.trigger !== null && order.reason === "target") price = Math.min(quote.ltp, Math.max(order.trigger, quote.candleOpen));
    price += buy ? fills.looseSlippage : -fills.looseSlippage;
  } else if (quote.bid !== null && quote.ask !== null) {
    source = "book";
    price = buy ? quote.ask + fills.slippage : quote.bid - fills.slippage;
  } else {
    source = "ltp";
    price = quote.ltp + (buy ? fills.looseSlippage : -fills.looseSlippage);
  }
  // An option can't be sold for less than a tick.
  return { price: Math.max(tick > 0 ? tick : 0.05, roundToTick(price, tick, order.side)), source };
}

/** Marks `order` filled against `quote` at market time `at`, with Dhan's charges on it. */
export function fillOrder(order: Order, quote: MarketQuote, at: number, fills: TradingConfig["fills"]): Order {
  const { price, source } = fillPrice(order, quote, fills);
  const value = price * order.quantity;
  return {
    ...order,
    status: "filled",
    filledAt: at,
    price,
    priceSource: source,
    ltp: quote.ltp,
    bid: quote.bid,
    ask: quote.ask,
    value,
    charges: orderCharges(order.side, value),
  };
}
