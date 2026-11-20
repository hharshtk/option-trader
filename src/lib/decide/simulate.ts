// Plays a rule over one recorded day, minute by minute, with the trader's own rules for entries,
// exits, prices and charges, against the option quotes recorded at each minute's close:
//
//   - A firing between 09:25 and 14:45 buys one lot of the nearest expiry's at-the-money option
//     (call on +1, put on −1) at the ask + ₹0.05, rounded up to the tick. Without a book, the last
//     price + ₹0.50. Skipped when no position can be priced, the premium is under ₹5 or the
//     spread is wider than 3%.
//   - It is sold at the bid − ₹0.05 when the hold is up, the stop or target is crossed (on the last
//     price, as the trader's percent levels are), the rule votes the other way, or at 15:10.
//   - With a trailing stop there is no target: the stop follows the option's best last price up,
//     staying the stop's distance below it, so a winner runs until it falls back.
//   - One position at a time, and 2 minutes between a sale and the next buy.
//   - Dhan's charges on both orders.
//
// Quotes are those at each minute's close, with each option's lowest and highest last price within
// the minute: a stop or target crossed inside a minute is sold near its level (less half the spread
// and the slippage), as paper trading's tick-by-tick check would. When both were crossed in one
// minute the stop is taken to have come first. A trailing stop moves up with the best price of the
// minutes before, so a minute's high raises it from the next minute. Other exits wait for the
// minute's close. Replaying
// the day with paper trading is the exact check; this is the quick one across days.

import { roundTripCharges } from "../trading/charges.ts";
import { STOP_MOVES, TARGET_MOVES, volatilityExits } from "../trading/exits.ts";
import { expectedMove, type MoveProfile } from "../trading/moves.ts";
import { costCheck } from "./cost.ts";
import { movesFor, type Rule } from "./rules.ts";
import type { MinuteState } from "./state.ts";

/** An option's quote at a minute's close. */
export interface MinuteQuote {
  key: string;
  strike: number;
  type: "CE" | "PE";
  bid: number | null;
  ask: number | null;
  ltp: number | null;
  /** The last price's lowest and highest since the previous minute's quote; absent in tables built before 18 November 2026's rebuild. */
  low?: number | null;
  high?: number | null;
  lotSize: number;
}

export interface DayData {
  date: string;
  /** The states by minute (index = minutes since 09:15); a hole where the day has none. */
  states: (MinuteState | undefined)[];
  /** The nearest expiry's option quotes by minute. */
  quotes: (MinuteQuote[] | undefined)[];
  /** NIFTY's recent days before this one, for volatility exits' typical move; null or absent: today's formula. */
  profile?: MoveProfile | null;
}

export interface Exits {
  holdMinutes: number;
  /**
   * Fixed percents (`stopPct`, `targetPct`), or each trade's own from how much NIFTY is moving at
   * entry (lib/trading/exits.ts `volatilityExits`), as the trader sets them; the fixed ones stand
   * in when the movement isn't known. `trailing` is the fixed stop made to trail, with no target.
   */
  from: ExitMode;
  /** Percent of the premium; 0 turns it off. */
  stopPct: number;
  targetPct: number;
  /** With volatility exits: the stop and target in NIFTY's typical moves over the hold. */
  stopMoves: number;
  targetMoves: number;
  /** Sell when the rule votes the other way. */
  opposite: boolean;
  /** The stop follows the best price up at its distance, and there is no target. */
  trail: boolean;
}

/** How a trade's stop and target are set: fixed percents, from NIFTY's moves, or a trailing stop with no target. */
export type ExitMode = "fixed" | "volatility" | "trailing";

/** The trader's defaults, with fixed percents. */
export const DEFAULT_EXITS: Exits = { holdMinutes: 10, from: "fixed", stopPct: 20, targetPct: 30, stopMoves: STOP_MOVES, targetMoves: TARGET_MOVES, opposite: true, trail: false };
/** The ways exits are scored. */
export const EXIT_MODES = ["fixed", "volatility", "trailing"] as const satisfies readonly ExitMode[];
/** Holds every rule is scored at. */
export const HOLDS = [5, 10, 15, 30] as const;

export const LIMITS = {
  /** 09:25 and 14:45 IST, in minutes since 09:15. */
  firstEntry: 10,
  lastEntry: 330,
  /** 15:10 IST. */
  squareOff: 355,
  cooldownMinutes: 2,
  minPremium: 5,
  maxSpreadPct: 3,
  slippage: 0.05,
  looseSlippage: 0.5,
  tick: 0.05,
};

export type ExitReason = "hold" | "stop" | "trail" | "target" | "opposite" | "square-off" | "end of data";

/** How trades are taken, beyond the rule itself. */
export interface Policy {
  /** Every entry must pass the cost check (lib/decide/cost.ts). */
  costCheck: boolean;
}

