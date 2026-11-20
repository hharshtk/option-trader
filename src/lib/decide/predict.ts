// The prediction scoreboard: every predictor graded on every minute of every recorded day, not
// only on the minutes it traded. Step 1 of the Predict and Grade phase (docs/roadmap.md).
//
// For each minute up to 14:59 the outcome is what followed over the next HORIZON minutes:
//   - NIFTY's move, in points;
//   - what one lot of the at-the-money call, and of the put, bought at that minute's close and
//     sold HORIZON minutes later made after Dhan's charges, with the lab's own entry and exit
//     prices (lib/decide/simulate.ts `entryAt`, `exitPrice`). No stop, no target: the prediction
//     is graded, not a trading plan.
// Outcomes never cross 15:15, where the closing auction starts and NIFTY stops trading.
//
// A predictor makes a call (+1 up, −1 down) or says nothing at each minute. Its call is right when
// NIFTY then moved its way, and it pays when the option on its side made money after charges.
// The bars: a coin flip (the average of the call and the put at the same minutes), and "NIFTY
// keeps going the way it has since the open". Pure: a day in, outcomes and calls out.

import { SIGNALS } from "../engine/trading.ts";
import { roundTripCharges } from "../trading/charges.ts";
import { CANDIDATES } from "./rules.ts";
import { entryAt, exitPrice, type DayData, type MinuteQuote } from "./simulate.ts";
import type { MinuteState } from "./state.ts";

/** Minutes ahead a prediction is graded on. */
export const HORIZON = 15;
/** 15:15 in minutes since 09:15: the closing auction. No outcome reaches it. */
export const AUCTION_MINUTE = 360;

/** What followed one minute. Rupees are one lot, after charges; null when the option couldn't be bought or sold. */
export interface Outcome {
  t: number;
  /** NIFTY's points from this minute's close to HORIZON minutes later. */
  move: number;
  call: number | null;
  put: number | null;
}

/** One predictor's call at one minute. */
export interface Call {
  predictor: string;
  t: number;
  vote: 1 | -1;
}

export interface Predictor {
  id: string;
  name: string;
  /** What it calls on, in a sentence. */
  idea: string;
  kind: "bar" | "signal" | "rule";
  /** The first day that tests it, for a rule written with earlier days seen. */
  since?: string;
  call(now: MinuteState, before: readonly MinuteState[]): 1 | -1 | null;
}

/** The coin flip has no calls: its row is the average of the call and the put at every graded minute. */
export const COIN = "coin";

/** Every predictor on the scoreboard, bars first. */
export const PREDICTORS: readonly Predictor[] = [
  {
    id: COIN,
    name: "Coin flip",
    idea: "No prediction: half a call and half a put at every minute. What guessing earns; every predictor must beat it.",
    kind: "bar",
    call: () => null,
  },
  {
    id: "trend-open",
    name: "Keeps going since the open",
    idea: "Calls NIFTY to keep going the way it has gone since the open: up when it is above its open, down when below.",
    kind: "bar",
    call: (now) => (now.nifty_from_open === null || now.nifty_from_open === 0 ? null : now.nifty_from_open > 0 ? 1 : -1),
  },
  ...SIGNALS.map(
    (s): Predictor => ({
      id: `signal:${s.id}`,
      name: s.name,
      idea: `The Pulse signal "${s.name}": its long vote calls up, its short vote down.`,
      kind: "signal",
      call: (now) => {
        const vote = now[`sig_${s.id}`];
        return vote === 1 ? 1 : vote === -1 ? -1 : null;
      },
    }),
  ),
  // A rule calls inside its own entry window; its daily cap is a trading limit, not a prediction one.
  ...CANDIDATES.map(
    (r): Predictor => ({
      id: r.id,
      name: r.name,
      idea: r.idea,
      kind: "rule",
      since: r.since,
      call: (now, before) => (r.window && (now.t < r.window.from || now.t > r.window.until) ? null : r.decide(now, before)),
    }),
  ),
];

/** The outcome of every minute that has one: a state now and HORIZON minutes later, before the auction. */
export function outcomes(day: DayData, horizon = HORIZON): Outcome[] {
  const out: Outcome[] = [];
  for (const now of day.states) {
    if (!now || now.nifty === null || now.t + horizon >= AUCTION_MINUTE) continue;
    const later = day.states[now.t + horizon];
    if (!later || later.nifty === null) continue;
    out.push({
      t: now.t,
      move: round(later.nifty - now.nifty),
      call: optionNet(day, now.t, horizon, now.nifty, "CE"),
      put: optionNet(day, now.t, horizon, now.nifty, "PE"),
    });
  }
  return out;
}

/** One lot of the at-the-money option bought at minute `t`'s close and sold `horizon` minutes later, after charges. */
function optionNet(day: DayData, t: number, horizon: number, spot: number, type: "CE" | "PE"): number | null {
  const found = entryAt(day.quotes[t], spot, type);
  if ("skip" in found) return null;
  const { quote, buy } = found.entry;
  const later = latestQuote(day, quote.key, t + horizon, t);
  if (!later) return null;
  const sell = exitPrice(later);
  const quantity = quote.lotSize;
  return round((sell - buy) * quantity - roundTripCharges(buy * quantity, sell * quantity).total);
}

