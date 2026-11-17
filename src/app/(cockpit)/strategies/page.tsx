import type { Metadata } from "next";
import { Suspense } from "react";
import { TradingConsole } from "@/components/trading/trading-console";
import { WorkspaceSkeleton } from "@/components/ui";
import { requireSession } from "@/lib/cockpit";

export const metadata: Metadata = { title: "Strategies" };

export default function StrategiesPage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Strategies" panels={4} />}>
      <Strategies />
    </Suspense>
  );
}

async function Strategies() {
  await requireSession();
  return <TradingConsole />;
}
