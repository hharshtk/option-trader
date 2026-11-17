// The trader's parts on their own: fill prices, the decision gate's rules, contract picking, the
// run log and the settings check.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getParquetStore } from "../../lib/db/parquet-store.ts";
import { DEFAULT_TRADING_CONFIG, mergeTradingConfig, type OptionRef, type Order, type Position } from "../../lib/engine/trading.ts";
import { NO_CHARGES } from "../../lib/trading/charges.ts";
import { atmIndex, buildContractBook, loadContractBook, MASTER_KEY, pickContract, pickExpiry, windowContracts } from "./contracts.ts";
import { decisionKey, judge, QUESTIONS, readAnswers } from "./decision.ts";
import type { MarketQuote } from "./market.ts";
import { fillPrice } from "./paper-broker.ts";
import { foldRunRecords, openRunLog, readRunLog } from "./run-log.ts";

const CONTRACT: OptionRef = { securityId: "1", feedKey: "NSE_FNO:1", name: "NIFTY 17 NOV 25900 CALL", strike: 25900, type: "CE", expiry: "2026-11-17", lotSize: 65, tickSize: 0.05 };
const FILLS = DEFAULT_TRADING_CONFIG.fills;
const quote = (extra: Partial<MarketQuote>): MarketQuote => ({ key: "NSE_FNO:1", ltp: 100, at: 1, bid: null, ask: null, bidQty: null, askQty: null, oi: null, volume: null, candleOpen: null, ...extra });
const order = (side: "BUY" | "SELL", reason: Order["reason"] = "entry", trigger: number | null = null) => ({ side, reason, trigger, contract: CONTRACT });

test("with a book, a buy pays the ask and a sell gets the bid, each a tick worse", () => {
  const book = quote({ ltp: 100, bid: 99.9, ask: 100.1 });
  assert.deepEqual(fillPrice(order("BUY"), book, FILLS), { price: 100.15, source: "book" });
  assert.deepEqual(fillPrice(order("SELL", "time"), book, FILLS), { price: 99.85, source: "book" });
});

test("with only a last price, the wider slippage stands in for the spread", () => {
  assert.deepEqual(fillPrice(order("BUY"), quote({ ltp: 100 }), FILLS), { price: 100.5, source: "ltp" });
  assert.deepEqual(fillPrice(order("SELL", "time"), quote({ ltp: 100 }), FILLS), { price: 99.5, source: "ltp" });
});

test("prices round to the tick against the trader, and never below one tick", () => {
  const fills = { ...FILLS, slippage: 0.02 };
  assert.equal(fillPrice(order("BUY"), quote({ bid: 85.2, ask: 85.2 }), fills).price, 85.25);
  assert.equal(fillPrice(order("SELL", "time"), quote({ bid: 85.2, ask: 85.2 }), fills).price, 85.15);
  assert.equal(fillPrice(order("SELL", "time"), quote({ ltp: 0.1 }), FILLS).price, 0.05);
});

test("against a candle, a stop fills at its level, or at the open when the minute started beyond it", () => {
  // The low tick of a minute that opened at 100: the stop at 80 was crossed on the way down.
  assert.deepEqual(fillPrice(order("SELL", "stop", 80), quote({ ltp: 75, candleOpen: 100 }), FILLS), { price: 79.5, source: "candle" });
  // The minute opened below the stop: no better price was ever there.
  assert.equal(fillPrice(order("SELL", "stop", 80), quote({ ltp: 70, candleOpen: 70 }), FILLS).price, 69.5);
  // A target is the mirror image.
  assert.equal(fillPrice(order("SELL", "target", 130), quote({ ltp: 140, candleOpen: 100 }), FILLS).price, 129.5);
  assert.equal(fillPrice(order("SELL", "target", 130), quote({ ltp: 135, candleOpen: 135 }), FILLS).price, 134.5);
  // Anything else fills at the close just seen.
  assert.equal(fillPrice(order("SELL", "time"), quote({ ltp: 110, candleOpen: 100 }), FILLS).price, 109.5);
});

test("the gate passes a trade on probability and turns it down against the regime", () => {
  const config = DEFAULT_TRADING_CONFIG.decision;
  const answer = { probability: 0.7, regime: "trend_up", regimeProbabilities: null, quality: 0.5, model: "m", inputTokens: 1, cost: 0 };
  assert.equal(judge(answer, 1, config).approved, true);
  assert.deepEqual(judge({ ...answer, probability: 0.5 }, 1, config), { approved: false, reason: "Probability 0.50 is below 0.55" });
  assert.match(judge(answer, -1, config).reason, /Against the regime \(trend up\)/);
  assert.equal(judge(answer, -1, { ...config, vetoAgainstRegime: false }).approved, true);
  assert.equal(judge({ ...answer, regime: "range" }, -1, config).approved, true);
});

