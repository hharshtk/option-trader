import "server-only";
import { tmpdir } from "node:os";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

// The app's DuckDB, held in memory: nothing is written to the app's own folder, so it runs on
// serverless hosts too. Data that must last lives in files (see src/lib/storage.ts) that code
// loads into it, as option-scrips-store.ts does for option contracts.

const DUCKDB = Symbol.for("option-trader.duckdb");
const globalStore = globalThis as typeof globalThis & { [DUCKDB]?: Promise<DuckDBInstance> };

// One instance per server process, kept on globalThis so dev hot reloads share it.
function instance() {
  globalStore[DUCKDB] ??= DuckDBInstance.create(":memory:", {
    // Point DuckDB's own scratch folders at /tmp: the app folder is read-only on serverless hosts.
    home_directory: tmpdir(),
    temp_directory: path.join(tmpdir(), "duckdb"),
  }).catch((error: unknown) => {
    globalStore[DUCKDB] = undefined;
    throw error;
  });
  return globalStore[DUCKDB];
}

/** Runs `work` on its own connection, closed afterwards. Connections are cheap in DuckDB. */
export async function withDb<T>(work: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
  const connection = await (await instance()).connect();
  try {
    return await work(connection);
  } finally {
    connection.closeSync();
  }
}
