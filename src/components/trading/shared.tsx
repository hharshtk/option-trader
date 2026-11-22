"use client";

import type { ReactNode } from "react";
import { useEngineTelemetry, type EngineTelemetry } from "@/components/engine/use-engine-telemetry";
import { Panel, StatusDot, Tag } from "@/components/ui";
import { DECISION_DATA, type Book, type DecisionData, type ExitReason, type TradingStatus } from "@/lib/engine/trading";
import { istTime } from "@/lib/format";

const TOPICS = ["status", "trading"] as const;

/** The engine's trading state, streamed. `trading` is null until the first message arrives. */
export function useTrading(): EngineTelemetry {
  return useEngineTelemetry(TOPICS);
}

export const fieldClass = "h-7 rounded-sm border border-line-strong bg-canvas px-2 text-body focus-visible:border-accent disabled:opacity-60";

export const clock = (time: number) => istTime.format(new Date(time));

export const EXIT_REASON: Record<ExitReason, string> = {
  stop: "Stop loss",
  trail: "Trailing stop",
  target: "Target",
  time: "Hold time",
  opposite: "Opposite signal",
  "square-off": "Square-off",
  manual: "Sold by you",
  halt: "Day stopped",
};

/** Small tags for the depth and option data a signal or rule reads; nothing when it reads none. */
export function DataTags({ uses }: { uses?: readonly DecisionData[] }) {
  if (!uses?.length) return null;
  return (
    <>
      {uses.map((d) => (
        <span key={d} title={DECISION_DATA[d].title}>
          <Tag>{DECISION_DATA[d].label}</Tag>
        </span>
      ))}
    </>
  );
}

export function BookTag({ book }: { book: Book }) {
  return book === "shadow" ? (
    <span className="rounded-sm border border-line-strong px-1 text-[0.625rem] leading-4 font-medium tracking-wide text-muted uppercase" title="Turned down by the decision gate; followed to see what it would have made">
      Shadow
    </span>
  ) : null;
}

export function Vote({ vote }: { vote: -1 | 0 | 1 }) {
  if (vote === 0) return <span className="text-muted">—</span>;
  return <span className={vote > 0 ? "text-up" : "text-down"}>{vote > 0 ? "▲ Long" : "▼ Short"}</span>;
}

const STATE_TONE: Record<TradingStatus["state"], "up" | "down" | "warn" | "muted"> = {
  ready: "up",
  waiting: "warn",
  starting: "muted",
  disarmed: "muted",
  halted: "down",
  closed: "muted",
};

const STATE_LABEL: Record<TradingStatus["state"], string> = {
  ready: "Trading",
  waiting: "Waiting",
  starting: "Starting",
  disarmed: "Entries off",
  halted: "Stopped for the day",
  closed: "No session",
};

export function StateLine({ trading }: { trading: TradingStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot tone={STATE_TONE[trading.state]} />
      {STATE_LABEL[trading.state]}
    </span>
  );
}

/** What to show instead of the page when the engine can't be reached or is too old. */
export function NoTrading({ telemetry }: { telemetry: EngineTelemetry }): ReactNode {
  if (telemetry.link === "unconfigured") {
    return (
      <Panel>
        <p>The engine isn&apos;t configured.</p>
        <p className="mt-1 text-muted">Set ENGINE_URL and ENGINE_TOKEN in .env.local, then start the engine with `npm run engine`.</p>
      </Panel>
    );
  }
  if (telemetry.link === "offline") {
    return (
      <Panel>
        <p className="text-down">The engine is offline{telemetry.error ? `: ${telemetry.error}` : "."}</p>
        <p className="mt-1 text-muted">Trading runs inside the engine. Start it with `npm run engine`; this page reconnects on its own.</p>
      </Panel>
    );
  }
  // An engine with trading reports a "trading" health component; its status is on the way.
  if (telemetry.status && !telemetry.trading && !telemetry.status.components.some((c) => c.component === "trading")) {
    return (
      <Panel>
        <p>This engine doesn&apos;t report trading.</p>
        <p className="mt-1 text-muted">It is running older code ({telemetry.status.version}). Restart it to load the trading engine.</p>
      </Panel>
    );
  }
  return (
    <Panel>
      <p className="text-muted">Connecting to the engine…</p>
    </Panel>
  );
}
