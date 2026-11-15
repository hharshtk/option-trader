import { Suspense } from "react";
import { connection } from "next/server";
import { Holdings, Positions } from "@/components/portfolio";
import { Card, EmptyState, Field, InlineError } from "@/components/ui";
import {
  describeDhanError,
  getAccessTokenExpiry,
  getDhanCredentials,
  getFundLimit,
  getHoldings,
  getLtp,
  getPositions,
  getProfile,
  INDEX,
  type DhanErrorDescription,
} from "@/lib/dhan";
import { inr, istDateTime, price } from "@/lib/format";

const SEGMENT_NAMES: Record<string, string> = {
  E: "Equity",
  D: "Derivatives",
  C: "Currency",
  M: "Commodity",
};

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Option Trader</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Broker connection and portfolio
      </p>
      <Suspense fallback={<StatusSkeleton />}>
        <DhanStatus />
      </Suspense>
    </main>
  );
}

async function DhanStatus() {
  await connection();

  const nifty = INDEX.NIFTY.securityId;
  const bankNifty = INDEX.BANKNIFTY.securityId;
  const profileRequest = getProfile();
  const [profile, funds, holdings, positions, ltp] = await Promise.allSettled([
    profileRequest,
    getFundLimit(),
    getHoldings(),
    getPositions(),
    profileRequest.then((account) =>
      account.dataPlan === "Active" ? getLtp({ IDX_I: [nifty, bankNifty] }) : null,
    ),
  ]);

  if (profile.status === "rejected") {
    return <ConnectionError error={describeDhanError(profile.reason)} />;
  }

  const account = profile.value;
  const tokenExpiry = getAccessTokenExpiry(getDhanCredentials().accessToken);
  const segments = account.activeSegment
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean)
    .map((code) => SEGMENT_NAMES[code] ?? code);

  return (
    <div className="mt-8 space-y-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 font-medium">
            <span aria-hidden className="size-2.5 rounded-full bg-emerald-500" />
            Connected to Dhan
          </p>
          <p className="font-mono text-sm text-zinc-600 dark:text-zinc-400">
            Client ID {account.dhanClientId}
          </p>
        </div>
        {tokenExpiry && (
          <TokenExpiry expiresAt={tokenExpiry} remaining={timeUntil(tokenExpiry)} />
        )}
      </Card>

      <Card title="Account">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Active segments" value={segments.join(", ") || "None"} />
          <Field label="DDPI" value={account.ddpi} />
          <Field
            label="Data API plan"
            value={
              account.dataPlan === "Active"
                ? `Active until ${account.dataValidity}`
                : "Not subscribed"
            }
          />
        </dl>
      </Card>

      <Card title="Funds">
        {funds.status === "fulfilled" ? (
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Available" value={inr.format(funds.value.availabelBalance)} />
            <Field label="Utilized" value={inr.format(funds.value.utilizedAmount)} />
            <Field label="Withdrawable" value={inr.format(funds.value.withdrawableBalance)} />
          </dl>
        ) : (
          <InlineError error={describeDhanError(funds.reason)} />
        )}
      </Card>

      <Card title="Positions">
        {positions.status === "fulfilled" ? (
          <Positions positions={positions.value} />
        ) : (
          <InlineError error={describeDhanError(positions.reason)} />
        )}
      </Card>

      <Card title="Holdings">
        {holdings.status === "fulfilled" ? (
          <Holdings holdings={holdings.value} />
        ) : (
          <InlineError error={describeDhanError(holdings.reason)} />
        )}
      </Card>

      <Card title="Market data">
        {ltp.status === "rejected" ? (
          <InlineError error={describeDhanError(ltp.reason)} />
        ) : ltp.value === null ? (
          <EmptyState>
            Not requested: live prices need Dhan&apos;s Data API plan, which isn&apos;t active
            on this account.
          </EmptyState>
        ) : (
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="NIFTY 50" value={formatLtp(ltp.value.IDX_I?.[nifty]?.last_price)} />
            <Field label="NIFTY BANK" value={formatLtp(ltp.value.IDX_I?.[bankNifty]?.last_price)} />
          </dl>
        )}
      </Card>
    </div>
  );
}

function timeUntil(date: Date) {
  const ms = Math.max(0, date.getTime() - Date.now());
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return { ms, label: `${hours}h ${minutes}m` };
}

function TokenExpiry({
  expiresAt,
  remaining,
}: {
  expiresAt: Date;
  remaining: { ms: number; label: string };
}) {
  const warn = remaining.ms < 2 * 3_600_000;

  return (
    <p
      className={`mt-3 text-sm ${warn ? "text-amber-800 dark:text-amber-300" : "text-zinc-600 dark:text-zinc-400"}`}
    >
      Access token expires {istDateTime.format(expiresAt)} IST ({remaining.label} left)
    </p>
  );
}

function formatLtp(value: number | undefined) {
  return value === undefined ? "—" : price.format(value);
}

function ConnectionError({ error }: { error: DhanErrorDescription }) {
  return (
    <div className="mt-8">
      <Card>
        <p className="flex items-center gap-2 font-medium">
          <span aria-hidden className="size-2.5 rounded-full bg-red-500" />
          Not connected to Dhan
        </p>
        <div className="mt-3">
          <InlineError error={error} />
        </div>
      </Card>
    </div>
  );
}

function StatusSkeleton() {
  return (
    <div className="mt-8">
      <Card>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Connecting to Dhan…</p>
      </Card>
    </div>
  );
}
