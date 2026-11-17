import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getParquetStore, type Columns } from "./parquet-store.ts";

const COLUMNS: Columns = { id: "VARCHAR", at: "DOUBLE", lots: "INTEGER", net: "DOUBLE", win: "BOOLEAN", note: "VARCHAR" };

async function withStore(work: (store: ReturnType<typeof getParquetStore>) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "parquet-store-"));
  try {
    await work(getParquetStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("rows written to a Parquet file read back with their types", async () => {
  await withStore(async (store) => {
    await store.write("trading/trades/run-a.parquet", COLUMNS, [
      { id: "t1", at: 1794800000123, lots: 1, net: 88.76, win: true, note: "it's fine" },
      { id: "t2", at: 1794800060000, lots: 2, net: -41.5, win: false, note: null },
    ]);
    const rows = await store.query<Record<string, unknown>>((table) => `SELECT * FROM ${table("trading/trades/run-a.parquet")} ORDER BY id`);
    assert.deepEqual(rows, [
      { id: "t1", at: 1794800000123, lots: 1, net: 88.76, win: true, note: "it's fine" },
      { id: "t2", at: 1794800060000, lots: 2, net: -41.5, win: false, note: null },
    ]);
  });
});

test("a glob reads every run's file as one table, and parameters bind", async () => {
  await withStore(async (store) => {
    await store.write("trading/trades/run-a.parquet", COLUMNS, [{ id: "a1", at: 1, lots: 1, net: 10, win: true }]);
    await store.write("trading/trades/run-b.parquet", COLUMNS, [
      { id: "b1", at: 2, lots: 1, net: -4, win: false },
      { id: "b2", at: 3, lots: 1, net: 6, win: true },
    ]);
    const [total] = await store.query<{ n: number; net: number }>(
      (table) => `SELECT CAST(count(*) AS INTEGER) AS n, sum(net) AS net FROM ${table("trading/trades/*.parquet")} WHERE net > $floor`,
      { floor: -5 },
    );
    assert.deepEqual(total, { n: 3, net: 12 });
  });
});

test("writing a key again replaces the file; a column absent from a row is NULL", async () => {
  await withStore(async (store) => {
    await store.write("runs/r.parquet", COLUMNS, [{ id: "old", at: 1, lots: 1, net: 1, win: true }]);
    await store.write("runs/r.parquet", COLUMNS, [{ id: "new", at: 2 }]);
    const rows = await store.query<Record<string, unknown>>((table) => `SELECT * FROM ${table("runs/r.parquet")}`);
    assert.deepEqual(rows, [{ id: "new", at: 2, lots: null, net: null, win: null, note: null }]);
  });
});

test("a table with no files yet is empty, and an empty table can be written", async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.query((table) => `SELECT * FROM ${table("trading/none/*.parquet")}`), []);
    await store.write("trading/empty.parquet", COLUMNS, []);
    assert.deepEqual(await store.query((table) => `SELECT * FROM ${table("trading/empty.parquet")}`), []);
  });
});

test("keys can't escape the store", async () => {
  await withStore(async (store) => {
    assert.throws(() => store.url("../outside.parquet"), /Invalid storage key/);
    assert.throws(() => store.url("a/'; DROP TABLE x; --.parquet"), /Invalid storage key/);
  });
});
