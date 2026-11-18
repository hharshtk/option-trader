// A signal study's core: each day's votes from the strategy store's signals (the code the engine
// trades), the firings they make and what NIFTY did next, and the measurements over all of them.
// Pure: frames in, rows out.

import { DEFAULT_SIGNAL_PARAMS, isPattern, readAt, readSignalAt, sessionInputs, voteIn, type SignalParams, type SingleSignalId } from "../strategies/signals.ts";
import { NIFTY_CONSTITUENTS, SESSION_MINUTES, type DayFrame } from "./day-frames.ts";
import { measure, verdictOf, type Measured } from "./stats.ts";
import type { DailyRow, EventRow, SignalId, SliceKind, StudySpec, SummaryRow } from "./types.ts";

const MINUTE_MS = 60_000;
const IST_MS = 5.5 * 3_600_000;

/** Minutes from 09:15 to an "HH:MM" IST clock time. */
const minutesFromOpen = (clock: string) => {
  const [h, m] = clock.split(":").map(Number);
  return h * 60 + m - (9 * 60 + 15);
};

/**
 * The minute bars whose firings fall in the entry window. The trader reads a minute's signals
 * when it closes (plus 1.5 s) and enters from `from` up to, not including, `until`: so 09:25–14:45
 * means the bars that start at 09:24 through 14:43.
 */
export function windowBars(window: StudySpec["window"]): { first: number; last: number } {
  return { first: Math.max(0, minutesFromOpen(window.from) - 1), last: Math.min(SESSION_MINUTES - 1, minutesFromOpen(window.until) - 2) };
}

/**
 * Each signal's vote at the close of every minute of the day, with the strategy's numbers (the
 * defaults otherwise): the same definitions computePulse and the trader read.
 */
export function dayVotes(frame: DayFrame, params: SignalParams = DEFAULT_SIGNAL_PARAMS, signals: readonly SignalId[] = ["breadth", "lead", "momentum", "agree"]): Partial<Record<SignalId, Int8Array>> | null {
  const inputs = sessionInputs(frame.session, NIFTY_CONSTITUENTS);
  if (!inputs) return null;
  const n = frame.session.minutes.length;
  const votes: Partial<Record<SignalId, Int8Array>> = {};
  for (const signal of signals) votes[signal] = new Int8Array(n);
  const pulse = signals.filter((s) => !isPattern(s));
  const patterns = signals.filter(isPattern);
  for (let t = 0; t < n; t += 1) {
    if (pulse.length) {
      const reading = readAt(inputs, t, params);
      for (const signal of pulse) votes[signal]![t] = voteIn(reading, signal as SingleSignalId | "agree");
    }
    for (const signal of patterns) votes[signal]![t] = readSignalAt(inputs, t, signal, params).vote;
  }
  return votes;
}

/**
 * The firings of one signal at one holding time on one day. After a firing the next `horizon`
 * minutes are skipped (one position at a time), and a firing counts only when its exit is a
 * price anyone could trade: before 15:15 on closing-auction days.
 */
export function firings(frame: DayFrame, votes: Int8Array, horizon: number, window: StudySpec["window"]): Omit<EventRow, "study" | "signal" | "horizon">[] {
  const { first, last } = windowBars(window);
  const lastExit = frame.rules.continuousMinutes - 1;
  const out: Omit<EventRow, "study" | "signal" | "horizon">[] = [];
  for (let t = first; t <= last && t < votes.length; ) {
    const vote = votes[t];
    const entry = frame.nifty[t];
    const exit = t + horizon <= lastExit ? frame.nifty[t + horizon] : null;
    if (vote !== 0 && entry != null && exit != null) {
      out.push({ day: frame.date, at: frame.open + t * MINUTE_MS, vote, entry, exit, points: round(vote * (exit - entry)), vix: frame.vix[t] });
      t += horizon;
    } else t += 1;
  }
  return out;
}

/** NIFTY's move over `horizon` from every minute in the window: the drift a signal has to beat. */
export function drift(frame: DayFrame, horizon: number, window: StudySpec["window"]): { sum: number; count: number } {
  const { first, last } = windowBars(window);
  const lastExit = frame.rules.continuousMinutes - 1;
  let sum = 0;
  let count = 0;
  for (let t = first; t <= last && t + horizon <= lastExit; t += 1) {
    const a = frame.nifty[t];
    const b = frame.nifty[t + horizon];
    if (a != null && b != null) {
      sum += b - a;
      count += 1;
    }
  }
  return { sum, count };
}

/** Accumulates a study day by day, then summarises. Memory grows with firings, not with candles. */
export class StudyAccumulator {
  readonly events: EventRow[] = [];
  private readonly drifts = new Map<number, { sum: number; count: number }>();
  readonly days: string[] = [];
  private readonly auction = new Map<string, boolean>();
  private niftyCloses: number[] = [];
  private readonly spec: StudySpec;
  private readonly id: string;

