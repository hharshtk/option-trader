"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type KeyboardEvent } from "react";
import { logout } from "@/app/login/actions";
import {
  ChevronDownIcon,
  LogOutIcon,
  MoonIcon,
  RefreshIcon,
  SettingsIcon,
  SunIcon,
  UserIcon,
} from "@/components/icons";
import { useStreamStatus } from "@/components/live/live-quote";
import { createSessionCalendar } from "@/engine/market/session-calendar";
import { Tooltip } from "@/components/tooltip";
import { StatusDot } from "@/components/ui";
import type { IndexQuotes } from "@/lib/cockpit";
import { istTime } from "@/lib/format";
import type { FeedStatus } from "@/lib/live/store";
import { DataAge, useNow } from "./freshness";
import { setTheme, useTheme } from "./preferences";

export const popupClass =
  "m-0 rounded-sm border border-line-strong bg-raised text-fg shadow-lg shadow-black/40";

export const tooltipClass = `${popupClass} px-2 py-1 text-label`;

const menuItemClass =
  "flex h-7 cursor-default items-center gap-2 rounded-sm px-2 text-body outline-none focus:bg-line-strong/70";

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
    <Tooltip
      side="bottom"
      sideOffset={6}
      className={`${tooltipClass} max-w-72`}
      content={connected ? `Connected, client ${clientId}` : `Not connected: ${error}`}
    >
      <Link
        href="/settings"
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-label font-medium hover:bg-raised"
      >
        <StatusDot tone={connected ? "up" : "down"} />
        <span>Dhan</span>
        <span className="sr-only">{connected ? "connected" : "not connected"}</span>
      </Link>
    </Tooltip>
  );
}

const LIVE_WINDOW_MS = 15_000;
// NSE trading days and hours, holidays included: the same calendar the engine uses.
const calendar = createSessionCalendar();

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
    const phase = now === null ? null : calendar.phaseAt("NSE_EQ", now);
    return (
      <div className="flex shrink-0 items-center gap-1.5 text-label text-muted">
        {phase === "closed" ? (
          // Dhan keeps repeating the last price after hours, so updates still arrive; they aren't news.
          <Tooltip
            side="bottom"
            sideOffset={6}
            className={`${tooltipClass} max-w-72`}
            content="Feed connected. Dhan keeps sending the last price after hours, so updates still arrive, but prices aren't changing."
          >
            <span className="flex items-center gap-1.5 font-medium">
              <StatusDot tone="muted" />
              Market closed
            </span>
          </Tooltip>
        ) : phase === "pre-open" ? (
          <span className="flex items-center gap-1.5 font-medium text-warn">
            <StatusDot tone="warn" />
            Pre-open
          </span>
        ) : fresh ? (
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
    <Tooltip
      type="label"
      side="bottom"
      sideOffset={6}
      className={tooltipClass}
      content={pending ? "Refreshing…" : "Refresh account and market data"}
    >
      <button
        type="button"
        onClick={() => {
          if (!pending) startTransition(() => router.refresh());
        }}
        aria-disabled={pending || undefined}
        className="grid size-7 place-items-center rounded-sm text-muted hover:bg-raised hover:text-fg aria-disabled:opacity-60"
      >
        <RefreshIcon className={pending ? "motion-safe:animate-spin" : undefined} />
      </button>
    </Tooltip>
  );
}

export function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";

  return (
    <Tooltip type="label" side="bottom" sideOffset={6} className={tooltipClass} content={`Switch to ${next} mode`}>
      <button
        type="button"
        onClick={() => setTheme(next)}
        aria-label={`Switch to ${next} mode`}
        className="grid size-7 place-items-center rounded-sm text-muted hover:bg-raised hover:text-fg"
      >
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>
    </Tooltip>
  );
}

function menuItems(menu: HTMLElement | null) {
  return Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
}

export function AccountMenu({ clientId }: { clientId: string | null }) {
  const [signingOut, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const labelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusFirstItem = useRef(false);

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Enter" || event.key === " ") focusFirstItem.current = true;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusFirstItem.current = true;
      menuRef.current?.showPopover();
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = menuItems(menuRef.current);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const last = items.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = current === -1 || current === last ? 0 : current + 1;
    else if (event.key === "ArrowUp") next = current <= 0 ? last : current - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Tab") menuRef.current?.hidePopover();
    else if (event.key === " " && event.target instanceof HTMLAnchorElement) {
      event.preventDefault();
      event.target.click();
    }
    if (next !== null) {
      event.preventDefault();
      items[next]?.focus();
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        popoverTarget={menuId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        data-open={open ? "" : undefined}
        onKeyDown={onTriggerKeyDown}
        className="flex h-7 items-center gap-1.5 rounded-sm px-2 text-label text-muted hover:bg-raised hover:text-fg data-open:bg-raised data-open:text-fg"
      >
        <UserIcon />
        <span className="sr-only">Account</span>
        <span className="font-mono max-sm:hidden">{clientId ?? "Account"}</span>
        <ChevronDownIcon className="size-3.5" />
      </button>
      <div
        ref={menuRef}
        id={menuId}
        popover="auto"
        role="menu"
        tabIndex={-1}
        onBeforeToggle={(event) => {
          const trigger = triggerRef.current;
          if (event.newState !== "open" || !trigger) return;
          // Below the trigger, right edges aligned.
          const rect = trigger.getBoundingClientRect();
          Object.assign(event.currentTarget.style, {
            position: "fixed",
            inset: "auto",
            top: `${rect.bottom + 6}px`,
            right: `${document.documentElement.clientWidth - rect.right}px`,
          });
        }}
        onToggle={(event) => {
          const menu = event.currentTarget;
          const isOpen = event.newState === "open";
          setOpen(isOpen);
          if (isOpen) {
            (focusFirstItem.current ? menuItems(menu)[0] : menu)?.focus();
          } else if (menu.contains(document.activeElement)) {
            triggerRef.current?.focus();
          }
          focusFirstItem.current = false;
        }}
        onKeyDown={onMenuKeyDown}
        onClick={(event) => {
          if ((event.target as Element).closest('[role="menuitem"]')) {
            menuRef.current?.hidePopover();
          }
        }}
        className={`${popupClass} min-w-52 p-1 outline-none`}
      >
        <div role="group" aria-labelledby={labelId}>
          <div id={labelId} className="px-2 pt-1 pb-1.5 text-label text-muted">
            {clientId ? `Dhan client ${clientId}` : "Dhan not connected"}
          </div>
          <Link
            href="/settings"
            role="menuitem"
            tabIndex={-1}
            onPointerMove={(event) => event.currentTarget.focus()}
            className={menuItemClass}
          >
            <span aria-hidden>
              <SettingsIcon />
            </span>
            Settings
          </Link>
        </div>
        <div role="separator" className="my-1 h-px bg-line" />
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          onPointerMove={(event) => event.currentTarget.focus()}
          onClick={() => startTransition(() => logout())}
          className={`${menuItemClass} w-full`}
        >
          <span aria-hidden>
            <LogOutIcon />
          </span>
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </>
  );
}
