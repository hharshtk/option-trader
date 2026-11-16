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

/**
 * A trading day read back from its journal file: what the market did and what the feed delivered,
 * computed only from the raw frames on disk. `GET /v1/journal/session?date=YYYY-MM-DD`.
 */
export interface JournalSession {
  date: string;
  /** The NSE session that day (09:15–15:30 IST), or null on a weekend or holiday. */
  session: { open: number; close: number } | null;
  /** Engine wall-clock ms when this was built. */
  builtAt: number;
  /** How long reading the bytes added since the previous request took, in ms. */
  readMs: number;
  file: {
    bytes: number;
    records: number;
    frames: number;
    controls: number;
    /** Parsed packets by kind: ticker, quote, prevClose, … */
    packets: Record<string, number>;
    /** Control records by kind: subscribe, state, gap, … */
    events: Record<string, number>;
    firstFrameAt: number | null;
    lastFrameAt: number | null;
  };
  /** Each engine start in the file, with its stop when one was recorded. */
  runs: { startedAt: number; version: string | null; stoppedAt: number | null; reason: string | null }[];
  gaps: { reason: string; from: number; to: number; connection: number }[];
  /** The last 50 socket state changes. */
  states: { at: number; connection: number; state: string; reason: string | null }[];
  /** The benchmark index used for the chart and per-minute bars. */
  benchmark: string;
  /** One entry per session minute up to the last data, starting at 09:15 IST. */
  minutes: SessionMinute[];
  instruments: SessionInstrument[];
}

export interface SessionMinute {
  /** Start of the minute, wall-clock ms. */
  at: number;
  frames: number;
  packets: number;
  /** Benchmark open, high, low, close in this minute, from its ticks. */
  bar: [number, number, number, number] | null;
  /** Equities above and below their reference price at the end of the minute. */
  advancers: number;
  decliners: number;
}

export interface SessionInstrument {
  key: string;
  symbol: string;
  name: string | null;
  sector: string | null;
  /** The mode it was subscribed in: ticker, quote or full. */
  mode: string | null;
  /** Packets received for it during the day (from 09:00 IST on a trading day). */
  packets: number;
  /**
   * The price changes are measured from: the last price recorded before 09:00 IST, which is the
   * previous session's close; else Dhan's previous-close packet received during the day (Ticker
   * mode only). Null when the engine started after 09:00 in Quote mode.
   */
  reference: number | null;
  ltp: number | null;
  /** Day open, high and low: the exchange's figures in Quote mode, from the day's ticks in Ticker mode. */
  open: number | null;
  high: number | null;
  low: number | null;
  /** The exchange's average traded price for the day. Quote mode only. */
  vwap: number | null;
  /** Shares traded today, cumulative. Quote mode only. */
  volume: number | null;
  /** Pending buy and sell quantity in the order book. Quote mode only. */
  buyQty: number | null;
  sellQty: number | null;
  firstAt: number | null;
  lastAt: number | null;
  /** Last price at the end of each session minute, aligned with `minutes`; null before its first tick. */
  closes: (number | null)[];
}

export interface UniverseStatus {
  name: string;
  /** Instruments the engine keeps subscribed whether or not a page shows them. */
  instruments: number;
  /** How many of them per mode, e.g. { ticker: 1, quote: 50 }. */
  byMode: Record<string, number>;
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
