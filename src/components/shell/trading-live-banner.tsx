"use client";

// A bar across the top of every page while real money is in play: live trading on, a real position
// held, or something at Dhan that needs a look. Read from the engine's status stream every second.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEngineTelemetry } from "@/components/engine/use-engine-telemetry";
import { signedInr } from "@/lib/format";

const TOPICS = ["status"] as const;

export function TradingLiveBanner() {
  const { status } = useEngineTelemetry(TOPICS);
  const pathname = usePathname();
  const live = status?.tradingLive ?? null;
  if (!live) return null;
  const holding = live.holding === 0 ? "nothing held" : `${live.holding} real position${live.holding === 1 ? "" : "s"} held`;
  return (
    <div role={live.alert ? "alert" : "status"} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b-2 border-down bg-down/15 px-3 py-1.5 text-body">
      <span className="font-semibold text-down">{live.on ? "Live trading: real orders at Dhan" : "Live trading is off, but real money is still in play"}</span>
      <span className="tabular-nums">
        {holding} · {signedInr.format(Math.round(live.net * 100) / 100)} today after charges
      </span>
      {live.alert && <span className="font-medium text-down">{live.alert}</span>}
      {pathname !== "/strategies" && (
        <Link href="/strategies" className="ml-auto rounded-sm border border-down px-2 py-0.5 font-medium text-down hover:bg-down/15">
          Open Strategies
        </Link>
      )}
    </div>
  );
}
