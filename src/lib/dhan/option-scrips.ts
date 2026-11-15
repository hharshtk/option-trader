// Filters Dhan's detailed instrument master down to the options this app trades.
// Source and column meanings: dhanhq.co/docs/v2/instruments/. Pure functions only, so tests
// can run them without the server; downloading and storing live in option-scrips-store.ts.

export const SCRIP_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv";

/** Index and stock options on NSE and BSE. MCX and currency options are left out. */
const OPTION_INSTRUMENTS = new Set(["OPTIDX", "OPTSTK"]);
const OPTION_EXCHANGES = new Set(["NSE", "BSE"]);

const REQUIRED_COLUMNS = [
  "EXCH_ID",
  "SEGMENT",
  "SECURITY_ID",
  "INSTRUMENT",
  "UNDERLYING_SECURITY_ID",
  "UNDERLYING_SYMBOL",
  "DISPLAY_NAME",
  "LOT_SIZE",
  "SM_EXPIRY_DATE",
  "STRIKE_PRICE",
  "OPTION_TYPE",
  "TICK_SIZE",
  "EXPIRY_FLAG",
  "SM_FREEZE_QTY",
] as const;

type Column = (typeof REQUIRED_COLUMNS)[number];

export interface OptionScripSummary {
  /** Rows in Dhan's full file, header excluded. */
  sourceRows: number;
  optionRows: number;
  /** Rows per exchange and instrument, e.g. { NSE: { OPTIDX: 13537, OPTSTK: 78088 } }. */
  byExchange: Record<string, Record<string, number>>;
  underlyings: number;
  /** Nearest expiry per index underlying, keyed "NSE:NIFTY". */
  nearestIndexExpiry: Record<string, string>;
  /** Rows that had the wrong number of fields and were skipped. */
  malformedRows: number;
}

export interface FilteredOptionScrips {
  /** Dhan's header line followed by the kept rows, unchanged. */
  csv: string;
  summary: OptionScripSummary;
}

/**
 * Keeps unexpired NSE/BSE index and stock options. `today` is the IST date as "YYYY-MM-DD";
 * contracts expiring today stay in. Throws if the header is missing a column this app reads.
 */
export function filterOptionScrips(text: string, today: string): FilteredOptionScrips {
  const lines = text.split(/\r?\n/);
  const header = lines[0] ?? "";
  // Every row ends with a comma, so the last field name is empty; keep it so counts line up.
  const names = header.split(",");
  const missing = REQUIRED_COLUMNS.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(`Dhan's instrument file is missing columns: ${missing.join(", ")}`);
  }
  const col = Object.fromEntries(REQUIRED_COLUMNS.map((name) => [name, names.indexOf(name)])) as Record<
    Column,
    number
  >;

  const kept: string[] = [header];
  const byExchange: Record<string, Record<string, number>> = {};
  const underlyings = new Set<string>();
  const nearestIndexExpiry: Record<string, string> = {};
  let sourceRows = 0;
  let malformedRows = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    sourceRows += 1;

    const fields = line.split(",");
    if (fields.length !== names.length) {
      malformedRows += 1;
      continue;
    }

    const exchange = fields[col.EXCH_ID];
    const instrument = fields[col.INSTRUMENT];
    const expiry = fields[col.SM_EXPIRY_DATE];
    if (
      !OPTION_EXCHANGES.has(exchange) ||
      fields[col.SEGMENT] !== "D" ||
      !OPTION_INSTRUMENTS.has(instrument) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(expiry) ||
      expiry < today
    ) {
      continue;
    }

    kept.push(line);
    const counts = (byExchange[exchange] ??= {});
    counts[instrument] = (counts[instrument] ?? 0) + 1;

    const underlying = `${exchange}:${fields[col.UNDERLYING_SYMBOL]}`;
    underlyings.add(underlying);
    if (instrument === "OPTIDX") {
      const nearest = nearestIndexExpiry[underlying];
      if (nearest === undefined || expiry < nearest) nearestIndexExpiry[underlying] = expiry;
    }
  }

  if (sourceRows > 0 && malformedRows > sourceRows / 100) {
    throw new Error(`${malformedRows} of ${sourceRows} rows in Dhan's instrument file had the wrong number of fields`);
  }

  return {
    csv: `${kept.join("\n")}\n`,
    summary: {
      sourceRows,
      optionRows: kept.length - 1,
      byExchange,
      underlyings: underlyings.size,
      nearestIndexExpiry,
      malformedRows,
    },
  };
}
