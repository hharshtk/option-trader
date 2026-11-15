import type { DuckDBConnection } from "@duckdb/node-api";

// Option contract lookups over the option_scrips DuckDB table, which importOptionScrips builds
// from the CSV that Settings → Option instruments downloads, and importOptionScripsParquet
// rebuilds from the stored copy. Every function takes the connection
// (and the IST date where expiry matters) so tests can run them on an in-memory database;
// option-lookup.ts binds them to the app's database.
//
// Underlyings are named by Dhan's UNDERLYING_SYMBOL ("NIFTY", "SENSEX", "RELIANCE") plus the
// exchange. Don't match options to the feed's index IDs: NIFTY options list underlying ID 26000,
// while the NIFTY index streams as IDX_I:13.

export type OptionType = "CE" | "PE";
export type OptionExchange = "NSE" | "BSE";

export interface OptionContract {
  exchange: OptionExchange;
  /** Exchange segment for orders and the feed: NSE_FNO or BSE_FNO. */
  segment: "NSE_FNO" | "BSE_FNO";
  securityId: string;
  /** "NSE_FNO:35028", the key the live feed and useLiveQuote take. */
  feedKey: string;
  instrument: "OPTIDX" | "OPTSTK";
  underlying: string;
  displayName: string;
  /** "YYYY-MM-DD". */
  expiry: string;
  /** W (weekly) or M (monthly). */
  expiryFlag: string;
  strike: number;
  optionType: OptionType;
  lotSize: number;
  /** Rupees. Dhan's file gives paise (5.0000 = ₹0.05). */
  tickSize: number;
  /** Largest quantity one order may carry; larger orders must be split. Dhan's freeze qty − 1. */
  maxOrderQty: number;
  maxLotsPerOrder: number;
  /** Price band on the download day. */
  upperLimit: number | null;
  lowerLimit: number | null;
}

export interface OptionUnderlying {
  exchange: OptionExchange;
  underlying: string;
  instrument: "OPTIDX" | "OPTSTK";
  nearestExpiry: string;
  expiries: number;
}

export interface ChainStrike {
  strike: number;
  CE?: OptionContract;
  PE?: OptionContract;
}

export interface OptionChainSlice {
  atmStrike: number;
  /** Ascending, atmStrike in the middle when the chain is wide enough. */
  strikes: ChainStrike[];
}

const TABLE = "option_scrips";
const INFO_TABLE = "option_scrips_info";
const STRIKE_EPSILON = 0.001;

/** What the option_scrips table was built from. */
export interface OptionScripsInfo {
  /** IST date of the download; lookups treat the table as current only on this date. */
  tradingDate: string;
  /** IST date Dhan generated its file, from HTTP Last-Modified; null if Dhan didn't say. */
  sourceDate: string | null;
  sourceUpdatedAt: string | null;
  downloadedAt: string;
}

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * Replaces option_scrips with the rows in `csvPath` (the filtered CSV), records `info` beside
 * it, and returns the row count. Both tables change in one transaction, so lookups never see
 * a half-built table or contracts paired with another day's info.
 */
export function importOptionScrips(
  connection: DuckDBConnection,
  csvPath: string,
  info: OptionScripsInfo,
): Promise<number> {
  return replaceTables(
    connection,
    `SELECT
       EXCH_ID AS exchange,
       CASE EXCH_ID WHEN 'NSE' THEN 'NSE_FNO' WHEN 'BSE' THEN 'BSE_FNO' END AS segment,
       SECURITY_ID AS security_id,
       INSTRUMENT AS instrument,
       UNDERLYING_SYMBOL AS underlying,
       UNDERLYING_SECURITY_ID AS underlying_security_id,
       DISPLAY_NAME AS display_name,
       CAST(SM_EXPIRY_DATE AS DATE) AS expiry,
       EXPIRY_FLAG AS expiry_flag,
       CAST(STRIKE_PRICE AS DOUBLE) AS strike,
       OPTION_TYPE AS option_type,
       CAST(CAST(LOT_SIZE AS DOUBLE) AS INTEGER) AS lot_size,
       CAST(TICK_SIZE AS DOUBLE) / 100 AS tick_size,
       CAST(SM_FREEZE_QTY AS BIGINT) - 1 AS max_order_qty,
       TRY_CAST(SM_UPPER_LIMIT AS DOUBLE) AS upper_limit,
       TRY_CAST(SM_LOWER_LIMIT AS DOUBLE) AS lower_limit
     FROM read_csv(${sqlString(csvPath)}, header = true, all_varchar = true)
     ORDER BY exchange, underlying, expiry, strike, option_type`,
    info,
  );
}

/** Saves option_scrips as a zstd Parquet file (about 1.3 MB for a day's contracts). */
export async function exportOptionScripsParquet(connection: DuckDBConnection, parquetPath: string) {
  await connection.run(`COPY ${TABLE} TO ${sqlString(parquetPath)} (FORMAT parquet, COMPRESSION zstd)`);
}

