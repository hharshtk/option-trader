// One-minute candle history from Dhan, kept as Parquet in the app's file store for research: one
// file per calendar month holding every instrument, `history/candles-1m/YYYY-MM.parquet`. Daily
// bars sit beside it, one file per year, `history/daily/YYYY.parquet`: their close is the official
// close, which minute candles don't give (stock candles stop at 15:14 since the closing auction).
//
// Dhan serves five years of 1-minute candles, at most 90 days per request; a month per request
// keeps each file one unit that is rewritten together (the current month grows day by day).
//
// Candles are stamped with the start of their minute. Only 09:00–15:30 IST is kept: Dhan's index
// candles run on after the close with the after-hours heartbeat. Note how NSE closes now: stocks
// trade continuously until 15:15, then a closing auction runs to 15:30, so stock candles stop at
// 15:14 and the index holds flat from 15:15 until the auction price lands around 15:28.

import type { ParquetStore } from "../db/parquet-store.ts";
import type { ChartInstrument, DailyCandleRequest, ExchangeSegment, IntradayCandleRequest, IntradayCandles } from "../dhan/types.ts";
import { INDEX_CONSTITUENTS } from "../index-constituents.ts";

const IST_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;

export const historyKey = (month: string) => `history/candles-1m/${month}.parquet`;
export const dailyKey = (year: string) => `history/daily/${year}.parquet`;
/** The first month of minute history. The daily bars start a month earlier, for its first previous close. */
export const HISTORY_START = "2025-11";

export const CANDLE_COLUMNS = {
  key: "VARCHAR",
  t: "DOUBLE",
  open: "DOUBLE",
  high: "DOUBLE",
  low: "DOUBLE",
  close: "DOUBLE",
  volume: "DOUBLE",
} as const;

export interface HistoryInstrument {
  /** Feed key, `SEGMENT:SECURITY_ID`, the same as the journal uses. */
  key: string;
  name: string;
  segment: ExchangeSegment;
  securityId: string;
  instrument: ChartInstrument;
}

