// What a round trip costs, in NIFTY points, so a signal's average move can be held against it.
// Built from Dhan's charges (charges.ts), the same module paper trading uses. Pure.

import { FUTURES_RATES, OPTION_RATES, roundTripCharges } from "../trading/charges.ts";
import type { StudySpec } from "./types.ts";

/**
 * One option lot bought and sold at the same premium: Dhan's charges plus slippage each way, per
 * unit of premium, divided by delta to give the NIFTY move that pays for it. Time decay while
 * held is not included: an estimate until studies price real options.
 */
export function optionCostPoints({ lot, premium, slippage, delta }: StudySpec["costs"]["option"]): number {
  const charges = roundTripCharges(premium * lot, premium * lot, OPTION_RATES).total;
  return (charges / lot + 2 * slippage) / delta;
}

/** One futures lot bought and sold at `nifty`: Dhan's charges per unit plus the spread. */
export function futuresCostPoints({ lot, spread }: StudySpec["costs"]["futures"], nifty: number): number {
  const charges = roundTripCharges(nifty * lot, nifty * lot, FUTURES_RATES).total;
  return charges / lot + spread;
}
