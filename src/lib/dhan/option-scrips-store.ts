import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withDb } from "../db/duckdb.ts";
import { getFileStore } from "../storage.ts";
import {
  exportOptionScripsParquet,
  importOptionScrips,
  importOptionScripsParquet,
  type OptionScripsInfo,
} from "./option-contracts.ts";
import { getParquetStore } from "../db/parquet-store.ts";
import { filterIndexFutures, filterOptionScrips, SCRIP_MASTER_URL, type OptionScripSummary } from "./option-scrips.ts";

// Settings → Download option instruments: fetch Dhan's instrument master from its CDN (a public
// file, so it uses neither the access token nor the API rate limits), keep the options, and
// store them as Parquet plus a JSON summary in the app's file store (S3 when S3_BUCKET is set,
// otherwise DATA_DIR). Lookups read them into the in-memory DuckDB: every server instance loads
// the stored file on first use and picks up a newer download within RECHECK_MS.
//
// Plain Node can load this module: the engine downloads the file itself on a trading day when
// the stored one is older, so trading never waits for someone to press the button.

export const OPTION_SCRIPS_PARQUET = "instruments/options-scrip-master.parquet";
const META_KEY = "instruments/options-scrip-master.json";
/** Unexpired index futures from the same file, for the engine's recorder. One row per contract. */
export const INDEX_FUTURES_PARQUET = "instruments/index-futures.parquet";
const INDEX_FUTURES_COLUMNS = {
  security_id: "VARCHAR",
  exchange: "VARCHAR",
  underlying: "VARCHAR",
  display_name: "VARCHAR",
  expiry: "VARCHAR",
  lot_size: "DOUBLE",
  tick_size: "DOUBLE",
  trading_date: "VARCHAR",
} as const;

const TIMEOUT_MS = 120_000;
const RECHECK_MS = 30_000;

export interface OptionScripsMeta extends OptionScripSummary {
  downloadedAt: string;
  /** The IST trading date the file was filtered for. */
  tradingDate: string;
  source: string;
  /** When Dhan last regenerated its file (HTTP Last-Modified), if it said. */
  sourceUpdatedAt: string | null;
  /** IST date of sourceUpdatedAt. Earlier than tradingDate means Dhan hadn't published that day's file yet. */
  sourceDate: string | null;
  /** Size of the stored Parquet file. */
  bytes: number;
  /** Index futures saved to INDEX_FUTURES_PARQUET; absent from downloads made before they were. */
  indexFutures?: number;
}

const istDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });

export function todayIst(now: number | Date = Date.now()) {
  return istDate.format(now);
}

/** True when Dhan's file is the one it published on the download day. */
export function isSourceCurrent(meta: Pick<OptionScripsMeta, "sourceDate" | "tradingDate">) {
  return meta.sourceDate === null || meta.sourceDate === meta.tradingDate;
}

function infoOf(meta: OptionScripsMeta): OptionScripsInfo {
  return {
    tradingDate: meta.tradingDate,
    sourceDate: meta.sourceDate,
    sourceUpdatedAt: meta.sourceUpdatedAt,
    downloadedAt: meta.downloadedAt,
  };
}

// Per server process, on globalThis so dev hot reloads share it.
interface State {
  download?: Promise<OptionScripsMeta>;
  load?: Promise<void>;
  /** downloadedAt of the download now in DuckDB. */
  loaded?: string;
  checkedAt: number;
}
const STATE = Symbol.for("option-trader.option-scrips");
const globalStore = globalThis as typeof globalThis & { [STATE]?: State };
const state = (globalStore[STATE] ??= { checkedAt: 0 });

async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "option-scrips-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The last download's summary, or null if there hasn't been one. */
export async function readOptionScripsMeta(): Promise<OptionScripsMeta | null> {
  const bytes = await getFileStore().get(META_KEY);
  return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as OptionScripsMeta) : null;
}

export function optionScripsLocation() {
  return getFileStore().location;
}

// A second click while a download runs gets the same result instead of a second download.
export function downloadOptionScrips(): Promise<OptionScripsMeta> {
  state.download ??= download().finally(() => {
    state.download = undefined;
  });
  return state.download;
}

