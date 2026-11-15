// Browser-side live quotes. One EventSource per tab carries every instrument that mounted
// components ask for; quotes live outside React so a tick only re-renders its own subscribers.

export interface LiveQuote {
  ltp?: number;
  ltt?: number;
  prevClose?: number;
  at: number;
}

export type FeedStatus =
  | { state: "idle" | "connecting" | "offline" }
  | { state: "live"; since?: number }
  | { state: "reconnecting"; retryAt?: number; reason?: string }
  | { state: "stopped"; reason?: string };

export interface StreamStatus {
  feed: FeedStatus;
  lastQuoteAt: number | null;
}

const STREAM_URL = "/api/market/stream";
const SYNC_DELAY_MS = 150;
const CLOSED_RETRY_MS = 10_000;

const quotes = new Map<string, LiveQuote>();
const quoteListeners = new Map<string, Set<() => void>>();
const statusListeners = new Set<() => void>();
let status: StreamStatus = { feed: { state: "idle" }, lastQuoteAt: null };
let source: EventSource | null = null;
let streamKeys = "";
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export function subscribeQuote(key: string, listener: () => void) {
  let listeners = quoteListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    quoteListeners.set(key, listeners);
  }
  listeners.add(listener);
  scheduleSync();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) quoteListeners.delete(key);
    scheduleSync();
  };
}

export function getQuote(key: string): LiveQuote | null {
  return quotes.get(key) ?? null;
}

export function subscribeStatus(listener: () => void) {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

export function getStatus(): StreamStatus {
  return status;
}

function setStatus(next: Partial<StreamStatus>) {
  status = { ...status, ...next };
  for (const listener of statusListeners) listener();
}

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, SYNC_DELAY_MS);
}

function sync() {
  const keys = [...quoteListeners.keys()].sort().join(",");
  if (keys === streamKeys && source) return;

  clearTimeout(retryTimer);
  source?.close();
  source = null;
  streamKeys = keys;
  for (const key of quotes.keys()) {
    if (!quoteListeners.has(key)) quotes.delete(key);
  }

  if (!keys) {
    setStatus({ feed: { state: "idle" } });
    return;
  }

  const stream = new EventSource(`${STREAM_URL}?i=${encodeURIComponent(keys)}`);
  source = stream;
  if (status.feed.state === "idle") setStatus({ feed: { state: "connecting" } });

  stream.addEventListener("status", (event) => {
    setStatus({ feed: JSON.parse((event as MessageEvent<string>).data) as FeedStatus });
  });

  stream.addEventListener("quotes", (event) => {
    const update = JSON.parse((event as MessageEvent<string>).data) as Record<string, LiveQuote>;
    let newest = status.lastQuoteAt ?? 0;
    for (const [key, quote] of Object.entries(update)) {
      quotes.set(key, quote);
      newest = Math.max(newest, quote.at);
      for (const listener of quoteListeners.get(key) ?? []) listener();
    }
    // Status subscribers only need second-level precision for "last tick" displays.
    if (newest - (status.lastQuoteAt ?? 0) >= 1_000) setStatus({ lastQuoteAt: newest });
  });

  stream.addEventListener("error", () => {
    if (stream.readyState !== EventSource.CLOSED || source !== stream) return;
    source = null;
    setStatus({ feed: { state: "offline" } });
    retryTimer = setTimeout(sync, CLOSED_RETRY_MS);
  });
}
