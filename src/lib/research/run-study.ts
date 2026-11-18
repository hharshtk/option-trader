// Runs one signal study from start to finish: fingerprint the inputs, read the minute history a
// month at a time, rebuild each day, take the engine's votes, measure the firings. Data access is
// passed in, so tests run the whole thing on small local files. Node only (hashing).

import { createHash } from "node:crypto";
import type { ParquetStore } from "../db/parquet-store.ts";
import { CONSTITUENTS_AS_OF } from "../index-constituents.ts";
import type { FileStore } from "../storage.ts";
import { historyKey, monthsBetween } from "./candle-history.ts";
import { optionCostPoints, futuresCostPoints } from "./costs.ts";
import { buildDays, DailyCloses, isFrame, NIFTY_CONSTITUENTS, NIFTY_KEY, VIX_KEY, type CandleColumns, type DroppedDay } from "./day-frames.ts";
import { StudyAccumulator, dayVotes } from "./study.ts";
import type { StudyFiles } from "./study-store.ts";
import { studyQuestion, type StudyManifest, type StudyRow, type StudySpec, type SummaryRow } from "./types.ts";

export interface StudyInputs {
  /** The stored files a study reads, for its fingerprint: minute months and daily years. */
  sources(): Promise<{ key: string; etag: string; bytes: number }[]>;
  /** Official daily closes for every instrument. */
  dailyCloses(): Promise<{ key: string; date: string; close: number }[]>;
  /** One month of minute candles for these instruments, column by column; null when the month isn't stored. */
  month(month: string, keys: readonly string[]): Promise<CandleColumns | null>;
}

const KEY = /^[A-Z_]+:\d+$/;

/** Inputs read from the app's file store: the minute history and daily closes on S3. */
export function storeInputs(parquet: ParquetStore, files: FileStore): StudyInputs {
  return {
    async sources() {
      const [minute, daily] = await Promise.all([files.list("history/candles-1m/"), files.list("history/daily/")]);
      return [...minute, ...daily];
    },
    dailyCloses() {
      return parquet.query((table) => `SELECT key, date, close FROM ${table("history/daily/*.parquet")}`);
    },
    async month(month, keys) {
      if (!keys.every((key) => KEY.test(key))) throw new Error("Invalid instrument key");
      const list = keys.map((key) => `'${key}'`).join(", ");
      // Each key as its index in `keys`: numbers instead of half a million strings.
      const columns = await parquet.queryColumns(
        (table) => `SELECT CAST(list_position([${list}], key) - 1 AS INTEGER) AS k, t, open, high, low, close
                    FROM ${table(historyKey(month))} WHERE key IN (${list})`,
      );
      if (!columns.k) return null;
      return {
        keys,
        k: columns.k as number[],
        t: columns.t as number[],
        open: columns.open as number[],
        high: columns.high as number[],
        low: columns.low as number[],
        close: columns.close as number[],
      };
    },
  };
}

export interface StudyContext {
  inputs: StudyInputs;
  namespace: string;
  /** The engine's `git describe --dirty`. */
  version: string;
  /** sha256 of the signal code and of the study code. */
  code: { signals: string; study: string };
  now: () => number;
  onProgress?: (done: number, total: number, label: string) => void;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Objects with their keys sorted, so the same content always serialises the same way. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A study's id: its primary question and a hash of everything that decides its results (the
 * spec, the input files' fingerprints, the code). The same inputs always give the same id.
 */
export function studyId(spec: StudySpec, sources: readonly { key: string; etag: string }[], code: StudyContext["code"]): string {
  const hash = sha256(canonical({ spec, sources: sources.map(({ key, etag }) => ({ key, etag })), code })).slice(0, 10);
  return `${spec.primary.signal}-${spec.primary.horizon}m-${hash}`;
}

/** A hash of the results, to check that a rerun reproduced them. */
export function resultsHash(summary: readonly SummaryRow[]): string {
  // Without the study id, which is part of every row: the same results hash the same in any study.
  return sha256(canonical(summary.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "study")))));
}

