import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { OptionChainTable } from "@/components/option-chain";
import { RefreshEvery } from "@/components/refresh-every";
import { DataAge } from "@/components/shell/freshness";
import { EmptyState, InlineError, PageHeader, Panel, WorkspaceSkeleton } from "@/components/ui";
import { MARKET_INDICES, requireSession, settle, type IndexKey } from "@/lib/cockpit";
import { getOptionChain, getOptionExpiries, getProfile, INDEX, type OptionChain } from "@/lib/dhan";
import type { ChainView } from "@/lib/engine/protocol";
import { engineConfig, engineFetch } from "@/lib/engine/web";
import { istTime, price } from "@/lib/format";

export const metadata: Metadata = { title: "Options Chain" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const chipClass =
  "shrink-0 rounded-sm px-2 py-1 text-label font-medium whitespace-nowrap text-muted hover:bg-raised hover:text-fg aria-[current=true]:bg-accent/15 aria-[current=true]:text-accent";

const expiryDay = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const expiryDayYear = new Intl.DateTimeFormat("en-IN", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "2-digit",
});

export default function OptionsChainPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Options Chain" />}>
      <OptionsChain searchParams={searchParams} />
    </Suspense>
  );
}

async function OptionsChain({ searchParams }: { searchParams: SearchParams }) {
  await requireSession();
  const params = await searchParams;
  const underlyingKey = parseUnderlying(first(params.u));
  const underlying = MARKET_INDICES.find(({ key }) => key === underlyingKey) ?? MARKET_INDICES[0];
  const showAll = first(params.all) === "1";

  // While the engine replays a recorded day, show that day's chain as recorded, not today's.
  const replayed = await recordedChain(underlyingKey, first(params.expiry));
  if (replayed) return <RecordedChain view={replayed} underlying={underlyingKey} showAll={showAll} />;

  const profile = await settle(getProfile());
  if (!profile.ok) {
    return (
      <ChainLayout underlying={underlyingKey}>
        <InlineError error={profile.error} />
      </ChainLayout>
    );
  }
  if (profile.value.dataPlan !== "Active") {
    return (
      <ChainLayout underlying={underlyingKey}>
        <EmptyState>
          Not requested: option chains need Dhan&apos;s Data API plan, which isn&apos;t active on
          this account.
        </EmptyState>
      </ChainLayout>
    );
  }

  const expiries = await settle(getOptionExpiries(INDEX[underlyingKey]));
  if (!expiries.ok) {
    return (
      <ChainLayout underlying={underlyingKey}>
        <InlineError error={expiries.error} />
      </ChainLayout>
    );
  }
  if (expiries.value.length === 0) {
    return (
      <ChainLayout underlying={underlyingKey}>
        <EmptyState>Dhan returned no expiries for {underlying.name}.</EmptyState>
      </ChainLayout>
    );
  }

  const requested = first(params.expiry);
  const expiry = requested && expiries.value.includes(requested) ? requested : expiries.value[0];
  const chain = await settle(getOptionChain(INDEX[underlyingKey], expiry));
  const fetchedAt = new Date().toISOString();
  const firstYear = expiries.value[0].slice(0, 4);
  const href = (next: { expiry?: string; all?: boolean }) =>
    chainHref(underlyingKey, next.expiry ?? expiry, next.all ?? showAll);

  return (
    <ChainLayout
      underlying={underlyingKey}
      meta={
        chain.ok ? (
          <>
            Snapshot <DataAge at={fetchedAt} />
          </>
        ) : undefined
      }
      expiryPicker={
        <nav aria-label="Expiry" className="flex min-w-0 gap-1 overflow-x-auto">
          {expiries.value.map((value) => (
            <Link
              key={value}
              href={href({ expiry: value })}
              aria-current={value === expiry ? "true" : undefined}
              className={`${chipClass} tabular-nums`}
            >
              {formatExpiry(value, firstYear)}
            </Link>
          ))}
        </nav>
      }
      chain={
        <Panel
          title={`${underlying.name} · ${formatExpiry(expiry, firstYear)} expiry`}
          meta={chain.ok ? `Spot ${price.format(chain.value.last_price)}` : undefined}
          flush
        >
          {chain.ok ? (
            <OptionChainTable
              chain={chain.value}
              underlyingName={underlying.name}
              scrollToken={`${underlyingKey}:${expiry}:${showAll}`}
              showAll={showAll}
              toggleHref={href({ all: !showAll })}
            />
          ) : (
            <div className="p-3">
              <InlineError error={chain.error} />
            </div>
          )}
        </Panel>
      }
    />
  );
}

