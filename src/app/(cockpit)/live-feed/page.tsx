import type { Metadata } from "next";
import { Suspense } from "react";
import { FeedMonitor } from "@/components/live/feed-monitor";
import { WorkspaceSkeleton } from "@/components/ui";
import { MARKET_INDICES, requireSession } from "@/lib/cockpit";
import { indexInstrument } from "@/lib/live/instruments";

export const metadata: Metadata = { title: "Live Feed" };

const INSTRUMENT_NAMES = Object.fromEntries(
  MARKET_INDICES.map(({ key, name }) => [indexInstrument(key), name]),
);

export default function LiveFeedPage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Live Feed" panels={3} />}>
      <LiveFeed />
    </Suspense>
  );
}

async function LiveFeed() {
  await requireSession();
  return <FeedMonitor names={INSTRUMENT_NAMES} />;
}
