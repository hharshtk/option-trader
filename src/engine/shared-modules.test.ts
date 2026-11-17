// The engine reuses these web modules directly. This fails if one of them picks up a Next-only
// import (server-only, @/ paths, next/*) that plain Node can't load.

import assert from "node:assert/strict";
import test from "node:test";

const MODULES: Record<string, string[]> = {
  "../lib/dhan/client.ts": ["dhanRequest"],
  "../lib/dhan/config.ts": ["getDhanCredentials", "loadDhanCredentials", "getTokenStore"],
  "../lib/dhan/errors.ts": ["DhanApiError", "describeDhanError"],
  "../lib/dhan/rate-limit.ts": ["dhanRateLimiter", "bucketFor"],
  "../lib/dhan/api.ts": ["getProfile"],
  "../lib/dhan/instruments.ts": ["INDEX"],
  "../lib/dhan/token-store.ts": ["createTokenStore"],
  "../lib/dhan/option-contracts.ts": [],
  "../lib/dhan/option-scrips.ts": ["filterOptionScrips"],
  "../lib/dhan/option-scrips-store.ts": ["downloadOptionScrips", "readOptionScripsMeta"],
  "../lib/storage.ts": ["getFileStore"],
  "../lib/db/duckdb.ts": ["withDb"],
  "../lib/db/parquet-store.ts": ["getParquetStore"],
  "../lib/trading/charges.ts": ["orderCharges"],
  "../lib/insight/pulse.ts": ["computePulse"],
  "../lib/index-constituents.ts": [],
  "../lib/live/feed/feed-hub.ts": ["createFeedHub"],
  "../lib/engine/protocol.ts": ["worstHealth"],
  "../lib/engine/trading.ts": ["mergeTradingConfig"],
};

for (const [path, exports] of Object.entries(MODULES)) {
  test(`plain Node loads ${path.replace("../", "src/")}`, async () => {
    const loaded = await import(path);
    for (const name of exports) assert.notEqual(loaded[name], undefined, `${name} is exported`);
  });
}

test("shared DuckDB runs a query", async () => {
  const { withDb } = await import("../lib/db/duckdb.ts");
  const rows = await withDb(async (db) => (await db.runAndReadAll("select 42 as answer")).getRowObjects());
  assert.deepEqual(rows, [{ answer: 42 }]);
});
