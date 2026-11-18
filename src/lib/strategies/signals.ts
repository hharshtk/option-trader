// The signals strategies are built from, defined once. The Pulse page (computePulse), the engine's
// trader and research all read them here, so what the page shows, what is tested and what trades
// are the same rules. Each signal's numbers are settings (SignalParams) a strategy can change.
//
// Two families:
// - The Pulse signals (breadth, lead, momentum) and their combination, "Two or more agree": what the
//   Pulse page scores. Their defaults are the values the page has always used.
// - Well-known strategies' entry rules (PATTERN_SIGNALS): intraday momentum, opening range breakout,
//   a moving-average crossover, Supertrend, RSI reversal and gap fade, with the settings most often
//   published for them. They read NIFTY's own minute bars and never touch the Pulse page.
//
// Pure: closes, bars and breadth in, readings and votes out. A reading at minute t (the minute bar
// that starts t minutes after 09:15, read when it closes) uses data up to t only.

import type { JournalSession, SessionInstrument } from "../engine/protocol.ts";

export type PulseSignalId = "breadth" | "lead" | "momentum";
export type PatternSignalId = "day-momentum" | "opening-range" | "ema-cross" | "supertrend" | "rsi-reversal" | "gap-fade";
/** The Pulse signals, which "Two or more agree" combines. */
export type SingleSignalId = PulseSignalId;
export type SignalId = PulseSignalId | "agree" | PatternSignalId;
export type Vote = -1 | 0 | 1;

/** A strategy's numbers for each signal. */
export interface SignalParams {
  /** Stocks up minus down changed by `stocks` or more over `minutes`. */
  breadth: { minutes: number; stocks: number };
  /** The average stock beat or lagged NIFTY by `bps` basis points (hundredths of a percent) over `minutes`. */
  lead: { minutes: number; bps: number };
  /** NIFTY moved `pct` percent or more over `minutes`. */
  momentum: { minutes: number; pct: number };
  /** At least `min` of the three point the same way, net. */
  agree: { min: number };
  /** At minute `at` after 09:15, follow NIFTY's move from the previous close to the end of its first `firstMinutes`, when at least `minPct`. */
  "day-momentum": { firstMinutes: number; at: number; minPct: number };
  /** Follow the first close beyond the high or low of the first `minutes`, by at least `bufferPct`. */
  "opening-range": { minutes: number; bufferPct: number };
  /** Follow the `fast` average crossing the `slow` one, on `barMinutes`-minute bars. */
  "ema-cross": { fast: number; slow: number; barMinutes: number };
  /** Follow Supertrend (ATR `period`, `multiplier`) turning, on `barMinutes`-minute bars. */
  supertrend: { period: number; multiplier: number; barMinutes: number };
  /** Bet on a bounce when RSI (`period`) climbs back above `low`, or a drop when it falls back below `high`. */
  "rsi-reversal": { period: number; low: number; high: number; barMinutes: number };
  /** At minute `at`, bet against an opening gap between `minPct` and `maxPct`. */
  "gap-fade": { minPct: number; maxPct: number; at: number };
}

export const DEFAULT_SIGNAL_PARAMS: SignalParams = {
  breadth: { minutes: 5, stocks: 6 },
  lead: { minutes: 5, bps: 4 },
  momentum: { minutes: 15, pct: 0.12 },
  agree: { min: 2 },
  // Read at 14:44, the last minute the trader's default entry window (until 14:45) takes.
  "day-momentum": { firstMinutes: 30, at: 329, minPct: 0.05 },
  "opening-range": { minutes: 15, bufferPct: 0.05 },
  "ema-cross": { fast: 9, slow: 21, barMinutes: 5 },
  supertrend: { period: 10, multiplier: 3, barMinutes: 5 },
  "rsi-reversal": { period: 14, low: 30, high: 70, barMinutes: 5 },
  // Read at 09:25, the first minute the trader's default entry window (from 09:25) takes.
  "gap-fade": { minPct: 0.3, maxPct: 1, at: 10 },
};

