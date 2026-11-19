// The decision lab's scorecard: how each rule did over the recorded days, after costs, at each
// hold. Shared by the engine (`GET /v1/decide`), the command line and the Strategies page.

import { FIELDS } from "./state.ts";
import { RANDOM_SCHEDULES, SCORED } from "./rules.ts";
import { DEFAULT_EXITS, EXIT_MODES, HOLDS, LIMITS, type SimTrade } from "./simulate.ts";
import { MOVE_MINUTES, type MinuteState } from "./state.ts";

export interface ScoreRow {
  rule: string;
  name: string;
  hold: number;
  /** With every entry put through the cost check. */
  checked: boolean;
  /** Fixed percent exits, or each trade's own from how much NIFTY was moving. */
  exits: "fixed" | "volatility";
  /** Days with option quotes to trade on. */
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
  rules: { id: string; name: string; idea: string; candidate: boolean; exits: string | null }[];
  costCheckFactor: number;
  moveMinutes: number;
  /** What every trade assumes, for the page to say. */
  assumptions: { stopPct: number; targetPct: number; stopMoves: number; targetMoves: number; opposite: boolean; slippage: number; entries: string; squareOff: string };
  /** What a rule can read at each minute: field and meaning. */
  fields: { name: string; meaning: string }[];
  /** A build running now, or the last one's outcome. */
  build: { state: "idle" | "running" | "failed"; at: number | null; message: string | null };
}

export function scorecard(trades: readonly SimTrade[], pricedDays: readonly string[]): ScoreRow[] {
  const rows: ScoreRow[] = [];
  for (const hold of HOLDS) for (const checked of [false, true]) for (const exits of EXIT_MODES) {
    for (const rule of SCORED) {
      // No signal is the average of its schedules: totals divided by how many there are.
      const random = rule.id === "random";
      const share = random ? 1 / RANDOM_SCHEDULES.length : 1;
      const mine = trades.filter((t) => (random ? t.rule.startsWith("random:") : t.rule === rule.id) && t.hold === hold && t.checked === checked && t.exits === exits);
      const byDay = new Map<string, number>();
      for (const day of pricedDays) byDay.set(day, 0);
      for (const t of mine) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.net * share);
      const days = [...byDay].map(([date, net]) => ({ date, net: round(net) }));
      const total = mine.reduce((a, t) => a + t.net, 0);
      rows.push({
        rule: rule.id,
        name: rule.name,
        hold,
        checked,
        exits,
        days: pricedDays.length,
        trades: round(mine.length * share),
        wins: round(mine.filter((t) => t.net > 0).length * share),
        net: round(total * share),
        perTrade: mine.length ? round(total / mine.length) : null,
        worstDay: days.length ? days.reduce((a, b) => (b.net < a.net ? b : a)) : null,
        bestDay: days.length ? days.reduce((a, b) => (b.net > a.net ? b : a)) : null,
      });
    }
  }
  return rows;
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
    e?.stopPct !== undefined && `stop ${e.stopPct}%`,
    e?.targetPct !== undefined && `target ${e.targetPct}%`,
    e?.opposite === false && "no exit on an opposite vote",
    rule.maxTrades !== undefined && `at most ${rule.maxTrades} trades a day`,
  ].filter(Boolean);
  return parts.join(", ");
}

export const ASSUMPTIONS: DecideView["assumptions"] = {
  stopPct: DEFAULT_EXITS.stopPct,
  targetPct: DEFAULT_EXITS.targetPct,
  stopMoves: DEFAULT_EXITS.stopMoves,
  targetMoves: DEFAULT_EXITS.targetMoves,
  opposite: DEFAULT_EXITS.opposite,
  slippage: LIMITS.slippage,
  entries: "09:25 to 14:45",
  squareOff: "15:10",
};

export const FIELD_LIST: DecideView["fields"] = (Object.entries(FIELDS) as [string, string][]).map(([name, meaning]) => ({ name, meaning }));

const round = (value: number) => Math.round(value * 100) / 100;
