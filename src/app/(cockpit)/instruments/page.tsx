import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import {
  buttonClass,
  EmptyState,
  Field,
  linkClass,
  PageHeader,
  Panel,
  StatusDot,
  Tag,
  WorkspaceSkeleton,
} from "@/components/ui";
import { requireSession } from "@/lib/cockpit";
import {
  getOptionScripsStatus,
  listOptionChain,
  listOptionExpiries,
  listOptionUnderlyings,
  type ChainStrike,
  type OptionContract,
  type OptionExchange,
  type OptionUnderlying,
} from "@/lib/dhan/option-lookup";
import { optionScripsLocation } from "@/lib/dhan/option-scrips-store";
import { istDateTime, price, quantity } from "@/lib/format";

// Scrip explorer: browse the option contracts stored by Settings → Download option instruments
// (S3 when configured), as loaded into this server's memory by option-lookup.ts.

export const metadata: Metadata = { title: "Instruments" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const LOOKUP = { allowStale: true };

const chipClass =
  "inline-flex shrink-0 items-center gap-1 rounded-sm px-2 py-1 text-label font-medium whitespace-nowrap text-muted hover:bg-raised hover:text-fg aria-[current=true]:bg-accent/15 aria-[current=true]:text-accent";
const inputClass =
  "h-7 w-48 rounded-sm border border-line-strong bg-canvas px-2 text-body focus-visible:border-accent";

const expiryFormat = new Intl.DateTimeFormat("en-IN", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "2-digit",
});

export default function InstrumentsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Instruments" />}>
      <Explorer searchParams={searchParams} />
    </Suspense>
  );
}

async function Explorer({ searchParams }: { searchParams: SearchParams }) {
  await requireSession();
  const params = await searchParams;
  const location = optionScripsLocation();

  let status: Awaited<ReturnType<typeof getOptionScripsStatus>>;
  try {
    status = await getOptionScripsStatus();
  } catch (error) {
    return (
      <Layout location={location}>
        <p className="text-down">
          Couldn&apos;t load option instruments from {location}:{" "}
          {error instanceof Error ? error.message : String(error)}
        </p>
      </Layout>
    );
  }
  if (!status.info) {
    return (
      <Layout location={location}>
        <EmptyState>
          No option instruments stored yet. Download them in{" "}
          <Link href="/settings" className="text-accent hover:underline">
            Settings
          </Link>
          .
        </EmptyState>
      </Layout>
    );
  }

  const underlyings = await listOptionUnderlyings(LOOKUP);
  const selected = pickUnderlying(underlyings, first(params.u));
  const expiries = selected ? await listOptionExpiries(selected.underlying, selected.exchange, LOOKUP) : [];
  const requested = first(params.expiry);
  const expiry = expiries.find((entry) => entry.expiry === requested) ?? expiries[0];
  const chain = selected && expiry ? await listOptionChain(selected.underlying, expiry.expiry, selected.exchange, LOOKUP) : [];

  const indices = underlyings.filter((entry) => entry.instrument === "OPTIDX");
  const stocks = underlyings.filter((entry) => entry.instrument === "OPTSTK");

  return (
    <Layout
      location={location}
      meta={
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={status.current ? "up" : "warn"} />
          Downloaded {istDateTime.format(new Date(status.info.downloadedAt))}
          {!status.current && <span className="text-warn">· not today</span>}
        </span>
      }
    >
      {!status.current && (
        <p className="text-warn">
          These are contracts for {status.info.tradingDate}. Strategies refuse an earlier day&apos;s
          download; get today&apos;s in{" "}
          <Link href="/settings" className="underline">
            Settings
          </Link>
          .
        </p>
      )}

      <Panel>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-4">
          <nav aria-label="Index underlyings" className="flex min-w-0 gap-1 overflow-x-auto">
            {indices.map((entry) => (
              <Link
                key={underlyingParam(entry)}
                href={explorerHref(entry)}
                aria-current={entry === selected ? "true" : undefined}
                className={chipClass}
              >
                {entry.underlying}
              </Link>
            ))}
          </nav>
          <span aria-hidden className="hidden h-5 w-px shrink-0 bg-line lg:block" />
          <Form action="/instruments" className="flex shrink-0 items-center gap-2">
            <label htmlFor="stock-underlying" className="sr-only">
              Stock underlying
            </label>
            <input
              id="stock-underlying"
              name="u"
              list="stock-underlyings"
              placeholder={`Stock, e.g. RELIANCE (${stocks.length})`}
              defaultValue={selected?.instrument === "OPTSTK" ? underlyingParam(selected) : undefined}
              autoComplete="off"
              className={inputClass}
            />
            <datalist id="stock-underlyings">
              {stocks.map((entry) => (
                <option key={underlyingParam(entry)} value={underlyingParam(entry)} />
              ))}
            </datalist>
            <button type="submit" className={buttonClass}>
              Show
            </button>
          </Form>
        </div>
        {selected && expiries.length > 0 && (
          <nav aria-label="Expiry" className="mt-2 flex min-w-0 gap-1 overflow-x-auto border-t border-line pt-2">
            {expiries.map((entry) => (
              <Link
                key={entry.expiry}
                href={explorerHref(selected, entry.expiry)}
                aria-current={entry.expiry === expiry?.expiry ? "true" : undefined}
                className={`${chipClass} tabular-nums`}
              >
                {formatExpiry(entry.expiry)}
                {entry.expiryFlag === "M" && <Tag>M</Tag>}
              </Link>
            ))}
          </nav>
        )}
      </Panel>

      {!selected ? (
        <Panel>
          <EmptyState>No underlying matches “{first(params.u)}”.</EmptyState>
        </Panel>
      ) : !expiry ? (
        <Panel>
          <EmptyState>{selected.underlying} has no unexpired options.</EmptyState>
        </Panel>
      ) : (
        <ChainPanel underlying={selected} expiry={expiry} chain={chain} />
      )}
    </Layout>
  );
}

