// The decision lab's scorecard: how each rule did over the recorded days, after costs, at each
// hold. Shared by the engine (`GET /v1/decide`), the command line and the Strategies page.

import { FIELDS } from "./state.ts";
import { RANDOM_SCHEDULES, SCORED } from "./rules.ts";
import { DEFAULT_EXITS, EXIT_MODES, HOLDS, LIMITS, type ExitMode, type SimTrade } from "./simulate.ts";
import { MOVE_MINUTES, type MinuteState } from "./state.ts";

export interface ScoreRow {
  rule: string;
  name: string;
  hold: number;
  /** With every entry put through the cost check. */
  checked: boolean;
  /** Fixed percent exits, each trade's own from how much NIFTY was moving, or a trailing stop with no target. */
  exits: ExitMode;
  /**
   * Days with option quotes to trade on that test the rule. A candidate's figures count only the
   * days from its `since`: the days it was written with say nothing about it.
   */
  days: number;
  /** For No signal, averages over its schedules (so possibly fractional). */
  trades: number;
  /** Trades that made money after costs. */
  wins: number;
  /** Rupees after Dhan's charges, spread and slippage, one lot a trade. */
  net: number;
  perTrade: number | null;
  /** The day's net on the worst and best days, and when. */
  worstDay: { date: string; net: number } | null;
  bestDay: { date: string; net: number } | null;
  /**
   * Rupees a trade above (or below) what random trades on the same side made on the same days: a
   * rule's calls against No signal's calls that day, its puts against its puts. On a day NIFTY went
   * one way, every rule that bought that side looks good; this takes the day's direction out.
   * Null for No signal itself, and without trades.
   */
  vsSameSide: number | null;
  /** Tested days the rule traded on, and how many of them it beat that bar. */
  daysTraded: number;
  daysAhead: number;
  /**
   * Every scored day, tested or not: the rule's trades and net, and `bar`, what as many random
   * trades on the same sides made that day (null without them).
   */
  byDay: { date: string; tested: boolean; trades: number; net: number; bar: number | null }[];
}

/** A recorded day in the lab. */
export interface LabDay {
  date: string;
  /** Minutes with a state, and with option quotes to trade on. */
  minutes: number;
  pricedMinutes: number;
  expiry: string | null;
  depth: boolean;
  chain: boolean;
  builtAt: number;
  /**
   * The day's average move over MOVE_MINUTES minutes either way: what the at-the-money straddle
   * priced at each minute, and what NIFTY then delivered. Delivered above priced: buying options
   * paid that day. Null before the day is scored, or without options.
   */
  pricedMove: number | null;
  deliveredMove: number | null;
}

/** `GET /v1/decide`: the lab's days and scorecard. */
export interface DecideView {
  days: LabDay[];
  holds: readonly number[];
  rows: ScoreRow[];
  rules: { id: string; name: string; idea: string; candidate: boolean; exits: string | null; since: string | null }[];
  costCheckFactor: number;
  moveMinutes: number;
  /** What every trade assumes, for the page to say. */
  assumptions: { stopPct: number; targetPct: number; stopMoves: number; targetMoves: number; opposite: boolean; slippage: number; entries: string; squareOff: string };
  /** Exit styles in the order the page offers them. */
  exitModes: readonly ExitMode[];
  /** What a rule can read at each minute: field and meaning. */
  fields: { name: string; meaning: string }[];
  /** A build running now, or the last one's outcome. */
  build: { state: "idle" | "running" | "failed"; at: number | null; message: string | null };
}