  constructor(spec: StudySpec, id: string) {
    this.spec = spec;
    this.id = id;
  }

  add(frame: DayFrame, votes: Partial<Record<SignalId, Int8Array>>) {
    this.days.push(frame.date);
    this.auction.set(frame.date, frame.rules.auction);
    const close = frame.nifty.findLast((c) => c !== null);
    if (close != null) this.niftyCloses.push(close);
    for (const signal of this.spec.signals) {
      for (const horizon of this.spec.horizons) {
        const own = votes[signal];
        if (!own) continue;
        for (const event of firings(frame, own, horizon, this.spec.window)) this.events.push({ study: this.id, signal, horizon, ...event });
      }
    }
    for (const horizon of this.spec.horizons) {
      const d = drift(frame, horizon, this.spec.window);
      const total = this.drifts.get(horizon) ?? { sum: 0, count: 0 };
      total.sum += d.sum;
      total.count += d.count;
      this.drifts.set(horizon, total);
    }
  }

  /** The median daily NIFTY close over the study: the price futures charges are computed at. */
  medianNifty(): number {
    const sorted = [...this.niftyCloses].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  }

  daily(): DailyRow[] {
    const rows = new Map<string, DailyRow>();
    for (const e of this.events) {
      const key = `${e.signal}|${e.horizon}|${e.day}`;
      const row = rows.get(key) ?? { study: this.id, signal: e.signal, horizon: e.horizon, day: e.day, firings: 0, points: 0 };
      row.firings += 1;
      row.points = round(row.points + e.points);
      rows.set(key, row);
    }
    return [...rows.values()];
  }

  summary(optionCost: number, futuresCost: number): SummaryRow[] {
    const rows: SummaryRow[] = [];
    const sorted = [...this.days].sort();
    // The last 30% of days: the later part of the period, held against the rest.
    const holdoutFrom = sorted[Math.floor(sorted.length * 0.7)] ?? "9999";
    const vixBand = (vix: number | null) => (vix === null ? "Unknown" : vix < 12 ? "VIX under 12" : vix < 16 ? "VIX 12–16" : "VIX 16 and over");
    const timeBand = (at: number) => {
      const clock = new Date(at + IST_MS).toISOString().slice(11, 16);
      return clock < "11:00" ? "Before 11:00" : clock < "13:30" ? "11:00–13:30" : "After 13:30";
    };
    const slicers: [SliceKind, (e: EventRow) => string][] = [
      ["all", () => "All"],
      ["month", (e) => e.day.slice(0, 7)],
      ["era", (e) => (this.auction.get(e.day) ? "With closing auction" : "Before closing auction")],
      ["time", (e) => timeBand(e.at)],
      ["vix", (e) => vixBand(e.vix)],
      ["side", (e) => (e.vote > 0 ? "Long" : "Short")],
      ["split", (e) => (e.day >= holdoutFrom ? "Last 30% of days" : "First 70% of days")],
    ];
    for (const signal of this.spec.signals) {
      for (const horizon of this.spec.horizons) {
        const events = this.events.filter((e) => e.signal === signal && e.horizon === horizon);
        const holdout = measure(events.filter((e) => e.day >= holdoutFrom), optionCost, futuresCost);
        const d = this.drifts.get(horizon);
        const baseline = d && d.count ? round(d.sum / d.count) : null;
        for (const [kind, sliceOf] of slicers) {
          const groups = new Map<string, EventRow[]>();
          for (const e of events) {
            const slice = sliceOf(e);
            const list = groups.get(slice) ?? [];
            list.push(e);
            groups.set(slice, list);
          }
          if (kind === "all" && groups.size === 0) groups.set("All", []);
          for (const [slice, list] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            const m = measure(list, optionCost, futuresCost);
            rows.push(summaryRow(this.id, signal, horizon, kind, slice, m, baseline, verdictOf(m, optionCost, kind === "all" ? holdout : null)));
          }
        }
      }
    }
    return rows;
  }
}

function summaryRow(study: string, signal: SignalId, horizon: number, kind: SliceKind, slice: string, m: Measured, baseline: number | null, verdict: SummaryRow["verdict"]): SummaryRow {
  return {
    study,
    signal,
    horizon,
    slice_kind: kind,
    slice,
    firings: m.firings,
    days: m.days,
    hits: m.hits,
    hit_rate: roundOrNull(m.hitRate, 4),
    hit_lo: roundOrNull(m.hitRange?.[0] ?? null, 4),
    hit_hi: roundOrNull(m.hitRange?.[1] ?? null, 4),
    mean: roundOrNull(m.mean),
    lo: roundOrNull(m.range?.[0] ?? null),
    hi: roundOrNull(m.range?.[1] ?? null),
    net_option: roundOrNull(m.netOption),
    net_futures: roundOrNull(m.netFutures),
    baseline,
    verdict,
  };
}

/** Rounded so results hash the same on every machine. */
export const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const roundOrNull = (value: number | null, places = 3) => (value === null ? null : round(value, places));