async function download(): Promise<OptionScripsMeta> {
  let response: Response;
  try {
    response = await fetch(SCRIP_MASTER_URL, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    const reason =
      cause instanceof Error && cause.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1000}s` : "network error";
    throw new Error(`Could not download Dhan's instrument file (${reason})`, { cause });
  }
  if (!response.ok) throw new Error(`Dhan's instrument file returned HTTP ${response.status}`);

  const tradingDate = todayIst();
  const text = await response.text();
  const { csv, summary } = filterOptionScrips(text, tradingDate);
  const futures = filterIndexFutures(text, tradingDate);
  if (summary.optionRows === 0) throw new Error("Dhan's instrument file had no unexpired options; kept the previous file");

  const lastModified = response.headers.get("last-modified");
  const sourceUpdated = lastModified ? new Date(lastModified) : null;
  const sourceValid = sourceUpdated !== null && !Number.isNaN(sourceUpdated.getTime());
  const meta: OptionScripsMeta = {
    downloadedAt: new Date().toISOString(),
    tradingDate,
    source: SCRIP_MASTER_URL,
    sourceUpdatedAt: sourceValid ? sourceUpdated.toISOString() : null,
    sourceDate: sourceValid ? todayIst(sourceUpdated) : null,
    bytes: 0,
    ...summary,
  };

  const parquet = await withTempDir(async (dir) => {
    const csvFile = path.join(dir, "options.csv");
    const parquetFile = path.join(dir, "options.parquet");
    await writeFile(csvFile, csv);
    const imported = await withDb(async (db) => {
      const count = await importOptionScrips(db, csvFile, infoOf(meta));
      await exportOptionScripsParquet(db, parquetFile);
      return count;
    });
    if (imported !== summary.optionRows) {
      throw new Error(`DuckDB loaded ${imported} of ${summary.optionRows} option rows`);
    }
    return readFile(parquetFile);
  });
  meta.bytes = parquet.byteLength;

  // Futures are a side table: a failure here mustn't cost the options, which trading needs.
  if (futures.length > 0) {
    try {
      await getParquetStore().write(INDEX_FUTURES_PARQUET, INDEX_FUTURES_COLUMNS, futures.map((row) => ({ ...row, trading_date: tradingDate })));
      meta.indexFutures = futures.length;
    } catch (error) {
      console.warn("Couldn't save the index futures from Dhan's instrument file.", error);
    }
  }

  // The summary goes last: other instances reload when it changes, by which time the file is in place.
  const store = getFileStore();
  await store.put(OPTION_SCRIPS_PARQUET, parquet, "application/vnd.apache.parquet");
  await store.put(META_KEY, `${JSON.stringify(meta, null, 2)}\n`, "application/json");
  state.loaded = meta.downloadedAt;
  state.checkedAt = Date.now();
  return meta;
}

/**
 * Makes sure DuckDB holds the newest stored download, checking the store at most every
 * RECHECK_MS. If the store can't be reached but contracts are already loaded, keeps them.
 */
export function ensureOptionScripsLoaded(): Promise<void> {
  if (Date.now() - state.checkedAt < RECHECK_MS) return Promise.resolve();
  state.load ??= reload().finally(() => {
    state.load = undefined;
  });
  return state.load;
}

async function reload() {
  try {
    const meta = await readOptionScripsMeta();
    if (meta && meta.downloadedAt !== state.loaded) {
      const parquet = await getFileStore().get(OPTION_SCRIPS_PARQUET);
      if (!parquet) throw new Error(`${OPTION_SCRIPS_PARQUET} is missing from ${getFileStore().location}`);
      await withTempDir(async (dir) => {
        const file = path.join(dir, "options.parquet");
        await writeFile(file, parquet);
        await withDb((db) => importOptionScripsParquet(db, file, infoOf(meta)));
      });
      state.loaded = meta.downloadedAt;
    }
    state.checkedAt = Date.now();
  } catch (error) {
    if (state.loaded === undefined) throw error;
    console.warn("Couldn't check for newer option instruments; using the loaded ones.", error);
    state.checkedAt = Date.now();
  }
}
