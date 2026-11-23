"use client";

// The trading mode at the top of every page, so it is never in doubt: PAPER while only the paper book
// trades, LIVE in red while real orders at Dhan follow it. It links to Strategies, where live is
// switched on and off (with its confirmation); it switches nothing itself.

import Link from "next/link";
import { engineView } from "@/components/engine/engine-status";
import { useEngineTelemetry } from "@/components/engine/use-engine-telemetry";
import { tooltipClass } from "@/components/shell/header-controls";
import { useNow } from "@/components/shell/freshness";
import { Tooltip } from "@/components/tooltip";
import { signedInr } from "@/lib/format";

const TOPICS = ["status"] as const;

export function TradingMode() {
  const telemetry = useEngineTelemetry(TOPICS);
  const now = useNow();
  const view = engineView(telemetry, now);
  const status = telemetry.status;
  // Without the engine's status the mode isn't known: the engine indicator beside this says why.
  if (!status || view === "offline" || view === "unconfigured" || view === "connecting") return null;

  const live = status.tradingLive ?? null;
  const replay = status.replay ? " · replay" : "";
  const today = live ? `${signedInr.format(Math.round(live.net * 100) / 100)} today after charges` : "";
  const mode = live?.on
    ? {
        label: "Live",
        detail: "real orders",
        className: "bg-down text-white hover:bg-down/85",
        tip: `Live: each paper entry also buys one lot at Dhan with real money. ${live.holding ? `${live.holding} real position held` : "Nothing real held"}, ${today}. Turn it off on Strategies.`,
      }
    : live && live.holding > 0
      ? {
          label: "Live off",
          detail: `${live.holding} real held`,
          className: "border border-warn bg-warn/15 text-warn hover:bg-warn/25",
          tip: `Live is off, but ${live.holding} real position is still held at Dhan and is sold with its paper position. ${today}.`,
        }
      : {
          label: "Paper",
          detail: replay ? "replay" : "no real orders",
          className: "border border-accent bg-accent/10 text-accent hover:bg-accent/20",
          tip: `Paper only: trades are simulated${replay ? " on a recorded day" : ""} and nothing is sent to Dhan. Live trading is switched on for a day on Strategies.`,
        };

  return (
    <Tooltip side="bottom" sideOffset={6} className={`${tooltipClass} max-w-80`} content={live?.alert ? `${mode.tip} Needs a look: ${live.alert}` : mode.tip}>
      <Link
        href="/strategies"
        aria-label={`Trading mode: ${mode.label}, ${mode.detail}. Open Strategies`}
        className={`flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-label font-semibold tracking-wider uppercase ${mode.className}`}
      >
        {live?.on && (
          <span className="relative inline-flex size-2">
            <span className="absolute inline-flex size-full rounded-full bg-white opacity-70 motion-safe:animate-ping" />
            <span className="relative inline-flex size-2 rounded-full bg-white" />
          </span>
        )}
        <span>{mode.label}</span>
        <span className="font-normal tracking-normal normal-case opacity-80 max-md:hidden">{mode.detail}</span>
        {live?.alert && <span aria-hidden className="ml-0.5 rounded-full bg-white px-1 text-[0.625rem] leading-4 font-bold text-down">!</span>}
      </Link>
    </Tooltip>
  );
}
