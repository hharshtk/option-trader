// Where a long option position's stop and target sit. Pure, shared by the engine (set on every
// entry fill) and the web (the settings hint, the decision API's trade math).
//
// Two ways to say it:
//   percent — a share of the premium paid, as a broker's bracket order takes it. Either fixed in
//             the settings, or worked out for each trade from how much NIFTY is moving
//             (`volatilityExits`), which is what the trader does by default.
//   rupees  — rupees made or lost on the trade after Dhan's charges on both orders and the
//             slippage on the sale. This is the scalping setting: "take ₹250, cut at ₹200", and the
//             engine works out what the option has to trade at for that to be true.

import { optionView } from "../insight/derivatives.ts";
import { sellPriceForNet } from "./charges.ts";

export type ExitUnit = "percent" | "rupees";

export interface ExitSettings {
  exitIn?: ExitUnit;
  stopLossPct: number;
  targetPct: number;
  /** Rupees after charges. 0 turns it off. */
  stopNet?: number;
  targetNet?: number;
}

export interface ExitLevels {
  stopPrice: number | null;
  targetPrice: number | null;
  /**
   * Set when a rupee stop is smaller than the trade's own charges: selling at the entry price
   * would already lose more, so the stop is moved to one tick below the entry.
   */
  stopClamped: boolean;
}

function roundUp(price: number, tick: number) {
  if (!(tick > 0)) return price;
  // The epsilon keeps 85.2 / 0.05 = 1703.9999… from rounding a whole tick away.
  return Math.round(Math.ceil(price / tick - 1e-9) * tick * 100) / 100;
}

/**
 * The stop and target for a position bought at `entryPrice`. `slippage` is what the sale is
 * expected to lose past the price that triggers it, per unit: rupee levels are raised by it so the
 * fill, not the trigger, nets the amount. Rupee levels round up to the tick, so a target nets at
 * least its amount and a stop loses at most its amount (before the market gaps past it).
 */
export function exitLevels(settings: ExitSettings, entryPrice: number, quantity: number, tickSize: number, slippage: number): ExitLevels {
  if (settings.exitIn !== "rupees") {
    return {
      stopPrice: settings.stopLossPct > 0 ? entryPrice * (1 - settings.stopLossPct / 100) : null,
      targetPrice: settings.targetPct > 0 ? entryPrice * (1 + settings.targetPct / 100) : null,
      stopClamped: false,
    };
  }
  const level = (net: number) => roundUp(sellPriceForNet(entryPrice, quantity, net) + slippage, tickSize);
  const targetPrice = (settings.targetNet ?? 0) > 0 ? level(settings.targetNet!) : null;
  let stopPrice = (settings.stopNet ?? 0) > 0 ? level(-settings.stopNet!) : null;
  let stopClamped = false;
  const tick = tickSize > 0 ? tickSize : 0.05;
  if (stopPrice !== null && stopPrice >= entryPrice) {
    stopPrice = Math.round((entryPrice - tick) * 100) / 100;
    stopClamped = true;
  }
  return { stopPrice, targetPrice, stopClamped };
}

/** The stop and target as a share of the premium, in percent, for showing a rupee plan beside a percent one. */
export function exitPercents(settings: ExitSettings, premium: number, quantity: number, tickSize: number, slippage: number): { stopPct: number | null; targetPct: number | null } {
  const { stopPrice, targetPrice } = exitLevels(settings, premium, quantity, tickSize, slippage);
  return {
    stopPct: stopPrice === null || premium <= 0 ? null : ((premium - stopPrice) / premium) * 100,
    targetPct: targetPrice === null || premium <= 0 ? null : ((targetPrice - premium) / premium) * 100,
  };
}

/** How far NIFTY typically moves over the hold, as stop and target distances: the defaults. */
export const STOP_MOVES = 1;
export const TARGET_MOVES = 2;
/** Volatility exits are kept within these, in percent of the premium. */
const MIN_PCT = 2;
const MAX_STOP_PCT = 60;
const MAX_TARGET_PCT = 300;

export interface VolatilityExitInput {
  /** What the option costs now (the entry, or the ask before it). */
  premium: number;
  strike: number;
  type: "CE" | "PE";
  /** NIFTY's forward, or its price. */
  forward: number | null;
  minutesToExpiry: number | null;
  holdMinutes: number;
  /** NIFTY's average 1-minute move either way, recently, in points. */
  minuteMove: number | null;
  /**
   * NIFTY's typical move over the hold, in points, when measured from recent days at this time of
   * day (lib/trading/moves.ts `expectedMove`). Without it, `minuteMove` × √hold stands in.
   */
  move?: number | null;
  /** The stop and target as multiples of the typical move over the hold. */
  stopMoves: number;
  targetMoves: number;
}

export interface VolatilityExits {
  stopPct: number;
  targetPct: number;
  /** NIFTY's typical move over the hold, in points, and what it moves this option, in rupees a unit. */
  move: number;
  premiumMove: number;
  delta: number;
}

/**
 * A stop and target that follow the market instead of fixed percents: NIFTY's typical move over
 * the hold (measured from recent days at this time of day when known, `move`; else its recent
 * 1-minute move times the square root of the hold) times the option's delta is how far the premium
 * typically moves. The stop
 * sits `stopMoves` of those below the entry and the target `targetMoves` above: outside the
 * ordinary noise, and a target a fixed multiple of the stop. On 18 November 2026 a fixed 20% stop
 * on a ₹170 option was about 68 NIFTY points away while NIFTY typically moved 20 in 10 minutes, so
 * fixed levels almost never triggered. Null when the inputs aren't known.
 */
export function volatilityExits(input: VolatilityExitInput): VolatilityExits | null {
  const { premium, strike, type, forward, minutesToExpiry, holdMinutes, minuteMove, stopMoves, targetMoves } = input;
  const measured = input.move != null && input.move > 0 ? input.move : null;
  if (!(premium > 0) || forward === null || minutesToExpiry === null || minutesToExpiry <= 0) return null;
  if (measured === null && (minuteMove === null || !(minuteMove > 0))) return null;
  const view = optionView({ premium, forward, strike, type, minutesToExpiry, holdMinutes });
  if (!view) return null;
  const delta = Math.abs(view.delta);
  const move = measured ?? minuteMove! * Math.sqrt(holdMinutes);
  const premiumMove = move * delta;
  const pct = (moves: number, most: number) => Math.min(most, Math.max(MIN_PCT, (moves * premiumMove * 100) / premium));
  return {
    stopPct: round(pct(stopMoves, MAX_STOP_PCT)),
    targetPct: round(pct(targetMoves, MAX_TARGET_PCT)),
    move: round(move),
    premiumMove: round(premiumMove),
    delta: round(delta),
  };
}

const round = (value: number) => Math.round(value * 100) / 100;
