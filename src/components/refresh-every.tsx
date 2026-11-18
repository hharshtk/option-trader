"use client";

// Re-renders the server page every `ms` while the tab is visible: for a page showing a replay,
// which moves on without the page asking.

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function RefreshEvery({ ms }: { ms: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, ms);
    return () => clearInterval(timer);
  }, [ms, router]);
  return null;
}