export interface SimTrade {
  date: string;
  rule: string;
  hold: number;
  /** Taken with the cost check on. */
  checked: boolean;
  /** How its stop and target were set, and where they were, in percent of the premium paid (target 0 with a trailing stop). */
  exits: ExitMode;
  stopPct: number;
  targetPct: number;
  direction: 1 | -1;
  key: string;
  strike: number;
  type: "CE" | "PE";
  quantity: number;
  entryMinute: number;
  exitMinute: number;
  buy: number;
  sell: number;
  exit: ExitReason;
  /** Rupees: price difference × quantity, Dhan's charges, and the two together. */
  gross: number;
  charges: number;
  net: number;
  /** NIFTY's points from entry to exit. */
  niftyMove: number | null;
}

export interface DayResult {
  trades: SimTrade[];
  /** Firings that couldn't be traded, and why. */
  skipped: Record<string, number>;
  /** Whether the day had option quotes to trade at all. */
  priced: boolean;
}

const up = (price: number) => Math.round(Math.ceil(price / LIMITS.tick - 1e-9) * LIMITS.tick * 100) / 100;
const down = (price: number) => Math.max(LIMITS.tick, Math.round(Math.floor(price / LIMITS.tick + 1e-9) * LIMITS.tick * 100) / 100);

/** A buy that can be made at a minute's close: the at-the-money contract, its ask and what the fill pays. */
export interface Entry {
  quote: MinuteQuote;
  /** True when the order book is known (bid and ask); else the last price stands in. */
  book: boolean;
  /** The ask, or the last price without a book. */
  ask: number;
  /** The fill: the ask + ₹0.05 (the last price + ₹0.50 without a book), up to the tick. */
  buy: number;
}

/**
 * The trader's entry rules at one minute's close: the nearest expiry's option of `type` closest
 * to NIFTY (within 100 points), skipped when its premium is under ₹5 or its spread over 3%.
 * Shared by the lab's trades and the prediction scoreboard.
 */
export function entryAt(quotes: readonly MinuteQuote[] | undefined, spot: number | null, type: "CE" | "PE"): { entry: Entry } | { skip: string } {
  const choices = (quotes ?? []).filter((q) => q.type === type && (q.ask !== null || q.ltp !== null));
  if (spot === null || choices.length === 0) return { skip: "no quote" };
  const quote = choices.reduce((best, q) => (Math.abs(q.strike - spot) < Math.abs(best.strike - spot) ? q : best), choices[0]);
  if (Math.abs(quote.strike - spot) > 100) return { skip: "no quote near the money" };
  const book = quote.bid !== null && quote.ask !== null && quote.ask >= quote.bid;
  const ask = book ? quote.ask! : quote.ltp!;
  if (ask < LIMITS.minPremium) return { skip: "premium too low" };
  if (book && ((quote.ask! - quote.bid!) / ((quote.ask! + quote.bid!) / 2)) * 100 > LIMITS.maxSpreadPct) return { skip: "spread too wide" };
  return { entry: { quote, book, ask, buy: up(ask + (book ? LIMITS.slippage : LIMITS.looseSlippage)) } };
}

/** What a sale at this quote fetches: the bid − ₹0.05 (the last price − ₹0.50 without a bid), down to the tick. */
export function exitPrice(q: MinuteQuote): number {
  return down(q.bid !== null && q.bid > 0 ? q.bid - LIMITS.slippage : (q.ltp ?? 0) - LIMITS.looseSlippage);
}