/** The files a study over this period reads. */
export function studySources(all: readonly { key: string; etag: string; bytes: number }[], spec: StudySpec) {
  const months = new Set(monthsBetween(spec.from.slice(0, 7), spec.to.slice(0, 7)));
  return all.filter((file) => {
    const month = file.key.match(/^history\/candles-1m\/(\d{4}-\d{2})\.parquet$/)?.[1];
    if (month) return months.has(month);
    return /^history\/daily\/\d{4}\.parquet$/.test(file.key);
  });
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (month: string) => `${MONTH_NAMES[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;

export async function runStudy(spec: StudySpec, context: StudyContext): Promise<StudyFiles> {
  const startedAt = context.now();
  const sources = studySources(await context.inputs.sources(), spec);
  const id = studyId(spec, sources, context.code);
  const months = monthsBetween(spec.from.slice(0, 7), spec.to.slice(0, 7));
  context.onProgress?.(0, months.length + 1, "Reading official closes");

  const closes = new DailyCloses(await context.inputs.dailyCloses());
  const breadthKeys = NIFTY_CONSTITUENTS.map((c) => c.key);
  const keys = [NIFTY_KEY, VIX_KEY, ...breadthKeys];
  const study = new StudyAccumulator(spec, id);
  const dropped: DroppedDay[] = [];

  for (const [index, month] of months.entries()) {
    context.onProgress?.(index + 1, months.length + 1, `Studying ${monthName(month)} · ${study.days.length} days so far`);
    const columns = await context.inputs.month(month, keys);
    if (!columns) continue;
    for (const day of buildDays(columns, closes, { from: spec.from, to: spec.to, breadthKeys })) {
      if (!isFrame(day)) {
        dropped.push(day);
        continue;
      }
      const votes = dayVotes(day, spec.signalParams, spec.signals);
      if (votes) study.add(day, votes);
      else dropped.push({ date: day.date, reason: "The signal code returned nothing for this day" });
    }
  }

  context.onProgress?.(months.length + 1, months.length + 1, "Measuring");
  const medianNifty = study.medianNifty();
  const optionCost = round(optionCostPoints(spec.costs.option));
  const futuresCost = round(futuresCostPoints(spec.costs.futures, medianNifty));
  const summary = study.summary(optionCost, futuresCost);
  const daily = study.daily();
  const hash = resultsHash(summary);
  const primary = summary.find((row) => row.signal === spec.primary.signal && row.horizon === spec.primary.horizon && row.slice_kind === "all")!;
  const days = [...study.days].sort();
  const ms = context.now() - startedAt;
  const question = studyQuestion(spec);

  const manifest: StudyManifest = {
    schema: 1,
    id,
    question,
    spec,
    data: {
      sources,
      days: days.length,
      first: days[0] ?? null,
      last: days.at(-1) ?? null,
      dropped,
      breadthStocks: breadthKeys,
      constituentsAsOf: CONSTITUENTS_AS_OF,
    },
    code: { version: context.version, ...context.code },
    costs: { optionPoints: optionCost, futuresPoints: futuresCost, medianNifty },
    run: { startedAt, ms, namespace: context.namespace, node: process.version },
    results: { hash, verdict: primary.verdict, firings: primary.firings },
  };
  const row: StudyRow = {
    id,
    question,
    signal: spec.primary.signal,
    horizon: spec.primary.horizon,
    from: days[0] ?? spec.from,
    to: days.at(-1) ?? spec.to,
    days: days.length,
    firings: primary.firings,
    hit_rate: primary.hit_rate,
    mean: primary.mean,
    lo: primary.lo,
    hi: primary.hi,
    net_option: primary.net_option,
    cost_option: optionCost,
    cost_futures: futuresCost,
    verdict: primary.verdict,
    started_at: startedAt,
    ms,
    results_hash: hash,
    version: context.version,
    strategy_id: spec.strategy?.id ?? null,
    strategy_version: spec.strategy?.version ?? null,
    strategy_name: spec.strategy?.name ?? null,
  };
  return { events: study.events, daily, summary, manifest, row };
}

const round = (value: number) => Math.round(value * 1000) / 1000;