export function scorecard(trades: readonly SimTrade[], pricedDays: readonly string[]): ScoreRow[] {
  const rows: ScoreRow[] = [];
  for (const hold of HOLDS) for (const checked of [false, true]) for (const exits of EXIT_MODES) {
    const scored = trades.filter((t) => t.hold === hold && t.checked === checked && t.exits === exits);
    // What a random trade made on each day and side: the bar for that day's calls and puts.
    const sides = new Map<string, { trades: number; net: number }>();
    for (const t of scored) {
      if (!t.rule.startsWith("random:")) continue;
      const side = sides.get(`${t.date}|${t.type}`) ?? { trades: 0, net: 0 };
      side.trades += 1;
      side.net += t.net;
      sides.set(`${t.date}|${t.type}`, side);
    }
    const randomTrade = (t: SimTrade) => {
      const side = sides.get(`${t.date}|${t.type}`);
      return side && side.trades > 0 ? side.net / side.trades : null;
    };

    for (const rule of SCORED) {
      // No signal is the average of its schedules: totals divided by how many there are.
      const random = rule.id === "random";
      const share = random ? 1 / RANDOM_SCHEDULES.length : 1;
      const tested = (date: string) => !rule.since || date >= rule.since;
      const all = scored.filter((t) => (random ? t.rule.startsWith("random:") : t.rule === rule.id));
      const byDay = pricedDays.map((date) => {
        const day = all.filter((t) => t.date === date);
        const bars = day.map(randomTrade);
        return {
          date,
          tested: tested(date),
          trades: round(day.length * share),
          net: round(day.reduce((a, t) => a + t.net, 0) * share),
          bar: random || bars.some((b) => b === null) ? null : round(bars.reduce((a: number, b) => a + b!, 0)),
        };
      });
      const days = byDay.filter((d) => d.tested);
      const mine = all.filter((t) => tested(t.date));
      const total = mine.reduce((a, t) => a + t.net, 0);
      const compared = random ? [] : mine.filter((t) => randomTrade(t) !== null);
      const traded = days.filter((d) => d.trades > 0 && d.bar !== null);
      rows.push({
        rule: rule.id,
        name: rule.name,
        hold,
        checked,
        exits,
        days: days.length,
        trades: round(mine.length * share),
        wins: round(mine.filter((t) => t.net > 0).length * share),
        net: round(total * share),
        perTrade: mine.length ? round(total / mine.length) : null,
        worstDay: days.length ? pick(days, (a, b) => b.net < a.net) : null,
        bestDay: days.length ? pick(days, (a, b) => b.net > a.net) : null,
        vsSameSide: compared.length ? round(compared.reduce((a, t) => a + t.net - randomTrade(t)!, 0) / compared.length) : null,
        daysTraded: random ? 0 : traded.length,
        daysAhead: random ? 0 : traded.filter((d) => d.net > d.bar!).length,
        byDay,
      });
    }
  }
  return rows;
}

/** The day `better` prefers, as date and net. */
function pick(days: readonly { date: string; net: number }[], better: (a: { date: string; net: number }, b: { date: string; net: number }) => boolean) {
  const { date, net } = days.reduce((a, b) => (better(a, b) ? b : a));
  return { date, net };
}

/**
 * What options priced against what NIFTY delivered over a day: at each minute with a straddle
 * price, the move over MOVE_MINUTES minutes it priced and NIFTY's actual move over the next
 * MOVE_MINUTES minutes (both either way, in points), averaged. Outcomes stop at the closing auction.
 */
export function movement(states: readonly (MinuteState | undefined)[]): { priced: number; delivered: number; minutes: number } | null {
  let priced = 0;
  let delivered = 0;
  let minutes = 0;
  for (const now of states) {
    if (!now || now.priced_move === null || now.nifty === null) continue;
    const later = states[now.t + MOVE_MINUTES];
    if (!later || later.nifty === null || now.t + MOVE_MINUTES >= 360) continue;
    priced += now.priced_move;
    delivered += Math.abs(later.nifty - now.nifty);
    minutes += 1;
  }
  return minutes ? { priced: round(priced / minutes), delivered: round(delivered / minutes), minutes } : null;
}

/** A rule's own exits, in words, for the page. */
export function exitsText(rule: (typeof SCORED)[number]): string | null {
  const e = rule.exits;
  if (!e && rule.maxTrades === undefined) return null;
  const parts = [
    e?.stopPct !== undefined && (e.trail ? `stop ${e.stopPct}% below the best price, no target` : `stop ${e.stopPct}%`),
    e?.targetPct !== undefined && !e.trail && `target ${e.targetPct}%`,
    e?.opposite === false && "no exit on an opposite vote",
    e?.holdMinutes !== undefined && `held until ${SQUARE_OFF} whatever the hold`,
    rule.maxTrades !== undefined && `at most ${rule.maxTrades} trades a day`,
  ].filter(Boolean);
  return parts.join(", ");
}

const SQUARE_OFF = "15:10";

export const ASSUMPTIONS: DecideView["assumptions"] = {
  stopPct: DEFAULT_EXITS.stopPct,
  targetPct: DEFAULT_EXITS.targetPct,
  stopMoves: DEFAULT_EXITS.stopMoves,
  targetMoves: DEFAULT_EXITS.targetMoves,
  opposite: DEFAULT_EXITS.opposite,
  slippage: LIMITS.slippage,
  entries: "09:25 to 14:45",
  squareOff: SQUARE_OFF,
};

export const FIELD_LIST: DecideView["fields"] = (Object.entries(FIELDS) as [string, string][]).map(([name, meaning]) => ({ name, meaning }));

const round = (value: number) => Math.round(value * 100) / 100;