test("answers are read from the API's reply; a refusal or a missing probability is an error", () => {
  const reply = {
    answers: {
      take_trade: { type: "noul", noul: 0.62 },
      regime: { type: "choice", choice: "range", probabilities: { range: 0.8, chop: 0.2 } },
      quality: { type: "score", score: 1.5 },
    },
    model: "perplexity/pplx-decider",
    usage: { inputTokens: 437, cost: 0 },
  };
  assert.deepEqual(readAnswers(reply), { probability: 0.62, regime: "range", regimeProbabilities: { range: 0.8, chop: 0.2 }, quality: 0.75, model: "perplexity/pplx-decider", inputTokens: 437, cost: 0 });
  assert.throws(() => readAnswers({ answers: { take_trade: { type: "refusal" } } }), /declined/);
  assert.throws(() => readAnswers({ answers: {} }), /no probability/);
  assert.equal(readAnswers({ answers: { take_trade: { type: "noul", noul: 1 } } }).regime, null);
  assert.deepEqual(Object.keys(QUESTIONS), ["take_trade", "regime", "quality"]);
});

test("a proposal's key separates minutes, directions, contracts and models", () => {
  const base = { model: "m", minute: 1, direction: 1 as const, signal: "agree", securityId: "1" };
  const keys = new Set([decisionKey(base), decisionKey({ ...base, minute: 2 }), decisionKey({ ...base, direction: -1 }), decisionKey({ ...base, securityId: "2" }), decisionKey({ ...base, model: "n" })]);
  assert.equal(keys.size, 5);
});

function rows(fileDate: string) {
  const out = [];
  for (const expiry of ["2026-11-17", "2026-11-23", "2026-12-01", "2026-12-08"]) {
    for (let strike = 25800; strike <= 26000; strike += 50) {
      for (const type of ["CE", "PE"]) out.push({ security_id: `${expiry.slice(5, 7)}${expiry.slice(8)}${strike}${type === "CE" ? 1 : 2}`, name: `NIFTY ${expiry} ${strike} ${type}`, strike, option_type: type, expiry, lot_size: 65, tick_size: 0.05, file_date: fileDate });
    }
  }
  return out;
}

test("contracts: the nearest expiries, the strike at the money, and offsets out of the money", () => {
  const book = buildContractBook(rows("2026-11-16"), "2026-11-16", "2026-11-16")!;
  assert.deepEqual(book.expiries, ["2026-11-17", "2026-11-23", "2026-12-01"]);
  assert.equal(pickExpiry(book, "2026-11-16", 0), "2026-11-17");
  assert.equal(pickExpiry(book, "2026-11-16", 2), "2026-11-23");
  assert.equal(pickExpiry(book, "2026-11-16", 60), null);
  const chain = book.chain("2026-11-17");
  assert.equal(chain[atmIndex(chain, 25_926)].strike, 25_950);
  assert.equal(chain[atmIndex(chain, 25_925)].strike, 25_900, "a tie goes to the lower strike");
  assert.deepEqual([pickContract(chain, 25_905, 1, 0)?.strike, pickContract(chain, 25_905, 1, 0)?.type], [25_900, "CE"]);
  assert.deepEqual([pickContract(chain, 25_905, 1, 1)?.strike, pickContract(chain, 25_905, -1, 1)?.strike], [25_950, 25_850]);
  assert.equal(pickContract(chain, 25_905, 1, 5), null);
  assert.equal(windowContracts(chain, 25_905, 1).length, 6);
  assert.equal(book.byKey("NSE_FNO:111725900" + "1")?.strike, 25_900);
  // A day after the nearest expiry, that expiry is gone.
  assert.deepEqual(buildContractBook(rows("2026-11-16"), "2026-11-18", "2026-11-16")!.expiries[0], "2026-11-23");
  assert.equal(buildContractBook([], "2026-11-16", "2026-11-16"), null);
});

