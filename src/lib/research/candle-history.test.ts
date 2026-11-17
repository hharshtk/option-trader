import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getParquetStore } from "../db/parquet-store.ts";
import { downloadMonth, historyKey, historyUniverse, monthRange, monthsBetween, toRows } from "./candle-history.ts";

const sec = (value: string) => Date.parse(`${value}+05:30`) / 1000;

test("months and request ranges", () => {
  assert.deepEqual(monthsBetween("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(monthRange("2025-12"), { fromDate: "2025-12-01", toDate: "2026-01-01" });
  assert.deepEqual(monthRange("2026-11"), { fromDate: "2026-11-01", toDate: "2026-12-01" });
});

test("the universe: four indices and the NIFTY and BANKNIFTY stocks, each once", () => {
  const universe = historyUniverse();
  const keys = universe.map((i) => i.key);
  assert.equal(keys.length, new Set(keys).size);
  assert.ok(keys.includes("IDX_I:13") && keys.includes("IDX_I:21") && keys.includes("NSE_EQ:1333") && keys.includes("NSE_EQ:10666"));
  assert.equal(universe.find((i) => i.key === "IDX_I:21")!.instrument, "INDEX");
  assert.equal(universe.find((i) => i.key === "NSE_EQ:1333")!.instrument, "EQUITY");
});

test("rows keep the month and 09:00–15:30 IST only", () => {
  const timestamp = [sec("2026-10-31T15:29:00"), sec("2026-11-02T08:59:00"), sec("2026-11-02T09:15:00"), sec("2026-11-02T15:29:00"), sec("2026-11-02T15:30:00")];
  const rows = toRows("IDX_I:13", "2026-11", { timestamp, open: [1, 2, 3, 4, 5], high: [1, 2, 3, 4, 5], low: [1, 2, 3, 4, 5], close: [1, 2, 3, 4, 5], volume: [0, 0, 7, 8, 9] } as never);
  assert.deepEqual(rows.map((r) => r.close), [3, 4]);
  assert.equal(rows[0].t, sec("2026-11-02T09:15:00") * 1000);
  assert.equal(rows[0].volume, 7);
});

test("a month is written as one file; failures are reported and left out", async () => {
  const store = getParquetStore(mkdtempSync(path.join(tmpdir(), "history-")));
  const universe = historyUniverse().slice(0, 3);
  const result = await downloadMonth("2026-11", universe, {
    store,
    fetchCandles: async (request) => {
      if (request.securityId === "21") throw new Error("Dhan said no\nmore");
      assert.equal(request.fromDate, "2026-11-01");
      assert.equal(request.interval, "1");
      const t = sec("2026-11-02T09:15:00");
      return { timestamp: [t, t + 60], open: [10, 11], high: [12, 13], low: [9, 10], close: [11, 12], volume: [100, 200] } as never;
    },
  });
  assert.deepEqual(result.failed, [{ key: "IDX_I:21", error: "Dhan said no" }]);
  assert.equal(result.rows, 4);
  assert.equal(result.instruments, 2);
  assert.equal(result.days, 1);
  const stored = await store.query<{ key: string; n: number }>(
    (table) => `SELECT key, CAST(count(*) AS INTEGER) AS n FROM ${table(historyKey("2026-11"))} GROUP BY key ORDER BY key`,
  );
  assert.deepEqual(stored, [
    { key: "IDX_I:13", n: 2 },
    { key: "IDX_I:25", n: 2 },
  ]);
});
