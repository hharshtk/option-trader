import "server-only";
import type { DuckDBConnection } from "@duckdb/node-api";
import { withDb } from "@/lib/db/duckdb";
import {
  findOptionContract as findIn,
  getOptionContract as getIn,
  listOptionExpiries as expiriesIn,
  listOptionStrikes as strikesIn,
  listOptionUnderlyings as underlyingsIn,
  optionChainAround as chainIn,
  readOptionScripsInfo,
  type OptionExchange,
  type OptionScripsInfo,
  type OptionType,
} from "./option-contracts";
import { ensureOptionScripsLoaded, todayIst } from "./option-scrips-store";

// Option lookups on the app's DuckDB database, for server code (pages, actions, strategies).
// Resolve contracts when a strategy starts or the ATM strike moves, not on every tick.
//
// Lookups refuse to answer from an earlier day's download (OptionScripsStaleError): new strikes
// and lot-size changes would be missing. Pass { allowStale: true } where yesterday's contracts
// are acceptable, such as a page that shows a warning beside them.

export type {
  ChainStrike,
  OptionChainSlice,
  OptionContract,
  OptionExchange,
  OptionScripsInfo,
  OptionType,
  OptionUnderlying,
} from "./option-contracts";

export interface LookupOptions {
  allowStale?: boolean;
}

export class OptionScripsMissingError extends Error {
  constructor() {
    super("Option instruments haven't been downloaded. Use Settings → Download option instruments.");
    this.name = "OptionScripsMissingError";
  }
}

export class OptionScripsStaleError extends Error {
  readonly tradingDate: string;

  constructor(tradingDate: string) {
    super(`Option instruments were last downloaded for ${tradingDate}. Use Settings → Download option instruments.`);
    this.name = "OptionScripsStaleError";
    this.tradingDate = tradingDate;
  }
}

export interface OptionScripsStatus {
  info: OptionScripsInfo | null;
  /** Downloaded today (IST). */
  current: boolean;
  /** Dhan's file was published today (IST); false means it was downloaded before Dhan updated it. */
  sourceCurrent: boolean;
}

function statusOf(info: OptionScripsInfo | null, today: string): OptionScripsStatus {
  return {
    info,
    current: info?.tradingDate === today,
    sourceCurrent: info !== null && (info.sourceDate === null || info.sourceDate === today),
  };
}

/** What the lookups would answer from, without failing when it's missing or stale. */
export async function getOptionScripsStatus(): Promise<OptionScripsStatus> {
  await ensureOptionScripsLoaded();
  return withDb(async (db) => statusOf(await readOptionScripsInfo(db), todayIst()));
}

async function lookup<T>(
  options: LookupOptions | undefined,
  work: (db: DuckDBConnection, today: string) => Promise<T>,
): Promise<T> {
  await ensureOptionScripsLoaded();
  return withDb(async (db) => {
    const today = todayIst();
    const info = await readOptionScripsInfo(db);
    if (!info) throw new OptionScripsMissingError();
    if (info.tradingDate !== today && !options?.allowStale) throw new OptionScripsStaleError(info.tradingDate);
    return work(db, today);
  });
}

export function findOptionContract(
  query: { underlying: string; expiry: string; strike: number; optionType: OptionType; exchange?: OptionExchange },
  options?: LookupOptions,
) {
  return lookup(options, (db, today) => findIn(db, query, today));
}

export function getOptionContract(securityId: string, exchange?: OptionExchange, options?: LookupOptions) {
  return lookup(options, (db) => getIn(db, securityId, exchange));
}

export function listOptionUnderlyings(options?: LookupOptions) {
  return lookup(options, (db, today) => underlyingsIn(db, today));
}

export function listOptionExpiries(underlying: string, exchange?: OptionExchange, options?: LookupOptions) {
  return lookup(options, (db, today) => expiriesIn(db, underlying, today, exchange));
}

export function listOptionStrikes(
  underlying: string,
  expiry: string,
  exchange?: OptionExchange,
  options?: LookupOptions,
) {
  return lookup(options, (db) => strikesIn(db, underlying, expiry, exchange));
}

export function optionChainAround(
  query: { underlying: string; expiry: string; spot: number; strikesEachSide: number; exchange?: OptionExchange },
  options?: LookupOptions,
) {
  return lookup(options, (db, today) => chainIn(db, query, today));
}
