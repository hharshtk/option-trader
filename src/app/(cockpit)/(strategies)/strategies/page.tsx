import type { Metadata } from "next";
import { Suspense } from "react";
import { StrategyStore } from "@/components/strategies/strategy-store";
import { WorkspaceSkeleton } from "@/components/ui";
import { requireSession } from "@/lib/cockpit";

export const metadata: Metadata = { title: "Strategies" };

export default function StrategiesPage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Strategies" panels={3} />}>
      <Strategies />
    </Suspense>
  );
}

async function Strategies() {
  await requireSession();
  return <StrategyStore />;
}
