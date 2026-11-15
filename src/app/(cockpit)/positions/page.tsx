import type { Metadata } from "next";
import { Suspense } from "react";
import { PositionsStats, PositionsTable, summarizePositions } from "@/components/portfolio";
import { AsOf, InlineError, PageHeader, Panel, WorkspaceSkeleton } from "@/components/ui";
import { requireSession, settle } from "@/lib/cockpit";
import { getPositions } from "@/lib/dhan";

export const metadata: Metadata = { title: "Positions" };

export default function PositionsPage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Positions" />}>
      <Positions />
    </Suspense>
  );
}

async function Positions() {
  await requireSession();
  const positions = await settle(getPositions());
  const fetchedAt = new Date().toISOString();

  if (!positions.ok) {
    return (
      <>
        <PageHeader title="Positions" />
        <div className="p-2 sm:p-3">
          <Panel>
            <InlineError error={positions.error} />
          </Panel>
        </div>
      </>
    );
  }

  const summary = summarizePositions(positions.value);

  return (
    <>
      <PageHeader title="Positions" meta={<AsOf at={fetchedAt} />} />
      <div className="space-y-2 p-2 sm:p-3">
        <Panel>
          <PositionsStats summary={summary} />
        </Panel>
        <Panel
          title="Today"
          meta="Open positions first. Dhan's positions response has no LTP column."
          flush
        >
          <PositionsTable summary={summary} detailed />
        </Panel>
      </div>
    </>
  );
}