export function simulateDay(rule: Rule, day: DayData, base: Exits = DEFAULT_EXITS, policy: Policy = { costCheck: false }): DayResult {
  // A rule's own stop, target, trailing stop, opposite-vote exit and hold (when it holds to the
  // close); trades are filed under the scoring's hold either way. Trailing exits trail any stop.
  const exits: Exits = { ...base, ...rule.exits, ...(base.from === "trailing" ? { trail: true } : {}) };
  const firstEntry = Math.max(LIMITS.firstEntry, rule.window?.from ?? 0);
  const lastEntry = Math.min(LIMITS.lastEntry, rule.window?.until ?? Infinity);
  const trades: SimTrade[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  const priced = day.quotes.some((q) => q && q.length > 0);
  const before: MinuteState[] = [];
  let open: { direction: 1 | -1; quote: MinuteQuote; buy: number; entryMinute: number; nifty: number | null; stopPct: number; targetPct: number; best: number } | null = null;
  let freeFrom = 0;

  const quoteAt = (t: number, key: string) => day.quotes[t]?.find((q) => q.key === key) ?? null;

  /** `at`: the sale price when known (a level crossed inside the minute), else the bid at the close. */
  const close = (t: number, exit: ExitReason, q: MinuteQuote | null, at: number | null = null) => {
    const position = open!;
    const last = q ?? lastQuote(position.quote.key, t);
    const sell = at !== null ? down(at) : last ? exitPrice(last) : down(position.buy);
    const quantity = position.quote.lotSize;
    const charges = roundTripCharges(position.buy * quantity, sell * quantity).total;
    const gross = (sell - position.buy) * quantity;
    const nifty = day.states[t]?.nifty ?? null;
    trades.push({
      date: day.date,
      rule: rule.id,
      hold: base.holdMinutes,
      checked: policy.costCheck,
      exits: base.from,
      stopPct: position.stopPct,
      targetPct: position.targetPct,
      direction: position.direction,
      key: position.quote.key,
      strike: position.quote.strike,
      type: position.quote.type,
      quantity,
      entryMinute: position.entryMinute,
      exitMinute: t,
      buy: position.buy,
      sell,
      exit,
      gross: round(gross),
      charges: round(charges),
      net: round(gross - charges),
      niftyMove: nifty !== null && position.nifty !== null ? round(nifty - position.nifty) : null,
    });
    open = null;
    freeFrom = t + LIMITS.cooldownMinutes;
  };

  /** The contract's latest quote at or before minute `t`. */
  const lastQuote = (key: string, t: number) => {
    for (let k = t; k >= 0; k -= 1) {
      const q = quoteAt(k, key);
      if (q) return q;
    }
    return null;
  };

  const lastMinute = day.states.length - 1;
  for (let t = 0; t <= lastMinute; t += 1) {
    const now = day.states[t];
    if (!now) continue;
    const vote = rule.decide(now, before);
    before.push(now);

    if (open) {
      const q = quoteAt(t, open.quote.key);
      const ltp = q?.ltp ?? null;
      const low = q?.low ?? ltp;
      const high = q?.high ?? ltp;
      const fixedStop = open.stopPct > 0 ? open.buy * (1 - open.stopPct / 100) : null;
      // A trailing stop sits its distance below the best price of the minutes before this one.
      const stopAt = exits.trail && fixedStop !== null ? Math.max(fixedStop, open.best * (1 - open.stopPct / 100)) : fixedStop;
      const trailed = stopAt !== null && fixedStop !== null && stopAt > fixedStop;
      const targetAt = open.targetPct > 0 ? open.buy * (1 + open.targetPct / 100) : null;
      // Crossed inside the minute: sold near the level, as a tick-by-tick check would.
      const ranged = q?.low !== undefined && q?.low !== null;
      const nearLevel = (level: number) => (ranged ? level - halfSpread(q!) - LIMITS.slippage : null);
      if (t >= LIMITS.squareOff) close(t, "square-off", q);
      else if (low !== null && stopAt !== null && low <= stopAt) close(t, trailed ? "trail" : "stop", q, nearLevel(stopAt));
      else if (high !== null && targetAt !== null && high >= targetAt) close(t, "target", q, nearLevel(targetAt));
      else if (exits.opposite && vote !== null && vote !== open.direction) close(t, "opposite", q);
      else if (t - open.entryMinute >= exits.holdMinutes) close(t, "hold", q);
      if (open && high !== null && high > open.best) open.best = high;
      // An exit this minute doesn't buy again in the same minute: the cooldown starts now.
      if (open || freeFrom > t) continue;
    }

    if (vote === null || t < firstEntry || t > lastEntry || t < freeFrom) continue;
    if (rule.maxTrades !== undefined && trades.length >= rule.maxTrades) continue;
    const type: "CE" | "PE" = vote > 0 ? "CE" : "PE";
    const spot = now.nifty;
    const found = entryAt(day.quotes[t], spot, type);
    if ("skip" in found) {
      skip(found.skip);
      continue;
    }
    const { quote, book, ask, buy } = found.entry;
    if (policy.costCheck) {
      const check = costCheck({
        bid: book ? quote.bid : null,
        ask,
        quantity: quote.lotSize,
        strike: quote.strike,
        type,
        forward: now.opt_forward ?? spot,
        minutesToExpiry: now.opt_minutes_to_expiry,
        holdMinutes: exits.holdMinutes,
        minuteMove: now.minute_move,
      });
      if (!check.pass) {
        skip("cost check");
        continue;
      }
    }
    let { stopPct, targetPct } = exits;
    if (exits.from === "volatility") {
      const levels = volatilityExits({
        premium: ask,
        strike: quote.strike,
        type,
        forward: now.opt_forward ?? spot,
        minutesToExpiry: now.opt_minutes_to_expiry,
        holdMinutes: exits.holdMinutes,
        minuteMove: now.minute_move,
        move: expectedMove(day.profile ?? null, t, exits.holdMinutes, now.minute_move)?.move ?? null,
        ...movesFor(rule, exits.stopMoves, exits.targetMoves),
      });
      if (levels) ({ stopPct, targetPct } = levels);
    }
    if (exits.trail) targetPct = 0;
    open = { direction: vote, quote, buy, entryMinute: t, nifty: spot!, stopPct, targetPct, best: buy };
  }
  if (open) close(lastMinute, "end of data", null);
  return { trades, skipped, priced };
}

/** Half the quoted spread, or half a rupee without a book. */
function halfSpread(q: MinuteQuote) {
  return q.bid !== null && q.ask !== null && q.ask >= q.bid ? (q.ask - q.bid) / 2 : LIMITS.looseSlippage;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
