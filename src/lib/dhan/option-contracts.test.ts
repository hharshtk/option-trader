import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  exportOptionScripsParquet,
  findOptionContract,
  getOptionContract,
  importOptionScrips,
  importOptionScripsParquet,
  listOptionExpiries,
  listOptionStrikes,
  listOptionUnderlyings,
  nearestStrike,
  optionChainAround,
  readOptionScripsInfo,
} from "./option-contracts.ts";

const HEADER =
  "EXCH_ID,SEGMENT,SECURITY_ID,ISIN,INSTRUMENT,UNDERLYING_SECURITY_ID,UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,INSTRUMENT_TYPE,SERIES,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE,EXPIRY_FLAG,BRACKET_FLAG,COVER_FLAG,ASM_GSM_FLAG,ASM_GSM_CATEGORY,BUY_SELL_INDICATOR,BUY_CO_MIN_MARGIN_PER,BUY_CO_SL_RANGE_MAX_PERC,BUY_CO_SL_RANGE_MIN_PERC,BUY_BO_MIN_MARGIN_PER,BUY_BO_PROFIT_RANGE_MAX_PERC,BUY_BO_PROFIT_RANGE_MIN_PERC,MTF_LEVERAGE,SM_UPPER_LIMIT,SM_LOWER_LIMIT,SM_FREEZE_QTY,";

let id = 1000;
function row(exchange: string, instrument: string, underlying: string, expiry: string, strike: number, type: string, flag = "W", lot = 65, freeze = 1756) {
  id += 1;
  const name = `${underlying} ${expiry} ${strike} ${type === "CE" ? "CALL" : "PUT"}`;
  return `${exchange},D,${id},NA,${instrument},26000,${underlying},X,${name},OP,NA,${lot}.0,${expiry},${strike.toFixed(5)},${type},5.0000,${flag},N,N,N,NA,A,0,0,0,0,0,0,0,120.5000,0.0500,${freeze},`;
}

const rows = [HEADER];
for (const expiry of ["2026-11-10", "2026-11-17", "2026-11-24"]) {
  for (const strike of [24900, 24950, 25000, 25050, 25100]) {
    for (const type of ["CE", "PE"]) rows.push(row("NSE", "OPTIDX", "NIFTY", expiry, strike, type));
  }
}
rows.push(row("NSE", "OPTIDX", "NIFTY", "2026-11-24", 25150, "CE")); // a strike listed only as a call
rows.push(row("BSE", "OPTIDX", "SENSEX", "2026-11-19", 82000, "CE", "W", 20, 1001));
rows.push(row("NSE", "OPTSTK", "RELIANCE", "2026-11-26", 1312.5, "PE", "M", 500, 100000001));

const TODAY = "2026-11-17";
const INFO = {
  tradingDate: TODAY,
  sourceDate: "2026-11-16",
  sourceUpdatedAt: "2026-11-16T02:50:07.000Z",
  downloadedAt: "2026-11-17T02:30:00.000Z",
};
let dir: string;
let db: DuckDBConnection;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "option-contracts-"));
  const csv = path.join(dir, "it's options.csv"); // the quote checks path escaping
  await writeFile(csv, `${rows.join("\n")}\n`);
  db = await (await DuckDBInstance.create(":memory:")).connect();
  assert.equal(await readOptionScripsInfo(db), null);
  assert.equal(await importOptionScrips(db, csv, INFO), rows.length - 1);
});

after(async () => {
  db?.closeSync();
  await rm(dir, { recursive: true, force: true });
});

test("finds a contract with order-ready fields", async () => {
  const contract = await findOptionContract(db, { underlying: "NIFTY", expiry: "2026-11-17", strike: 25000, optionType: "CE" }, TODAY);
  assert.ok(contract);
  assert.equal(contract.segment, "NSE_FNO");
  assert.equal(contract.feedKey, `NSE_FNO:${contract.securityId}`);
  assert.equal(contract.expiry, "2026-11-17");
  assert.equal(contract.strike, 25000);
  assert.equal(contract.lotSize, 65);
  assert.equal(contract.tickSize, 0.05);
  assert.equal(contract.maxOrderQty, 1755);
  assert.equal(contract.maxLotsPerOrder, 27);
  assert.equal(contract.upperLimit, 120.5);
});

test("BSE, fractional strikes, and expired or unknown contracts", async () => {
  const sensex = await findOptionContract(db, { exchange: "BSE", underlying: "SENSEX", expiry: "2026-11-19", strike: 82000, optionType: "CE" }, TODAY);
  assert.equal(sensex?.segment, "BSE_FNO");
  assert.equal(sensex?.maxLotsPerOrder, 50);
  const reliance = await findOptionContract(db, { underlying: "RELIANCE", expiry: "2026-11-26", strike: 1312.5, optionType: "PE" }, TODAY);
  assert.equal(reliance?.instrument, "OPTSTK");
  assert.equal(await findOptionContract(db, { underlying: "SENSEX", expiry: "2026-11-19", strike: 82000, optionType: "CE" }, TODAY), null);
  assert.equal(await findOptionContract(db, { underlying: "NIFTY", expiry: "2026-11-10", strike: 25000, optionType: "CE" }, TODAY), null);
  assert.equal(await findOptionContract(db, { underlying: "NIFTY", expiry: "2026-11-17", strike: 25025, optionType: "CE" }, TODAY), null);
});

