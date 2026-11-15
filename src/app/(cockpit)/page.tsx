import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowRightIcon } from "@/components/icons";
import {
  HoldingsTable,
  PositionsTable,
  summarizeHoldings,
  summarizePositions,
} from "@/components/portfolio";
import { DataAge, TokenExpiry } from "@/components/shell/freshness";
import {
  AsOf,
  EmptyState,
  InlineError,
  linkClass,
  PageHeader,
  Panel,
  PanelSkeleton,
  Pnl,
  StatRow,
  StatusDot,
} from "@/components/ui";
import {
  getIndexQuotes,
  HEADLINE_INDICES,
  requireSession,
  settle,
  tokenExpiryIso,
} from "@/lib/cockpit";
import { getFundLimit, getHoldings, getPositions, getProfile } from "@/lib/dhan";
import { inr, price, quantity } from "@/lib/format";

export const metadata: Metadata = { title: "Overview" };

const HOLDINGS_PREVIEW_ROWS = 10;

export default function OverviewPage() {
  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <Overview />
    </Suspense>
  );
}

async function Overview() {
  await requireSession();
  const [profile, funds, holdings, positions, quotes] = await Promise.all([
    settle(getProfile()),
    settle(getFundLimit()),
    settle(getHoldings()),
    settle(getPositions()),
    getIndexQuotes(),
  ]);
  const fetchedAt = new Date().toISOString();

  if (!profile.ok) {
    return (
      <>
        <PageHeader title="Overview" />
        <div className="p-2 sm:p-3">
          <Panel>
            <p className="flex items-center gap-2 font-medium">
              <StatusDot tone="down" />
              Not connected to Dhan
            </p>
            <div className="mt-2">
              <InlineError error={profile.error} />
            </div>
          </Panel>
        </div>
      </>
    );
  }

  const account = profile.value;
  const tokenExpiry = tokenExpiryIso();
  const holdingsSummary = holdings.ok
    ? { ok: true as const, value: summarizeHoldings(holdings.value) }
    : holdings;
  const positionsSummary = positions.ok
    ? { ok: true as const, value: summarizePositions(positions.value) }
    : positions;

  return (
    <>
      <PageHeader title="Overview" meta={<>Account data <AsOf at={fetchedAt} /></>} />
      <div className="grid gap-2 p-2 sm:p-3 xl:grid-cols-6">
        <Panel title="Account" className="xl:col-span-2" action={<SectionLink href="/funds">Funds</SectionLink>}>
          {funds.ok ? (
            <dl>
              <StatRow label="Available" value={inr.format(funds.value.availabelBalance)} emphasis />
              <StatRow label="Utilized" value={inr.format(funds.value.utilizedAmount)} />
              <StatRow label="Withdrawable" value={inr.format(funds.value.withdrawableBalance)} />
            </dl>
          ) : (
            <InlineError error={funds.error} />
          )}
          <dl className="mt-2 border-t border-line pt-2">
            <StatRow
              label="Broker"
              value={
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot tone="up" />
                  Dhan · <span className="font-mono">{account.dhanClientId}</span>
                </span>
              }
            />
            {tokenExpiry && (
              <StatRow label="Token expires" value={<TokenExpiry expiresAt={tokenExpiry} />} />
            )}
          </dl>
        </Panel>

        <Panel
          title="Market"
          className="xl:col-span-2"
          meta={quotes.status === "ok" ? <DataAge at={quotes.fetchedAt} /> : undefined}
          action={<SectionLink href="/market-watch">Market Watch</SectionLink>}
        >
          {quotes.status === "ok" ? (
            <>
              <dl>
                {HEADLINE_INDICES.map(({ key, name }) => {
                  const value = quotes.prices[key];
                  return (
                    <StatRow
                      key={key}
                      label={name}
                      value={
                        <span className="font-mono">
                          {value === undefined ? "—" : price.format(value)}
                        </span>
                      }
                      emphasis
                    />
                  );
                })}
              </dl>
              <p className="mt-2 text-label text-muted">
                Last traded price. Dhan&apos;s LTP endpoint doesn&apos;t return the day&apos;s
                change.
              </p>
            </>
          ) : quotes.status === "no-plan" ? (
            <EmptyState>
              Not requested: live prices need Dhan&apos;s Data API plan, which isn&apos;t active
              on this account.
            </EmptyState>
          ) : (
            <InlineError error={quotes.error} />
          )}
        </Panel>

        <Panel
          title="Portfolio"
          className="xl:col-span-2"
          action={<SectionLink href="/holdings">Holdings</SectionLink>}
        >
          {holdingsSummary.ok ? (
            <dl>
              <StatRow label="Invested" value={inr.format(holdingsSummary.value.invested)} />
              <StatRow
                label="Current value"
                value={inr.format(holdingsSummary.value.current)}
                emphasis
              />
              <StatRow
                label="Unrealized P&L"
                value={
                  <Pnl value={holdingsSummary.value.pnl} percent={holdingsSummary.value.pnlRatio} />
                }
                emphasis
              />
            </dl>
          ) : (
            <InlineError error={holdingsSummary.error} />
          )}
          {positionsSummary.ok && (
            <dl className="mt-2 border-t border-line pt-2">
              <StatRow
                label="Open positions"
                value={quantity.format(positionsSummary.value.openCount)}
              />
              <StatRow
                label="Positions realized"
                value={<Pnl value={positionsSummary.value.realized} />}
              />
              <StatRow
                label="Positions unrealized"
                value={<Pnl value={positionsSummary.value.unrealized} />}
              />
            </dl>
          )}
        </Panel>

        <Panel
          title="Positions"
          flush
          className="xl:col-span-6 2xl:col-span-3"
          meta={
            positionsSummary.ok &&
            `${positionsSummary.value.openCount} open of ${positionsSummary.value.rows.length}`
          }
          action={<SectionLink href="/positions">All positions</SectionLink>}
        >
          {positionsSummary.ok ? (
            <PositionsTable summary={positionsSummary.value} />
          ) : (
            <div className="p-3">
              <InlineError error={positionsSummary.error} />
            </div>
          )}
        </Panel>

        <Panel
          title="Holdings"
          flush
          className="xl:col-span-6 2xl:col-span-3"
          meta={
            holdingsSummary.ok &&
            holdingsSummary.value.rows.length > HOLDINGS_PREVIEW_ROWS &&
            `Showing ${HOLDINGS_PREVIEW_ROWS} of ${holdingsSummary.value.rows.length}`
          }
          action={<SectionLink href="/holdings">All holdings</SectionLink>}
        >
          {holdingsSummary.ok ? (
            <HoldingsTable summary={holdingsSummary.value} limit={HOLDINGS_PREVIEW_ROWS} />
          ) : (
            <div className="p-3">
              <InlineError error={holdingsSummary.error} />
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

function SectionLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className={linkClass}>
      {children}
      <ArrowRightIcon className="size-3" />
    </Link>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <PageHeader title="Overview" meta="Connecting to Dhan…" />
      <div className="grid gap-2 p-2 sm:p-3 xl:grid-cols-6">
        <PanelSkeleton title="Account" rows={5} className="xl:col-span-2" />
        <PanelSkeleton title="Market" rows={3} className="xl:col-span-2" />
        <PanelSkeleton title="Portfolio" rows={5} className="xl:col-span-2" />
        <PanelSkeleton title="Positions" rows={4} className="xl:col-span-6 2xl:col-span-3" />
        <PanelSkeleton title="Holdings" rows={6} className="xl:col-span-6 2xl:col-span-3" />
      </div>
    </>
  );
}
