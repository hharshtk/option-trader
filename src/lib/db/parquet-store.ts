// Tables kept as Parquet files in the app's file store and read and written by DuckDB: the app's
// database. With S3_BUCKET set the files live on S3 (or R2/MinIO through S3_ENDPOINT) and DuckDB
// reaches them with its httpfs extension; otherwise they live under DATA_DIR. Nothing else holds
// state: any process with the same settings sees the same tables.
//
// A table is one file or a set of files matched by a glob (`trading/main/trades/*.parquet`).
// Parquet files can't be appended to, so writers replace whole files: keep each file to one unit
// that is rewritten together, such as one run's trades.

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { DATA_DIR } from "../storage.ts";
import { withDb } from "./duckdb.ts";

/** Column types. Times are stored as DOUBLE epoch milliseconds: exact, and plain numbers in JS. */
export type ColumnType = "VARCHAR" | "DOUBLE" | "INTEGER" | "BOOLEAN";
export type Columns = Record<string, ColumnType>;
export type Row = Record<string, string | number | boolean | null>;

export interface ParquetStore {
  /** Where files go, for display: "s3://bucket/prefix/" or a folder path. */
  location: string;
  /** True when files are on S3, read and written through DuckDB's httpfs extension. */
  remote: boolean;
  /** The address DuckDB uses for a key or glob. */
  url(key: string): string;
  /** Replaces the file at `key` with `rows`. Columns missing from a row are written as NULL. */
  write(key: string, columns: Columns, rows: readonly Row[]): Promise<void>;
  /**
   * Runs a query over stored files. `sql` receives `table(keyOrGlob)`, which gives the
   * `read_parquet(...)` expression for those files. Answers [] when no file matches.
   */
  query<T>(sql: (table: (keyOrGlob: string) => string) => string, values?: Record<string, string | number | boolean | null>): Promise<T[]>;
  /**
   * The same, answered column by column: `{ name: values[] }`. Far lighter than one object per
   * row for large reads (a month of candles is half a million rows).
   */
  queryColumns(sql: (table: (keyOrGlob: string) => string) => string, values?: Record<string, string | number | boolean | null>): Promise<Record<string, unknown[]>>;
}

const KEY = /^[\w.*=-]+(\/[\w.*=-]+)*$/;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

function checkKey(key: string) {
  if (!KEY.test(key) || key.split("/").includes("..")) throw new Error(`Invalid storage key: ${key}`);
}

interface S3Settings {
  bucket: string;
  prefix: string;
  endpoint: string | undefined;
  region: string;
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
}

function s3Settings(): S3Settings | null {
  const bucket = process.env.S3_BUCKET?.trim();
  if (!bucket) return null;
  return {
    bucket,
    prefix: (process.env.S3_PREFIX?.trim() ?? "option-trader/").replace(/^\/+/, ""),
    endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
    region: process.env.S3_REGION?.trim() || "ap-south-1",
    accessKeyId: process.env.S3_ACCESS_KEY_ID?.trim(),
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY?.trim(),
  };
}

// The extension and the credentials are loaded once per process, on the shared DuckDB instance.
const REMOTE = Symbol.for("option-trader.duckdb.s3");
const globalStore = globalThis as typeof globalThis & { [REMOTE]?: { key: string; ready: Promise<void> } };

function ensureRemote(s3: S3Settings): Promise<void> {
  const key = JSON.stringify(s3);
  if (globalStore[REMOTE]?.key !== key) {
    const ready = withDb(async (db) => {
      // INSTALL downloads the extension once into DuckDB's home folder; later starts load it from there.
      await db.run("INSTALL httpfs");
      await db.run("LOAD httpfs");
      const options = [
        "TYPE s3",
        s3.accessKeyId && `KEY_ID ${quote(s3.accessKeyId)}`,
        s3.secretAccessKey && `SECRET ${quote(s3.secretAccessKey)}`,
        `REGION ${quote(s3.region)}`,
        `SCOPE ${quote(`s3://${s3.bucket}`)}`,
      ];
      if (s3.endpoint) {
        // S3-compatible services (Cloudflare R2, MinIO): their host, path-style URLs.
        const endpoint = new URL(s3.endpoint);
        options.push(`ENDPOINT ${quote(endpoint.host)}`, "URL_STYLE 'path'", `USE_SSL ${endpoint.protocol === "https:"}`);
      }
      await db.run(`CREATE OR REPLACE SECRET option_trader_s3 (${options.filter(Boolean).join(", ")})`);
    });
    globalStore[REMOTE] = { key, ready };
    ready.catch(() => {
      if (globalStore[REMOTE]?.key === key) globalStore[REMOTE] = undefined;
    });
  }
  return globalStore[REMOTE]!.ready;
}

