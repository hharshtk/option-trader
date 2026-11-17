// What a trade costs at Dhan: brokerage, exchange fees, taxes. Pure, shared by the engine (every
// paper fill) and the web (Pulse's option replay).
//
// Dhan's brokerage calculator (dhan.co/calculators/brokerage-calculator) computes on its server and
// publishes no formula, so the rates below are the published ones, checked against a calculator
// result on 16 November 2026 (one NIFTY lot of 65, bought at 22.85, sold at 25.00):
//
//   brokerage 40.00, charges 50.99 in total, net P&L 88.76, breakeven 23.63
//
// charges.test.ts reproduces that result to the paisa. The calculator's own lines show STT rounded
// to the rupee (2.00) and fold IPFT into "Exchange Transaction Charges" (1.11); its total uses the
// unrounded amounts, as this module does. Your contract note is the final word: STT is rounded to
// the nearest rupee per contract note there, so a day's real total can differ by under a rupee.

export interface ChargeRates {
  /** Rupees per executed order. Dhan charges a flat ₹20 on F&O. */
  brokeragePerOrder: number;
  /** Securities transaction tax, a fraction of the sell-side value. */
  stt: number;
  /** Exchange transaction charge, a fraction of turnover (premium for options). */
  exchange: number;
  /** NSE's Investor Protection Fund Trust levy, a fraction of turnover. */
  ipft: number;
  /** SEBI turnover fee, a fraction of turnover. */
  sebi: number;
  /** Stamp duty, a fraction of the buy-side value. */
  stamp: number;
  /** GST on brokerage, exchange, IPFT and SEBI charges. */
  gst: number;
}

/** NSE index and stock options. STT is 0.15% of sell premium since 1 April 2026 (0.1% before). */
export const OPTION_RATES: ChargeRates = {
  brokeragePerOrder: 20,
  stt: 0.0015,
  exchange: 0.0003503,
  ipft: 0.000005,
  sebi: 0.000001,
  stamp: 0.00003,
  gst: 0.18,
};

/** NSE index and stock futures. STT is 0.05% of sell value since 1 April 2026 (0.02% before). */
export const FUTURES_RATES: ChargeRates = {
  brokeragePerOrder: 20,
  stt: 0.0005,
  exchange: 0.0000173,
  ipft: 0.000001,
  sebi: 0.000001,
  stamp: 0.00002,
  gst: 0.18,
};

/** Every line of a charge, in rupees, unrounded. `total` is their sum. */
export interface Charges {
  brokerage: number;
  exchange: number;
  ipft: number;
  sebi: number;
  stt: number;
  stamp: number;
  gst: number;
  total: number;
}

export const NO_CHARGES: Charges = { brokerage: 0, exchange: 0, ipft: 0, sebi: 0, stt: 0, stamp: 0, gst: 0, total: 0 };

/**
 * Charges on one executed order of `value` rupees (price × quantity). A buy pays stamp duty, a
 * sell pays STT; both pay brokerage, exchange fees and GST on those.
 */
export function orderCharges(side: "BUY" | "SELL", value: number, rates: ChargeRates = OPTION_RATES): Charges {
  const brokerage = rates.brokeragePerOrder;
  const exchange = value * rates.exchange;
  const ipft = value * rates.ipft;
  const sebi = value * rates.sebi;
  const stt = side === "SELL" ? value * rates.stt : 0;
  const stamp = side === "BUY" ? value * rates.stamp : 0;
  const gst = (brokerage + exchange + ipft + sebi) * rates.gst;
  return { brokerage, exchange, ipft, sebi, stt, stamp, gst, total: brokerage + exchange + ipft + sebi + stt + stamp + gst };
}

export function addCharges(a: Charges, b: Charges): Charges {
  return {
    brokerage: a.brokerage + b.brokerage,
    exchange: a.exchange + b.exchange,
    ipft: a.ipft + b.ipft,
    sebi: a.sebi + b.sebi,
    stt: a.stt + b.stt,
    stamp: a.stamp + b.stamp,
    gst: a.gst + b.gst,
    total: a.total + b.total,
  };
}

/** Charges on a round trip: one buy order and one sell order. */
export function roundTripCharges(buyValue: number, sellValue: number, rates: ChargeRates = OPTION_RATES): Charges {
  return addCharges(orderCharges("BUY", buyValue, rates), orderCharges("SELL", sellValue, rates));
}

/**
 * The sell price at which a long round trip nets zero after charges: what Dhan's calculator calls
 * "points to breakeven". Solved exactly, since the sell-side charges grow with the sell price.
 */
export function breakevenSellPrice(buyPrice: number, quantity: number, rates: ChargeRates = OPTION_RATES): number {
  if (quantity <= 0) return buyPrice;
  const buy = orderCharges("BUY", buyPrice * quantity, rates).total;
  const fixed = rates.brokeragePerOrder * (1 + rates.gst);
  // Net of a sale at price p: p·q·(1 − k) − fixed, with k the sell-side rate per rupee sold.
  const k = (rates.exchange + rates.ipft + rates.sebi) * (1 + rates.gst) + rates.stt;
  return (buyPrice * quantity + buy + fixed) / (quantity * (1 - k));
}

/** Rupees to two decimals, for display and stored totals. */
export function paise(value: number): number {
  return Math.round(value * 100) / 100;
}
