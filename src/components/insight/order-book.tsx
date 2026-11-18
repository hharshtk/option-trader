"use client";

// The 20-level order book of one contract: NIFTY's futures and the options around the money that
// the research recorder follows on Dhan's depth feed. Live, it is the latest book the depth feed
// sent; during a replay, the book as recorded at the replay's position. Polled once a second.

import { useEffect, useState } from "react";
import { EmptyState, Panel } from "@/components/ui";
import type { BookLevel, DepthView } from "@/lib/engine/protocol";
import { istTime, price } from "@/lib/format";

const REFRESH_MS = 1_000;
const qty = new Intl.NumberFormat("en-IN");

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; view: DepthView };

function useDepth(key: string | null): Load {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function fetchOnce() {
      try {
        const response = await fetch(`/api/engine/v1/depth${key ? `?key=${encodeURIComponent(key)}` : ""}`, { signal: controller.signal, cache: "no-store" });
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) setLoad({ state: "error", message: body?.error ?? `The engine answered ${response.status}` });
        else setLoad({ state: "ready", view: body as DepthView });
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) setLoad({ state: "error", message: (error as Error).message });
      }
      if (!cancelled) {
        timer = setTimeout(function next() {
          if (document.hidden) timer = setTimeout(next, REFRESH_MS);
          else void fetchOnce();
        }, REFRESH_MS);
      }
    }
    void fetchOnce();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [key]);
  return load;
}

export function OrderBook() {
  const [key, setKey] = useState<string | null>(null);
  const load = useDepth(key);
  const view = load.state === "ready" ? load.view : null;
  const book = view?.book ?? null;
  const selected = key ?? book?.key ?? "";

  const picker =
    view && view.instruments.length > 0 ? (
      <select value={selected} onChange={(e) => setKey(e.target.value)} className="h-7 max-w-56 rounded-sm border border-line-strong bg-canvas px-2 text-body" aria-label="Contract">
        {view.instruments.map((i) => (
          <option key={i.key} value={i.key}>
            {i.name ?? i.key}
          </option>
        ))}
      </select>
    ) : null;

  return (
    <Panel
      title="Order book, 20 levels"
      meta={book ? `${view?.source === "replay" ? "as recorded" : "live"} at ${istTime.format(book.at)}` : undefined}
      action={picker}
    >
      {load.state === "loading" && <EmptyState>Asking the engine for the order book…</EmptyState>}
      {load.state === "error" && <p className="text-down">{load.message}</p>}
      {view && !book && (
        <EmptyState>
          {view.instruments.length === 0
            ? view.source === "replay"
              ? "This day has no 20-level books recorded (they start on 18 November 2026)."
              : "No 20-level books yet. The research recorder starts the depth feed at 08:45 on trading days."
            : "No book for this contract yet at this point of the day."}
        </EmptyState>
      )}
      {book && <Ladder bids={book.bids} asks={book.asks} />}
    </Panel>
  );
}

function Ladder({ bids, asks }: { bids: BookLevel[]; asks: BookLevel[] }) {
  const bidQty = bids.reduce((a, l) => a + l.qty, 0);
  const askQty = asks.reduce((a, l) => a + l.qty, 0);
  const bidOrders = bids.reduce((a, l) => a + l.orders, 0);
  const askOrders = asks.reduce((a, l) => a + l.orders, 0);
  const largest = Math.max(1, ...bids.map((l) => l.qty), ...asks.map((l) => l.qty));
  const spread = bids[0] && asks[0] ? asks[0].price - bids[0].price : null;
  const share = bidQty + askQty > 0 ? bidQty / (bidQty + askQty) : null;
  const rows = Math.max(bids.length, asks.length);

  return (
    <div className="grid gap-2">
      <p className="text-body">
        {share === null ? (
          "—"
        ) : (
          <>
            <span className="text-up">bids {Math.round(share * 100)}%</span> · <span className="text-down">asks {Math.round((1 - share) * 100)}%</span> of what waits ({qty.format(bidQty)} against {qty.format(askQty)};
            orders {qty.format(bidOrders)} against {qty.format(askOrders)})
          </>
        )}
        {spread !== null && <span className="text-muted"> · spread {spread.toFixed(2)}</span>}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[22rem] border-collapse text-body tabular-nums">
          <thead className="text-label text-muted">
            <tr>
              <th className="px-1.5 py-1 text-right font-normal">Orders</th>
              <th className="px-1.5 py-1 text-right font-normal">Qty</th>
              <th className="px-1.5 py-1 text-right font-normal">Bid</th>
              <th className="px-1.5 py-1 text-left font-normal">Ask</th>
              <th className="px-1.5 py-1 text-left font-normal">Qty</th>
              <th className="px-1.5 py-1 text-left font-normal">Orders</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, i) => {
              const b = bids[i];
              const a = asks[i];
              return (
                <tr key={i} className="border-t border-line">
                  <td className="px-1.5 py-0.5 text-right text-muted">{b ? b.orders : ""}</td>
                  <td className="relative px-1.5 py-0.5 text-right">
                    {b && <span aria-hidden className="absolute inset-y-0.5 right-0 rounded-l-sm bg-up/15" style={{ width: `${(b.qty / largest) * 100}%` }} />}
                    <span className="relative">{b ? qty.format(b.qty) : ""}</span>
                  </td>
                  <td className="px-1.5 py-0.5 text-right text-up">{b ? price.format(b.price) : ""}</td>
                  <td className="px-1.5 py-0.5 text-left text-down">{a ? price.format(a.price) : ""}</td>
                  <td className="relative px-1.5 py-0.5 text-left">
                    {a && <span aria-hidden className="absolute inset-y-0.5 left-0 rounded-r-sm bg-down/15" style={{ width: `${(a.qty / largest) * 100}%` }} />}
                    <span className="relative">{a ? qty.format(a.qty) : ""}</span>
                  </td>
                  <td className="px-1.5 py-0.5 text-left text-muted">{a ? a.orders : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