/** DuckDB says this when a glob or a file matches nothing: an empty table, not a failure. */
function isMissing(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /No files found|404|NoSuchKey|does not exist|No such file/i.test(message);
}

async function writeRows(db: DuckDBConnection, target: string, columns: Columns, rows: readonly Row[]) {
  const names = Object.keys(columns);
  const scratch = path.join(tmpdir(), `option-trader-rows-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  // Every row carries every column, so DuckDB reads the declared type even when all values are null.
  const lines = rows.map((row) => JSON.stringify(Object.fromEntries(names.map((name) => [name, row[name] ?? null]))));
  await writeFile(scratch, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  try {
    const schema = names.map((name) => `${quote(name)}: ${quote(columns[name])}`).join(", ");
    await db.run(
      `COPY (SELECT * FROM read_json(${quote(scratch)}, format = 'newline_delimited', columns = {${schema}}))
       TO ${quote(target)} (FORMAT parquet, COMPRESSION zstd)`,
    );
  } finally {
    await rm(scratch, { force: true });
  }
}

async function runQuery<T>(sql: string, values: Record<string, string | number | boolean | null> | undefined): Promise<T[]> {
  try {
    return await withDb(async (db) => (await db.runAndReadAll(sql, values)).getRowObjectsJS() as unknown as T[]);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function runColumns(sql: string, values: Record<string, string | number | boolean | null> | undefined): Promise<Record<string, unknown[]>> {
  try {
    return await withDb(async (db) => (await db.runAndReadAll(sql, values)).getColumnsObjectJS() as Record<string, unknown[]>);
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
}

function remoteStore(s3: S3Settings): ParquetStore {
  const url = (key: string) => {
    checkKey(key);
    return `s3://${s3.bucket}/${s3.prefix}${key}`;
  };
  return {
    location: `s3://${s3.bucket}/${s3.prefix}`,
    remote: true,
    url,
    async write(key, columns, rows) {
      await ensureRemote(s3);
      await withDb((db) => writeRows(db, url(key), columns, rows));
    },
    async query(sql, values) {
      await ensureRemote(s3);
      return runQuery(sql((key) => `read_parquet(${quote(url(key))}, union_by_name = true)`), values);
    },
    async queryColumns(sql, values) {
      await ensureRemote(s3);
      return runColumns(sql((key) => `read_parquet(${quote(url(key))}, union_by_name = true)`), values);
    },
  };
}

function localStore(root: string): ParquetStore {
  const url = (key: string) => {
    checkKey(key);
    return path.join(root, ...key.split("/"));
  };
  return {
    location: root,
    remote: false,
    url,
    async write(key, columns, rows) {
      const file = url(key);
      await mkdir(path.dirname(file), { recursive: true });
      // Write then rename, so a reader never sees a half-written file.
      await withDb((db) => writeRows(db, `${file}.tmp`, columns, rows));
      await rename(`${file}.tmp`, file);
    },
    query(sql, values) {
      return runQuery(sql((key) => `read_parquet(${quote(url(key))}, union_by_name = true)`), values);
    },
    queryColumns(sql, values) {
      return runColumns(sql((key) => `read_parquet(${quote(url(key))}, union_by_name = true)`), values);
    },
  };
}

let cached: { key: string; store: ParquetStore } | undefined;

/** The store for the configured file location; pass `root` to force a local folder (tests). */
export function getParquetStore(root?: string): ParquetStore {
  if (root) return localStore(root);
  const s3 = s3Settings();
  const key = s3 ? JSON.stringify(s3) : DATA_DIR;
  if (cached?.key !== key) cached = { key, store: s3 ? remoteStore(s3) : localStore(DATA_DIR) };
  return cached.store;
}
