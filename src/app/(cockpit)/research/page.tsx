import type { Metadata } from "next";
import { Suspense } from "react";
import { ResearchWorkspace } from "@/components/research/research-workspace";
import { WorkspaceSkeleton } from "@/components/ui";
import { requireSession } from "@/lib/cockpit";

export const metadata: Metadata = { title: "Research" };

export default function ResearchPage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Research" panels={3} />}>
      <Research />
    </Suspense>
  );
}

async function Research() {
  await requireSession();
  return <ResearchWorkspace />;
}
