// Decision rules: what to do at the close of a minute, from what the engine knows then. A rule is
// a plain function of the minute's state (and the minutes before it): buy a call (+1), buy a put
// (−1) or do nothing (null). The same function is scored on every recorded day by the test runner
// and, once a rule earns it, followed by the live trader.
//
// Step 1 holds the bars any new rule must clear: trading at fixed times with no signal, and
// following each Pulse signal as the trader does today.

import { SIGNALS } from "../engine/trading.ts";
import type { Exits } from "./simulate.ts";
import type { MinuteState } from "./state.ts";

export interface Rule {
  id: string;
  name: string;
  /** What it does and why, in a sentence or two. */
  idea: string;
  /** +1 buys a call, −1 a put, null does nothing. `before` holds the earlier minutes' states, oldest first. */
  decide(now: MinuteState, before: readonly MinuteState[]): 1 | -1 | null;
  /**
   * The rule's own exits, in place of the trader's defaults. The hold comes from the scoring unless
   * the rule sets its own (UNTIL_CLOSE: kept until 15:10). `trail` makes the stop follow the best
   * price, with no target.
   */
  exits?: Partial<Pick<Exits, "stopPct" | "targetPct" | "opposite" | "trail" | "holdMinutes">>;
  /** At most this many trades a day. */
  maxTrades?: number;
  /** Entries only from and until these minutes since 09:15, within the trader's 09:25 to 14:45. */
  window?: { from: number; until: number };
  /** One of the step-2 candidates the live trader can follow. */
  candidate?: true;
  /**
   * The first day that tests a candidate (YYYY-MM-DD): it was written with the days before it
   * already seen, so those days say nothing about it and the scorecard keeps them apart.
   */
  since?: string;
}

/** A rule's own hold that keeps the position until the square-off at 15:10, whatever the hold scored. */
export const UNTIL_CLOSE = 360;

/** No signal fires every this many minutes, alternating calls and puts. */
const RANDOM_EVERY = 15;

/**
 * No signal at every phase: each starting minute of the 15 and each first side, 30 schedules in
 * all. One fixed schedule can line up with the day's swings by chance (on 18 November 2026,
 * calls at :15 and :45 and puts at :00 and :30 caught NIFTY's 30-minute rhythm and "won" 17 trades
 * of 22); the average over every schedule is what a trade at a random moment costs.
 */
export const RANDOM_SCHEDULES: readonly Rule[] = Array.from({ length: RANDOM_EVERY * 2 }, (_, i) => {
  const offset = i % RANDOM_EVERY;
  const first: 1 | -1 = i < RANDOM_EVERY ? 1 : -1;
  return {
    id: `random:${offset}:${first > 0 ? "call" : "put"}`,
    name: `No signal (from minute ${offset}, ${first > 0 ? "call" : "put"} first)`,
    idea: "",
    decide: (now: MinuteState) => {
      if (now.t % RANDOM_EVERY !== offset) return null;
      return Math.floor(now.t / RANDOM_EVERY) % 2 === 0 ? first : (-first as 1 | -1);
    },
  };
});

/** The rules on the scorecard. "No signal" stands for the average of its schedules. */
export const RULES: readonly Rule[] = [
  {
    id: "random",
    name: "No signal",
    idea: `A call, then ${RANDOM_EVERY} minutes later a put, and so on, whatever the market does; averaged over every starting minute and side. What a trade at a random moment earns: the bar every other rule must clear.`,
    decide: RANDOM_SCHEDULES[0].decide,
  },
  ...SIGNALS.map(
    (s): Rule => ({
      id: `signal:${s.id}`,
      name: s.name,
      idea: `Follows the Pulse signal "${s.name}" as the trader does: a long vote buys a call, a short vote a put.`,
      decide: (now) => {
        const vote = now[`sig_${s.id}`];
        return vote === 1 ? 1 : vote === -1 ? -1 : null;
      },
    }),
  ),
];

/**
 * The candidates: fewer trades, each needing less to go right. Every number was fixed on 18
 * November 2026, with that day already seen, so only days from 19 November test them; they are
 * not to be tuned on the days that score them. Each reads different data. A target bigger than
 * the stop means a rule can be right less than half the time and still pay.
 */
/** Trend day's test: NIFTY well away from its open, its stocks and the future's buyers or sellers all on that side. */
function trendSide(now: MinuteState): 1 | -1 | null {
  const { nifty, nifty_from_open: move, advancers, decliners, fut_flow_15m: flow } = now;
  if (nifty === null || move === null || advancers === null || decliners === null || flow === null) return null;
  const side = move > 0 ? 1 : -1;
  if (Math.abs(move) < 0.0025 * nifty) return null;
  if ((advancers - decliners) * side < 10) return null;
  if (flow * side < 0.1) return null;
  return side;
}

/** Minutes a vote counts for when two signals must agree: the one now and the 14 before. */
const AGREE_MINUTES = 15;