export interface CandleRow {
  key: string;
  /** Start of the minute, epoch ms. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const INDICES: [string, string][] = [
  ["13", "NIFTY"],
  ["21", "INDIA VIX"],
  ["25", "BANKNIFTY"],
  ["27", "FINNIFTY"],
];

/** The indices and the NIFTY and BANKNIFTY constituents: what the live universe records. */
export function historyUniverse(): HistoryInstrument[] {
  const out = new Map<string, HistoryInstrument>();
  for (const [securityId, name] of INDICES) {
    out.set(`IDX_I:${securityId}`, { key: `IDX_I:${securityId}`, name, segment: "IDX_I", securityId, instrument: "INDEX" });
  }
  for (const stock of [...INDEX_CONSTITUENTS.NIFTY, ...INDEX_CONSTITUENTS.BANKNIFTY]) {
    const key = `NSE_EQ:${stock.securityId}`;
    if (!out.has(key)) out.set(key, { key, name: stock.symbol, segment: "NSE_EQ", securityId: String(stock.securityId), instrument: "EQUITY" });
  }
  return [...out.values()];
}

/** "YYYY-MM" months from `from` to `to`, inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [year, month] = from.split("-").map(Number);
  const [endYear, endMonth] = to.split("-").map(Number);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) [year, month] = [year + 1, 1];
  }
  return out;
}

/** The request dates for a month: its first day to the first day of the next. */
export function monthRange(month: string): { fromDate: string; toDate: string } {
  const [year, m] = month.split("-").map(Number);
  const next = m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, "0")}`;
  return { fromDate: `${month}-01`, toDate: `${next}-01` };
}

/** Dhan's parallel arrays as rows, kept to the month and to 09:00–15:30 IST. */
export function toRows(key: string, month: string, candles: IntradayCandles): CandleRow[] {
  const rows: CandleRow[] = [];
  const times = candles.timestamp ?? [];
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i] * 1000;
    const ist = new Date(t + IST_MS).toISOString();
    if (ist.slice(0, 7) !== month) continue;
    const clock = ist.slice(11, 16);
    if (clock < "09:00" || clock >= "15:30") continue;
    rows.push({ key, t, open: candles.open[i], high: candles.high[i], low: candles.low[i], close: candles.close[i], volume: candles.volume[i] ?? 0 });
  }
  return rows;
}

export interface MonthResult {
  month: string;
  rows: number;
  instruments: number;
  days: number;
  failed: { key: string; error: string }[];
}

/**
 * Downloads one month for every instrument and replaces that month's file. Instruments that fail
 * are reported and left out; a month where every instrument fails is not written.
 */
export async function downloadMonth(
  month: string,
  instruments: readonly HistoryInstrument[],
  {
    store,
    fetchCandles,
  }: {
    store: ParquetStore;
    fetchCandles: (request: IntradayCandleRequest) => Promise<IntradayCandles>;
  },
): Promise<MonthResult> {
  const { fromDate, toDate } = monthRange(month);
  const rows: CandleRow[] = [];
  const failed: MonthResult["failed"] = [];
  let withData = 0;
  for (const instrument of instruments) {
    try {
      const candles = await fetchCandles({
        securityId: instrument.securityId,
        exchangeSegment: instrument.segment,
        instrument: instrument.instrument,
        interval: "1",
        fromDate,
        toDate,
      });
      const kept = toRows(instrument.key, month, candles);
      if (kept.length > 0) withData += 1;
      rows.push(...kept);
    } catch (error) {
      failed.push({ key: instrument.key, error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    }
  }
  if (withData > 0) await store.write(historyKey(month), CANDLE_COLUMNS, rows as unknown as Record<string, number | string>[]);
  const days = new Set(rows.map((row) => Math.floor((row.t + IST_MS) / DAY_MS))).size;
  return { month, rows: rows.length, instruments: withData, days, failed };
}

export const DAILY_COLUMNS = {
  key: "VARCHAR",
  /** The trading day, "YYYY-MM-DD" IST. */
  date: "VARCHAR",
  open: "DOUBLE",
  high: "DOUBLE",
  low: "DOUBLE",
  close: "DOUBLE",
  volume: "DOUBLE",
} as const;

export interface DailyRow {
  key: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** The IST calendar day of an epoch-ms time. */
export const istDay = (t: number) => new Date(t + IST_MS).toISOString().slice(0, 10);

/** The month before `month`, "YYYY-MM". */
export function previousMonth(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return m === 1 ? `${year - 1}-12` : `${year}-${String(m - 1).padStart(2, "0")}`;
}

export interface DailyResult {
  years: string[];
  rows: number;
  failed: { key: string; error: string }[];
}

/**
 * Downloads daily bars from `fromDate` up to (not including) `toDate` for every instrument, one
 * request each, and replaces the file of every year in the range. Nothing is written when every
 * instrument fails.
 */
export async function downloadDaily(
  fromDate: string,
  toDate: string,
  instruments: readonly HistoryInstrument[],
  {
    store,
    fetchDaily,
    onInstrument,
  }: {
    store: ParquetStore;
    fetchDaily: (request: DailyCandleRequest) => Promise<IntradayCandles>;
    onInstrument?: (done: number, total: number) => void | Promise<void>;
  },
): Promise<DailyResult> {
  const rows: DailyRow[] = [];
  const failed: DailyResult["failed"] = [];
  for (const [index, instrument] of instruments.entries()) {
    try {
      const candles = await fetchDaily({
        securityId: instrument.securityId,
        exchangeSegment: instrument.segment,
        instrument: instrument.instrument,
        fromDate,
        toDate,
      });
      const times = candles.timestamp ?? [];
      for (let i = 0; i < times.length; i += 1) {
        const date = istDay(times[i] * 1000);
        if (date < fromDate || date >= toDate) continue;
        rows.push({ key: instrument.key, date, open: candles.open[i], high: candles.high[i], low: candles.low[i], close: candles.close[i], volume: candles.volume[i] ?? 0 });
      }
    } catch (error) {
      failed.push({ key: instrument.key, error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    }
    await onInstrument?.(index + 1, instruments.length);
  }
  const years: string[] = [];
  if (rows.length > 0) {
    for (let year = Number(fromDate.slice(0, 4)); year <= Number(toDate.slice(0, 4)); year += 1) {
      const inYear = rows.filter((row) => row.date.startsWith(`${year}-`));
      if (inYear.length === 0) continue;
      await store.write(dailyKey(String(year)), DAILY_COLUMNS, inYear as unknown as Record<string, number | string>[]);
      years.push(String(year));
    }
  }
  return { years, rows: rows.length, failed };
}

export interface HistoryCoverage {
  /** First and last session minute held, epoch ms; null when there is no minute history. */
  minute: { from: number; to: number; months: string[] } | null;
  /** The last day with a daily bar, "YYYY-MM-DD". */
  dailyTo: string | null;
}

/** What history is stored, read from the Parquet files' footers only (about a second on S3). */
export async function historyCoverage(store: ParquetStore): Promise<HistoryCoverage> {
  const range = (glob: string, column: string) =>
    store.query<{ file_name: string; lo: string; hi: string }>(
      () => `SELECT file_name, min(stats_min_value) AS lo, max(stats_max_value) AS hi
             FROM parquet_metadata('${store.url(glob)}') WHERE path_in_schema = '${column}' GROUP BY file_name`,
    );
  const [minute, daily] = await Promise.all([range("history/candles-1m/*.parquet", "t"), range("history/daily/*.parquet", "date")]);
  const months = minute.map((row) => row.file_name.match(/(\d{4}-\d{2})\.parquet$/)?.[1]).filter((m): m is string => !!m).sort();
  return {
    minute: minute.length
      ? { from: Math.min(...minute.map((row) => Number(row.lo))), to: Math.max(...minute.map((row) => Number(row.hi))), months }
      : null,
    dailyTo: daily.length ? daily.map((row) => row.hi).sort().at(-1)! : null,
  };
}

export interface HistoryUpdate {
  months: MonthResult[];
  daily: DailyResult;
}

/**
 * Brings the history up to `today` (an IST day): the newest stored month and every month after it
 * are downloaded again (a missing history starts at HISTORY_START), then the daily bars for the
 * whole span. Each request waits `pauseMs` first, which keeps clear of Dhan's data limit (5 a
 * second, shared with the live engine).
 */
export async function updateHistory(
  today: string,
  {
    store,
    fetchCandles,
    fetchDaily,
    pauseMs = 500,
    onProgress,
  }: {
    store: ParquetStore;
    fetchCandles: (request: IntradayCandleRequest) => Promise<IntradayCandles>;
    fetchDaily: (request: DailyCandleRequest) => Promise<IntradayCandles>;
    pauseMs?: number;
    onProgress?: (done: number, total: number, label: string) => void;
  },
): Promise<HistoryUpdate> {
  const universe = historyUniverse();
  const coverage = await historyCoverage(store);
  const newest = coverage.minute?.months.at(-1) ?? HISTORY_START;
  const months = monthsBetween(newest, today.slice(0, 7));
  const total = (months.length + 1) * universe.length;
  let done = 0;
  const pause = () => new Promise((resolve) => setTimeout(resolve, pauseMs));
  const paced = <A, R>(fetch: (request: A) => Promise<R>, label: () => string) => async (request: A) => {
    await pause();
    onProgress?.(done, total, label());
    try {
      return await fetch(request);
    } finally {
      done += 1;
    }
  };
  const results: MonthResult[] = [];
  for (const month of months) {
    results.push(await downloadMonth(month, universe, { store, fetchCandles: paced(fetchCandles, () => `Minute bars, ${month}`) }));
  }
  const next = new Date(Date.parse(`${today}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  const daily = await downloadDaily(`${previousMonth(HISTORY_START)}-01`, next, universe, {
    store,
    fetchDaily: paced(fetchDaily, () => "Daily closes"),
  });
  onProgress?.(total, total, "Done");
  return { months: results, daily };
}
