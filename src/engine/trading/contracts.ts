// The NIFTY option contracts trading picks from: expiries, strikes, security ids and lot size.
// They come from the instrument file the app keeps as Parquet in its file store (Settings →
// Download option instruments), read where it lies with DuckDB.
//
// Dhan's file lists only unexpired contracts, so a day's contracts can't be looked up later. Each
// live day's NIFTY contracts are therefore saved as `reference/nifty-options/<date>.parquet`, and
// a replay of that day reads them back. Other underlyings (the recorder's BANKNIFTY) work the same
// way, under `reference/<underlying>-options/`.

import type { ParquetStore } from "../../lib/db/parquet-store.ts";
import type { OptionRef } from "../../lib/engine/trading.ts";

export const MASTER_KEY = "instruments/options-scrip-master.parquet";
const DEFAULT_UNDERLYING = "NIFTY";
const KEEP_EXPIRIES = 3;
const DAY_MS = 86_400_000;

export interface ChainRow {
  strike: number;
  CE?: OptionRef;
  PE?: OptionRef;
}

export interface ContractBook {
  /** IST date of the instrument file these came from. */
  fileDate: string;
  /** Unexpired on the market day, nearest first. */
  expiries: string[];
  /** An expiry's strikes, ascending. */
  chain(expiry: string): ChainRow[];
  byKey(feedKey: string): OptionRef | undefined;
  contracts: number;
}

interface ContractRow {
  security_id: string;
  name: string;
  strike: number;
  option_type: string;
  expiry: string;
  lot_size: number;
  tick_size: number;
  file_date: string;
}

const SNAPSHOT_COLUMNS = {
  security_id: "VARCHAR",
  name: "VARCHAR",
  strike: "DOUBLE",
  option_type: "VARCHAR",
  expiry: "VARCHAR",
  lot_size: "INTEGER",
  tick_size: "DOUBLE",
  file_date: "VARCHAR",
} as const;

const snapshotKey = (date: string, underlying: string) => `reference/${underlying.toLowerCase()}-options/${date}.parquet`;

export function buildContractBook(rows: readonly ContractRow[], marketDate: string, fileDate: string): ContractBook | null {
  const expiries = [...new Set(rows.map((row) => row.expiry))].filter((expiry) => expiry >= marketDate).sort().slice(0, KEEP_EXPIRIES);
  if (expiries.length === 0) return null;
  const chains = new Map<string, Map<number, ChainRow>>();
  const keys = new Map<string, OptionRef>();
  for (const row of rows) {
    if (!expiries.includes(row.expiry) || (row.option_type !== "CE" && row.option_type !== "PE")) continue;
    const ref: OptionRef = {
      securityId: String(row.security_id),
      feedKey: `NSE_FNO:${row.security_id}`,
      name: row.name,
      strike: row.strike,
      type: row.option_type,
      expiry: row.expiry,
      lotSize: row.lot_size,
      tickSize: row.tick_size,
    };
    let chain = chains.get(row.expiry);
    if (!chain) chains.set(row.expiry, (chain = new Map()));
    const entry = chain.get(row.strike) ?? { strike: row.strike };
    entry[ref.type] = ref;
    chain.set(row.strike, entry);
    keys.set(ref.feedKey, ref);
  }
  const sorted = new Map([...chains].map(([expiry, chain]) => [expiry, [...chain.values()].sort((a, b) => a.strike - b.strike)]));
  return {
    fileDate,
    expiries,
    chain: (expiry) => sorted.get(expiry) ?? [],
    byKey: (feedKey) => keys.get(feedKey),
    contracts: keys.size,
  };
}

/**
 * The contracts for a market day: that day's saved snapshot if there is one, else the instrument
 * file as it is now. `fileDate` is the IST date the instrument file was downloaded for. Null when
 * neither holds an unexpired NIFTY contract.
 */
export async function loadContractBook(
  store: ParquetStore,
  marketDate: string,
  fileDate: string | null,
  underlying = DEFAULT_UNDERLYING,
): Promise<ContractBook | null> {
  const saved = await store.query<ContractRow>((table) => `SELECT * FROM ${table(snapshotKey(marketDate, underlying))}`);
  if (saved.length > 0) return buildContractBook(saved, marketDate, saved[0].file_date);
  if (!fileDate) return null;

  const rows = await store.query<ContractRow>(
    (table) => `SELECT security_id, display_name AS name, strike, option_type,
                       strftime(expiry, '%Y-%m-%d') AS expiry, lot_size, tick_size, CAST($fileDate AS VARCHAR) AS file_date
                FROM ${table(MASTER_KEY)}
                WHERE exchange = 'NSE' AND underlying = $underlying AND instrument = 'OPTIDX'
                  AND expiry >= CAST($marketDate AS DATE)
                ORDER BY expiry, strike, option_type`,
    { underlying, marketDate, fileDate },
  );
  const book = buildContractBook(rows, marketDate, fileDate);
  // Today's file on today's market: keep it, so this day can be replayed after its contracts expire.
  if (book && fileDate === marketDate) {
    const keep = rows.filter((row) => book.expiries.includes(row.expiry));
    await store.write(snapshotKey(marketDate, underlying), SNAPSHOT_COLUMNS, keep as unknown as Record<string, string | number>[]).catch(() => {});
  }
  return book;
}

export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The nearest expiry at least `minDays` away from the market day. */
export function pickExpiry(book: ContractBook, marketDate: string, minDays: number): string | null {
  return book.expiries.find((expiry) => daysBetween(marketDate, expiry) >= minDays) ?? null;
}

/** Index of the strike nearest `spot`; a tie goes to the lower strike. −1 for an empty chain. */
export function atmIndex(chain: readonly ChainRow[], spot: number): number {
  let best = -1;
  for (let i = 0; i < chain.length; i += 1) {
    if (best === -1 || Math.abs(chain[i].strike - spot) < Math.abs(chain[best].strike - spot)) best = i;
  }
  return best;
}

/**
 * The contract to buy: a call for a long signal, a put for a short one, `offset` strikes out of
 * the money (above the spot for a call, below it for a put; negative is in the money).
 */
export function pickContract(chain: readonly ChainRow[], spot: number, direction: 1 | -1, offset: number): OptionRef | null {
  const atm = atmIndex(chain, spot);
  if (atm === -1) return null;
  const type = direction > 0 ? "CE" : "PE";
  return chain[atm + (type === "CE" ? offset : -offset)]?.[type] ?? null;
}

/** Calls and puts within `each` strikes of the money. */
export function windowContracts(chain: readonly ChainRow[], spot: number, each: number): OptionRef[] {
  const atm = atmIndex(chain, spot);
  if (atm === -1) return [];
  const out: OptionRef[] = [];
  for (const row of chain.slice(Math.max(0, atm - each), atm + each + 1)) {
    if (row.CE) out.push(row.CE);
    if (row.PE) out.push(row.PE);
  }
  return out;
}