/** Replaces option_scrips with a file exportOptionScripsParquet wrote, like importOptionScrips does. */
export function importOptionScripsParquet(
  connection: DuckDBConnection,
  parquetPath: string,
  info: OptionScripsInfo,
): Promise<number> {
  return replaceTables(connection, `SELECT * FROM read_parquet(${sqlString(parquetPath)})`, info);
}

async function replaceTables(connection: DuckDBConnection, select: string, info: OptionScripsInfo) {
  await connection.run("BEGIN TRANSACTION");
  try {
    await connection.run(`CREATE OR REPLACE TABLE ${TABLE} AS ${select}`);
    await connection.run(
      `CREATE OR REPLACE TABLE ${INFO_TABLE} AS
       SELECT CAST($tradingDate AS DATE) AS trading_date,
              CAST($sourceDate AS DATE) AS source_date,
              CAST($sourceUpdatedAt AS VARCHAR) AS source_updated_at,
              CAST($downloadedAt AS VARCHAR) AS downloaded_at`,
      {
        tradingDate: info.tradingDate,
        sourceDate: info.sourceDate,
        sourceUpdatedAt: info.sourceUpdatedAt,
        downloadedAt: info.downloadedAt,
      },
    );
    await connection.run("COMMIT");
  } catch (error) {
    await connection.run("ROLLBACK").catch(() => {});
    throw error;
  }
  const reader = await connection.runAndReadAll(`SELECT CAST(count(*) AS INTEGER) AS n FROM ${TABLE}`);
  return reader.getRowObjectsJS()[0].n as number;
}

/** What the table was built from, or null if it hasn't been built. */
export async function readOptionScripsInfo(connection: DuckDBConnection): Promise<OptionScripsInfo | null> {
  const exists = await connection.runAndReadAll(
    `SELECT count(*) AS n FROM duckdb_tables() WHERE table_name IN ('${TABLE}', '${INFO_TABLE}')`,
  );
  if (Number(exists.getRowObjectsJS()[0].n) < 2) return null;
  const reader = await connection.runAndReadAll(
    `SELECT strftime(trading_date, '%Y-%m-%d') AS "tradingDate",
            strftime(source_date, '%Y-%m-%d') AS "sourceDate",
            source_updated_at AS "sourceUpdatedAt",
            downloaded_at AS "downloadedAt"
     FROM ${INFO_TABLE} LIMIT 1`,
  );
  return (reader.getRowObjectsJS()[0] as unknown as OptionScripsInfo | undefined) ?? null;
}

const CONTRACT_COLUMNS = `
  exchange,
  segment,
  security_id AS "securityId",
  segment || ':' || security_id AS "feedKey",
  instrument,
  underlying,
  display_name AS "displayName",
  strftime(expiry, '%Y-%m-%d') AS expiry,
  expiry_flag AS "expiryFlag",
  strike,
  option_type AS "optionType",
  lot_size AS "lotSize",
  tick_size AS "tickSize",
  CAST(max_order_qty AS INTEGER) AS "maxOrderQty",
  CAST(floor(max_order_qty / lot_size) AS INTEGER) AS "maxLotsPerOrder",
  upper_limit AS "upperLimit",
  lower_limit AS "lowerLimit"
`;

async function rows<T>(
  connection: DuckDBConnection,
  sql: string,
  values: Record<string, string | number | null>,
): Promise<T[]> {
  const reader = await connection.runAndReadAll(sql, values);
  return reader.getRowObjectsJS() as unknown as T[];
}

/** One contract, or null if it doesn't exist or has expired. */
export async function findOptionContract(
  connection: DuckDBConnection,
  query: { underlying: string; expiry: string; strike: number; optionType: OptionType; exchange?: OptionExchange },
  today: string,
): Promise<OptionContract | null> {
  const [contract] = await rows<OptionContract>(
    connection,
    `SELECT ${CONTRACT_COLUMNS} FROM ${TABLE}
     WHERE exchange = $exchange AND underlying = $underlying AND expiry = CAST($expiry AS DATE)
       AND abs(strike - $strike) < ${STRIKE_EPSILON} AND option_type = $optionType
       AND expiry >= CAST($today AS DATE)`,
    {
      exchange: query.exchange ?? "NSE",
      underlying: query.underlying,
      expiry: query.expiry,
      strike: query.strike,
      optionType: query.optionType,
      today,
    },
  );
  return contract ?? null;
}

/** A contract by Dhan security ID, expired or not, e.g. to describe an open position. */
export async function getOptionContract(
  connection: DuckDBConnection,
  securityId: string,
  exchange?: OptionExchange,
): Promise<OptionContract | null> {
  const [contract] = await rows<OptionContract>(
    connection,
    `SELECT ${CONTRACT_COLUMNS} FROM ${TABLE}
     WHERE security_id = $securityId ${exchange ? "AND exchange = $exchange" : ""}
     ORDER BY exchange DESC LIMIT 1`,
    exchange ? { securityId, exchange } : { securityId },
  );
  return contract ?? null;
}

