import type { Metadata } from "next";
import { PageHeader, Panel, Tag } from "@/components/ui";

export const metadata: Metadata = { title: "Strategies" };

export default function StrategiesPage() {
  return (
    <>
      <PageHeader title="Strategies">
        <Tag>Not built</Tag>
      </PageHeader>
      <div className="p-2 sm:p-3">
        <Panel>
          <p>Strategies aren&apos;t built yet.</p>
          <p className="mt-1 text-muted">
            The app reads from Dhan but can&apos;t place orders, so there&apos;s nothing to automate
            yet. Dhan also requires a whitelisted static IP before its API accepts orders.
          </p>
        </Panel>
      </div>
    </>
  );
}
