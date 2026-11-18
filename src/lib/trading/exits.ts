// Where a long option position's stop and target sit. Pure, shared by the engine (set on every
// entry fill) and the web (the settings hint, the decision API's trade math).
//
// Two ways to say it:
//   percent — a share of the premium paid, as a broker's bracket order takes it.
//   rupees  — rupees made or lost on the trade after Dhan's charges on both orders and the
//             slippage on the sale. This is the scalping setting: "take ₹250, cut at ₹200", and the
//             engine works out what the option has to trade at for that to be true.

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
