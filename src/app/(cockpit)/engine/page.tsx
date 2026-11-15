import type { Metadata } from "next";
import { Suspense } from "react";
import { EngineConsole } from "@/components/engine/engine-console";
import { WorkspaceSkeleton } from "@/components/ui";
import { requireSession } from "@/lib/cockpit";

export const metadata: Metadata = { title: "Engine" };

export default function EnginePage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Engine" panels={4} />}>
      <Engine />
    </Suspense>
  );
}

async function Engine() {
  await requireSession();
  return <EngineConsole />;
}
