"use client";

import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemIcon,
  MenuSeparator,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { logout } from "@/app/login/actions";
import {
  ChevronDownIcon,
  LogOutIcon,
  RefreshIcon,
  SettingsIcon,
  UserIcon,
} from "@/components/icons";
import { useStreamStatus } from "@/components/live/live-quote";
import { StatusDot } from "@/components/ui";
import type { IndexQuotes } from "@/lib/cockpit";
import { istTime } from "@/lib/format";
import type { FeedStatus } from "@/lib/live/store";
import { DataAge, useNow } from "./freshness";

export const popupClass =
  "m-0 rounded-sm border border-line-strong bg-raised text-fg shadow-lg shadow-black/40";

export const tooltipClass = `${popupClass} px-2 py-1 text-label`;

const menuItemClass =
  "flex h-7 cursor-default items-center gap-2 rounded-sm px-2 text-body outline-none data-highlighted:bg-line-strong/70 data-pending:opacity-60";

export function BrokerStatus({
  connected,
  clientId,
  error,
}: {
  connected: boolean;
  clientId: string | null;
  error: string | null;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Link href="/settings" />}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-label font-medium hover:bg-raised"
      >
        <StatusDot tone={connected ? "up" : "down"} />
        <span>Dhan</span>
        <span className="sr-only">{connected ? "connected" : "not connected"}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className={`${tooltipClass} max-w-72`}>
        {connected ? `Connected, client ${clientId}` : `Not connected: ${error}`}
      </TooltipContent>
    </Tooltip>
  );
}

const LIVE_WINDOW_MS = 15_000;

const FEED_NOTE: Partial<Record<FeedStatus["state"], string>> = {
  connecting: "feed connecting",
  offline: "feed offline",
  reconnecting: "feed reconnecting",
  stopped: "feed stopped",
};

export function MarketDataStatus({ quotes }: { quotes: IndexQuotes }) {
  const stream = useStreamStatus();
  const now = useNow();
  const feed = stream?.feed;

  if (feed?.state === "live") {
    const lastQuoteAt = stream?.lastQuoteAt ?? null;
    const fresh = lastQuoteAt !== null && now !== null && now - lastQuoteAt < LIVE_WINDOW_MS;
    return (
      <div className="flex shrink-0 items-center gap-1.5 text-label text-muted">
        {fresh ? (
          <span className="flex items-center gap-1.5 font-medium text-up">
            <StatusDot tone="up" />
            Live
          </span>
        ) : (
          <span>
            Feed connected
            <span className="max-lg:hidden">
              {" · "}
              {lastQuoteAt === null ? "no updates yet" : `last update ${istTime.format(lastQuoteAt)}`}
            </span>
          </span>
        )}
        <RefreshButton />
      </div>
    );
  }

  const note = feed ? FEED_NOTE[feed.state] : undefined;

  if (quotes.status === "no-plan") {
    return <span className="shrink-0 text-label text-muted">No data plan</span>;
  }

  return (
    <div className="flex shrink-0 items-center gap-1 text-label text-muted">
      {quotes.status === "ok" ? (
        <>
          <span className="max-lg:hidden">LTP snapshot</span>
          <DataAge at={quotes.fetchedAt} />
        </>
      ) : (
        <span className="max-w-48 truncate text-down" title={quotes.error.message}>
          Market data failed
          {quotes.error.code && <span className="font-mono"> ({quotes.error.code})</span>}
        </span>
      )}
      {note && (
        <span
          className={`max-md:hidden ${feed?.state === "stopped" ? "text-down" : ""}`}
          title={feed && "reason" in feed ? feed.reason : undefined}
        >
          · {note}
        </span>
      )}
      <RefreshButton />
    </div>
  );
}

export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Tooltip>
      <TooltipTrigger
        onClick={() => {
          if (!pending) startTransition(() => router.refresh());
        }}
        aria-disabled={pending || undefined}
        className="grid size-7 place-items-center rounded-sm text-muted hover:bg-raised hover:text-fg aria-disabled:opacity-60"
      >
        <RefreshIcon className={pending ? "motion-safe:animate-spin" : undefined} />
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className={tooltipClass}>
        {pending ? "Refreshing…" : "Refresh account and market data"}
      </TooltipContent>
    </Tooltip>
  );
}

export function AccountMenu({ clientId }: { clientId: string | null }) {
  const [signingOut, startTransition] = useTransition();

  return (
    <Menu
      onAction={(value) => {
        if (value === "sign-out") startTransition(() => logout());
      }}
    >
      <MenuTrigger className="flex h-7 items-center gap-1.5 rounded-sm px-2 text-label text-muted hover:bg-raised hover:text-fg data-open:bg-raised data-open:text-fg">
        <UserIcon />
        <span className="sr-only">Account</span>
        <span className="font-mono max-sm:hidden">{clientId ?? "Account"}</span>
        <ChevronDownIcon className="size-3.5" />
      </MenuTrigger>
      <MenuContent side="bottom" align="end" sideOffset={6} className={`${popupClass} min-w-52 p-1`}>
        <MenuGroup>
          <MenuGroupLabel className="px-2 pt-1 pb-1.5 text-label text-muted">
            {clientId ? `Dhan client ${clientId}` : "Dhan not connected"}
          </MenuGroupLabel>
          <MenuItem render={<Link href="/settings" />} className={menuItemClass}>
            <MenuItemIcon>
              <SettingsIcon />
            </MenuItemIcon>
            Settings
          </MenuItem>
        </MenuGroup>
        <MenuSeparator className="my-1 h-px bg-line" />
        <MenuItem value="sign-out" className={menuItemClass}>
          <MenuItemIcon>
            <LogOutIcon />
          </MenuItemIcon>
          {signingOut ? "Signing out…" : "Sign out"}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
