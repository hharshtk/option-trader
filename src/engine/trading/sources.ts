// Where trading gets its reference data from in the running engine: the option contracts (the
// instrument file in the app's file store, downloaded from Dhan when a live day finds it out of
// date) and 1-minute option candles from Dhan (for replays of days recorded without options).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getIntradayCandles } from "../../lib/dhan/api.ts";
import { downloadOptionScrips, readOptionScripsMeta, type OptionScripsMeta } from "../../lib/dhan/option-scrips-store.ts";
import type { ParquetStore } from "../../lib/db/parquet-store.ts";
import type { OptionRef } from "../../lib/engine/trading.ts";
import type { Logger } from "../telemetry/logger.ts";
import { loadContractBook, type ContractBook } from "./contracts.ts";
import type { Candle } from "./trader.ts";

const DOWNLOAD_RETRY_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

/** The IST date the file's contents are from: Dhan's publication date when it is older than the download. */
function fileDateOf(meta: OptionScripsMeta) {
  return meta.sourceDate !== null && meta.sourceDate < meta.tradingDate ? meta.sourceDate : meta.tradingDate;
}

export function createContractSource({ store, log, now }: { store: ParquetStore; log: Logger; now: () => number }) {
  let lastDownloadAt = 0;

  return async function loadContracts(
    marketDate: string,
    live: boolean,
    underlying = "NIFTY",
  ): Promise<{ book: ContractBook | null; problem: string | null }> {
    let meta = await readOptionScripsMeta().catch(() => null);
    let problem: string | null = null;

    // A live day with an older file: fetch today's from Dhan, so trading never waits for the button.
    if (live && (!meta || fileDateOf(meta) < marketDate) && now() - lastDownloadAt > DOWNLOAD_RETRY_MS) {
      lastDownloadAt = now();
      try {
        meta = await downloadOptionScrips();
        log.info(`downloaded Dhan's instrument file: ${meta.optionRows} option contracts, published ${meta.sourceDate ?? "on an unknown date"}`);
      } catch (error) {
        problem = `Couldn't download today's instrument file: ${error instanceof Error ? error.message : String(error)}`;
        log.warn(problem);
      }
    }

    const fileDate = meta ? fileDateOf(meta) : null;
    const book = await loadContractBook(store, marketDate, fileDate, underlying);
    if (!book) {
      problem ??= fileDate
        ? `The ${fileDate} instrument file has no unexpired ${underlying} options for ${marketDate}`
        : "Option instruments haven't been downloaded. Use Settings → Download option instruments.";
    } else if (live && book.fileDate < marketDate) {
      problem ??= `Dhan hasn't published today's instrument file yet; using the ${book.fileDate} one, so new strikes may be missing`;
    }
    return { book, problem };
  };
}

export function createCandleSource({
  directory,
  istDate,
  complete,
}: {
  directory: string;
  istDate: (time: number) => string;
  /** Whether a day's session is over, so its candles won't change any more. */
  complete: (date: string) => boolean;
}) {
  const loaded = new Map<string, Promise<Candle[]>>();

  async function load(contract: OptionRef, date: string): Promise<Candle[]> {
    const file = path.join(directory, date, `${contract.securityId}.json`);
    try {
      return JSON.parse(await readFile(file, "utf8")) as Candle[];
    } catch {
      // Not fetched yet.
    }
    const next = new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
    const raw = await getIntradayCandles({ securityId: contract.securityId, exchangeSegment: "NSE_FNO", instrument: "OPTIDX", interval: "1", fromDate: date, toDate: next });
    // Dhan stamps each candle with the start of its minute, in epoch seconds.
    const candles: Candle[] = (raw.timestamp ?? [])
      .map((seconds, i) => ({ t: seconds * 1000, o: raw.open[i], h: raw.high[i], l: raw.low[i], c: raw.close[i] }))
      .filter((candle) => istDate(candle.t) === date && candle.c > 0)
      .sort((a, b) => a.t - b.t);
    if (candles.length === 0) throw new Error("Dhan has no 1-minute candles for it on that day");
    // A finished session's candles are final: keep them, so the next replay asks Dhan nothing
    // (and still works once the contract has expired and Dhan no longer serves it).
    if (complete(date)) {
      await mkdir(path.dirname(file), { recursive: true }).catch(() => {});
      await writeFile(file, JSON.stringify(candles)).catch(() => {});
    }
    return candles;
  }

  return function loadCandles(contract: OptionRef, date: string): Promise<Candle[]> {
    const key = `${date}/${contract.securityId}`;
    let pending = loaded.get(key);
    if (!pending) {
      pending = load(contract, date);
      loaded.set(key, pending);
      pending.catch(() => loaded.delete(key));
    }
    return pending;
  };
}
