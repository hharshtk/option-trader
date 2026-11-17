import type { Metadata } from "next";
import { Suspense } from "react";
import { ActivityConsole } from "@/components/trading/activity-console";
import { WorkspaceSkeleton } from "@/components/ui";
import { requireSession } from "@/lib/cockpit";

export const metadata: Metadata = { title: "Activity" };

export default function ActivityPage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Activity" panels={3} />}>
      <Activity />
    </Suspense>
  );
}

async function Activity() {
  await requireSession();
  return <ActivityConsole />;
}
