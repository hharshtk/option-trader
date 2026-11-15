import type { Metadata } from "next";
import { Suspense } from "react";
import { AsOf, Field, InlineError, PageHeader, Panel, WorkspaceSkeleton } from "@/components/ui";
import { requireSession, settle } from "@/lib/cockpit";
import { getFundLimit } from "@/lib/dhan";
import { inr } from "@/lib/format";

export const metadata: Metadata = { title: "Funds" };

export default function FundsPage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Funds" />}>
      <Funds />
    </Suspense>
  );
}

async function Funds() {
  await requireSession();
  const funds = await settle(getFundLimit());
  const fetchedAt = new Date().toISOString();

  if (!funds.ok) {
    return (
      <>
        <PageHeader title="Funds" />
        <div className="p-2 sm:p-3">
          <Panel>
            <InlineError error={funds.error} />
          </Panel>
        </div>
      </>
    );
  }

  const limit = funds.value;

  return (
    <>
      <PageHeader title="Funds" meta={<AsOf at={fetchedAt} />} />
      <div className="grid gap-2 p-2 sm:p-3 lg:grid-cols-2">
        <Panel title="Balances">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Available" value={inr.format(limit.availabelBalance)} size="lg" />
            <Field label="Utilized" value={inr.format(limit.utilizedAmount)} size="lg" />
            <Field label="Withdrawable" value={inr.format(limit.withdrawableBalance)} size="lg" />
          </dl>
        </Panel>
        <Panel title="Limits">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Start-of-day limit" value={inr.format(limit.sodLimit)} />
            <Field label="Collateral" value={inr.format(limit.collateralAmount)} />
            <Field label="Receivable" value={inr.format(limit.receiveableAmount)} />
            <Field label="Blocked payout" value={inr.format(limit.blockedPayoutAmount)} />
          </dl>
        </Panel>
      </div>
    </>
  );
}