/** Allowed ranges: [least, most, whole numbers only]. For checking a strategy and for the editor. */
export const SIGNAL_PARAM_LIMITS: { [S in keyof SignalParams]: { [F in keyof SignalParams[S]]: readonly [number, number, boolean] } } = {
  breadth: { minutes: [1, 60, true], stocks: [1, 50, true] },
  lead: { minutes: [1, 60, true], bps: [0.5, 100, false] },
  momentum: { minutes: [1, 120, true], pct: [0.01, 2, false] },
  agree: { min: [1, 3, true] },
  "day-momentum": { firstMinutes: [5, 120, true], at: [10, 360, true], minPct: [0, 3, false] },
  "opening-range": { minutes: [5, 120, true], bufferPct: [0, 1, false] },
  "ema-cross": { fast: [2, 50, true], slow: [3, 100, true], barMinutes: [1, 30, true] },
  supertrend: { period: [3, 50, true], multiplier: [0.5, 10, false], barMinutes: [1, 30, true] },
  "rsi-reversal": { period: [3, 50, true], low: [5, 50, false], high: [50, 95, false], barMinutes: [1, 30, true] },
  "gap-fade": { minPct: [0.05, 3, false], maxPct: [0.1, 5, false], at: [1, 120, true] },
};

/** Fills any signal's missing numbers with the defaults: strategies saved before a signal existed. */
export function withDefaults(params: Partial<{ [S in keyof SignalParams]: Partial<SignalParams[S]> }> | undefined): SignalParams {
  const out = structuredClone(DEFAULT_SIGNAL_PARAMS) as unknown as Record<string, Record<string, number>>;
  for (const [signal, fields] of Object.entries(params ?? {})) {
    if (!out[signal] || !fields || typeof fields !== "object") continue;
    for (const [field, value] of Object.entries(fields)) if (typeof value === "number" && field in out[signal]) out[signal][field] = value;
  }
  return out as unknown as SignalParams;
}

/** What a signal reads: breadth, closes and NIFTY's minute bars, each up to minute t. */
export interface SignalInputs {
  /** Stocks up minus stocks down from their previous close, at the end of minute t. */
  breadth(t: number): number;
  /** The average stock's return over the `h` minutes to t, equal-weighted; null when unknown. */
  basketMove(t: number, h: number): number | null;
  /** NIFTY's return over the `h` minutes to t; null when unknown. */
  indexMove(t: number, h: number): number | null;
  /** NIFTY's last price at the end of minute t. */
  close(t: number): number | null;
  /** NIFTY's open, high, low and close within minute t, when it traded. */
  bar(t: number): readonly [number, number, number, number] | null;
  /** NIFTY's previous official close. */
  reference: number | null;
}

interface SignalDefinition<Id extends string> {
  id: Id;
  name: string;
  /** The rule in a sentence, with the strategy's numbers. */
  rule(params: SignalParams): string;
  /** The value at the close of minute t, or null before there is enough data. */
  read(inputs: SignalInputs, t: number, params: SignalParams): number | null;
  /** A value at least this large (either way) is a vote. */
  threshold(params: SignalParams): number;
  format(value: number, params: SignalParams): string;
}

export type SingleSignal = SignalDefinition<SingleSignalId>;
export type PatternSignal = SignalDefinition<PatternSignalId>;

export const SINGLE_SIGNALS: readonly SingleSignal[] = [
  {
    id: "breadth",
    name: "Breadth thrust",
    rule: (p) => `Stocks up minus down changed by ${p.breadth.stocks} or more over ${p.breadth.minutes} minutes: follow it`,
    read: (s, t, p) => (t >= p.breadth.minutes ? s.breadth(t) - s.breadth(t - p.breadth.minutes) : null),
    threshold: (p) => p.breadth.stocks,
    format: (v, p) => `${v > 0 ? "+" : ""}${v} stocks in ${p.breadth.minutes} min`,
  },
  {
    id: "lead",
    name: "Basket leads index",
    rule: (p) => `The average stock beat NIFTY by ${p.lead.bps} bps or more over ${p.lead.minutes} minutes: NIFTY follows the average stock`,
    read: (s, t, p) => {
      const h = p.lead.minutes;
      if (t < h) return null;
      const a = s.basketMove(t, h);
      const b = s.indexMove(t, h);
      return a === null || b === null ? null : (a - b) * 10_000;
    },
    threshold: (p) => p.lead.bps,
    format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} bps vs NIFTY`,
  },
  {
    id: "momentum",
    name: "15-minute momentum",
    rule: (p) => `NIFTY moved ${p.momentum.pct}% or more over ${p.momentum.minutes} minutes: follow it`,
    read: (s, t, p) => (t >= p.momentum.minutes ? s.indexMove(t, p.momentum.minutes) : null),
    threshold: (p) => p.momentum.pct / 100,
    format: (v, p) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(2)}% in ${p.momentum.minutes} min`,
  },
];

const NUMBER_WORDS = ["none", "one", "two", "three"];

