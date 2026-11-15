// Types shared by the engine and the web. The web imports only this file, never engine
// internals. Plain TypeScript with type-only imports, so both sides can load it.

import type { FeedHealth } from "../live/feed/monitor.ts";

export const PROTOCOL_VERSION = 1;

/** The live run's id. Replays and backtests get their own ids. */
export const LIVE_RUN = "live";

export type HealthState = "ok" | "degraded" | "failing";

export interface ComponentHealth {
  component: string;
  state: HealthState;
  /** Why it isn't ok. Absent when ok. */
  reason?: string;
  /** Wall-clock ms when it entered this state. */
  since: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  /** Wall-clock ms. */
  at: number;
  level: LogLevel;
  component: string;
  message: string;
  fields?: Record<string, unknown>;
}

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p99: number;
}

export interface MetricsSnapshot {
  /** Wall-clock ms when taken. */
  at: number;
  /** Length of the window histograms cover, in ms. */
  windowMs: number;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramSnapshot>;
}

export interface ProcessStats {
  rssBytes: number;
  heapUsedBytes: number;
  /** Share of one CPU core used since the last sample, 0–100+. */
  cpuPercent: number;
  eventLoopDelayP99Ms: number;
}

export interface TokenStatus {
  source: "redis" | "env" | "none";
  /** ISO time the access token expires, read from the token itself. */
  expiresAt: string | null;
}

export interface DhanAccountStatus {
  /** Wall-clock ms of the last successful profile check. */
  checkedAt: number;
  clientId: string;
  dataPlan: string;
  /** As Dhan sends it. */
  dataValidity: string;
  /** As Dhan sends it: "DD/MM/YYYY HH:mm" IST. */
  tokenValidity: string;
  activeSegments: string[];
}

export interface ClockStatus {
  /** Dhan's clock minus ours, estimated from REST `Date` headers. Positive: ours is behind. */
  offsetMs: number;
  /** The estimate is within ± this, from the header's 1 s resolution and the round trip. */
  uncertaintyMs: number;
  measuredAt: number;
}

export interface SegmentSession {
  segment: string;
  phase: "pre-open" | "open" | "closed";
  /** The current or next session, as wall-clock ms. */
  next: { date: string; open: number; close: number } | null;
  /** Holiday name when today is a holiday. */
  holiday: string | null;
}

export interface JournalStatus {
  /** IST date of the file being written, or null before the first record. */
  date: string | null;
  file: string | null;
  /** Size of today's file, including what earlier runs wrote. */
  bytes: number;
  /** Records written by this engine run today. */
  frames: number;
  controls: number;
  gaps: number;
  /** Last sequence number written. Restarts at each engine start. */
  seq: number;
  lastWriteAt: number | null;
  /** Data accepted but not yet on disk. */
  backlogBytes: number;
  error: string | null;
  /** The backlog is large: the disk isn't keeping up. */
  slow: boolean;
}

export interface JournalDay {
  date: string;
  bytes: number;
}

export interface UniverseStatus {
  name: string;
  /** Instruments the engine keeps subscribed whether or not a page shows them. */
  instruments: number;
  /** Entries in config/engine/universe.json that couldn't be resolved. */
  problems: string[];
}

export interface EngineStatus {
  protocol: number;
  /** Git commit the engine runs, with -dirty for uncommitted changes, or "unknown". */
  version: string;
  pid: number;
  host: string;
  node: string;
  startedAt: number;
  now: number;
  /** Worst state of any component. */
  overall: HealthState;
  components: ComponentHealth[];
  token: TokenStatus;
  dhan: DhanAccountStatus | null;
  clock: ClockStatus | null;
  sessions: SegmentSession[];
  journal: JournalStatus | null;
  /** Recorded days, newest first. */
  journalDays: JournalDay[];
  universe: UniverseStatus | null;
  process: ProcessStats;
}

export type TelemetryTopic = "status" | "log" | "metrics" | "feed" | "bars" | "gaps";

export interface TelemetryData {
  status: EngineStatus;
  log: LogEntry;
  metrics: MetricsSnapshot;
  feed: FeedHealth;
  bars: unknown;
  gaps: unknown;
}

/** One message on the telemetry stream. */
export interface TelemetryMessage<T extends TelemetryTopic = TelemetryTopic> {
  run: string;
  /** Increases by one per message within a run, so a client can resume and spot gaps. */
  seq: number;
  topic: T;
  /** The run's clock time: virtual in replays and backtests. */
  at: number;
  /** The engine's wall-clock time. */
  wall: number;
  data: TelemetryData[T];
}

/** Sent first on every telemetry connection. */
export interface TelemetryHello {
  protocol: number;
  run: string;
  /** The newest seq at connect time. */
  seq: number;
}

/** Sent when a slow client lost messages. */
export interface TelemetryGap {
  dropped: number;
}

export const HEALTH_RANK: Record<HealthState, number> = { ok: 0, degraded: 1, failing: 2 };

export function worstHealth(states: Iterable<HealthState>): HealthState {
  let worst: HealthState = "ok";
  for (const state of states) if (HEALTH_RANK[state] > HEALTH_RANK[worst]) worst = state;
  return worst;
}
