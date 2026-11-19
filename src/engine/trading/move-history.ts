// Loads NIFTY's recent days for the typical-move profile (lib/trading/moves.ts), from two places
// in the file store:
//
//   history/candles-1m/YYYY-MM.parquet   1-minute candles downloaded from Dhan (research history)
//   decide/minutes/<date>.parquet        the decision lab's per-minute table, built from the
//                                        engine's own journal after every session
//
// The lab's tables keep the profile current with no download: each session the engine records
// becomes a day of history that evening. Where both have a day, the lab's (from the journal) wins.

import type { ParquetStore } from "../../lib/db/parquet-store.ts";
import { historyKey } from "../../lib/research/candle-history.ts";
import { buildProfile, type MoveProfile } from "../../lib/trading/moves.ts";

const NIFTY = "IDX_I:13";
/** Calendar days looked back over: enough for 20 trading days around holidays. */
const LOOKBACK_DAYS = 45;
const DAY_MS = 86_400_000;
const IST_MS = 5.5 * 3_600_000;

/** The profile of the trading days before `date` (YYYY-MM-DD); null when fewer than the minimum are stored. */
export async function loadMoveProfile(store: ParquetStore, date: string): Promise<MoveProfile | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" isn't a date`);
  const until = Date.parse(`${date}T00:00:00Z`) - IST_MS;
  const since = until - LOOKBACK_DAYS * DAY_MS;
  const sinceDate = new Date(since + IST_MS).toISOString().slice(0, 10);
  const byDate = new Map<string, (number | null)[]>();
  const put = (day: string, t: number, close: number) => {
    if (t < 0 || t >= 375 || !Number.isFinite(close)) return;
    let closes = byDate.get(day);
    if (!closes) byDate.set(day, (closes = []));
    closes[t] = close;
  };

  // Candles: stamped with the start of their minute; the minute index counts from that day's 09:15.
  for (const month of new Set([sinceDate.slice(0, 7), new Date(until - DAY_MS + IST_MS).toISOString().slice(0, 7)])) {
    const rows = await store.query<{ t: number; close: number }>(
      (table) => `SELECT t, close FROM ${table(historyKey(month))} WHERE key = '${NIFTY}' AND t >= ${since} AND t < ${until}`,
    );
    for (const { t, close } of rows) {
      const day = new Date(t + IST_MS).toISOString().slice(0, 10);
      put(day, Math.round((t - (Date.parse(`${day}T03:45:00Z`))) / 60_000), close);
    }
  }

  // The lab's tables, which replace a day the candles also have.
  const lab = await store.query<{ date: string; t: number; nifty: number | null }>(
    (table) => `SELECT date, t, nifty FROM ${table("decide/minutes/*.parquet")} WHERE date >= '${sinceDate}' AND date < '${date}' AND nifty IS NOT NULL`,
  );
  const labDays = new Set(lab.map((r) => r.date));
  for (const day of labDays) byDate.delete(day);
  for (const { date: day, t, nifty } of lab) put(day, t, nifty!);

  return buildProfile(byDate);
}
