// Research jobs in the engine: a queue that runs one job at a time, each in its own child process
// (worker.ts) at low priority, so a study can't slow down or crash the live feed and the trader.
// Reports every change on the `research` telemetry topic and reads stored studies for the web.

import { fork, type ChildProcess } from "node:child_process";
import { setPriority } from "node:os";
import path from "node:path";
import type { ParquetStore } from "../../lib/db/parquet-store.ts";
import { historyCoverage, istDay, type HistoryCoverage } from "../../lib/research/candle-history.ts";
import type { StudyStore } from "../../lib/research/study-store.ts";
import {
  checkSpec,
  defaultSpec,
  HORIZONS,
  studyQuestion,
  type ResearchCommandResult,
  type ResearchJob,
  type ResearchStatus,
  type SignalId,
  type StudyDetail,
  type StudyRow,
  type WorkerJob,
  type WorkerMessage,
} from "../../lib/research/types.ts";
import { DECISION_PROVIDERS, type DecisionProviderId, type TradingConfig } from "../../lib/engine/trading.ts";
import type { Health } from "../telemetry/health.ts";
import type { Logger } from "../telemetry/logger.ts";
import { readFreeQuota, RESERVE } from "./quota.ts";

const WORKER = path.join(import.meta.dirname, "worker.ts");
/** Finished jobs kept in the status for the page. */
const KEEP_FINISHED = 20;
const COVERAGE_MAX_AGE_MS = 10 * 60_000;
const QUOTA_MAX_AGE_MS = 2 * 60_000;
/** Below normal (0) so the OS always serves the live engine first. */
const WORKER_PRIORITY = 10;

export interface ResearchRunnerOptions {
  namespace: string;
  version: string;
  log: Logger;
  health: Health;
  now: () => number;
  parquet: ParquetStore;
  store: StudyStore;
  /** What the engine trades now: the signal it follows, its hold in minutes, and its decision gate. */
  trading: () => { signal: SignalId; holdMinutes: number; decision: TradingConfig["decision"] };
  /** For the free-answer quota. */
  openRouterKey: string | undefined;
  /** Which decision providers have a key. */
  providersReady: Record<DecisionProviderId, boolean>;
  publish: (status: ResearchStatus) => void;
  /** Called with a study's id when a study job finishes with one (new, or found already stored). */
  onStudy?: (studyId: string) => void;
}