function Layout({ location, meta, children }: { location: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <>
      <PageHeader title="Instruments" meta={meta}>
        <span className="hidden font-mono text-label text-muted sm:inline">{location}</span>
        <Link href="/settings" className={linkClass}>
          Download
        </Link>
      </PageHeader>
      <div className="space-y-2 p-2 sm:p-3">{children}</div>
    </>
  );
}

function ChainPanel({
  underlying,
  expiry,
  chain,
}: {
  underlying: OptionUnderlying;
  expiry: { expiry: string; expiryFlag: string };
  chain: ChainStrike[];
}) {
  const contracts = chain.flatMap((row) => [row.CE, row.PE]).filter((c): c is OptionContract => c !== undefined);
  const sample = contracts[0];

  return (
    <Panel
      title={`${underlying.underlying} · ${formatExpiry(expiry.expiry)} · ${expiry.expiryFlag === "M" ? "monthly" : "weekly"}`}
      meta={`${quantity.format(chain.length)} strikes · ${quantity.format(contracts.length)} contracts`}
      flush
    >
      {sample && (
        <dl className="grid grid-cols-2 gap-3 border-b border-line p-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Segment" value={<span className="font-mono">{sample.segment}</span>} />
          <Field label="Instrument" value={sample.instrument} />
          <Field label="Lot size" value={range(contracts.map((c) => c.lotSize))} />
          <Field label="Tick" value={`₹${price.format(sample.tickSize)}`} />
          <Field
            label="Max per order"
            value={
              sample.maxOrderQty >= 100_000_000
                ? "No freeze limit"
                : `${range(contracts.map((c) => c.maxLotsPerOrder))} lots (${quantity.format(sample.maxOrderQty)} qty)`
            }
          />
          <Field label="Strike step" value={strikeStep(chain)} />
        </dl>
      )}
      <div tabIndex={0} className="max-h-[calc(100dvh-20rem)] min-h-72 overflow-auto focus-visible:-outline-offset-2">
        <table className="w-full min-w-[44rem] border-collapse text-body tabular-nums">
          <caption className="sr-only">
            {underlying.underlying} {expiry.expiry} option contracts
          </caption>
          <thead className="sticky top-0 z-10 bg-panel text-label tracking-wider text-muted uppercase">
            <tr className="border-b border-line">
              <th colSpan={3} scope="colgroup" className="h-7 px-3 text-center font-medium">
                Calls (CE)
              </th>
              <td aria-hidden className="bg-raised" />
              <th colSpan={3} scope="colgroup" className="h-7 px-3 text-center font-medium">
                Puts (PE)
              </th>
            </tr>
            <tr className="border-b border-line">
              <th scope="col" className="h-7 px-3 text-left font-medium">Security ID</th>
              <th scope="col" className="h-7 px-3 text-right font-medium">Band low</th>
              <th scope="col" className="h-7 px-3 text-right font-medium">Band high</th>
              <th scope="col" className="h-7 bg-raised px-3 text-center font-medium">Strike</th>
              <th scope="col" className="h-7 px-3 text-right font-medium">Band low</th>
              <th scope="col" className="h-7 px-3 text-right font-medium">Band high</th>
              <th scope="col" className="h-7 px-3 text-right font-medium">Security ID</th>
            </tr>
          </thead>
          <tbody>
            {chain.map((row) => (
              <tr key={row.strike} className="border-b border-line/70 hover:bg-raised/50">
                <td className="h-8 px-3 text-left font-mono" title={row.CE?.displayName}>
                  {row.CE?.securityId ?? "—"}
                </td>
                <Band value={row.CE?.lowerLimit} />
                <Band value={row.CE?.upperLimit} />
                <th scope="row" className="h-8 bg-raised px-3 text-center font-medium">
                  {quantity.format(row.strike)}
                </th>
                <Band value={row.PE?.lowerLimit} />
                <Band value={row.PE?.upperLimit} />
                <td className="h-8 px-3 text-right font-mono" title={row.PE?.displayName}>
                  {row.PE?.securityId ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-3 py-2 text-label text-muted">
        Price bands are as of the download. Hover a security ID for Dhan&apos;s contract name.
      </p>
    </Panel>
  );
}

function Band({ value }: { value: number | null | undefined }) {
  return <td className="h-8 px-3 text-right text-muted">{value == null ? "—" : price.format(value)}</td>;
}

function range(values: number[]) {
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? quantity.format(low) : `${quantity.format(low)}–${quantity.format(high)}`;
}

/** The most common gap between neighbouring strikes. */
function strikeStep(chain: ChainStrike[]) {
  const counts = new Map<number, number>();
  for (let i = 1; i < chain.length; i++) {
    const step = Math.round((chain[i].strike - chain[i - 1].strike) * 100) / 100;
    counts.set(step, (counts.get(step) ?? 0) + 1);
  }
  const [step] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return step === undefined ? "—" : quantity.format(step);
}

/** "NIFTY" for NSE, "BSE:SENSEX" for BSE. */
function underlyingParam(entry: { exchange: OptionExchange; underlying: string }) {
  return entry.exchange === "NSE" ? entry.underlying : `${entry.exchange}:${entry.underlying}`;
}

function explorerHref(entry: OptionUnderlying, expiry?: string) {
  const query = new URLSearchParams({ u: underlyingParam(entry) });
  if (expiry) query.set("expiry", expiry);
  return `/instruments?${query}`;
}

/** Reads "NIFTY", "BSE:SENSEX" or "sensex" (NSE first, then BSE). Defaults to NIFTY. */
function pickUnderlying(underlyings: OptionUnderlying[], value: string | undefined) {
  const raw = value?.trim().toUpperCase();
  if (!raw) return underlyings.find((u) => u.exchange === "NSE" && u.underlying === "NIFTY") ?? underlyings[0];
  const [exchange, symbol] = raw.includes(":") ? raw.split(":", 2) : [undefined, raw];
  const matches = underlyings.filter((u) => u.underlying === symbol && (!exchange || u.exchange === exchange));
  return matches.find((u) => u.exchange === "NSE") ?? matches[0];
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatExpiry(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : expiryFormat.format(date);
}
