// The cost check: a gate on every trade, with no AI in it. Buying an option and selling it later
// costs Dhan's charges, the spread, slippage both ways and the time value the option loses over
// the hold. Divided by the option's delta, that is the NIFTY move the trade needs just to break
// even. The check lets a trade through only when the move NIFTY typically makes over the hold
// (its recent 1-minute move scaled to the hold) is at least COST_CHECK_FACTOR times that.
//
// Why 3: on a guess that is right half the time, the typical move must dwarf the costs before a
// target bigger than the stop can pay for the losers. Fixed on 18 November 2026; only days from
// 19 November test it, and it is not to be tuned on them.
//
// Shared by the decision lab and the trader: the same numbers decide in both.

import { optionView } from "../insight/derivatives.ts";
import { roundTripCharges } from "../trading/charges.ts";

export const COST_CHECK_FACTOR = 3;
/** Per-unit slippage on each order, as the trader's fills assume. */
const SLIPPAGE = 0.05;
/** Stands in for the spread when the book isn't known. */
const LOOSE_SPREAD = 1;

export interface CostCheckInput {
  bid: number | null;
  /** What the entry would pay: the ask, or the last price without a book. */
  ask: number;
  quantity: number;
  strike: number;
  type: "CE" | "PE";
  /** NIFTY's forward (strike + call − put at the money), or its price. */
  forward: number | null;
  minutesToExpiry: number | null;
  holdMinutes: number;
  /** NIFTY's average 1-minute move either way, recently, in points. */
  minuteMove: number | null;
}

export interface CostCheck {
  pass: boolean;
  /** The NIFTY move that pays for the trade, and the move NIFTY typically makes over the hold, in points. */
  breakEven: number | null;
  typical: number | null;
  reason: string;
}

export function costCheck(input: CostCheckInput): CostCheck {
  const { bid, ask, quantity, strike, type, forward, minutesToExpiry, holdMinutes, minuteMove } = input;
  if (forward === null || minutesToExpiry === null || minutesToExpiry <= 0 || minuteMove === null || !(ask > 0) || !(quantity > 0)) {
    return { pass: false, breakEven: null, typical: null, reason: "Cost check: not enough known to work out the trade's costs" };
  }
  const book = bid !== null && bid > 0 && ask >= bid;
  const mid = book ? (bid + ask) / 2 : ask;
  const spread = book ? ask - bid : LOOSE_SPREAD;
  const charges = roundTripCharges(ask * quantity, ask * quantity).total / quantity;
  const view = optionView({ premium: mid, forward, strike, type, minutesToExpiry, holdMinutes });
  const delta = view ? Math.abs(view.delta) : 0;
  if (!view || delta < 0.05) return { pass: false, breakEven: null, typical: null, reason: "Cost check: the option barely moves with NIFTY" };
  const breakEven = (charges + spread + 2 * SLIPPAGE + view.decay) / delta;
  const typical = minuteMove * Math.sqrt(holdMinutes);
  const pass = typical >= COST_CHECK_FACTOR * breakEven;
  const numbers = `NIFTY typically moves ${typical.toFixed(1)} points in ${holdMinutes} min; the trade needs ${breakEven.toFixed(1)} to break even`;
  return {
    pass,
    breakEven: Math.round(breakEven * 10) / 10,
    typical: Math.round(typical * 10) / 10,
    reason: pass ? `Cost check passed: ${numbers}` : `Cost check: ${numbers}, less than ${COST_CHECK_FACTOR} times over`,
  };
}