/** The contract's quote at minute `t`, else its latest after `after`. */
function latestQuote(day: DayData, key: string, t: number, after: number): MinuteQuote | null {
  for (let k = t; k > after; k -= 1) {
    const q = day.quotes[k]?.find((x) => x.key === key);
    if (q) return q;
  }
  return null;
}

/** Every predictor's calls over a day, in minute order, each seeing only the minutes up to its own. */
export function calls(day: DayData, predictors: readonly Predictor[] = PREDICTORS): Call[] {
  const out: Call[] = [];
  const before: MinuteState[] = [];
  for (const now of day.states) {
    if (!now) continue;
    for (const p of predictors) {
      const vote = p.call(now, before);
      if (vote !== null) out.push({ predictor: p.id, t: now.t, vote });
    }
    before.push(now);
  }
  return out;
}

/** One predictor's record on one day, or over its tested days. */
export interface Tally {
  /** Minutes it made a call that have an outcome. */
  calls: number;
  /** Calls after which NIFTY moved its way. */
  right: number;
  /**
   * Calls where both options could be bought and sold, and how many of those its option made money
   * after charges. For the coin flip, half a call and half a put: the share of single random trades that paid.
   */
  priced: number;
  paid: number;
  /** Average rupees a call, one lot, after charges; and a coin flip's at the same minutes. */
  perCall: number | null;
  coin: number | null;
}

export interface PredictionRow extends Tally {
  id: string;
  name: string;
  idea: string;
  kind: Predictor["kind"];
  since: string | null;
  /** Rupees a call above (or below) a coin flip at the same minutes. */
  vsCoin: number | null;
  /** Tested days it made priced calls on, and how many of them it beat the coin flip. */
  daysCalled: number;
  daysAhead: number;
  /** Every graded day, tested or not. */
  byDay: (Tally & { date: string; tested: boolean })[];
}

/** The scoreboard: what the engine serves at `GET /v1/predictions`. */
export interface PredictionView {
  horizon: number;
  /** Graded days, oldest first, with NIFTY's move from the first minute to 15:14 for context. */
  days: { date: string; minutes: number; niftyMove: number | null }[];
  rows: PredictionRow[];
  /** A build running now, or the last one's outcome (the decision lab's). */
  build: { state: "idle" | "running" | "failed"; at: number | null; message: string | null };
}

/** Grades every predictor from the stored outcomes and calls of each day. */
export function scoreboard(days: readonly { date: string; outcomes: readonly Outcome[]; calls: readonly Call[] }[]): PredictionRow[] {
  return PREDICTORS.map((p) => {
    const tested = (date: string) => !p.since || date >= p.since;
    const graded = days.map((d) => ({ date: d.date, graded: gradedCalls(p.id, d.outcomes, d.calls) }));
    const byDay = graded.map(({ date, graded: g }) => ({ date, tested: tested(date), ...tally(g) }));
    const total = tally(graded.filter((d) => tested(d.date)).flatMap((d) => d.graded));
    const counted = byDay.filter((d) => d.tested && d.perCall !== null && d.coin !== null);
    return {
      id: p.id,
      name: p.name,
      idea: p.idea,
      kind: p.kind,
      since: p.since ?? null,
      ...total,
      vsCoin: p.id === COIN || total.perCall === null || total.coin === null ? null : round(total.perCall - total.coin),
      daysCalled: p.id === COIN ? 0 : counted.length,
      daysAhead: p.id === COIN ? 0 : counted.filter((d) => d.perCall! > d.coin!).length,
      byDay,
    };
  });
}

/** A predictor's calls that have an outcome; the coin flip "calls" every minute where both options were priced, with vote 0. */
function gradedCalls(id: string, outs: readonly Outcome[], all: readonly Call[]): { o: Outcome; vote: 1 | -1 | 0 }[] {
  if (id === COIN) return outs.filter((o) => o.call !== null && o.put !== null).map((o) => ({ o, vote: 0 as const }));
  const at = new Map(outs.map((o) => [o.t, o]));
  return all.filter((c) => c.predictor === id && at.has(c.t)).map((c) => ({ o: at.get(c.t)!, vote: c.vote }));
}

/** A set of graded calls as a tally. Vote 0 is the coin flip: half a call, half a put. */
function tally(graded: readonly { o: Outcome; vote: 1 | -1 | 0 }[]): Tally {
  let right = 0;
  let priced = 0;
  let paid = 0;
  let net = 0;
  let coin = 0;
  for (const { o, vote } of graded) {
    if (vote !== 0 && o.move * vote > 0) right += 1;
    const mine = vote === 1 ? o.call : vote === -1 ? o.put : o.call !== null && o.put !== null ? (o.call + o.put) / 2 : null;
    if (mine === null || o.call === null || o.put === null) continue;
    priced += 1;
    paid += vote === 0 ? ((o.call > 0 ? 1 : 0) + (o.put > 0 ? 1 : 0)) / 2 : mine > 0 ? 1 : 0;
    net += mine;
    coin += (o.call + o.put) / 2;
  }
  return {
    calls: graded.length,
    right,
    priced,
    paid: round(paid),
    perCall: priced ? round(net / priced) : null,
    coin: priced ? round(coin / priced) : null,
  };
}

const round = (value: number) => Math.round(value * 100) / 100;
