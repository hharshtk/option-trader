import assert from "node:assert/strict";
import { test } from "node:test";
import { filterOptionScrips } from "./option-scrips.ts";

const HEADER =
  "EXCH_ID,SEGMENT,SECURITY_ID,ISIN,INSTRUMENT,UNDERLYING_SECURITY_ID,UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,INSTRUMENT_TYPE,SERIES,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE,EXPIRY_FLAG,SM_FREEZE_QTY,";

const row = (exchange: string, segment: string, id: number, instrument: string, underlying: string, expiry: string) =>
  `${exchange},${segment},${id},NA,${instrument},26000,${underlying},X,${underlying} OPT,OP,NA,65.0,${expiry},25000.00000,CE,5.0000,W,1756,`;

test("keeps unexpired NSE/BSE index and stock options, unchanged", () => {
  const nifty = row("NSE", "D", 1, "OPTIDX", "NIFTY", "2026-11-17");
  const niftyLater = row("NSE", "D", 2, "OPTIDX", "NIFTY", "2026-12-01");
  const sensex = row("BSE", "D", 3, "OPTIDX", "SENSEX", "2026-11-19");
  const stock = row("NSE", "D", 4, "OPTSTK", "RELIANCE", "2026-11-26");
  const text = [
    HEADER,
    niftyLater,
    nifty,
    sensex,
    stock,
    row("NSE", "D", 5, "OPTIDX", "NIFTY", "2026-11-10"), // expired
    row("NSE", "D", 6, "FUTIDX", "NIFTY", "2026-11-23"), // future
    row("MCX", "M", 7, "OPTFUT", "CRUDEOIL", "2026-11-17"), // commodity
    row("NSE", "C", 8, "OPTCUR", "USDINR", "2026-11-17"), // currency
    "",
  ].join("\r\n");

  const { csv, summary } = filterOptionScrips(text, "2026-11-17");
  assert.equal(csv, [HEADER, niftyLater, nifty, sensex, stock, ""].join("\n"));
  assert.deepEqual(summary, {
    sourceRows: 8,
    optionRows: 4,
    byExchange: { NSE: { OPTIDX: 2, OPTSTK: 1 }, BSE: { OPTIDX: 1 } },
    underlyings: 3,
    nearestIndexExpiry: { "NSE:NIFTY": "2026-11-17", "BSE:SENSEX": "2026-11-19" },
    malformedRows: 0,
  });
});

test("rejects a file without the columns the app reads", () => {
  assert.throws(() => filterOptionScrips("EXCH_ID,SEGMENT\nNSE,D\n", "2026-11-17"), /missing columns: SECURITY_ID/);
});

test("rejects a file with many malformed rows", () => {
  const text = [HEADER, "NSE,D,1,too,few", row("NSE", "D", 2, "OPTIDX", "NIFTY", "2026-11-17")].join("\n");
  assert.throws(() => filterOptionScrips(text, "2026-11-17"), /wrong number of fields/);
});
