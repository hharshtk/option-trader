// Plays a rule over one recorded day, minute by minute, with the trader's own rules for entries,
// exits, prices and charges, against the option quotes recorded at each minute's close:
//
//   - A firing between 09:25 and 14:45 buys one lot of the nearest expiry's at-the-money option
//     (call on +1, put on −1) at the ask + ₹0.05, rounded up to the tick. Without a book, the last
//     price + ₹0.50. Skipped when no position can be priced, the premium is under ₹5 or the
//     spread is wider than 3%.
//   - It is sold at the bid − ₹0.05 when the hold is up, the stop or target is crossed (on the last
//     price, as the trader's percent levels are), the rule votes the other way, or at 15:10.
//   - One position at a time, and 2 minutes between a sale and the next buy.
//   - Dhan's charges on both orders.
//
// Quotes are those at each minute's close, with each option's lowest and highest last price within
// the minute: a stop or target crossed inside a minute is sold near its level (less half the spread
// and the slippage), as paper trading's tick-by-tick check would. When both were crossed in one
// minute the stop is taken to have come first. Other exits wait for the minute's close. Replaying
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
   * in when the movement isn't known.
   */
  from: "fixed" | "volatility";
  /** Percent of the premium; 0 turns it off. */
  stopPct: number;
  targetPct: number;
  /** With volatility exits: the stop and target in NIFTY's typical moves over the hold. */
  stopMoves: number;
  targetMoves: number;
  /** Sell when the rule votes the other way. */
  opposite: boolean;
}

/** The trader's defaults, with fixed percents. */
export const DEFAULT_EXITS: Exits = { holdMinutes: 10, from: "fixed", stopPct: 20, targetPct: 30, stopMoves: STOP_MOVES, targetMoves: TARGET_MOVES, opposite: true };
/** The ways exits are scored. */
export const EXIT_MODES = ["fixed", "volatility"] as const;
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

export type ExitReason = "hold" | "stop" | "target" | "opposite" | "square-off" | "end of data";

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
  /** How its stop and target were set, and where they were, in percent of the premium paid. */
  exits: "fixed" | "volatility";
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

export function simulateDay(rule: Rule, day: DayData, base: Exits = DEFAULT_EXITS, policy: Policy = { costCheck: false }): DayResult {
  // A rule's own stop, target and opposite-vote exit; the hold is the scoring's.
  const exits: Exits = { ...base, ...rule.exits };
  const firstEntry = Math.max(LIMITS.firstEntry, rule.window?.from ?? 0);
  const lastEntry = Math.min(LIMITS.lastEntry, rule.window?.until ?? Infinity);
  const trades: SimTrade[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  const priced = day.quotes.some((q) => q && q.length > 0);
  const before: MinuteState[] = [];
  let open: { direction: 1 | -1; quote: MinuteQuote; buy: number; entryMinute: number; nifty: number | null; stopPct: number; targetPct: number } | null = null;
  let freeFrom = 0;

  const quoteAt = (t: number, key: string) => day.quotes[t]?.find((q) => q.key === key) ?? null;
  const sellPrice = (q: MinuteQuote) => (q.bid !== null && q.bid > 0 ? q.bid - LIMITS.slippage : (q.ltp ?? 0) - LIMITS.looseSlippage);

  /** `at`: the sale price when known (a level crossed inside the minute), else the bid at the close. */
  const close = (t: number, exit: ExitReason, q: MinuteQuote | null, at: number | null = null) => {
    const position = open!;
    const last = q ?? lastQuote(position.quote.key, t);
    const sell = down(at ?? (last ? sellPrice(last) : position.buy));
    const quantity = position.quote.lotSize;
    const charges = roundTripCharges(position.buy * quantity, sell * quantity).total;
    const gross = (sell - position.buy) * quantity;
    const nifty = day.states[t]?.nifty ?? null;
    trades.push({
      date: day.date,
      rule: rule.id,
      hold: exits.holdMinutes,
      checked: policy.costCheck,
      exits: exits.from,
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
      const stopAt = open.stopPct > 0 ? open.buy * (1 - open.stopPct / 100) : null;
      const targetAt = open.targetPct > 0 ? open.buy * (1 + open.targetPct / 100) : null;
      // Crossed inside the minute: sold near the level, as a tick-by-tick check would.
      const ranged = q?.low !== undefined && q?.low !== null;
      const nearLevel = (level: number) => (ranged ? level - halfSpread(q!) - LIMITS.slippage : null);
      if (t >= LIMITS.squareOff) close(t, "square-off", q);
      else if (low !== null && stopAt !== null && low <= stopAt) close(t, "stop", q, nearLevel(stopAt));
      else if (high !== null && targetAt !== null && high >= targetAt) close(t, "target", q, nearLevel(targetAt));
      else if (exits.opposite && vote !== null && vote !== open.direction) close(t, "opposite", q);
      else if (t - open.entryMinute >= exits.holdMinutes) close(t, "hold", q);
      // An exit this minute doesn't buy again in the same minute: the cooldown starts now.
      if (open || freeFrom > t) continue;
    }

    if (vote === null || t < firstEntry || t > lastEntry || t < freeFrom) continue;
    if (rule.maxTrades !== undefined && trades.length >= rule.maxTrades) continue;
    const type: "CE" | "PE" = vote > 0 ? "CE" : "PE";
    const spot = now.nifty;
    const choices: MinuteQuote[] = (day.quotes[t] ?? []).filter((q) => q.type === type && (q.ask !== null || q.ltp !== null));
    if (spot === null || choices.length === 0) {
      skip("no quote");
      continue;
    }
    const quote: MinuteQuote = choices.reduce((best: MinuteQuote, q: MinuteQuote) => (Math.abs(q.strike - spot) < Math.abs(best.strike - spot) ? q : best), choices[0]);
    if (Math.abs(quote.strike - spot) > 100) {
      skip("no quote near the money");
      continue;
    }
    const book = quote.bid !== null && quote.ask !== null && quote.ask >= quote.bid;
    const ask = book ? quote.ask! : quote.ltp!;
    if (ask < LIMITS.minPremium) {
      skip("premium too low");
      continue;
    }
    if (book && ((quote.ask! - quote.bid!) / ((quote.ask! + quote.bid!) / 2)) * 100 > LIMITS.maxSpreadPct) {
      skip("spread too wide");
      continue;
    }
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
    open = { direction: vote, quote, buy: up(ask + (book ? LIMITS.slippage : LIMITS.looseSlippage)), entryMinute: t, nifty: spot, stopPct, targetPct };
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