test("looks a contract up by security ID, expired or not", async () => {
  const expired = await findOptionContract(db, { underlying: "NIFTY", expiry: "2026-11-17", strike: 24900, optionType: "PE" }, "2026-11-01");
  assert.ok(expired);
  assert.deepEqual(await getOptionContract(db, expired.securityId), expired);
  assert.equal(await getOptionContract(db, "999999"), null);
});

test("lists underlyings, expiries and strikes", async () => {
  assert.deepEqual(await listOptionUnderlyings(db, TODAY), [
    { exchange: "NSE", underlying: "NIFTY", instrument: "OPTIDX", nearestExpiry: "2026-11-17", expiries: 2 },
    { exchange: "BSE", underlying: "SENSEX", instrument: "OPTIDX", nearestExpiry: "2026-11-19", expiries: 1 },
    { exchange: "NSE", underlying: "RELIANCE", instrument: "OPTSTK", nearestExpiry: "2026-11-26", expiries: 1 },
  ]);
  assert.deepEqual(await listOptionExpiries(db, "NIFTY", TODAY), [
    { expiry: "2026-11-17", expiryFlag: "W" },
    { expiry: "2026-11-24", expiryFlag: "W" },
  ]);
  assert.deepEqual(await listOptionStrikes(db, "NIFTY", "2026-11-24"), [24900, 24950, 25000, 25050, 25100, 25150]);
});

test("nearest strike breaks ties downward", () => {
  assert.equal(nearestStrike([24900, 24950, 25000], 24974), 24950);
  assert.equal(nearestStrike([24900, 24950, 25000], 24975), 24950);
  assert.equal(nearestStrike([24900, 24950, 25000], 24976), 25000);
  assert.equal(nearestStrike([], 25000), null);
});

test("chain slice around the ATM strike", async () => {
  const chain = await optionChainAround(db, { underlying: "NIFTY", expiry: "2026-11-24", spot: 25060, strikesEachSide: 1 }, TODAY);
  assert.ok(chain);
  assert.equal(chain.atmStrike, 25050);
  assert.deepEqual(chain.strikes.map((s) => [s.strike, s.CE?.optionType, s.PE?.optionType]), [
    [25000, "CE", "PE"],
    [25050, "CE", "PE"],
    [25100, "CE", "PE"],
  ]);

  const edge = await optionChainAround(db, { underlying: "NIFTY", expiry: "2026-11-24", spot: 26000, strikesEachSide: 2 }, TODAY);
  assert.deepEqual(edge?.strikes.map((s) => [s.strike, Boolean(s.CE), Boolean(s.PE)]), [
    [25050, true, true],
    [25100, true, true],
    [25150, true, false],
  ]);

  assert.equal(await optionChainAround(db, { underlying: "NIFTY", expiry: "2026-11-10", spot: 25000, strikesEachSide: 2 }, TODAY), null);
  assert.equal(await optionChainAround(db, { underlying: "NOPE", expiry: "2026-11-24", spot: 25000, strikesEachSide: 2 }, TODAY), null);
});

test("records what the table was built from, and keeps it when an import fails", async () => {
  assert.deepEqual(await readOptionScripsInfo(db), INFO);
  await assert.rejects(
    importOptionScrips(db, path.join(dir, "missing.csv"), { ...INFO, tradingDate: "2026-11-18", sourceDate: null, sourceUpdatedAt: null }),
  );
  assert.deepEqual(await readOptionScripsInfo(db), INFO);
  assert.ok(await findOptionContract(db, { underlying: "NIFTY", expiry: "2026-11-17", strike: 25000, optionType: "CE" }, TODAY));
});

test("a Parquet copy reloads into an identical table", async () => {
  const file = path.join(dir, "options.parquet");
  await exportOptionScripsParquet(db, file);
  const fresh = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    assert.equal(await importOptionScripsParquet(fresh, file, INFO), rows.length - 1);
    assert.deepEqual(await readOptionScripsInfo(fresh), INFO);
    const query = { underlying: "NIFTY", expiry: "2026-11-24", spot: 25060, strikesEachSide: 2 };
    assert.deepEqual(await optionChainAround(fresh, query, TODAY), await optionChainAround(db, query, TODAY));
    assert.deepEqual(await listOptionUnderlyings(fresh, TODAY), await listOptionUnderlyings(db, TODAY));
  } finally {
    fresh.closeSync();
  }
});
