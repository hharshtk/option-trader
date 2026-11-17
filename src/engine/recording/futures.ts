// The index futures the recorder streams, from the index futures table that the daily download of
// Dhan's instrument file writes (instruments/index-futures.parquet). A live day whose table is
// missing or older than the day downloads the file again, at most every 10 minutes.

import type { ParquetStore } from "../../lib/db/parquet-store.ts";
import { downloadOptionScrips, INDEX_FUTURES_PARQUET } from "../../lib/dhan/option-scrips-store.ts";
import type { Logger } from "../telemetry/logger.ts";

const DOWNLOAD_RETRY_MS = 10 * 60_000;

export interface IndexFuture {
  securityId: string;
  feedKey: string;
  name: string;
  expiry: string;
  lotSize: number;
}

interface FutureRow {
  security_id: string;
  display_name: string;
  expiry: string;
  lot_size: number;
  trading_date: string;
}

export function createFuturesSource({
  store,
  log,
  now,
  download = downloadOptionScrips,
}: {
  store: ParquetStore;
  log: Logger;
  now: () => number;
  download?: () => Promise<unknown>;
}) {
  let lastDownloadAt = 0;

  const read = (marketDate: string, underlying: string) =>
    store
      .query<FutureRow>(
        (table) => `SELECT security_id, display_name, expiry, lot_size, trading_date FROM ${table(INDEX_FUTURES_PARQUET)}
                    WHERE exchange = 'NSE' AND underlying = $underlying AND expiry >= $marketDate ORDER BY expiry`,
        { marketDate, underlying },
      )
      .catch(() => [] as FutureRow[]);

  return async function loadFutures(marketDate: string, underlying = "NIFTY"): Promise<{ futures: IndexFuture[]; problem: string | null }> {
    let rows = await read(marketDate, underlying);
    const stale = rows.length === 0 || rows[0].trading_date < marketDate;
    if (stale && now() - lastDownloadAt > DOWNLOAD_RETRY_MS) {
      lastDownloadAt = now();
      try {
        await download();
        log.info("downloaded Dhan's instrument file for today's index futures");
        rows = await read(marketDate, underlying);
      } catch (error) {
        log.warn(`Couldn't download Dhan's instrument file: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const futures = rows.map((row) => ({
      securityId: String(row.security_id),
      feedKey: `NSE_FNO:${row.security_id}`,
      name: row.display_name,
      expiry: row.expiry,
      lotSize: Number(row.lot_size),
    }));
    return {
      futures,
      problem: futures.length === 0 ? `No ${underlying} futures in the index futures table; it is written by each download of Dhan's instrument file` : null,
    };
  };
}
