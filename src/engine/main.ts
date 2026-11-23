// The engine process: `npm run engine`. It monitors itself and the Dhan account, owns the live
// Dhan feed, and reports everything to the web. Later steps add the journal and runs.

import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION, type EngineStatus, type LogLevel, type SegmentSession } from "../lib/engine/protocol.ts";
import { createControlServer } from "./api/server.ts";
import { createDhanWatch } from "./dhan-watch.ts";
import { subscriptionSnapshot } from "./feed.ts";
import { createFeedSwitch } from "./feed-switch.ts";
import { createJournalSessions } from "./journal/session-reader.ts";
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
import { getParquetStore } from "../lib/db/parquet-store.ts";
import { getOptionChain } from "../lib/dhan/api.ts";
import { getDhanCredentials, getTokenStore } from "../lib/dhan/config.ts";
import { INDEX } from "../lib/dhan/instruments.ts";
import { createDepthFeed } from "./recording/depth-feed.ts";
import { chainView, createLiveSideData, depthView } from "./replay/side-data.ts";
import { createDecisionJob } from "./decide/job.ts";
import { createDecisionLab } from "./decide/lab.ts";
import { loadMoveProfile } from "./trading/move-history.ts";
import { createFuturesSource } from "./recording/futures.ts";
import { createRecorder } from "./recording/recorder.ts";
import { createDecisionProviders } from "./trading/decision.ts";
import { createCandleSource, createContractSource } from "./trading/sources.ts";
import { createTradingStore } from "./trading/store.ts";
import { createTrader } from "./trading/trader.ts";
import { createDhanBroker } from "./trading/dhan-broker.ts";
import { createLiveDesk } from "./trading/live-desk.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const STATUS_INTERVAL_MS = 1_000;
const METRICS_INTERVAL_MS = 5_000;
const DHAN_CHECK_INTERVAL_MS = 15 * 60_000;
/** A status tick this late means the process was suspended or starved: data is missing. */
const SUSPEND_THRESHOLD_MS = 5_000;

// `--replay` starts on a recorded day instead of the live feed (`npm run engine:replay`), with
// `--date YYYY-MM-DD` (default: the newest recorded day), `--from HH:MM` IST (default: 09:00 on a
// trading day) and `--speed N` (default 1). The Engine page can switch either way at any time.
const args = (() => {
  try {
    return parseArgs({
      options: {
        replay: { type: "boolean", default: false },
        date: { type: "string" },
        from: { type: "string" },
        speed: { type: "string" },
      },
    }).values;
  } catch (error) {
    console.error(`${(error as Error).message}\nUsage: npm run engine:replay -- [--date YYYY-MM-DD] [--from HH:MM] [--speed N]`);
    process.exit(1);
  }
})();

