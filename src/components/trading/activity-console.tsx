"use client";

// The Activity page: everything the engine's trading did in the current run, in order. What the
// strategy proposed and what became of each proposal, every order with the quote it filled
// against, and the event log.

import { useState } from "react";
import { DataTable, EmptyState, PageHeader, Panel, StatusDot, Td } from "@/components/ui";
import type { Intent, Order, TradingEvent, TradingStatus } from "@/lib/engine/trading";
import { inr, price, quantity } from "@/lib/format";
import { BookTag, clock, NoTrading, StateLine, useTrading, Vote } from "./shared";

const OUTCOME: Record<Intent["outcome"], { label: string; tone: string }> = {
  pending: { label: "Deciding", tone: "text-muted" },
  taken: { label: "Traded", tone: "text-up" },
  shadowed: { label: "Turned down, shadowed", tone: "text-warn" },
  rejected: { label: "Not traded", tone: "text-muted" },
};

const KINDS: readonly TradingEvent["kind"][] = ["run", "intent", "decision", "fill", "trade", "order", "risk", "halt", "config", "contracts", "storage", "signal"];

export function ActivityConsole() {
  const telemetry = useTrading();
  const trading = telemetry.trading;
  return (
    <>
      <PageHeader
        title="Activity"
        meta={
          trading && (
            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
              <StateLine trading={trading} />
              {trading.run && <span className="font-mono">{trading.run.id}</span>}
              <span className="tabular-nums">{clock(trading.marketTime)} IST</span>
            </span>
          )
        }
      />
      <div className="space-y-2 p-2 sm:p-3">
        {trading ? (
          <>
            <Events events={trading.events} />
            <Proposals trading={trading} />
            <Orders orders={trading.orders} />
          </>
        ) : (
          <NoTrading telemetry={telemetry} />
        )}
      </div>
    </>
  );
}

function Events({ events }: { events: TradingEvent[] }) {
  const [kind, setKind] = useState<"all" | TradingEvent["kind"]>("all");
  const present = KINDS.filter((k) => events.some((e) => e.kind === k));
  const shown = kind === "all" ? events : events.filter((e) => e.kind === kind);
  return (
    <Panel
      title="Log"
      meta="Newest first; times are the market's clock"
      action={
        <label className="inline-flex items-center gap-1.5 text-label text-muted">
          Show
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="h-7 rounded-sm border border-line-strong bg-canvas px-2 text-body">
            <option value="all">Everything</option>
            {present.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      }
      flush
    >
      {shown.length === 0 ? (
        <div className="p-3">
          <EmptyState>Nothing yet. A run starts 20 minutes before a session opens, or when a replay starts.</EmptyState>
        </div>
      ) : (
        <ol className="max-h-[28rem] overflow-y-auto">
          {shown.map((event, index) => (
            <li key={`${event.wall}-${index}`} className="flex items-start gap-2 border-b border-line/70 px-3 py-1.5 last:border-0">
              <span className="w-16 shrink-0 text-muted tabular-nums">{clock(event.at)}</span>
              <span className="mt-1.5">
                <StatusDot tone={event.level === "error" ? "down" : event.level === "warn" ? "warn" : "muted"} />
              </span>
              <span className="w-20 shrink-0 text-label text-muted uppercase">{event.kind}</span>
              <span className="min-w-0 break-words">{event.message}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function Proposals({ trading }: { trading: TradingStatus }) {
  const { intents } = trading;
  return (
    <Panel title="Proposals" meta="Each time the followed signal fired with entries on, and what became of it" flush>
      {intents.length === 0 ? (
        <div className="p-3">
          <EmptyState>No proposals in this run.</EmptyState>
        </div>
      ) : (
        <DataTable caption="Strategy proposals, newest first" minWidth="min-w-[52rem]" columns={["At", { label: "Signal", align: "left" }, { label: "Reading", align: "left" }, "NIFTY", { label: "Contract", align: "left" }, { label: "Outcome", align: "left" }]}>
          {intents.map((intent) => (
            <tr key={intent.id}>
              <Td className="tabular-nums">{clock(intent.at)}</Td>
              <Td>
                <Vote vote={intent.direction} />
              </Td>
              <Td className="text-muted">{intent.reading}</Td>
              <Td numeric>{intent.spot === null ? "—" : price.format(intent.spot)}</Td>
              <Td>{intent.contract?.name ?? "—"}</Td>
              <Td className="whitespace-normal">
                <span className={OUTCOME[intent.outcome].tone}>{OUTCOME[intent.outcome].label}</span>
                {intent.reason && <span className="text-muted"> · {intent.reason}</span>}
              </Td>
            </tr>
          ))}
        </DataTable>
      )}
    </Panel>
  );
}

function Orders({ orders }: { orders: Order[] }) {
  return (
    <Panel title="Orders" meta="Paper orders and the quote each filled against" flush>
      {orders.length === 0 ? (
        <div className="p-3">
          <EmptyState>No orders in this run.</EmptyState>
        </div>
      ) : (
        <DataTable
          caption="Orders, newest first"
          minWidth="min-w-[60rem]"
          columns={["Sent", { label: "Side", align: "left" }, { label: "Contract", align: "left" }, "Qty", { label: "Why", align: "left" }, { label: "Status", align: "left" }, "Filled at", "Bid", "Ask", "Last", "Charges"]}
        >
          {orders.map((order) => (
            <tr key={order.id} className={order.book === "shadow" ? "text-muted" : undefined}>
              <Td className="tabular-nums">{clock(order.at)}</Td>
              <Td>
                <span className={order.side === "BUY" ? "text-up" : "text-down"}>{order.side === "BUY" ? "Buy" : "Sell"}</span>
              </Td>
              <Td>
                <span className="inline-flex items-center gap-1.5">
                  <BookTag book={order.book} />
                  {order.contract.name}
                </span>
              </Td>
              <Td numeric>{quantity.format(order.quantity)}</Td>
              <Td>{order.reason}</Td>
              <Td className="whitespace-normal">
                {order.status === "filled" ? `Filled (${order.priceSource === "book" ? "order book" : order.priceSource === "candle" ? "1-minute candle" : "last price"})` : order.status === "pending" ? "Waiting to fill" : `Cancelled${order.note ? `: ${order.note}` : ""}`}
              </Td>
              <Td numeric>{order.price === null ? "—" : price.format(order.price)}</Td>
              <Td numeric>{order.bid === null ? "—" : price.format(order.bid)}</Td>
              <Td numeric>{order.ask === null ? "—" : price.format(order.ask)}</Td>
              <Td numeric>{order.ltp === null ? "—" : price.format(order.ltp)}</Td>
              <Td numeric>{order.charges ? inr.format(order.charges.total) : "—"}</Td>
            </tr>
          ))}
        </DataTable>
      )}
    </Panel>
  );
}
