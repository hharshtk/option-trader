"use client";

import Link from "next/link";
import { tooltipClass } from "@/components/shell/header-controls";
import { useNow } from "@/components/shell/freshness";
import { Tooltip } from "@/components/tooltip";
import { StatusDot } from "@/components/ui";
import type { HealthState, ReplayStatus } from "@/lib/engine/protocol";
import { istTime } from "@/lib/format";
import { replayDay, replaySummary } from "./replay-format";
import { isStale, useEngineTelemetry, type EngineTelemetry } from "./use-engine-telemetry";

const TOPICS = ["status"] as const;

export type EngineView = "ok" | "degraded" | "failing" | "offline" | "connecting" | "unconfigured";

export const VIEW_TONE: Record<EngineView, "up" | "warn" | "down" | "muted"> = {
  ok: "up",
  degraded: "warn",
  failing: "down",
  offline: "down",
  connecting: "muted",
  unconfigured: "muted",
};

export const VIEW_LABEL: Record<EngineView, string> = {
  ok: "Running",
  degraded: "Degraded",
  failing: "Failing",
  offline: "Offline",
  connecting: "Connecting",
  unconfigured: "Not configured",
};

/** One word for the engine's state, combining the link and the engine's own health. */
export function engineView(telemetry: EngineTelemetry, now: number | null): EngineView {
  if (telemetry.link === "unconfigured") return "unconfigured";
  if (telemetry.link === "offline" || isStale(telemetry, now)) return "offline";
  if (!telemetry.status) return "connecting";
  return telemetry.status.overall satisfies HealthState;
}

/** A one-line explanation for the tooltip. */
export function engineSummary(telemetry: EngineTelemetry, view: EngineView) {
  if (view === "offline") return `${telemetry.error ?? "No status for over 5 seconds"}. Start it with npm run engine.`;
  if (view === "unconfigured") return telemetry.error ?? "Set ENGINE_URL and ENGINE_TOKEN in .env.local.";
  if (view === "connecting") return "Connecting to the engine…";
  const problems = telemetry.status?.components.filter((c) => c.state !== "ok") ?? [];
  if (problems.length === 0) return "All components ok";
  return problems.map((c) => `${c.component}: ${c.reason ?? c.state}`).join(" · ");
}

/** Header indicator on every page: the engine's overall state, linking to the Engine page. */
export function EngineStatus() {
  const telemetry = useEngineTelemetry(TOPICS);
  const now = useNow();
  const view = engineView(telemetry, now);
  const replay = view === "offline" || view === "unconfigured" ? null : telemetry.status?.replay;
  const summary = engineSummary(telemetry, view);
  const running = view === "ok" || view === "degraded" || view === "failing";

  return (
    <>
      <Tooltip
        side="bottom"
        sideOffset={6}
        className={`${tooltipClass} max-w-80`}
        content={replay ? `${replaySummary(replay)}: prices are recorded, not live. ${summary}` : summary}
      >
        <Link
          href="/engine"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-label font-medium hover:bg-raised"
        >
          <StatusDot tone={VIEW_TONE[view]} />
          <span>Engine</span>
          <span className="sr-only">{VIEW_LABEL[view]}</span>
          {replay && (
            <span className="rounded-sm border border-warn/60 px-1 text-[0.625rem] leading-4 font-medium tracking-wide text-warn uppercase">
              Replay
            </span>
          )}
        </Link>
      </Tooltip>
      {running && now !== null && (
        <TradingClock replay={replay ?? null} now={now} receivedAt={telemetry.statusReceivedAt} />
      )}
    </>
  );
}

/**
 * The time trading runs on: the recorded time during a replay, else IST now. Status arrives once
 * a second; in between, a playing replay is moved on at its speed so the seconds keep ticking.
 */
function TradingClock({
  replay,
  now,
  receivedAt,
}: {
  replay: ReplayStatus | null;
  now: number;
  receivedAt: number | null;
}) {
  if (!replay) {
    return (
      <time dateTime={new Date(now).toISOString()} className="shrink-0 font-mono text-label text-muted tabular-nums">
        {istTime.format(now)}
        <span className="font-sans max-sm:hidden"> IST</span>
      </time>
    );
  }

  const elapsed = replay.state === "playing" && receivedAt !== null ? Math.max(0, now - receivedAt) : 0;
  const at = Math.min(replay.endAt, replay.at + elapsed * replay.speed);
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={`Replay time, ${replayDay(replay.date)}, ${replay.state === "playing" ? `×${replay.speed}` : replay.state}`}
      className="flex shrink-0 items-baseline gap-1.5 font-mono text-label text-warn tabular-nums"
    >
      <span className="font-sans max-md:hidden">{replayDay(replay.date)}</span>
      {istTime.format(at)}
      {replay.state !== "playing" && <span className="font-sans text-muted max-sm:hidden">{replay.state}</span>}
    </time>
  );
}