const config = {
  host: process.env.ENGINE_HOST ?? "127.0.0.1",
  port: Number(process.env.ENGINE_PORT ?? 3100),
  token: process.env.ENGINE_TOKEN?.trim() ?? "",
  dataDir: path.resolve(ROOT, process.env.ENGINE_DATA_DIR ?? "data/engine"),
  logLevel: (process.env.ENGINE_LOG_LEVEL ?? "info") as LogLevel,
  // On unless switched off: a second engine on the same Dhan account should set it to false.
  recordOptionChain: !/^(false|0|off|no)$/i.test(process.env.ENGINE_RECORD_OPTION_CHAIN?.trim() ?? ""),
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
const universe = resolveUniverse();

const journalLog = logs.logger("journal");
const journal = createJournal({
  directory: path.join(config.dataDir, "journal"),
  istDate: calendar.istDate,
  now: clock.now,
  // Each file starts with who wrote it and what was subscribed, so a replay of that day alone
  // knows its starting point.
  onOpen: (date) => {
    journal.control("file-open", { date, version, subscriptions: subscriptionSnapshot(feeds.liveHub()) }, clock.now());
    journalLog.info(`writing ${date}.bin`);
  },
  onError: (error) => journalLog.error("journal write failed", { error: error.message }),
  onWriteLatency: (ms) => metrics.observe("journal.write_ms", ms),
});
// The feed: live from Dhan, or a recorded day replayed through a stand-in for Dhan's socket.
const feeds = createFeedSwitch({
  logger: (component) => logs.logger(component),
  health,
  metrics,
  telemetry,
  journal,
  journalDirectory: path.join(config.dataDir, "journal"),
  universe,
  calendar,
  now: clock.now,
  // Trading reads the market from the same frames, live or replayed; the recorder only live ones.
  onFrame: (frame, at) => {
    trader.onFrame(frame, at);
    if (feeds.liveHub()) recorder.onFrame(frame);
  },
});
const journalSessions = createJournalSessions({ directory: path.join(config.dataDir, "journal"), calendar, now: clock.now });

// Paper trading. Its tables go to the app's file store as Parquet; the namespace keeps a second
// engine on another port (development) from overwriting the main engine's runs in a shared bucket.
const tradingNamespace = config.port === 3100 ? "main" : `dev-${config.port}`;
const tradingDirectory = path.join(config.dataDir, "trading");
const parquet = getParquetStore();
// One source for both trading and the recorder, so a stale instrument file is downloaded once.
const loadContracts = createContractSource({ store: parquet, log: logs.logger("trading.contracts"), now: clock.now });
// Shared too: the recorder streams the futures, and trading's scalp lab reads the nearest one.
const loadFutures = createFuturesSource({ store: parquet, log: logs.logger("futures"), now: clock.now });
const trader = createTrader({
  namespace: tradingNamespace,
  directory: tradingDirectory,
  version,
  calendar,
  log: logs.logger("trading"),
  health,
  now: clock.now,
  store: createTradingStore(parquet, tradingNamespace),
  hub: () => feeds.current()?.hub ?? null,
  replay: () => feeds.replayPosition(),
  hold: () => feeds.holdReplay(),
  // The same day the Pulse page reads: as far as the replay has reached, or today's journal.
  session: (date) => feeds.replaySession(date) ?? journalSessions.read(date),
  // A client per Decision API provider whose key is set; the trading settings choose one.
  decisions: createDecisionProviders(process.env),
  loadContracts,
  loadFutures,
  loadCandles: createCandleSource({
    directory: path.join(tradingDirectory, "candles"),
    istDate: calendar.istDate,
    complete: (date) => {
      const session = calendar.session("NSE_FNO", date);
      return !session || clock.now() > session.close + 5 * 60_000;
    },
  }),
  publish: (status) => telemetry.publish("trading", status, status.marketTime),
  loadMoveProfile: (date) => loadMoveProfile(parquet, date),
  // The live pilot. Only the main engine may place orders: development and test engines share the Dhan account.
  live: (hooks) =>
    createLiveDesk({
      notAllowed: config.port === 3100 ? null : `Live orders are placed only by the main engine (port 3100); this one is on port ${config.port}`,
      directory: tradingDirectory,
      broker: createDhanBroker(),
      now: clock.now,
      log: logs.logger("trading.live"),
      table: { store: parquet, namespace: tradingNamespace },
      ...hooks,
    }),
});

// The research recorder: futures, a wide option window, 20-level depth and option chain snapshots
// on every trading day. Depth and chain go to side files next to the journal.
const recorderLog = logs.logger("recorder");
const sideJournal = (suffix: string, describe: () => Record<string, unknown>) => {
  const side = createJournal({
    directory: path.join(config.dataDir, "journal"),
    suffix,
    istDate: calendar.istDate,
    now: clock.now,
    onOpen: (date) => side.control("file-open", { date, version, ...describe() }, clock.now()),
    onError: (error) => recorderLog.error(`${suffix.slice(1)} file write failed`, { error: error.message }),
  });
  return side;
};
const depthJournal = sideJournal(".depth", () => ({ feed: "twentydepth", instruments: recorder.status().depth.instruments }));
const chainJournal = sideJournal(".chain", () => ({ indices: recorder.status().indices.map((index) => index.name) }));
// The latest books, chains and contract names, kept as the recorder writes them, for the web.
const liveSides = createLiveSideData(clock.now);
const depthFeed = createDepthFeed({
  readCredentials: getDhanCredentials,
  currentToken: () => getTokenStore().current(),
  onFrame: (frame, at) => {
    depthJournal.frame(1, frame, at);
    liveSides.addDepthFrame(frame, at);
  },
  onEvent: (kind, data, at) => depthJournal.control(kind, data, at, 1),
  log: (message) => recorderLog.info(message),
  now: clock.now,
});
// The decision lab: after each session, the day's per-minute table and every rule scored on
// every recorded day, in a child process. Its scorecard is on the Strategies page.
const decisions = createDecisionJob({
  lab: createDecisionLab({ store: parquet, directory: path.join(config.dataDir, "journal"), calendar, version, now: clock.now }),
  calendar,
  log: logs.logger("decide"),
  now: clock.now,
  root: ROOT,
  dataDir: config.dataDir,
});

const recorder = createRecorder({
  log: recorderLog,
  health,
  now: clock.now,
  calendar,
  hub: () => feeds.liveHub(),
  journal: {
    control(kind, data, at, connection) {
      liveSides.addControl(kind, data, at);
      journal.control(kind, data, at, connection);
    },
  },
  depth: depthFeed,
  chainJournal: {
    control(kind, data, at, connection) {
      liveSides.addControl(kind, data, at);
      chainJournal.control(kind, data, at, connection);
    },
  },
  loadContracts,
  loadFutures,
  fetchChain: (underlying, expiry) => getOptionChain(INDEX[underlying as keyof typeof INDEX], expiry),
  depthFile: () => depthJournal.status(),
  chainFile: () => chainJournal.status(),
  recordChain: config.recordOptionChain,
});
if (!config.recordOptionChain) recorderLog.info("option chain snapshots off (ENGINE_RECORD_OPTION_CHAIN)");

const dhan = createDhanWatch({
  log: logs.logger("dhan"),
  health,
  now: clock.now,
  // A socket stopped by a rejected token reconnects as soon as a new token is saved.
  onTokenChange: () => {
    feeds.liveHub()?.retryStopped();
    depthFeed.retryStopped();
  },
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
    replay: feeds.replayStatus(),
    replayBlocked: feeds.replayBlocked(),
    recorder: recorder.status(),
    tradingHalt: trader.halted(),
    tradingLive: trader.live(),
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
  feed: () => feeds.current()?.hub ?? null,
  replay: async (body) => {
    const result = await feeds.command(body);
    // Trading follows a replay start or seek at once instead of at the next tick.
    trader.tick();
    return result;
  },
  // During a replay, the replayed day reads as far as the replay has reached (and is the default).
  journalSession: (date) => {
    const day = date ?? feeds.replayDate() ?? calendar.istDate(clock.now());
    return feeds.replaySession(day) ?? journalSessions.read(day);
  },
  trading: trader,
  depth: (key) => depthView(feeds.replaySides() ?? liveSides, key),
  chain: (underlying, expiry) => chainView(feeds.replaySides() ?? liveSides, underlying, expiry),
  decide: () => decisions.view(),
  predictions: () => decisions.predictions(),
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
  await trader.start();
  // After the token is loaded, so the first connection doesn't start out "missing a token".
  journal.control("engine-start", { version, pid: process.pid, universe: universe.name }, clock.now());
  if (args.replay) {
    const result = await feeds.command({
      action: "start",
      date: args.date,
      from: args.from,
      speed: args.speed === undefined ? undefined : Number(args.speed),
    });
    if (!result.ok) {
      log.warn(`not replaying: ${result.message} Starting the live feed.`);
      feeds.startLive();
    }
    trader.tick();
  } else {
    feeds.startLive();
  }
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
      feeds.tick();
      trader.tick();
      recorder.tick();
      decisions.tick();
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
  // Before the feed goes: the run's tables are saved and its log closed.
  await trader.stop().catch((error: unknown) => log.error("trading did not stop cleanly", { error: String(error) }));
  recorder.shutdown();
  decisions.shutdown();
  feeds.shutdown();
  journal.control("engine-stop", { reason }, clock.now());
  await Promise.all([journal.close(), depthJournal.close(), chainJournal.close()]);
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
