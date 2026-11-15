import Link from "next/link";
import { Suspense } from "react";
import { LogoMark } from "@/components/icons";
import { LiveChange, LivePrice } from "@/components/live/live-quote";
import {
  getIndexQuotes,
  HEADLINE_INDICES,
  requireSession,
  settle,
  tokenExpiryIso,
} from "@/lib/cockpit";
import { getProfile } from "@/lib/dhan";
import { indexInstrument } from "@/lib/live/instruments";
import { TokenExpiry } from "./freshness";
import { AccountMenu, BrokerStatus, MarketDataStatus } from "./header-controls";

export function MarketHeader() {
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel pr-2 pl-3">
      <Link
        href="/"
        className="flex shrink-0 items-center gap-2 rounded-sm md:w-[12.5rem] md:sidebar-collapsed:w-auto"
      >
        <LogoMark />
        <span className="text-body font-semibold tracking-tight max-sm:sr-only">Option Trader</span>
      </Link>
      <Suspense fallback={<HeaderFallback />}>
        <HeaderStatus />
      </Suspense>
    </header>
  );
}

async function HeaderStatus() {
  await requireSession();
  const [profile, quotes] = await Promise.all([settle(getProfile()), getIndexQuotes()]);
  const clientId = profile.ok ? profile.value.dhanClientId : null;
  const tokenExpiry = profile.ok ? tokenExpiryIso() : null;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-4">
      <BrokerStatus
        connected={profile.ok}
        clientId={clientId}
        error={profile.ok ? null : profile.error.message}
      />
      <div className="flex min-w-0 items-center gap-4 overflow-x-auto [scrollbar-width:none]">
        {HEADLINE_INDICES.map(({ key, name }) => {
          const value = quotes.status === "ok" ? quotes.prices[key] : undefined;
          return (
            <div key={key} className="flex shrink-0 items-baseline gap-2">
              <span className="text-label font-medium text-muted">{name}</span>
              <span className="font-mono text-body">
                <LivePrice instrument={indexInstrument(key)} fallback={value} />
              </span>
              <LiveChange instrument={indexInstrument(key)} className="max-md:hidden" />
            </div>
          );
        })}
      </div>
      <MarketDataStatus quotes={quotes} />
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {tokenExpiry && <TokenExpiry expiresAt={tokenExpiry} variant="alert" />}
        <AccountMenu clientId={clientId} />
      </div>
    </div>
  );
}

function HeaderFallback() {
  return (
    <div aria-hidden className="flex min-w-0 flex-1 items-center gap-4">
      <span className="h-3 w-12 rounded-sm bg-raised motion-safe:animate-pulse" />
      {HEADLINE_INDICES.map(({ key, name }) => (
        <span key={key} className="flex items-baseline gap-2 max-sm:hidden">
          <span className="text-label font-medium text-muted">{name}</span>
          <span className="h-3 w-16 rounded-sm bg-raised motion-safe:animate-pulse" />
        </span>
      ))}
      <span className="ml-auto h-3 w-24 rounded-sm bg-raised motion-safe:animate-pulse" />
    </div>
  );
}