/** Every underlying with unexpired options, index options first. */
export function listOptionUnderlyings(connection: DuckDBConnection, today: string): Promise<OptionUnderlying[]> {
  return rows<OptionUnderlying>(
    connection,
    `SELECT exchange, underlying, instrument,
            strftime(min(expiry), '%Y-%m-%d') AS "nearestExpiry",
            CAST(count(DISTINCT expiry) AS INTEGER) AS expiries
     FROM ${TABLE} WHERE expiry >= CAST($today AS DATE)
     GROUP BY ALL
     ORDER BY instrument, exchange DESC, underlying`,
    { today },
  );
}

/** Unexpired expiries, nearest first. */
export function listOptionExpiries(
  connection: DuckDBConnection,
  underlying: string,
  today: string,
  exchange: OptionExchange = "NSE",
): Promise<{ expiry: string; expiryFlag: string }[]> {
  return rows(
    connection,
    `SELECT strftime(expiry, '%Y-%m-%d') AS expiry, max(expiry_flag) AS "expiryFlag"
     FROM ${TABLE}
     WHERE exchange = $exchange AND underlying = $underlying AND expiry >= CAST($today AS DATE)
     GROUP BY expiry ORDER BY expiry`,
    { exchange, underlying, today },
  );
}

/** Strikes listed for an expiry, ascending. */
export async function listOptionStrikes(
  connection: DuckDBConnection,
  underlying: string,
  expiry: string,
  exchange: OptionExchange = "NSE",
): Promise<number[]> {
  const result = await rows<{ strike: number }>(
    connection,
    `SELECT DISTINCT strike FROM ${TABLE}
     WHERE exchange = $exchange AND underlying = $underlying AND expiry = CAST($expiry AS DATE)
     ORDER BY strike`,
    { exchange, underlying, expiry },
  );
  return result.map((row) => row.strike);
}

/** The strike nearest `spot`; a tie goes to the lower strike. Null if `strikes` is empty. */
export function nearestStrike(strikes: number[], spot: number): number | null {
  let best: number | null = null;
  for (const strike of strikes) {
    if (best === null || Math.abs(strike - spot) < Math.abs(best - spot)) best = strike;
  }
  return best;
}

/**
 * The ATM strike for `spot` and `strikesEachSide` strikes either side of it, with CE and PE
 * contracts. Null if the expiry has no strikes (unknown, expired, or not downloaded).
 */
export async function optionChainAround(
  connection: DuckDBConnection,
  query: { underlying: string; expiry: string; spot: number; strikesEachSide: number; exchange?: OptionExchange },
  today: string,
): Promise<OptionChainSlice | null> {
  const exchange = query.exchange ?? "NSE";
  if (query.expiry < today) return null;
  const strikes = await listOptionStrikes(connection, query.underlying, query.expiry, exchange);
  const atmStrike = nearestStrike(strikes, query.spot);
  if (atmStrike === null) return null;

  const at = strikes.indexOf(atmStrike);
  const each = Math.max(0, Math.floor(query.strikesEachSide));
  const wanted = strikes.slice(Math.max(0, at - each), at + each + 1);
  const contracts = await rows<OptionContract>(
    connection,
    `SELECT ${CONTRACT_COLUMNS} FROM ${TABLE}
     WHERE exchange = $exchange AND underlying = $underlying AND expiry = CAST($expiry AS DATE)
       AND strike BETWEEN $low - ${STRIKE_EPSILON} AND $high + ${STRIKE_EPSILON}
     ORDER BY strike, option_type`,
    { exchange, underlying: query.underlying, expiry: query.expiry, low: wanted[0], high: wanted.at(-1)! },
  );

  const byStrike = new Map<number, ChainStrike>(wanted.map((strike) => [strike, { strike }]));
  for (const contract of contracts) {
    const entry = byStrike.get(contract.strike);
    if (entry) entry[contract.optionType] = contract;
  }
  return { atmStrike, strikes: [...byStrike.values()] };
}

/** Every strike listed for an expiry, ascending, with its CE and PE contracts. */
export async function listOptionChain(
  connection: DuckDBConnection,
  underlying: string,
  expiry: string,
  exchange: OptionExchange = "NSE",
): Promise<ChainStrike[]> {
  const contracts = await rows<OptionContract>(
    connection,
    `SELECT ${CONTRACT_COLUMNS} FROM ${TABLE}
     WHERE exchange = $exchange AND underlying = $underlying AND expiry = CAST($expiry AS DATE)
     ORDER BY strike, option_type`,
    { exchange, underlying, expiry },
  );
  const byStrike = new Map<number, ChainStrike>();
  for (const contract of contracts) {
    const entry = byStrike.get(contract.strike) ?? { strike: contract.strike };
    entry[contract.optionType] = contract;
    byStrike.set(contract.strike, entry);
  }
  return [...byStrike.values()];
}
