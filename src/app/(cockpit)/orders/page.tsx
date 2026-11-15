import type { Metadata } from "next";
import { Suspense } from "react";
import { countOrders, OrdersTable } from "@/components/orders";
import { AsOf, InlineError, PageHeader, Panel, Tag, WorkspaceSkeleton } from "@/components/ui";
import { requireSession, settle } from "@/lib/cockpit";
import { getOrders } from "@/lib/dhan";

export const metadata: Metadata = { title: "Orders" };

export default function OrdersPage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Orders" panels={1} />}>
      <Orders />
    </Suspense>
  );
}

async function Orders() {
  await requireSession();
  const orders = await settle(getOrders());
  const fetchedAt = new Date().toISOString();

  if (!orders.ok) {
    return (
      <>
        <PageHeader title="Orders" />
        <div className="p-2 sm:p-3">
          <Panel>
            <InlineError error={orders.error} />
          </Panel>
        </div>
      </>
    );
  }

  const counts = countOrders(orders.value);

  return (
    <>
      <PageHeader title="Orders" meta={<AsOf at={fetchedAt} />}>
        <Tag>Read-only</Tag>
      </PageHeader>
      <div className="space-y-2 p-2 sm:p-3">
        <Panel
          title="Today"
          meta={`${counts.total} orders · ${counts.traded} traded · ${counts.open} open · ${counts.rejected} rejected`}
          flush
        >
          <OrdersTable orders={orders.value} />
        </Panel>
        <p className="px-1 text-label text-muted">
          Placing, modifying and cancelling orders isn&apos;t built. Dhan&apos;s order APIs also
          need a whitelisted static IP.
        </p>
      </div>
    </>
  );
}
