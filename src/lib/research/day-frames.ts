// One trading day rebuilt from 1-minute candles in the shape the engine's journal gives
// computePulse(), so research runs the exact signal code the engine trades. Checked against the
// journal: on 16 and 17 November 2026 the votes match on 99–100% of minutes (day-frames.test.ts).
//
// What makes it match:
// - Each minute's close is the last price at the minute's end, carried forward through minutes
//   with no trade, as the journal's closes are.
// - Changes are measured from the official previous close (daily bars), not the last minute
//   candle: since the closing auction the two differ for almost every stock.
// - Breadth counts a fixed list of stocks, recorded in the study, not whatever the feed held.
//
// Pure: candles and closes in, sessions out.

import type { JournalSession, SessionInstrument, SessionMinute } from "../engine/protocol.ts";
import { INDEX_CONSTITUENTS } from "../index-constituents.ts";
import type { PulseConstituent } from "../insight/pulse.ts";

export const NIFTY_KEY = "IDX_I:13";
export const VIX_KEY = "IDX_I:21";
const MINUTE_MS = 60_000;
/** 09:15 to 15:29: the minutes of an NSE session, each stamped with its start. */
export const SESSION_MINUTES = 375;
/** Fewer NIFTY minutes than this is a special session (Muhurat) or a broken day: left out. */
export const MIN_SESSION_MINUTES = 300;

/**
 * NSE's closing auction for stocks began on this day: from it, stocks trade continuously until
 * 15:15 only, and the index holds flat until the auction price lands at about 15:28. Seen in the
 * minute history: stock candles end at 15:29 until 31 July 2026 and at 15:14 from 3 August.
 */
export const CLOSING_AUCTION_FROM = "2026-08-03";

/** NIFTY's stocks as Pulse takes them: the same list the Pulse page and the engine's trader build. */
export const NIFTY_CONSTITUENTS: readonly PulseConstituent[] = INDEX_CONSTITUENTS.NIFTY.map((c) => ({
  key: `NSE_EQ:${c.securityId}`,
  symbol: c.symbol,
  sector: c.sector,
  prior: c.mcapShare,
}));

export interface SessionRules {
  /** True on days with the closing auction. */
  auction: boolean;
  /** Minutes from 09:15 whose index close is a price anyone could trade: 360 with the auction, 375 before. */
  continuousMinutes: number;
}

export function sessionRules(date: string): SessionRules {
  const auction = date >= CLOSING_AUCTION_FROM;
  return { auction, continuousMinutes: auction ? 360 : SESSION_MINUTES };
}

/** One month of candles, column by column; `k` indexes `keys`. Rows in any order. */
export interface CandleColumns {
  keys: readonly string[];
  k: ArrayLike<number>;
  t: ArrayLike<number>;
  open: ArrayLike<number>;
  high: ArrayLike<number>;
  low: ArrayLike<number>;
  close: ArrayLike<number>;
}

/** Official closes by instrument and day, for the previous close. */
export class DailyCloses {
  private readonly byKey = new Map<string, { dates: string[]; closes: number[] }>();

  constructor(rows: Iterable<{ key: string; date: string; close: number }>) {
    const grouped = new Map<string, [string, number][]>();
    for (const row of rows) {
      const list = grouped.get(row.key) ?? [];
      list.push([row.date, row.close]);
      grouped.set(row.key, list);
    }
    for (const [key, list] of grouped) {
      list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      this.byKey.set(key, { dates: list.map((x) => x[0]), closes: list.map((x) => x[1]) });
    }
  }

  /** The last official close strictly before `date`, or null. */
  before(key: string, date: string): number | null {
    const series = this.byKey.get(key);
    if (!series) return null;
    let lo = 0;
    let hi = series.dates.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series.dates[mid] < date) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found === -1 ? null : series.closes[found];
  }

  /** The last day held for any instrument. */
  get lastDate(): string | null {
    let last: string | null = null;
    for (const { dates } of this.byKey.values()) if (dates.length && (last === null || dates.at(-1)! > last)) last = dates.at(-1)!;
    return last;
  }
}

export interface DayFrame {
  date: string;
  /** 09:15 IST, epoch ms. */
  open: number;
  rules: SessionRules;
  /** What computePulse() reads, as the journal would give it for the whole day. */
  session: JournalSession;
  /** NIFTY's close at the end of each session minute, carried forward. */
  nifty: (number | null)[];
  /** India VIX at the end of each minute, carried forward. */
  vix: (number | null)[];
}

export interface DroppedDay {
  date: string;
  reason: string;
}

const IST_MS = 5.5 * 3_600_000;
const dayOf = (t: number) => new Date(t + IST_MS).toISOString().slice(0, 10);

/**
 * The days in one month of candles, in date order, each either a frame or the reason it was left
 * out. `breadthKeys` are the stocks breadth counts; `stockKeys` the stocks given to computePulse.
 */
