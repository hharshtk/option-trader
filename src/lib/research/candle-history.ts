// One-minute candle history from Dhan, kept as Parquet in the app's file store for research: one
// file per calendar month holding every instrument, `history/candles-1m/YYYY-MM.parquet`.
//
// Dhan serves five years of 1-minute candles, at most 90 days per request; a month per request
// keeps each file one unit that is rewritten together (the current month grows day by day).
//
// Candles are stamped with the start of their minute. Only 09:00–15:30 IST is kept: Dhan's index
// candles run on after the close with the after-hours heartbeat. Note how NSE closes now: stocks
// trade continuously until 15:15, then a closing auction runs to 15:30, so stock candles stop at
// 15:14 and the index holds flat from 15:15 until the auction price lands around 15:28.

import type { ParquetStore } from "../db/parquet-store.ts";
import type { ChartInstrument, ExchangeSegment, IntradayCandleRequest, IntradayCandles } from "../dhan/types.ts";
import { INDEX_CONSTITUENTS } from "../index-constituents.ts";

const IST_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;

export const historyKey = (month: string) => `history/candles-1m/${month}.parquet`;

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
