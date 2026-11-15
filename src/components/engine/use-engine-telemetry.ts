"use client";

import { useEffect, useReducer } from "react";
import type { FeedHealth } from "@/lib/live/feed/monitor";
import type {
  EngineStatus,
  LogEntry,
  MetricsSnapshot,
  TelemetryGap,
  TelemetryHello,
  TelemetryMessage,
  TelemetryTopic,
} from "@/lib/engine/protocol";

const BASE = "/api/engine/v1";
const MAX_LOGS = 2_000;
const RETRY_MS = 2_000;
const SLOW_RETRY_MS = 15_000;

export type EngineLink = "connecting" | "open" | "offline" | "unconfigured";

export interface EngineTelemetry {
  link: EngineLink;
  /** Why the engine can't be reached, from the proxy. */
  error: string | null;
  status: EngineStatus | null;
  /** Wall-clock ms in this browser when the last status arrived. */
  statusReceivedAt: number | null;
  metrics: MetricsSnapshot | null;
  /** The engine's Dhan feed: sockets, instruments, tick flow. */
  feed: FeedHealth | null;
  logs: LogEntry[];
  /** Messages the engine dropped because this tab fell behind. */
  dropped: number;
}

type Action =
  | { type: "link"; link: EngineLink; error?: string | null }
  | { type: "status"; status: EngineStatus; at: number }
  | { type: "metrics"; metrics: MetricsSnapshot }
  | { type: "feed"; feed: FeedHealth }
  | { type: "logs"; entries: LogEntry[] }
  | { type: "gap"; dropped: number };

const INITIAL: EngineTelemetry = {
  link: "connecting",
  error: null,
  status: null,
  statusReceivedAt: null,
  metrics: null,
  feed: null,
  logs: [],
  dropped: 0,
};

function reduce(state: EngineTelemetry, action: Action): EngineTelemetry {
  switch (action.type) {
    case "link":
      return { ...state, link: action.link, error: action.error ?? null };
    case "status": {
      // A different start time means the engine restarted: its old log lines are history.
      const restarted = state.status !== null && state.status.startedAt !== action.status.startedAt;
      return {
        ...state,
        link: "open",
        error: null,
        status: action.status,
        statusReceivedAt: action.at,
        logs: restarted ? [] : state.logs,
        metrics: restarted ? null : state.metrics,
        feed: restarted ? null : state.feed,
      };
    }
    case "metrics":
      return { ...state, metrics: action.metrics };
    case "feed":
      return { ...state, feed: action.feed };
    case "logs": {
      const logs = state.logs.concat(action.entries);
      return { ...state, logs: logs.length > MAX_LOGS ? logs.slice(-MAX_LOGS) : logs };
    }
    case "gap":
      return { ...state, dropped: state.dropped + action.dropped };
  }
}

/** Streams the engine's telemetry through the signed-in proxy. One EventSource per caller. */
export function useEngineTelemetry(topics: readonly TelemetryTopic[]): EngineTelemetry {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const topicKey = topics.join(",");

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastSeq = 0;
    let disposed = false;
    // Log lines arrive in bursts (the backlog on connect); batch them into one render.
    let pendingLogs: LogEntry[] = [];
    let flushScheduled = false;

    const flushLogs = () => {
      flushScheduled = false;
      if (pendingLogs.length === 0) return;
      dispatch({ type: "logs", entries: pendingLogs });
      pendingLogs = [];
    };

    const read = <T,>(event: Event) => {
      const message = JSON.parse((event as MessageEvent<string>).data) as TelemetryMessage;
      lastSeq = Math.max(lastSeq, message.seq);
      return message.data as T;
    };

    // EventSource can't see the HTTP status, so ask the proxy why the stream failed.
    async function diagnose() {
      try {
        const response = await fetch(`${BASE}/status`, { cache: "no-store" });
        if (response.ok) return { link: "offline" as const, error: "Telemetry stream dropped", retryMs: RETRY_MS };
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (response.status === 501) return { link: "unconfigured" as const, error: body.error ?? null, retryMs: SLOW_RETRY_MS };
        if (response.status === 401) return { link: "offline" as const, error: "Signed out", retryMs: SLOW_RETRY_MS };
        return { link: "offline" as const, error: body.error ?? `Engine returned HTTP ${response.status}`, retryMs: RETRY_MS };
      } catch {
        return { link: "offline" as const, error: "Web server unreachable", retryMs: RETRY_MS };
      }
    }

    function connect() {
      if (disposed) return;
      // A new EventSource doesn't resend Last-Event-ID, so pass the last seq explicitly.
      source = new EventSource(`${BASE}/telemetry?topics=${topicKey}${lastSeq ? `&since=${lastSeq}` : ""}`);
      source.addEventListener("hello", (event) => {
        const hello = JSON.parse((event as MessageEvent<string>).data) as TelemetryHello;
        // The engine restarted with a lower seq: forget ours so nothing is skipped next time.
        if (hello.seq < lastSeq) lastSeq = 0;
        dispatch({ type: "link", link: "open" });
      });
      source.addEventListener("status", (event) =>
        dispatch({ type: "status", status: read<EngineStatus>(event), at: Date.now() }),
      );
      source.addEventListener("metrics", (event) => dispatch({ type: "metrics", metrics: read<MetricsSnapshot>(event) }));
      source.addEventListener("feed", (event) => dispatch({ type: "feed", feed: read<FeedHealth>(event) }));
      source.addEventListener("log", (event) => {
        pendingLogs.push(read<LogEntry>(event));
        if (!flushScheduled) {
          flushScheduled = true;
          requestAnimationFrame(flushLogs);
        }
      });
      source.addEventListener("gap", (event) =>
        dispatch({ type: "gap", dropped: (JSON.parse((event as MessageEvent<string>).data) as TelemetryGap).dropped }),
      );
      source.addEventListener("error", () => {
        if (source?.readyState !== EventSource.CLOSED) return dispatch({ type: "link", link: "connecting" });
        source = null;
        void diagnose().then(({ link, error, retryMs }) => {
          if (disposed) return;
          dispatch({ type: "link", link, error });
          retry = setTimeout(connect, retryMs);
        });
      });
    }

    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      source?.close();
    };
  }, [topicKey]);

  return state;
}

/** True when the stream is open but no status arrived for a while: the engine is hung or gone. */
export function isStale(telemetry: EngineTelemetry, now: number | null) {
  return (
    telemetry.link === "open" &&
    now !== null &&
    telemetry.statusReceivedAt !== null &&
    now - telemetry.statusReceivedAt > 5_000
  );
}
