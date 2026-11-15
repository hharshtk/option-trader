"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { istDateTime, istTime } from "@/lib/format";

const STALE_AFTER_MS = 60_000;
const TOKEN_WARN_MS = 2 * 3_600_000;

const listeners = new Set<() => void>();
let now = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot() {
  if (now === 0) now = Date.now();
  return now;
}

// One shared one-second clock. The server snapshot is null so nothing
// time-relative renders until hydration, which keeps server and client HTML equal.
function useNow(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

export function DataAge({ at }: { at: string }) {
  const current = useNow();
  const age = current === null ? null : Math.max(0, current - Date.parse(at));
  const stale = age !== null && age > STALE_AFTER_MS;

  return (
    <span className={`tabular-nums ${stale ? "text-warn" : ""}`}>
      <time dateTime={at} className="max-sm:hidden">
        {istTime.format(new Date(at))}
      </time>
      {age !== null && (
        <span>
          <span className="max-sm:hidden"> · </span>
          {formatAge(age)} ago{stale && " (stale)"}
        </span>
      )}
    </span>
  );
}

export function TokenExpiry({
  expiresAt,
  variant = "inline",
}: {
  expiresAt: string;
  variant?: "inline" | "alert";
}) {
  const current = useNow();
  const remainingMs = current === null ? null : Math.max(0, Date.parse(expiresAt) - current);
  const warn = remainingMs !== null && remainingMs < TOKEN_WARN_MS;
  const remaining = remainingMs === null ? null : timeLeft(remainingMs);

  if (variant === "alert") {
    if (!warn) return null;
    return (
      <Link
        href="/settings"
        className={`rounded-sm border px-1.5 py-0.5 text-label whitespace-nowrap ${
          remainingMs === 0 ? "border-down/50 text-down" : "border-warn/50 text-warn"
        }`}
      >
        {remainingMs === 0 ? "Access token expired" : `Token expires in ${remaining}`}
      </Link>
    );
  }

  return (
    <span className={remainingMs === 0 ? "text-down" : warn ? "text-warn" : undefined}>
      {istDateTime.format(new Date(expiresAt))} IST
      {remaining !== null && (
        <span className="ml-1 text-label">({remainingMs === 0 ? "expired" : `${remaining} left`})</span>
      )}
    </span>
  );
}

function timeLeft(ms: number) {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

function formatAge(ms: number) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
