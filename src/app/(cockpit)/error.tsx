"use client";

import { useEffect } from "react";
import { buttonClass, PageHeader, Panel } from "@/components/ui";

export default function CockpitError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <>
      <PageHeader title="Something broke" />
      <div className="p-2 sm:p-3">
        <Panel>
          <p className="text-down">
            This section failed to render: {error instanceof Error ? error.message : String(error)}
          </p>
          <p className="mt-1 text-muted">The header and the other sections still work.</p>
          <button type="button" onClick={retry} className={`${buttonClass} mt-3`}>
            Try again
          </button>
        </Panel>
      </div>
    </>
  );
}