/** The engine's recorded chain when it is replaying a day; null when it is live, unreachable or not set up. */
async function recordedChain(underlying: IndexKey, expiry: string | undefined): Promise<ChainView | null> {
  const config = engineConfig();
  if (!config) return null;
  const ask = async (wanted?: string) => {
    const query = new URLSearchParams({ underlying });
    if (wanted) query.set("expiry", wanted);
    const response = await engineFetch(config, `/v1/chain?${query}`, { signal: AbortSignal.timeout(3_000) });
    return response.ok ? ((await response.json()) as ChainView) : null;
  };
  try {
    const view = await ask();
    if (!view || view.source !== "replay") return null;
    if (expiry && expiry !== view.snapshot?.expiry && view.expiries.includes(expiry)) return (await ask(expiry)) ?? view;
    return view;
  } catch {
    // The engine is offline: the page falls back to Dhan as it always has.
    return null;
  }
}

const replayDay = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

/** A replayed day's chain: the latest snapshot the recorder took by the replay's position. Refreshes to follow the replay. */
function RecordedChain({ view, underlying, showAll }: { view: ChainView; underlying: IndexKey; showAll: boolean }) {
  const name = MARKET_INDICES.find(({ key }) => key === underlying)?.name ?? underlying;
  const snapshot = view.snapshot;
  const day = replayDay.format(view.at);
  const firstYear = view.expiries[0]?.slice(0, 4) ?? "";
  const meta = (
    <>
      <span className="text-warn">Replay of {day}</span> · {snapshot ? `recorded at ${istTime.format(snapshot.at)} IST, once a minute` : `at ${istTime.format(view.at)} IST`}
    </>
  );
  return (
    <>
      <RefreshEvery ms={10_000} />
      <ChainLayout
        underlying={underlying}
        meta={meta}
        expiryPicker={
          view.expiries.length > 0 ? (
            <nav aria-label="Expiry" className="flex min-w-0 gap-1 overflow-x-auto">
              {view.expiries.map((value) => (
                <Link key={value} href={chainHref(underlying, value, showAll)} aria-current={value === snapshot?.expiry ? "true" : undefined} className={`${chipClass} tabular-nums`}>
                  {formatExpiry(value, firstYear)}
                </Link>
              ))}
            </nav>
          ) : undefined
        }
        chain={
          snapshot ? (
            <Panel title={`${name} · ${formatExpiry(snapshot.expiry, firstYear)} expiry`} meta={`Spot ${price.format(snapshot.lastPrice)}`} flush>
              <OptionChainTable
                chain={{ last_price: snapshot.lastPrice, oc: snapshot.oc as OptionChain["oc"] }}
                underlyingName={name}
                scrollToken={`replay:${underlying}:${snapshot.expiry}:${showAll}`}
                showAll={showAll}
                toggleHref={chainHref(underlying, snapshot.expiry, !showAll)}
              />
            </Panel>
          ) : undefined
        }
      >
        {!snapshot && (
          <EmptyState>
            No {name} option chain recorded on {day} by {istTime.format(view.at)} IST. The recorder keeps NIFTY&apos;s three nearest expiries and BANKNIFTY&apos;s two, once a minute,
            from 18 November 2026.
          </EmptyState>
        )}
      </ChainLayout>
    </>
  );
}

function ChainLayout({
  underlying,
  meta,
  expiryPicker,
  chain,
  children,
}: {
  underlying: IndexKey;
  meta?: ReactNode;
  expiryPicker?: ReactNode;
  chain?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <PageHeader title="Options Chain" meta={meta} />
      <div className="space-y-2 p-2 sm:p-3">
        <Panel>
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-4">
            <nav aria-label="Underlying" className="flex shrink-0 gap-1 overflow-x-auto">
              {MARKET_INDICES.map(({ key, name }) => (
                <Link
                  key={key}
                  href={chainHref(key)}
                  aria-current={key === underlying ? "true" : undefined}
                  className={chipClass}
                >
                  {name}
                </Link>
              ))}
            </nav>
            {expiryPicker && (
              <>
                <span aria-hidden className="hidden h-5 w-px shrink-0 bg-line lg:block" />
                {expiryPicker}
              </>
            )}
          </div>
        </Panel>
        {chain}
        {children && <Panel>{children}</Panel>}
      </div>
    </>
  );
}

function chainHref(underlying: IndexKey, expiry?: string, all = false) {
  const query = new URLSearchParams({ u: underlying });
  if (expiry) query.set("expiry", expiry);
  if (all) query.set("all", "1");
  return `/options-chain?${query}`;
}

function parseUnderlying(value: string | undefined): IndexKey {
  return MARKET_INDICES.find(({ key }) => key === value)?.key ?? "NIFTY";
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatExpiry(value: string, firstYear: string) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return (value.startsWith(firstYear) ? expiryDay : expiryDayYear).format(date);
}
