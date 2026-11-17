import type { Metadata } from "next";
import { Suspense } from "react";
import { HoldingsStats, HoldingsTable, summarizeHoldings } from "@/components/portfolio";
import { AsOf, InlineError, PageHeader, Panel, WorkspaceSkeleton } from "@/components/ui";
import { requireSession, settle } from "@/lib/cockpit";
import { getHoldings } from "@/lib/dhan";

export const metadata: Metadata = { title: "Holdings" };

export default function HoldingsPage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Holdings" />}>
      <Holdings />
    </Suspense>
  );
}

async function Holdings() {
  await requireSession();
  const holdings = await settle(getHoldings());
  const fetchedAt = new Date().toISOString();

  if (!holdings.ok) {
    return (
      <>
        <PageHeader title="Holdings" />
        <div className="p-2 sm:p-3">
          <Panel>
            <InlineError error={holdings.error} />
          </Panel>
        </div>
      </>
    );
  }

  const summary = summarizeHoldings(holdings.value);

  return (
    <>
      <PageHeader title="Holdings" meta={<AsOf at={fetchedAt} />} />
      <div className="space-y-2 p-2 sm:p-3">
        <Panel>
          <HoldingsStats summary={summary} />
        </Panel>
        <Panel title="Demat" meta="LTP as reported by Dhan's holdings endpoint" flush>
          <HoldingsTable summary={summary} detailed />
        </Panel>
      </div>
    </>
  );
}