export const CANDIDATES: readonly Rule[] = [
  {
    id: "trend",
    name: "Trend day",
    idea: "From 10:00 to 14:00, when NIFTY is 0.25% or more from its open, its stocks agree (10 more up than down, or down than up) and buyers (or sellers) took most of what the future traded over 15 minutes: buy with the trend. At most 2 trades a day; a 45% target against a 15% stop, so one win pays for three losses.",
    window: { from: 45, until: 285 },
    maxTrades: 2,
    exits: { stopPct: 15, targetPct: 45, opposite: false },
    candidate: true,
    since: "2026-11-19",
    decide: trendSide,
  },
  {
    id: "cheap-momentum",
    name: "Momentum when options are cheap",
    idea: "Follows 15-minute momentum only when NIFTY has lately been moving at least as much as the at-the-money straddle prices: then the option is cheap for the move it is buying. At most 3 trades a day; a 40% target against a 20% stop.",
    maxTrades: 3,
    exits: { stopPct: 20, targetPct: 40 },
    candidate: true,
    since: "2026-11-19",
    decide(now) {
      const vote = now.sig_momentum;
      if (vote !== 1 && vote !== -1) return null;
      if (now.actual_move === null || now.priced_move === null || now.actual_move < now.priced_move) return null;
      return vote;
    },
  },
  {
    id: "wall-fade",
    name: "Fade at the walls",
    idea: "When NIFTY has climbed 0.15% or more in 15 minutes to within 0.15% of the strike with the most call open interest (the whole chain, else the journal's window), buy a put: call writers are betting it stops there. The mirror at the biggest put strike buys a call. At most 2 trades a day; a 45% target against a 15% stop.",
    maxTrades: 2,
    exits: { stopPct: 15, targetPct: 45, opposite: false },
    candidate: true,
    since: "2026-11-19",
    decide(now) {
      const nifty = now.nifty;
      const climb = now.nifty_points_15m;
      if (nifty === null || climb === null) return null;
      const near = 0.0015 * nifty;
      const calls = now.chain_call_wall ?? now.opt_call_wall;
      const puts = now.chain_put_wall ?? now.opt_put_wall;
      if (calls !== null && calls >= nifty && calls - nifty <= near && climb >= near) return -1;
      if (puts !== null && puts <= nifty && nifty - puts <= near && -climb >= near) return 1;
      return null;
    },
  },
  // Written on 19 November 2026 with 18 and 19 November seen; only days from 20 November test them.
  {
    id: "trend-hold",
    name: "Trend day, held",
    idea: "Trend day's entry from 10:00 to 13:00, but held: once NIFTY, its stocks and the future's buyers or sellers agree, buy with the trend and keep it until 15:10. The stop starts 25% below the buy and follows the option's best price up, staying 25% below it; there is no target. On 19 November Trend day's call was stopped out at 15% on a dip, then NIFTY rose about 390 points from its low to the close. At most 2 trades a day.",
    window: { from: 45, until: 225 },
    maxTrades: 2,
    exits: { stopPct: 25, trail: true, opposite: false, holdMinutes: UNTIL_CLOSE },
    candidate: true,
    since: "2026-11-20",
    decide: trendSide,
  },
  {
    id: "breadth-buildup",
    name: "Breadth and OI build-up agree",
    idea: `Buys when Breadth thrust and Futures OI build-up have both voted the same way within ${AGREE_MINUTES} minutes, neither has voted the other way since, and one of them votes now. The two signals picked the day's side on both 18 and 19 November. At most 3 trades a day; a 40% target against a 20% stop.`,
    maxTrades: 3,
    exits: { stopPct: 20, targetPct: 40 },
    candidate: true,
    since: "2026-11-20",
    decide(now, before) {
      const recent = [...before.slice(-(AGREE_MINUTES - 1)), now];
      for (const side of [1, -1] as const) {
        const votesNow = now.sig_breadth === side || now.sig_buildup === side;
        const held = (field: "sig_breadth" | "sig_buildup") => recent.some((m) => m[field] === side) && !recent.some((m) => m[field] === -side);
        if (votesNow && held("sig_breadth") && held("sig_buildup")) return side;
      }
      return null;
    },
  },
  {
    id: "flow-fade",
    name: "Fade futures order flow",
    idea: "Trades against Futures order flow: a put when buyers have been taking the future, a call when sellers have. Following it lost on both 18 and 19 November, more than trading at random. Fading only pays if that was more than bad luck and costs: both sides pay the same charges. At most 6 trades a day, with the default exits.",
    maxTrades: 6,
    candidate: true,
    since: "2026-11-20",
    decide(now) {
      const vote = now.sig_flow;
      return vote === 1 ? -1 : vote === -1 ? 1 : null;
    },
  },
];

/** Every rule the lab plays: the scorecard's, with No signal's schedules in place of its stand-in. */
export const PLAYED: readonly Rule[] = [...RANDOM_SCHEDULES, ...RULES.filter((r) => r.id !== "random"), ...CANDIDATES];

/** The rules on the scorecard, candidates included. */
export const SCORED: readonly Rule[] = [...RULES, ...CANDIDATES];

/** A rule the trader can follow: a candidate. The ids are also listed in FOLLOWABLE_RULES (lib/engine/trading.ts). */
export function ruleById(id: string): Rule | undefined {
  return SCORED.find((r) => r.id === id);
}

/**
 * A rule's stop and target in NIFTY's typical moves, for volatility exits: the stop as given, and
 * the target at the rule's own target-to-stop ratio (Trend day's 15% and 45% make it 3 stops), else
 * as given.
 */
export function movesFor(rule: Rule | undefined, stopMoves: number, targetMoves: number): { stopMoves: number; targetMoves: number } {
  const e = rule?.exits;
  if (e?.stopPct && e.targetPct) return { stopMoves, targetMoves: (stopMoves * e.targetPct) / e.stopPct };
  return { stopMoves, targetMoves };
}
