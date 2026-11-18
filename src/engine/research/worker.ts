// The research worker: a child process the engine forks for each research job (a study, a rerun,
// a history update), so heavy work never stalls the live feed or the trader. It takes one job over
// IPC, reports progress, writes its results to the file store and exits.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { getParquetStore } from "../../lib/db/parquet-store.ts";
import { withDb } from "../../lib/db/duckdb.ts";
import { getDailyCandles, getIntradayCandles } from "../../lib/dhan/api.ts";
import { loadDhanCredentials } from "../../lib/dhan/config.ts";
import { updateHistory } from "../../lib/research/candle-history.ts";
import { runStudy, storeInputs, studyId, studySources, type StudyContext } from "../../lib/research/run-study.ts";
import { createStudyStore } from "../../lib/research/study-store.ts";
import { PLAIN_VERDICT, signalName, type GateAnswerRow, type WorkerJob, type WorkerMessage } from "../../lib/research/types.ts";
import { getFileStore } from "../../lib/storage.ts";
import { createDecisionProviders } from "../trading/decision.ts";
import { runGatePass, summarizeGate } from "./gate.ts";
import { createAllowance, isFreeModel, readFreeQuota } from "./quota.ts";

const LIB = path.resolve(import.meta.dirname, "../../lib");
/** The code a study's results depend on. A change to any of these makes a different study id. */
const SIGNAL_CODE = ["strategies/signals.ts", "insight/pulse.ts"];
const STUDY_CODE = ["research/day-frames.ts", "research/study.ts", "research/stats.ts", "research/costs.ts", "research/run-study.ts", "research/types.ts", "trading/charges.ts", "index-constituents.ts"];

function hashFiles(files: readonly string[]) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update(readFileSync(path.join(LIB, file)));
  return hash.digest("hex");
}

/** Sends a message to the runner; resolves once it has gone. */
function send(message: WorkerMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send) return resolve();
    process.send(message, undefined, {}, () => resolve());
  });
}

// Progress at most four times a second: the runner forwards it to every open page.
let lastProgress = 0;
function progress(done: number, total: number, label: string) {
  const now = Date.now();
  if (now - lastProgress < 250 && done < total) return;
  lastProgress = now;
  void send({ type: "progress", done, total, label });
}

async function run(job: WorkerJob): Promise<WorkerMessage> {
  // Its own DuckDB, kept small: the engine and the web share this machine.
  await withDb(async (db) => {
    await db.run("SET threads = 2");
    await db.run("SET memory_limit = '1GB'");
  });
  const parquet = getParquetStore();
  const files = getFileStore();

  if (job.kind === "history") {
    await loadDhanCredentials();
    const result = await updateHistory(job.today, { store: parquet, fetchCandles: getIntradayCandles, fetchDaily: getDailyCandles, onProgress: progress });
    const failed = [...result.months.flatMap((m) => m.failed), ...result.daily.failed];
    const months = result.months.map((m) => `${m.month} (${m.days} days)`).join(", ");
    const message = `Minute bars: ${months || "nothing new"}. Daily closes: ${result.daily.rows.toLocaleString("en-IN")} rows.${failed.length ? ` ${failed.length} requests failed, first: ${failed[0].key}: ${failed[0].error}` : ""}`;
    return { type: "done", message, studyId: null, matched: null };
  }

  const store = createStudyStore(parquet, files, job.namespace);
  const code = { signals: hashFiles(SIGNAL_CODE), study: hashFiles(STUDY_CODE) };
  const context: StudyContext = { inputs: storeInputs(parquet, files), namespace: job.namespace, version: job.version, code, now: Date.now, onProgress: progress };

  if (job.kind === "study") {
    const id = studyId(job.spec, studySources(await context.inputs.sources(), job.spec), code);
    if (await store.exists(id)) {
      return { type: "done", message: "You've already tested exactly this, on the same data, so here is that result.", studyId: id, matched: null };
    }
    const study = await runStudy(job.spec, context);
    await store.write(study);
    const { row } = study;
    return {
      type: "done",
      message: `Done: ${row.strategy_name ? `${row.strategy_name}, version ${row.strategy_version}` : `${signalName(row.signal)}, held ${row.horizon} min`}: ${PLAIN_VERDICT[row.verdict].label.toLowerCase()} (${row.firings.toLocaleString("en-IN")} trades over ${row.days} days).`,
      studyId: row.id,
      matched: null,
    };
  }

  if (job.kind === "gate") return gate(job, store, context);

  const manifest = await store.manifest(job.id);
  if (!manifest) return { type: "failed", message: `No study ${job.id}.` };
  const rerun = await runStudy(manifest.spec, context);
  const matched = rerun.manifest.results.hash === manifest.results.hash;
  const sameInputs = rerun.manifest.id === manifest.id;
  await store.writeCheck({ id: manifest.id, at: Date.now(), version: job.version, matched, hash: rerun.manifest.results.hash, sameInputs });
  const message = matched
    ? "Rerun reproduced the stored results exactly."
    : sameInputs
      ? "Rerun gave different results from the same data and code. Something in the study isn't deterministic."
      : "Rerun gave different results: the data or the code has changed since this study. Run it as a new study to keep both.";
  return { type: "done", message, studyId: manifest.id, matched };
}

