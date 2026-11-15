import type { Metadata } from "next";
import { Suspense } from "react";
import { DataAge } from "@/components/shell/freshness";
import {
  EmptyState,
  InlineError,
  PageHeader,
  Panel,
  Tag,
  WorkspaceSkeleton,
} from "@/components/ui";
import { getIndexQuotes, MARKET_INDICES, requireSession } from "@/lib/cockpit";
import { price } from "@/lib/format";

export const metadata: Metadata = { title: "Market Watch" };

export default function MarketWatchPage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Market Watch" />}>
      <MarketWatch />
    </Suspense>
  );
}

async function MarketWatch() {
  await requireSession();
  const quotes = await getIndexQuotes();

  return (
    <>
      <PageHeader
        title="Market Watch"
        meta={
          quotes.status === "ok" ? (
            <>
              LTP snapshot <DataAge at={quotes.fetchedAt} />
            </>
          ) : undefined
        }
      />
      <div className="space-y-2 p-2 sm:p-3">
        <Panel title="Indices" flush>
          {quotes.status === "ok" ? (
            <ul className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 xl:grid-cols-6">
              {MARKET_INDICES.map(({ key, name, exchange }) => {
                const value = quotes.prices[key];
                return (
                  <li key={key} className="bg-panel px-3 py-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-label font-medium text-muted">{name}</span>
                      <span className="text-[0.625rem] tracking-wide text-muted">{exchange}</span>
                    </div>
                    <div className="mt-1 font-mono text-lg leading-6 tabular-nums">
                      {value === undefined ? "—" : price.format(value)}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="p-3">
              {quotes.status === "no-plan" ? (
                <EmptyState>
                  Not requested: live prices need Dhan&apos;s Data API plan, which isn&apos;t
                  active on this account.
                </EmptyState>
              ) : (
                <InlineError error={quotes.error} />
              )}
            </div>
          )}
        </Panel>
        <Panel title="Watchlist" action={<Tag>Not built</Tag>}>
          <EmptyState>
            Adding stocks or option contracts needs a search over Dhan&apos;s instrument master
            to find security IDs. Prices here refresh on page load; streaming needs the live
            market feed.
          </EmptyState>
        </Panel>
      </div>
    </>
  );
}