test("contracts load from the instrument file, and a live day's are kept for later replays", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "contracts-test-"));
  try {
    const store = getParquetStore(root);
    // The instrument file as the app stores it, with an expiry column of type DATE.
    const { withDb } = await import("../../lib/db/duckdb.ts");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(store.url(MASTER_KEY)), { recursive: true });
    await withDb((db) =>
      db.run(`COPY (
        SELECT 'NSE' AS exchange, 'NIFTY' AS underlying, 'OPTIDX' AS instrument, CAST(100 + i AS VARCHAR) AS security_id,
               'NIFTY 17 NOV ' || (25800 + 50 * (i // 2)) || (CASE WHEN i % 2 = 0 THEN ' CALL' ELSE ' PUT' END) AS display_name,
               CAST(25800 + 50 * (i // 2) AS DOUBLE) AS strike, CASE WHEN i % 2 = 0 THEN 'CE' ELSE 'PE' END AS option_type,
               DATE '2026-11-17' AS expiry, 65 AS lot_size, 0.05 AS tick_size
        FROM range(10) t(i)
        UNION ALL SELECT 'NSE', 'BANKNIFTY', 'OPTIDX', '999', 'BANKNIFTY', 50000.0, 'CE', DATE '2026-11-24', 30, 0.05
      ) TO '${store.url(MASTER_KEY)}' (FORMAT parquet)`),
    );

    const book = await loadContractBook(store, "2026-11-17", "2026-11-17");
    assert.equal(book?.contracts, 10);
    assert.equal(book?.fileDate, "2026-11-17");
    assert.equal(book?.chain("2026-11-17")[0].CE?.name, "NIFTY 17 NOV 25800 CALL");

    // After the expiry the file no longer lists them, but the day's snapshot does.
    assert.equal(await loadContractBook(store, "2026-11-18", "2026-11-18"), null);
    const later = await loadContractBook(store, "2026-11-17", "2026-11-25");
    assert.equal(later?.contracts, 10);
    assert.equal(later?.fileDate, "2026-11-17");
    assert.equal(await loadContractBook(store, "2026-11-17", null).then((b) => b?.contracts), 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run's log folds back to where the run was, and survives a cut-off last line", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-log-test-"));
  try {
    const file = path.join(root, "runs", "live-2026-11-16.jsonl");
    const log = openRunLog(file, (error) => assert.fail(error));
    const position = { id: "p1", status: "opening", book: "paper", entryCharges: NO_CHARGES } as unknown as Position;
    log.append({ kind: "run", run: { id: "live-2026-11-16", namespace: "test", mode: "paper", source: "live", date: "2026-11-16", startedAt: 1, endedAt: null, resumed: false } });
    log.append({ kind: "position", position });
    log.append({ kind: "position", position: { ...position, status: "open" } });
    log.append({ kind: "position", position: { ...position, id: "p2" } });
    log.append({ kind: "trade", trade: { id: "p2", net: 12 } as never });
    log.append({ kind: "halt", halt: { reason: "limit", at: 5 } });
    await log.close();
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, '{"kind":"trade","trade":{"id":"p1"');

    const state = await readRunLog(file);
    assert.equal(state?.run?.id, "live-2026-11-16");
    assert.deepEqual(state?.positions.map((p) => [p.id, p.status]), [["p1", "open"]]);
    assert.deepEqual(state?.trades.map((t) => t.id), ["p2"]);
    assert.deepEqual(state?.halt, { reason: "limit", at: 5 });
    assert.equal(await readRunLog(path.join(root, "runs", "none.jsonl")), null);
    assert.equal(foldRunRecords([]).run, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settings: a patch changes only what it names, and bad values are refused with the reason", () => {
  const merged = mergeTradingConfig(DEFAULT_TRADING_CONFIG, { strategy: { lots: 2, signal: "breadth" }, decision: { mode: "shadow" } });
  assert.ok(merged.ok);
  if (!merged.ok) return;
  assert.equal(merged.config.strategy.lots, 2);
  assert.equal(merged.config.strategy.signal, "breadth");
  assert.equal(merged.config.strategy.holdMinutes, DEFAULT_TRADING_CONFIG.strategy.holdMinutes);
  assert.equal(merged.config.decision.mode, "shadow");
  assert.equal(DEFAULT_TRADING_CONFIG.strategy.lots, 1, "the defaults are not touched");

  const bad = mergeTradingConfig(DEFAULT_TRADING_CONFIG, { strategy: { lots: 0.5, signal: "rsi" }, risk: { entryFrom: "15:00" }, mode: "live" });
  assert.ok(!bad.ok);
  if (bad.ok) return;
  assert.match(bad.message, /Lots must be a whole number from 1 to 50/);
  assert.match(bad.message, /Signal must be one of/);
  assert.match(bad.message, /Entries must start before they end/);
  assert.match(bad.message, /Only paper trading is built/);
  assert.equal(mergeTradingConfig(DEFAULT_TRADING_CONFIG, "nope").ok, false);
  // Unknown fields are ignored, not stored.
  const extra = mergeTradingConfig(DEFAULT_TRADING_CONFIG, { strategy: { leverage: 10 }, secret: 1 });
  assert.ok(extra.ok && !("leverage" in extra.config.strategy) && !("secret" in extra.config));
});