export function buildDays(
  columns: CandleColumns,
  closes: DailyCloses,
  {
    from,
    to,
    breadthKeys,
    stockKeys = NIFTY_CONSTITUENTS.map((c) => c.key),
  }: { from: string; to: string; breadthKeys: readonly string[]; stockKeys?: readonly string[] },
): (DayFrame | DroppedDay)[] {
  // Rows grouped by day, then laid out per instrument minute by minute.
  const days = new Map<string, number[]>();
  for (let i = 0; i < columns.t.length; i += 1) {
    const date = dayOf(columns.t[i]);
    if (date < from || date > to) continue;
    const rows = days.get(date) ?? [];
    rows.push(i);
    days.set(date, rows);
  }
  const wanted = new Set([NIFTY_KEY, VIX_KEY, ...stockKeys, ...breadthKeys]);
  const out: (DayFrame | DroppedDay)[] = [];
  for (const date of [...days.keys()].sort()) {
    const open = Date.parse(`${date}T09:15:00+05:30`);
    const series = new Map<string, (number | null)[]>();
    const bars: SessionMinute["bar"][] = new Array(SESSION_MINUTES).fill(null);
    let niftyMinutes = 0;
    for (const i of days.get(date)!) {
      const key = columns.keys[columns.k[i]];
      if (!wanted.has(key)) continue;
      const minute = Math.round((columns.t[i] - open) / MINUTE_MS);
      if (minute < 0 || minute >= SESSION_MINUTES) continue;
      let line = series.get(key);
      if (!line) series.set(key, (line = new Array(SESSION_MINUTES).fill(null)));
      line[minute] = columns.close[i];
      if (key === NIFTY_KEY) {
        bars[minute] = [columns.open[i], columns.high[i], columns.low[i], columns.close[i]];
        niftyMinutes += 1;
      }
    }
    if (niftyMinutes < MIN_SESSION_MINUTES) {
      out.push({ date, reason: niftyMinutes === 0 ? "No NIFTY minutes" : `Short session: ${niftyMinutes} NIFTY minutes (Muhurat or special session)` });
      continue;
    }
    const niftyReference = closes.before(NIFTY_KEY, date);
    if (niftyReference === null) {
      out.push({ date, reason: "No official close for the day before" });
      continue;
    }
    for (const line of series.values()) {
      for (let m = 1; m < SESSION_MINUTES; m += 1) if (line[m] === null) line[m] = line[m - 1];
    }

    const reference = new Map<string, number | null>();
    for (const key of series.keys()) reference.set(key, key === NIFTY_KEY ? niftyReference : closes.before(key, date));
    const minutes: SessionMinute[] = [];
    for (let m = 0; m < SESSION_MINUTES; m += 1) {
      let advancers = 0;
      let decliners = 0;
      for (const key of breadthKeys) {
        const price = series.get(key)?.[m];
        const ref = reference.get(key);
        if (price == null || ref == null) continue;
        if (price > ref) advancers += 1;
        else if (price < ref) decliners += 1;
      }
      minutes.push({ at: open + m * MINUTE_MS, frames: 0, packets: 0, bar: bars[m], advancers, decliners });
    }

    const instrument = (key: string, line: (number | null)[]): SessionInstrument => ({
      key,
      symbol: key,
      name: null,
      sector: null,
      mode: null,
      packets: 0,
      reference: reference.get(key) ?? null,
      ltp: line.findLast((c) => c !== null) ?? null,
      open: line.find((c) => c !== null) ?? null,
      high: null,
      low: null,
      vwap: null,
      volume: null,
      buyQty: null,
      sellQty: null,
      firstAt: null,
      lastAt: null,
      closes: line,
    });
    const instruments = [NIFTY_KEY, ...stockKeys].filter((key) => series.has(key)).map((key) => instrument(key, series.get(key)!));
    const end = open + SESSION_MINUTES * MINUTE_MS;
    const session: JournalSession = {
      date,
      session: { open, close: end },
      builtAt: end,
      readMs: 0,
      file: { bytes: 0, records: 0, frames: 0, controls: 0, packets: {}, events: {}, firstFrameAt: open, lastFrameAt: end },
      runs: [],
      gaps: [],
      states: [],
      benchmark: NIFTY_KEY,
      minutes,
      instruments,
    } as unknown as JournalSession;
    out.push({
      date,
      open,
      rules: sessionRules(date),
      session,
      nifty: series.get(NIFTY_KEY)!,
      vix: series.get(VIX_KEY) ?? new Array(SESSION_MINUTES).fill(null),
    });
  }
  return out;
}

export const isFrame = (day: DayFrame | DroppedDay): day is DayFrame => "session" in day;

/**
 * The day as the engine saw it when minute `t` closed: everything after it removed. Signals read
 * from a whole day never look ahead, but the rest of a pulse does (the day's range, the learned
 * weights, the verdict), so anything that uses those must work from this cut.
 */
export function sessionUntil(session: JournalSession, t: number): JournalSession {
  return {
    ...session,
    builtAt: session.minutes[t]?.at ?? session.builtAt,
    file: { ...session.file, lastFrameAt: (session.minutes[t]?.at ?? session.builtAt) + MINUTE_MS },
    minutes: session.minutes.slice(0, t + 1),
    instruments: session.instruments.map((instrument) => {
      const closes = instrument.closes.slice(0, t + 1);
      return { ...instrument, closes, ltp: closes.findLast((c) => c !== null) ?? null };
    }),
  };
}
