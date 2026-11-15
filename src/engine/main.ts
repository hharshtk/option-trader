// The engine process: `npm run engine`. It monitors itself and the Dhan account, owns the live
// Dhan feed, and reports everything to the web. Later steps add the journal and runs.

import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION, type EngineStatus, type LogLevel, type SegmentSession } from "../lib/engine/protocol.ts";
import { createControlServer } from "./api/server.ts";
import { createDhanWatch } from "./dhan-watch.ts";
import { startFeed, subscriptionSnapshot, type EngineFeed } from "./feed.ts";
import { createJournal } from "./journal/writer.ts";
import { createLiveClock } from "./kernel/clock.ts";
import { acquireLock, EngineLockedError } from "./lock.ts";
import { createSessionCalendar } from "./market/session-calendar.ts";
import { byMode, resolveUniverse } from "./market/universe.ts";
import { createHealth } from "./telemetry/health.ts";
import { createTelemetryHub } from "./telemetry/hub.ts";
import { createLogFile } from "./telemetry/log-file.ts";
import { consoleSink, createLogHub, LEVEL_RANK } from "./telemetry/logger.ts";
import { createMetrics } from "./telemetry/metrics.ts";
import { createProcessSampler } from "./telemetry/process-stats.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const STATUS_INTERVAL_MS = 1_000;
const METRICS_INTERVAL_MS = 5_000;
const DHAN_CHECK_INTERVAL_MS = 15 * 60_000;
/** A status tick this late means the process was suspended or starved: data is missing. */
const SUSPEND_THRESHOLD_MS = 5_000;

const config = {
  host: process.env.ENGINE_HOST ?? "127.0.0.1",
  port: Number(process.env.ENGINE_PORT ?? 3100),
  token: process.env.ENGINE_TOKEN?.trim() ?? "",
  dataDir: path.resolve(ROOT, process.env.ENGINE_DATA_DIR ?? "data/engine"),
  logLevel: (process.env.ENGINE_LOG_LEVEL ?? "info") as LogLevel,
};

const clock = createLiveClock();
const calendar = createSessionCalendar();
const startedAt = clock.now();
const telemetry = createTelemetryHub(clock.now);
const metrics = createMetrics(clock.now);
const logFile = createLogFile(path.join(config.dataDir, "logs"), calendar.istDate);
const logs = createLogHub({
  now: clock.now,
  minLevel: LEVEL_RANK[config.logLevel] === undefined ? "info" : config.logLevel,
  sinks: [consoleSink(), logFile.sink],
});
logs.subscribe((entry) => {
  metrics.increment(`log.${entry.level}`);
  telemetry.publish("log", entry);
});
const log = logs.logger("engine");

const health = createHealth(clock.now, (next, previous) => {
  if (!previous && next.state === "ok") return;
  const text = `${next.component}: ${previous?.state ?? "new"} → ${next.state}${next.reason ? ` (${next.reason})` : ""}`;
  if (next.state === "ok") log.info(text);
  else if (next.state === "degraded") log.warn(text);
  else log.error(text);
});

let releaseLock: (() => void) | undefined;

/** Startup failure: the message goes to the terminal (and journald under systemd). */
function fail(message: string): never {
  log.error(message);
  releaseLock?.();
  process.exit(1);
}

if (config.token.length < 32) {
  fail("ENGINE_TOKEN must be set in .env.local, at least 32 characters (e.g. `openssl rand -hex 32`).");
}

try {
  releaseLock = acquireLock(path.join(config.dataDir, "engine.lock"));
} catch (error) {
  fail(error instanceof EngineLockedError ? error.message : `Could not take the lock: ${String(error)}`);
}

const version = readVersion();
const sampler = createProcessSampler();
let processStats = sampler.sample();
let feed: EngineFeed | null = null;
const universe = resolveUniverse();

const journalLog = logs.logger("journal");
const journal = createJournal({
  directory: path.join(config.dataDir, "journal"),
  istDate: calendar.istDate,
  now: clock.now,
  // Each file starts with who wrote it and what was subscribed, so a replay of that day alone
  // knows its starting point.
  onOpen: (date) => {
    journal.control("file-open", { date, version, subscriptions: subscriptionSnapshot(feed?.hub ?? null) }, clock.now());
    journalLog.info(`writing ${date}.bin`);
  },
  onError: (error) => journalLog.error("journal write failed", { error: error.message }),
  onWriteLatency: (ms) => metrics.observe("journal.write_ms", ms),
});
const dhan = createDhanWatch({
  log: logs.logger("dhan"),
  health,
  now: clock.now,
  // A socket stopped by a rejected token reconnects as soon as a new token is saved.
  onTokenChange: () => feed?.hub.retryStopped(),
});

