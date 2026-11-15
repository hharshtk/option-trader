import { TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import type { Metadata } from "next";
import { Suspense } from "react";
import { ConstituentsPanel } from "@/components/index-constituents";
import { IndexWorkspace } from "@/components/live/index-workspace";
import { LiveChange, LivePrice } from "@/components/live/live-quote";
import { DataAge } from "@/components/shell/freshness";
import { EmptyState, InlineError, PageHeader, Panel, Tag } from "@/components/ui";
import { getIndexQuotes, MARKET_INDICES, requireSession, type IndexKey } from "@/lib/cockpit";
import { INDEX_CONSTITUENTS } from "@/lib/index-constituents";
import { indexInstrument } from "@/lib/live/instruments";

export const metadata: Metadata = { title: "Market Watch" };

export default function MarketWatchPage() {
  return (
    <>
      <PageHeader
        title="Market Watch"
        meta={
          <Suspense fallback="Loading from Dhan…">
            <QuotesAge />
          </Suspense>
        }
      />
      <IndexWorkspace
        indices={MARKET_INDICES.map(({ key, name }) => ({
          key,
          name,
          instrument: indexInstrument(key),
        }))}
        tiles={
          <Panel title="Indices" meta="Select one for its chart and constituents" flush>
            <TabsList
              aria-label="Index"
              className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 xl:grid-cols-6"
            >
              {MARKET_INDICES.map(({ key, name, exchange }) => (
                <TabsTab
                  key={key}
                  value={key}
                  className="group block w-full cursor-pointer bg-panel px-3 py-2.5 text-left hover:bg-raised/60 focus-visible:-outline-offset-2 data-selected:bg-raised data-selected:shadow-[inset_0_-2px_0_var(--color-accent)]"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-label font-medium text-muted group-data-selected:text-accent">
                      {name}
                    </span>
                    <span className="text-[0.625rem] tracking-wide text-muted">{exchange}</span>
                  </span>
                  <span className="mt-1 block font-mono text-lg leading-6">
                    <Suspense
                      fallback={
                        <span className="inline-block h-4 w-20 rounded-sm bg-raised motion-safe:animate-pulse" />
                      }
                    >
                      <IndexPrice indexKey={key} />
                    </Suspense>
                  </span>
                  <span className="block min-h-4">
                    <LiveChange instrument={indexInstrument(key)} />
                  </span>
                </TabsTab>
              ))}
            </TabsList>
            <Suspense fallback={null}>
              <QuotesNotice />
            </Suspense>
          </Panel>
        }
        panels={MARKET_INDICES.map(({ key, name }) => (
          <TabsPanel key={key} value={key} className="outline-none">
            <ConstituentsPanel name={name} rows={INDEX_CONSTITUENTS[key]} />
          </TabsPanel>
        ))}
      />
      <div className="p-2 sm:p-3">
        <Panel title="Watchlist" action={<Tag>Not built</Tag>}>
          <EmptyState>
            Adding stocks or option contracts needs a search over Dhan&apos;s instrument master
            to find security IDs.
          </EmptyState>
        </Panel>
      </div>
    </>
  );
}

async function loadQuotes() {
  await requireSession();
  return getIndexQuotes();
}

async function QuotesAge() {
  const quotes = await loadQuotes();
  if (quotes.status !== "ok") return null;
  return (
    <>
      Snapshot <DataAge at={quotes.fetchedAt} />
    </>
  );
}

async function IndexPrice({ indexKey }: { indexKey: IndexKey }) {
  const quotes = await loadQuotes();
  const value = quotes.status === "ok" ? quotes.prices[indexKey] : undefined;
  return <LivePrice instrument={indexInstrument(indexKey)} fallback={value} />;
}

async function QuotesNotice() {
  const quotes = await loadQuotes();
  if (quotes.status === "ok") return null;
  return (
    <div className="border-t border-line p-3">
      {quotes.status === "no-plan" ? (
        <EmptyState>
          Not requested: live prices need Dhan&apos;s Data API plan, which isn&apos;t active on
          this account.
        </EmptyState>
      ) : (
        <InlineError error={quotes.error} />
      )}
    </div>
  );
}