export function createResearchRunner(options: ResearchRunnerOptions) {
  const { namespace, version, log, health, now, parquet, store } = options;
  const jobs: ResearchJob[] = [];
  const specs = new Map<string, WorkerJob>();
  let child: { job: ResearchJob; process: ChildProcess } | null = null;
  let coverage: HistoryCoverage | null = null;
  let coverageError: string | null = null;
  let coverageAt = 0;
  let coverageLoading: Promise<void> | null = null;
  let sequence = 0;
  let stopped = false;
  let quota: { remaining: number; limit: number } | null = null;
  let quotaError: string | null = null;
  let quotaAt = 0;

  health.set("research", "ok");

  function defaults() {
    const { signal, holdMinutes } = options.trading();
    // The nearest holding time a study measures.
    const horizon = HORIZONS.reduce((best, h) => (Math.abs(h - holdMinutes) < Math.abs(best - holdMinutes) ? h : best), HORIZONS[0]);
    return { signal, horizon };
  }

  function status(): ResearchStatus {
    if (now() - coverageAt > COVERAGE_MAX_AGE_MS) void refreshCoverage();
    if (now() - quotaAt > QUOTA_MAX_AGE_MS) void refreshQuota();
    const { provider, model } = options.trading().decision;
    return {
      namespace,
      location: parquet.location,
      jobs: [...jobs],
      coverage,
      coverageError,
      defaults: defaults(),
      decisions: {
        provider,
        model,
        providers: {
          openrouter: { ready: options.providersReady.openrouter, model: modelFor("openrouter") },
          liquid: { ready: options.providersReady.liquid, model: modelFor("liquid") },
        },
        freeRemaining: quota?.remaining ?? null,
        freeLimit: quota?.limit ?? null,
        reserve: RESERVE,
        error: quotaError,
      },
    };
  }

  /** The model research asks a provider with: the trader's when it is the trader's provider, else that provider's default. */
  function modelFor(provider: DecisionProviderId) {
    const { decision } = options.trading();
    return decision.provider === provider ? decision.model : DECISION_PROVIDERS.find((p) => p.id === provider)!.defaultModel;
  }

  function refreshQuota() {
    quotaAt = now();
    return readFreeQuota(options.openRouterKey).then(
      (next) => {
        quota = next;
        quotaError = null;
        changed();
      },
      (error: unknown) => {
        quotaError = error instanceof Error ? error.message : String(error);
      },
    );
  }

  const changed = () => options.publish(status());

  function refreshCoverage(): Promise<void> {
    coverageLoading ??= historyCoverage(parquet)
      .then(
        (next) => {
          coverage = next;
          coverageError = next.minute ? null : "No minute history in the file store yet. Update the history to download it.";
        },
        (error: unknown) => {
          coverageError = `Could not read the history: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
          log.warn(coverageError);
        },
      )
      .finally(() => {
        coverageAt = now();
        coverageLoading = null;
        changed();
      });
    return coverageLoading;
  }

  function addJob(kind: ResearchJob["kind"], title: string, work: WorkerJob, studyId: string | null = null): ResearchJob {
    const job: ResearchJob = { id: `r${now().toString(36)}${(sequence++).toString(36)}`, kind, title, state: "queued", queuedAt: now(), startedAt: null, endedAt: null, progress: null, message: null, studyId, matched: null };
    jobs.unshift(job);
    specs.set(job.id, work);
    // Keep every unfinished job, and the newest finished ones.
    let finished = 0;
    for (let i = 0; i < jobs.length; i += 1) {
      if (jobs[i].state === "queued" || jobs[i].state === "running") continue;
      if (++finished > KEEP_FINISHED) jobs.splice(i--, 1);
    }
    changed();
    next();
    return job;
  }

  function finish(job: ResearchJob, state: ResearchJob["state"], message: string, extra: Partial<ResearchJob> = {}) {
    Object.assign(job, { state, message, endedAt: now(), ...extra });
    specs.delete(job.id);
    if (job.kind === "history" && state === "done") void refreshCoverage();
    if (job.kind === "gate") void refreshQuota();
    const level = state === "failed" ? "warn" : "info";
    log[level](`${job.title}: ${message}`);
  }

  function next() {
    if (child || stopped) return;
    const job = [...jobs].reverse().find((j) => j.state === "queued");
    if (!job) return;
    const work = specs.get(job.id)!;
    // The worker inherits the engine's settings (S3, Dhan), but not its flags: no --watch.
    const worker = fork(WORKER, [], { execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "advanced" });
    child = { job, process: worker };
    Object.assign(job, { state: "running", startedAt: now(), progress: { done: 0, total: 1, label: "Starting" } });
    try {
      if (worker.pid) setPriority(worker.pid, WORKER_PRIORITY);
    } catch {
      // Not allowed on this machine: the job still runs, at normal priority.
    }
    let reported = false;
    worker.stdout?.on("data", (data: Buffer) => log.debug(data.toString().trim()));
    worker.stderr?.on("data", (data: Buffer) => log.warn(`worker: ${data.toString().trim().slice(0, 500)}`));
    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "progress") {
        job.progress = { done: message.done, total: message.total, label: message.label };
      } else if (message.type === "done") {
        reported = true;
        finish(job, "done", message.message, { studyId: message.studyId, matched: message.matched, progress: null });
        health.set("research", "ok");
        if (job.kind === "study" && message.studyId) options.onStudy?.(message.studyId);
      } else {
        reported = true;
        finish(job, "failed", message.message, { progress: null });
      }
      changed();
    });
    worker.on("exit", (code, signal) => {
      child = null;
      if (!reported) {
        if (job.state === "cancelled") {
          // Already marked by cancel().
        } else {
          finish(job, "failed", `The research process stopped unexpectedly (${signal ?? `exit code ${code}`}).`, { progress: null });
          health.set("research", "degraded", `${job.title} crashed`);
        }
      }
      changed();
      next();
    });
    worker.send(work);
    log.info(`started ${job.title}`, { job: job.id, pid: worker.pid });
    changed();
  }

  async function command(body: unknown): Promise<ResearchCommandResult> {
    const input = (body ?? {}) as { action?: string; spec?: unknown; id?: unknown; job?: unknown; provider?: unknown };
    switch (input.action) {
      case "study": {
        if (!coverage?.minute) await refreshCoverage();
        if (!coverage?.minute) return { ok: false, message: coverageError ?? "No minute history to study." };
        const { signal, horizon } = defaults();
        const checked = checkSpec(input.spec, defaultSpec(signal, horizon, istDay(coverage.minute.from), istDay(coverage.minute.to)));
        if (!checked.ok) return checked;
        const job = addJob("study", studyQuestion(checked.spec), { kind: "study", spec: checked.spec, namespace, version });
        return { ok: true, message: "Study queued.", job: job.id };
      }
      case "rerun": {
        const id = typeof input.id === "string" ? input.id : "";
        const manifest = await store.manifest(id).catch(() => null);
        if (!manifest) return { ok: false, message: "No such study." };
        const job = addJob("rerun", `Rerun: ${manifest.question}`, { kind: "rerun", id, namespace, version }, id);
        return { ok: true, message: "Rerun queued.", job: job.id };
      }
      case "gate": {
        const id = typeof input.id === "string" ? input.id : "";
        const manifest = await store.manifest(id).catch(() => null);
        if (!manifest) return { ok: false, message: "No such study." };
        if (jobs.some((j) => j.kind === "gate" && j.studyId === id && (j.state === "queued" || j.state === "running"))) return { ok: false, message: "The Decision API is already being asked about this study." };
        const { decision } = options.trading();
        const provider: DecisionProviderId = input.provider === "liquid" || input.provider === "openrouter" ? input.provider : decision.provider;
        if (!options.providersReady[provider]) return { ok: false, message: `No key for ${DECISION_PROVIDERS.find((p) => p.id === provider)!.name}: set ${DECISION_PROVIDERS.find((p) => p.id === provider)!.keyName} in the engine's .env.local and restart it.` };
        const model = modelFor(provider);
        const job = addJob(
          "gate",
          `Decision API (${DECISION_PROVIDERS.find((p) => p.id === provider)!.name}): ${manifest.question}`,
          { kind: "gate", id, namespace, version, provider, model, rule: { minProbability: decision.minProbability, vetoAgainstRegime: decision.vetoAgainstRegime }, reserve: RESERVE },
          id,
        );
        return { ok: true, message: "Decision API pass queued.", job: job.id };
      }
      case "history": {
        if (jobs.some((j) => j.kind === "history" && (j.state === "queued" || j.state === "running"))) return { ok: false, message: "A history update is already queued." };
        const job = addJob("history", "Update history", { kind: "history", today: istDay(now()) });
        return { ok: true, message: "History update queued.", job: job.id };
      }
      case "cancel": {
        const job = jobs.find((j) => j.id === input.job);
        if (!job || (job.state !== "queued" && job.state !== "running")) return { ok: false, message: "That job isn't waiting or running." };
        if (job.state === "running" && child?.job === job) child.process.kill("SIGTERM");
        finish(job, "cancelled", "Cancelled.", { progress: null });
        changed();
        next();
        return { ok: true, message: "Cancelled." };
      }
      default:
        return { ok: false, message: "Unknown research command." };
    }
  }

  return {
    status,
    command,
    studies: (): Promise<StudyRow[]> => store.list(),
    /** One stored study's catalog row, or null. */
    studyRow: async (id: string): Promise<StudyRow | null> => (await store.list()).find((row) => row.id === id) ?? null,
    study: (id: string): Promise<StudyDetail | null> => store.read(id),
    start: () => Promise.all([refreshCoverage(), refreshQuota()]),
    stop() {
      stopped = true;
      child?.process.kill("SIGTERM");
    },
  };
}

export type ResearchRunner = ReturnType<typeof createResearchRunner>;