function sessions(now: number): SegmentSession[] {
  const today = calendar.istDate(now);
  return calendar.segments().map((segment) => {
    const next = calendar.nextSession(segment, now);
    return {
      segment,
      phase: calendar.phaseAt(segment, now),
      next: next && { date: next.date, open: next.open, close: next.close },
      holiday: calendar.holiday(segment, today),
    };
  });
}

function status(): EngineStatus {
  const now = clock.now();
  return {
    protocol: PROTOCOL_VERSION,
    version,
    pid: process.pid,
    host: hostname(),
    node: process.version,
    startedAt,
    now,
    overall: health.overall(),
    components: health.list(),
    token: dhan.token(),
    dhan: dhan.account(),
    clock: dhan.clock(),
    sessions: sessions(now),
    journal: journal.status(),
    journalDays: journal.days(),
    universe: {
      name: universe.name,
      instruments: universe.instruments.length,
      byMode: Object.fromEntries(byMode(universe).map(([mode, list]) => [mode, list.length])),
      problems: universe.problems,
    },
    process: processStats,
  };
}

const server = createControlServer({
  host: config.host,
  port: config.port,
  token: config.token,
  status,
  telemetry,
  logs,
  log: logs.logger("api"),
  feed: () => feed?.hub ?? null,
});

health.set("engine", "ok");
const timers: ReturnType<typeof setInterval>[] = [];
let stopping = false;

async function start() {
  log.info("starting", { version, pid: process.pid, node: process.version, dataDir: config.dataDir });
  try {
    await server.listen();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    fail(
      code === "EADDRINUSE"
        ? `Port ${config.port} is in use. Is another engine running?`
        : `Control API failed to start: ${String(error)}`,
    );
  }
  health.set("api", "ok");
  log.info(`control API listening on http://${config.host}:${config.port}`);

  if (!calendar.isCovered(calendar.istDate(clock.now()))) {
    health.set("calendar", "degraded", "No holiday list for this year in config/engine/calendar.json");
  } else {
    health.set("calendar", "ok");
  }

  await dhan.ready();
  // After the token is loaded, so the first connection doesn't start out "missing a token".
  journal.control("engine-start", { version, pid: process.pid, universe: universe.name }, clock.now());
  feed = startFeed({ log: logs.logger("feed"), health, metrics, telemetry, journal, universe });
  dhan.tick();
  telemetry.publish("status", status());
  void dhan.check();

  let lastTickAt = clock.now();
  timers.push(
    setInterval(() => {
      const now = clock.now();
      if (now - lastTickAt > SUSPEND_THRESHOLD_MS) {
        journal.control("gap", { reason: "suspend", from: lastTickAt, to: now }, now);
        log.warn("engine was suspended or starved; gap recorded", { seconds: Math.round((now - lastTickAt) / 1000) });
      }
      lastTickAt = now;
      checkJournal();
      processStats = sampler.sample();
      dhan.tick();
      feed?.tick();
      metrics.gauge("api.clients", server.clients);
      telemetry.publish("status", status());
    }, STATUS_INTERVAL_MS),
    setInterval(() => telemetry.publish("metrics", metrics.snapshot()), METRICS_INTERVAL_MS),
    setInterval(() => void dhan.check(), DHAN_CHECK_INTERVAL_MS),
  );
}

function checkJournal() {
  const state = journal.status();
  metrics.gauge("journal.bytes", state.bytes);
  metrics.gauge("journal.backlog_bytes", state.backlogBytes);
  if (state.error) health.set("journal", "failing", `Write error: ${state.error}`);
  else if (state.slow) health.set("journal", "degraded", `Disk is behind by ${Math.round(state.backlogBytes / 1_048_576)} MB`);
  else health.set("journal", "ok");
}

async function stop(reason: string, code = 0) {
  if (stopping) return;
  stopping = true;
  log.info(`stopping (${reason})`);
  for (const timer of timers) clearInterval(timer);
  sampler.stop();
  feed?.shutdown();
  journal.control("engine-stop", { reason }, clock.now());
  await journal.close();
  await server.close();
  releaseLock?.();
  log.info("stopped");
  await logFile.close();
  process.exit(code);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("uncaughtException", (error) => {
  log.error("uncaught exception", { error: error.stack ?? String(error) });
  void stop("uncaught exception", 1);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason) });
  void stop("unhandled rejection", 1);
});

function readVersion() {
  try {
    return execFileSync("git", ["describe", "--always", "--dirty"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

void start();
