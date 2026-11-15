import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader, Panel, Tag } from "@/components/ui";

export const metadata: Metadata = { title: "Activity" };

export default function ActivityPage() {
  return (
    <>
      <PageHeader title="Activity">
        <Tag>Not built</Tag>
      </PageHeader>
      <div className="p-2 sm:p-3">
        <Panel>
          <p>There&apos;s no activity log yet.</p>
          <p className="mt-1 text-muted">
            Today&apos;s orders from Dhan are on the{" "}
            <Link href="/orders" className="text-fg underline underline-offset-2">
              Orders
            </Link>{" "}
            page.
          </p>
        </Panel>
      </div>
    </>
  );
}
