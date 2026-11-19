"use client";

// A red bar across the top of every page while paper trading is stopped for the day: the daily
// loss limit, too many losses in a row, or Stop for the day. Without it the only sign is that no
// trades happen. Read from the engine's status stream, which carries the halt every second.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEngineTelemetry } from "@/components/engine/use-engine-telemetry";
import { istTime } from "@/lib/format";

const TOPICS = ["status"] as const;

export function TradingHaltBanner() {
  const { status } = useEngineTelemetry(TOPICS);
  const pathname = usePathname();
  const halt = status?.tradingHalt ?? null;
  if (!halt) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-down px-3 py-2 text-body text-white">
      <span className="font-semibold">Trading stopped for the day{halt.source === "replay" ? " (replay)" : ""}</span>
      <span>
        at {istTime.format(halt.at).slice(0, 5)} IST: {halt.reason}. No new trades until you resume, or the next session starts.
      </span>
      {pathname !== "/strategies" && (
        <Link href="/strategies" className="ml-auto rounded-sm border border-white/70 px-2 py-0.5 font-medium hover:bg-white/15">
          Open Strategies
        </Link>
      )}
    </div>
  );
}
