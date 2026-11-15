import type { Metadata } from "next";
import { Suspense } from "react";
import { FeedMonitor, type CatalogEntry } from "@/components/live/feed-monitor";
import { WorkspaceSkeleton } from "@/components/ui";
import { MARKET_INDICES, requireSession } from "@/lib/cockpit";
import { INDEX_CONSTITUENTS } from "@/lib/index-constituents";
import { indexInstrument } from "@/lib/live/instruments";

export const metadata: Metadata = { title: "Live Feed" };

// Instruments the add form can suggest: the six indices and their constituent stocks.
// NSE indices list NSE security IDs; SENSEX and BANKEX list BSE scrip codes.
function buildCatalog(): CatalogEntry[] {
  const entries = new Map<string, CatalogEntry>();
  for (const { key, name, exchange } of MARKET_INDICES) {
    entries.set(indexInstrument(key), { key: indexInstrument(key), name, detail: `${exchange} index` });
  }
  for (const { key, exchange } of MARKET_INDICES) {
    const segment = exchange === "BSE" ? "BSE_EQ" : "NSE_EQ";
    for (const stock of INDEX_CONSTITUENTS[key]) {
      const instrument = `${segment}:${stock.securityId}`;
      if (entries.has(instrument)) continue;
      entries.set(instrument, {
        key: instrument,
        name: exchange === "BSE" ? `${stock.symbol} (BSE)` : stock.symbol,
        detail: `${stock.name} · ${exchange} stock`,
      });
    }
  }
  return [...entries.values()];
}

const CATALOG = buildCatalog();

export default function LiveFeedPage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Live Feed" panels={3} />}>
      <LiveFeed />
    </Suspense>
  );
}

async function LiveFeed() {
  await requireSession();
  return <FeedMonitor catalog={CATALOG} />;
}