/** Answers not yet stored, written in batches and when the job is cancelled. */
let pendingAnswers: { flush: () => Promise<void> } | null = null;

async function gate(job: Extract<WorkerJob, { kind: "gate" }>, store: ReturnType<typeof createStudyStore>, context: StudyContext): Promise<WorkerMessage> {
  const detail = await store.read(job.id);
  if (!detail) return { type: "failed", message: `No study ${job.id}.` };
  // Any study's answer to the exact same context is reused. Failed answers aren't: they are asked again.
  const held = (await store.answers()).filter((row) => row.probability !== null && row.model !== "" && row.key);
  const cached = new Map(held.map((row) => [row.key, row]));
  const client = createDecisionProviders(process.env)[job.provider];
  if (!client.ready) return { type: "failed", message: `No key for ${job.provider} in .env.local.` };
  const quota = createAllowance({ read: () => readFreeQuota(process.env.OPENROUTER_API_KEY), reserve: job.reserve });
  // Every request is counted, retries included: OpenRouter's own count lags.
  const provider = {
    ready: true,
    ask: (request: Parameters<typeof client.ask>[0]) => {
      quota.counted();
      return client.ask(request);
    },
  };

  let batch: GateAnswerRow[] = [];
  const flush = async () => {
    const rows = batch;
    batch = [];
    await store.writeAnswers(job.id, rows, Date.now());
  };
  pendingAnswers = { flush };
  // Only OpenRouter's free models have a daily quota, shared with live trading.
  const free = job.provider === "openrouter" && isFreeModel(job.model);
  const { answers, stopped } = await runGatePass({
    manifest: detail.manifest,
    events: detail.events,
    inputs: context.inputs,
    provider,
    model: job.model,
    rule: job.rule,
    cached,
    allowance: async () => {
      if (!free) return { count: Number.POSITIVE_INFINITY, reason: "" };
      const { count, quota: left } = await quota.next();
      return {
        count,
        reason: `Stopped with about ${Math.max(0, left.remaining)} of today's ${left.limit} free Decision API answers left, kept for live trading. Run it again to carry on where it stopped; the quota resets at 05:30 IST.`,
      };
    },
    record: async (row) => {
      batch.push(row);
      if (batch.length >= 10) await flush();
    },
    onProgress: progress,
    // Free models allow 20 a minute, shared with live trading.
    pauseMs: free ? 4_000 : 250,
  });
  await flush();
  pendingAnswers = null;
  const summary = summarizeGate(detail.manifest, detail.events.length, answers, { provider: job.provider, model: job.model, rule: job.rule, version: job.version, at: Date.now(), stopped });
  await store.writeGate(summary);
  const asked = answers.filter((row) => !cached.has(row.key)).length;
  const result = `${summary.answered} of ${summary.firings} firings answered (${asked} asked now)${summary.failed ? `, ${summary.failed} failed` : ""}. Approved ${summary.approved.firings}: ${pointsText(summary.approved.mean)} a firing; turned down ${summary.turnedDown.firings}: ${pointsText(summary.turnedDown.mean)}.`;
  return { type: "done", message: stopped ? `${result} ${stopped}` : result, studyId: job.id, matched: null };
}

const pointsText = (value: number | null) => (value === null ? "—" : `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)} pts`);

// Cancelled: keep the answers already paid for in time and quota.
process.on("SIGTERM", () => {
  void (pendingAnswers?.flush() ?? Promise.resolve()).finally(() => process.exit(0));
});

process.once("message", (job: WorkerJob) => {
  run(job)
    .catch((error: unknown): WorkerMessage => ({ type: "failed", message: error instanceof Error ? error.message.split("\n")[0] : String(error) }))
    .then(send)
    // Exit once the last message has gone.
    .finally(() => process.exit(0));
});
// The engine went away: nothing left to report to.
process.on("disconnect", () => process.exit(1));
