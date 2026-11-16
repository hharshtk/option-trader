import type { Metadata } from "next";
import { Suspense } from "react";
import { PulseView } from "@/components/insight/pulse-view";
import { WorkspaceSkeleton } from "@/components/ui";
import { requireSession } from "@/lib/cockpit";

export const metadata: Metadata = { title: "Pulse" };

export default function PulsePage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Pulse" panels={4} />}>
      <Pulse />
    </Suspense>
  );
}

async function Pulse() {
  await requireSession();
  return <PulseView />;
}