export const AGREE = {
  id: "agree" as const,
  name: "Two or more agree",
  rule: (p: SignalParams) =>
    p.agree.min === 2
      ? "At least two of the signals above point the same way and none the other: follow them"
      : `At least ${NUMBER_WORDS[p.agree.min] ?? p.agree.min} more of the signals above point one way than the other: follow them`,
};

/** "09:15" plus `minutes`, as a clock time. */
export function clockAt(minutes: number): string {
  const total = 9 * 60 + 15 + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** True when an `n`-minute bar (counted from 09:15) closes with minute t. */
const barEndsAt = (t: number, n: number) => (t + 1) % n === 0;

/** The whole `n`-minute bars from 09:15 up to the one ending with minute t, from NIFTY's minute bars. */
function barsTo(s: SignalInputs, t: number, n: number): Bar[] {
  const out: Bar[] = [];
  for (let b = 0; b < Math.floor((t + 1) / n); b += 1) {
    let bar: Bar | null = null;
    for (let m = b * n; m < b * n + n; m += 1) {
      const minute = s.bar(m);
      if (!minute) continue;
      if (!bar) bar = { open: minute[0], high: minute[1], low: minute[2], close: minute[3] };
      else {
        bar.high = Math.max(bar.high, minute[1]);
        bar.low = Math.min(bar.low, minute[2]);
        bar.close = minute[3];
      }
    }
    if (bar) out.push(bar);
  }
  return out;
}

function ema(values: readonly number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  for (let i = 0; i < values.length; i += 1) out.push(i === 0 ? values[0] : values[i] * k + out[i - 1] * (1 - k));
  return out;
}

/** Wilder's RSI for every bar from `period` on (earlier bars are NaN). */
function rsi(closes: readonly number[], period: number): number[] {
  const out = new Array<number>(closes.length).fill(Number.NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = closes[i] - closes[i - 1];
    gain += Math.max(0, change);
    loss += Math.max(0, -change);
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(0, change)) / period;
    loss = (loss * (period - 1) + Math.max(0, -change)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Supertrend's direction for every bar from `period` on: 1 up, −1 down, 0 before it starts. */
function supertrendDirections(bars: readonly Bar[], period: number, multiplier: number): Vote[] {
  const directions: Vote[] = new Array(bars.length).fill(0);
  if (bars.length <= period) return directions;
  const ranges = bars.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
  let atr = ranges.slice(1, period + 1).reduce((a, r) => a + r, 0) / period;
  let upper = Number.POSITIVE_INFINITY;
  let lower = Number.NEGATIVE_INFINITY;
  let direction: Vote = 1;
  for (let i = period; i < bars.length; i += 1) {
    if (i > period) atr = (atr * (period - 1) + ranges[i]) / period;
    const middle = (bars[i].high + bars[i].low) / 2;
    const basicUpper = middle + multiplier * atr;
    const basicLower = middle - multiplier * atr;
    const previousClose = bars[i - 1].close;
    upper = basicUpper < upper || previousClose > upper ? basicUpper : upper;
    lower = basicLower > lower || previousClose < lower ? basicLower : lower;
    if (direction === 1 && bars[i].close < lower) direction = -1;
    else if (direction === -1 && bars[i].close > upper) direction = 1;
    directions[i] = direction;
  }
  return directions;
}

const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

/** Well-known strategies' entry rules, with the settings most often published for them. */
export const PATTERN_SIGNALS: readonly PatternSignal[] = [
  {
    id: "day-momentum",
    name: "Intraday momentum",
    rule: (p) =>
      `At ${clockAt(p["day-momentum"].at)}, follow NIFTY's move from the previous close to ${clockAt(p["day-momentum"].firstMinutes)} when it is at least ${p["day-momentum"].minPct}%`,
    read: (s, t, p) => {
      const q = p["day-momentum"];
      if (t + 1 !== q.at || t < q.firstMinutes - 1) return null;
      const early = s.close(q.firstMinutes - 1);
      return early === null || s.reference === null ? null : (early / s.reference - 1) * 100;
    },
    threshold: (p) => p["day-momentum"].minPct,
    format: (v, p) => `${pct(v)} by ${clockAt(p["day-momentum"].firstMinutes)}`,
  },
  {
    id: "opening-range",
    name: "Opening range breakout",
    rule: (p) => `Follow the first close above the high or below the low of the first ${p["opening-range"].minutes} minutes, by at least ${p["opening-range"].bufferPct}%`,
    read: (s, t, p) => {
      const { minutes, bufferPct } = p["opening-range"];
      if (t < minutes) return null;
      let high = Number.NEGATIVE_INFINITY;
      let low = Number.POSITIVE_INFINITY;
      for (let m = 0; m < minutes; m += 1) {
        const bar = s.bar(m);
        if (bar) {
          high = Math.max(high, bar[1]);
          low = Math.min(low, bar[2]);
        }
      }
      if (!Number.isFinite(high)) return null;
      const up = high * (1 + bufferPct / 100);
      const down = low * (1 - bufferPct / 100);
      // Only the first break of the day counts.
      for (let m = minutes; m <= t; m += 1) {
        const close = s.close(m);
        if (close === null || (close <= up && close >= down)) continue;
        return m === t ? (close > up ? (close / high - 1) * 100 : (close / low - 1) * 100) : 0;
      }
      return 0;
    },
    threshold: () => 1e-9,
    format: (v) => (v > 0 ? `broke above the opening range, ${pct(v)}` : v < 0 ? `broke below the opening range, ${pct(v)}` : "no new break"),
  },
  {
    id: "ema-cross",
    name: "Moving-average crossover",
    rule: (p) => `Follow the ${p["ema-cross"].fast}-bar average crossing the ${p["ema-cross"].slow}-bar average, on ${p["ema-cross"].barMinutes}-minute bars`,
    read: (s, t, p) => {
      const { fast, slow, barMinutes } = p["ema-cross"];
      if (!barEndsAt(t, barMinutes)) return null;
      const closes = barsTo(s, t, barMinutes).map((b) => b.close);
      if (closes.length < slow + 1 || fast >= slow) return null;
      const f = ema(closes, fast);
      const w = ema(closes, slow);
      const now = f.at(-1)! - w.at(-1)!;
      const before = f.at(-2)! - w.at(-2)!;
      return before <= 0 && now > 0 ? 1 : before >= 0 && now < 0 ? -1 : 0;
    },
    threshold: () => 0.5,
    format: (v) => (v > 0 ? "fast average crossed above the slow one" : v < 0 ? "fast average crossed below the slow one" : "no cross"),
  },
  {
    id: "supertrend",
    name: "Supertrend",
    rule: (p) => `Follow Supertrend (${p.supertrend.period}, ${p.supertrend.multiplier}) turning up or down, on ${p.supertrend.barMinutes}-minute bars`,
    read: (s, t, p) => {
      const { period, multiplier, barMinutes } = p.supertrend;
      if (!barEndsAt(t, barMinutes)) return null;
      const directions = supertrendDirections(barsTo(s, t, barMinutes), period, multiplier);
      if (directions.length < period + 2 || directions.at(-2) === 0) return null;
      return directions.at(-1) !== directions.at(-2) ? directions.at(-1)! : 0;
    },
    threshold: () => 0.5,
    format: (v) => (v > 0 ? "turned up" : v < 0 ? "turned down" : "no turn"),
  },
  {
    id: "rsi-reversal",
    name: "RSI reversal",
    rule: (p) => {
      const q = p["rsi-reversal"];
      return `Bet on a bounce when RSI (${q.period}) climbs back above ${q.low}, and on a drop when it falls back below ${q.high}, on ${q.barMinutes}-minute bars`;
    },
    read: (s, t, p) => {
      const { period, low, high, barMinutes } = p["rsi-reversal"];
      if (!barEndsAt(t, barMinutes)) return null;
      const values = rsi(barsTo(s, t, barMinutes).map((b) => b.close), period);
      const now = values.at(-1);
      const before = values.at(-2);
      if (now === undefined || before === undefined || Number.isNaN(now) || Number.isNaN(before)) return null;
      return before < low && now >= low ? 1 : before > high && now <= high ? -1 : 0;
    },
    threshold: () => 0.5,
    format: (v, p) => (v > 0 ? `RSI back above ${p["rsi-reversal"].low}` : v < 0 ? `RSI back below ${p["rsi-reversal"].high}` : "no reversal"),
  },
  {
    id: "gap-fade",
    name: "Gap fade",
    rule: (p) => {
      const q = p["gap-fade"];
      return `At ${clockAt(q.at)}, bet against an opening gap of ${q.minPct}% to ${q.maxPct}% from the previous close`;
    },
    read: (s, t, p) => {
      const { minPct, maxPct, at } = p["gap-fade"];
      if (t + 1 !== at) return null;
      const open = s.bar(0)?.[0] ?? null;
      if (open === null || s.reference === null) return null;
      const gap = (open / s.reference - 1) * 100;
      // Against the gap: a gap up is a bet down.
      return Math.abs(gap) < minPct || Math.abs(gap) > maxPct ? 0 : -gap;
    },
    threshold: (p) => p["gap-fade"].minPct,
    format: (v) => (v === 0 ? "no gap to fade" : `opened ${pct(-v)} from the previous close: bet ${v > 0 ? "up" : "down"}`),
  },
];

/** Every signal a strategy can follow, with its name: the Pulse three, their combination, then the patterns. */
export const SIGNALS: readonly { id: SignalId; name: string }[] = [
  ...SINGLE_SIGNALS.map(({ id, name }) => ({ id, name })),
  { id: AGREE.id, name: AGREE.name },
  ...PATTERN_SIGNALS.map(({ id, name }) => ({ id, name })),
];

export const isPattern = (id: SignalId): id is PatternSignalId => PATTERN_SIGNALS.some((s) => s.id === id);

export const voteOf = (value: number | null, threshold: number): Vote => (value === null || Math.abs(value) < threshold ? 0 : value > 0 ? 1 : -1);

/** The combined vote: long when at least `min` more singles vote long than short, and the reverse. */
export function agreeOf(votes: readonly Vote[], params: SignalParams): Vote {
  const sum = votes.reduce<number>((a, v) => a + v, 0);
  return sum >= params.agree.min ? 1 : sum <= -params.agree.min ? -1 : 0;
}

export interface Reading {
  /** Each Pulse signal's value and vote, in SINGLE_SIGNALS order. */
  values: (number | null)[];
  votes: Vote[];
  agree: Vote;
}

/** The Pulse signals and their combination at the close of minute t. */
export function readAt(inputs: SignalInputs, t: number, params: SignalParams): Reading {
  const values = SINGLE_SIGNALS.map((s) => s.read(inputs, t, params));
  const votes = SINGLE_SIGNALS.map((s, i) => voteOf(values[i], s.threshold(params)));
  return { values, votes, agree: agreeOf(votes, params) };
}

/** The vote of a Pulse signal or of "Two or more agree" in a reading. */
export function voteIn(reading: Reading, signal: SingleSignalId | "agree"): Vote {
  if (signal === "agree") return reading.agree;
  return reading.votes[SINGLE_SIGNALS.findIndex((s) => s.id === signal)];
}

/** Any signal's value, vote and words at the close of minute t. */
export function readSignalAt(inputs: SignalInputs, t: number, signal: SignalId, params: SignalParams): { value: number | null; vote: Vote; text: string } {
  if (isPattern(signal)) {
    const definition = PATTERN_SIGNALS.find((s) => s.id === signal)!;
    const value = definition.read(inputs, t, params);
    return { value, vote: voteOf(value, definition.threshold(params)), text: value === null ? "—" : definition.format(value, params) };
  }
  const reading = readAt(inputs, t, params);
  if (signal === "agree") return { value: reading.votes.reduce<number>((a, v) => a + v, 0), vote: reading.agree, text: "" };
  const index = SINGLE_SIGNALS.findIndex((s) => s.id === signal);
  const value = reading.values[index];
  return { value, vote: reading.votes[index], text: value === null ? "—" : SINGLE_SIGNALS[index].format(value, params) };
}

/** A constituent as signals and Pulse take it: its feed key (and, for Pulse, more). */
export interface SignalConstituent {
  key: string;
}

/**
 * The inputs from a journal day (or one rebuilt from candles), exactly as computePulse builds them:
 * breadth from the session's minutes, the basket from the constituents that have a previous close
 * and a price, NIFTY from the session's benchmark.
 */
export function sessionInputs(session: JournalSession, constituents: readonly SignalConstituent[], benchmark = session.benchmark): SignalInputs | null {
  const index = session.instruments.find((i) => i.key === benchmark);
  if (!index) return null;
  const idx = index.closes;
  const byKey = new Map(session.instruments.map((i) => [i.key, i]));
  const stocks = constituents.map((c) => byKey.get(c.key)).filter((s): s is SessionInstrument => !!s && s.reference !== null && s.ltp !== null);
  return {
    breadth: (t) => session.minutes[t].advancers - session.minutes[t].decliners,
    basketMove: (t, h) => {
      let sum = 0;
      let n = 0;
      for (const s of stocks) {
        const a = s.closes[t];
        const b = s.closes[t - h];
        if (a != null && b != null) {
          sum += a / b - 1;
          n += 1;
        }
      }
      return n ? sum / n : null;
    },
    indexMove: (t, h) => (idx[t] != null && idx[t - h] != null ? idx[t]! / idx[t - h]! - 1 : null),
    close: (t) => idx[t] ?? null,
    bar: (t) => session.minutes[t]?.bar ?? null,
    reference: index.reference,
  };
}
