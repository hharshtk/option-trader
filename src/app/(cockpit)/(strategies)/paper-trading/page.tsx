import type { Metadata } from "next";
import { Suspense } from "react";
import { TradingConsole } from "@/components/trading/trading-console";
import { WorkspaceSkeleton } from "@/components/ui";
import { requireSession } from "@/lib/cockpit";

export const metadata: Metadata = { title: "Paper trading" };

export default function PaperTradingPage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Paper trading" panels={4} />}>
      <PaperTrading />
    </Suspense>
  );
}

async function PaperTrading() {
  await requireSession();
  return <TradingConsole />;
}
