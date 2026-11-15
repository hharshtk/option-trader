"use client";

import { useCallback, useSyncExternalStore } from "react";
import { price, signedPercent, signedPrice } from "@/lib/format";
import {
  getQuote,
  getStatus,
  subscribeQuote,
  subscribeStatus,
  type LiveQuote,
  type StreamStatus,
} from "@/lib/live/store";

export function useLiveQuote(instrument: string): LiveQuote | null {
  const subscribe = useCallback(
    (listener: () => void) => subscribeQuote(instrument, listener),
    [instrument],
  );
  return useSyncExternalStore(subscribe, () => getQuote(instrument), () => null);
}

export function useStreamStatus(): StreamStatus | null {
  return useSyncExternalStore(subscribeStatus, getStatus, () => null);
}

export function LivePrice({ instrument, fallback }: { instrument: string; fallback?: number }) {
  const value = useLiveQuote(instrument)?.ltp ?? fallback;
  return <span className="tabular-nums">{value === undefined ? "—" : price.format(value)}</span>;
}

export function LiveChange({ instrument, className = "" }: { instrument: string; className?: string }) {
  const quote = useLiveQuote(instrument);
  if (quote?.ltp === undefined || !quote.prevClose) return null;

  const change = quote.ltp - quote.prevClose;
  const tone = change > 0 ? "text-up" : change < 0 ? "text-down" : "text-muted";
  return (
    <span className={`text-label tabular-nums ${tone} ${className}`}>
      {signedPrice.format(change)} ({signedPercent.format(change / quote.prevClose)})
    </span>
  );
}
