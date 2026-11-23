"use client";

// The live pilot on the Strategies page: whether real orders follow the paper book today, the real
// positions and orders at Dhan, and the switches. The engine does the trading (live-desk.ts); this
// shows it and sends the commands. How it works: docs/trading.md#live-pilot.

import type { ReactNode } from "react";
import { buttonClass, DataTable, Panel, Pnl, Td } from "@/components/ui";
import type { LiveOrder, LivePosition, LiveStatus } from "@/lib/engine/live";
import type { TradingCommand, TradingStatus } from "@/lib/engine/trading";
import { inr, price, quantity } from "@/lib/format";
import { clock } from "./shared";

const STATE: Record<LivePosition["state"], string> = { buying: "Buying", open: "Held", selling: "Selling", closed: "Closed" };
const ROLE: Record<LiveOrder["role"], string> = { entry: "Buy", stop: "Stop at Dhan", exit: "Sale" };

export function LivePanel({ trading, pending, send }: { trading: TradingStatus; pending: boolean; send: (command: TradingCommand) => void }) {
  const live = trading.live;
  // An engine older than this page has no live desk.
  if (!live) return null;
  if (!live.allowed) return <p className="px-1 text-label text-muted">Live orders: {live.notAllowed}</p>;

  const today = trading.source === "live" && trading.run?.source === "live" && trading.run.endedAt === null ? trading.run.date : null;
  const lossLimit = trading.config.risk.maxDailyLoss;
  const turnOn = () => {
    if (!today) return;
    const message = [
      `Trade with real money today, ${today}?`,
      `Each paper entry will also buy one lot of the same NIFTY option at Dhan, one position at a time, with a stop-loss order resting at Dhan. Real positions are sold when their paper positions are.`,
      `Dhan's P&L exit is set at a loss of ${inr.format(lossLimit)} (the daily loss limit in Settings) with Dhan's kill switch.`,
      ...(trading.config.armed ? [] : ["Taking trades is switched on too, so the next signal trades."]),
      `No strategy has passed the go-live gate yet. Losses are real money.`,
    ].join("\n\n");
    if (window.confirm(message)) send({ action: "live-on", date: today });
  };
  const exitAll = () => {
    const message = "Sell every position and cancel every open order in your Dhan account, through Dhan's own exit? This includes anything you opened yourself in the Dhan app. Live trading goes off.";
    if (window.confirm(message)) send({ action: "live-exit-all" });
  };

  const exitButton = (
    <button type="button" className={`${buttonClass} border-down text-down`} disabled={pending} onClick={exitAll} title="Dhan's own exit-all: sells everything in the account and cancels open orders">
      Exit everything at Dhan
    </button>
  );

  if (!live.on) {
    const held = live.positions.some((p) => p.state !== "closed");
    return (
      <Panel
        title="Live trading"
        meta={held ? <span className="text-warn">Off, but a real position is still held</span> : "Off: paper only"}
        action={
          <>
            {held && exitButton}
            <button type="button" className={`${buttonClass} border-down text-down`} disabled={pending || !today} onClick={turnOn}>
              Trade live today
            </button>
          </>
        }
      >
        <div className="space-y-1.5 text-body">
          <p>
            Switch on to also buy each paper entry for real at Dhan: one lot, one position at a time, a stop-loss order resting at Dhan, sold when its paper position is. Dhan&apos;s P&amp;L exit is set at the daily loss limit ({inr.format(lossLimit)})
            with its kill switch. It lasts for today only.
          </p>
          {!today && <p className="text-muted">It can be switched on once today&apos;s live run has started, 20 minutes before the open.</p>}
          {live.offReason && live.date === today && <p className="text-warn">Switched off: {live.offReason}.</p>}
          {live.alert && <Alert>{live.alert}</Alert>}
        </div>
        {live.positions.length > 0 && <Positions live={live} />}
        {live.events.length > 0 && <Log live={live} />}
      </Panel>
    );
  }

  const { totals, checks } = live;
  return (
    <Panel
      className="border-down"
      title="Live trading"
      meta={<span className="font-semibold text-down">On: real orders at Dhan{live.since ? ` since ${clock(live.since)}` : ""}</span>}
      action={
        <>
          {exitButton}
          <button type="button" className={buttonClass} disabled={pending} onClick={() => send({ action: "live-off" })} title="No new real orders; a real position held is still sold with its paper position">
            Turn live off
          </button>
        </>
      }
    >
      {live.alert && <Alert>{live.alert}</Alert>}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-body sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Real P&L today">
          <Pnl value={totals.net} />
          <span className="block text-label font-normal text-muted">after {inr.format(totals.charges)} charges</span>
        </Stat>
        <Stat label="Open, before charges">{live.positions.some((p) => p.state !== "closed") ? <Pnl value={totals.open} /> : <span className="text-muted">—</span>}</Stat>
        <Stat label="Real trades">
          {totals.trades}
          <span className="block text-label font-normal text-muted">{totals.wins} ahead after charges</span>
        </Stat>
        <Stat label="Dhan's P&L exit">
          {live.lossLimit !== null ? `at −${inr.format(live.lossLimit)}` : "—"}
          <span className="block truncate text-label font-normal text-muted" title={checks?.pnlExit ?? undefined}>
            {checks?.pnlExit ?? ""}
          </span>
        </Stat>
        <Stat label="Cash at Dhan">{checks?.balance != null ? inr.format(checks.balance) : "—"}</Stat>
        <Stat label="Whitelisted IP">{checks?.ip ?? <span className="text-down">None: orders will be refused</span>}</Stat>
      </dl>
      <Positions live={live} />
      {live.otherPositions.length > 0 && <p className="mt-2 text-label text-muted">Also in the Dhan account, not opened by the engine: {live.otherPositions.join(", ")}</p>}
      <Log live={live} />
    </Panel>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-label text-muted">{label}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mb-2 rounded-sm bg-down px-2 py-1 text-body font-medium text-white">
      {children}
    </p>
  );
}

function Positions({ live }: { live: LiveStatus }) {
  if (live.positions.length === 0) return <p className="mt-2 text-label text-muted">No real positions yet today. The next paper entry is bought for real.</p>;
  return (
    <div className="mt-2 -mx-3">
      <DataTable
        caption="Real positions at Dhan"
        minWidth="min-w-[60rem]"
        columns={["Bought", { label: "Contract", align: "left" }, { label: "State", align: "left" }, "Qty", "Buy", "Now", "Stop at Dhan", "Sold at", "Before charges", "Charges", "Net", { label: "What happened", align: "left" }]}
      >
        {live.positions.map((p) => {
          const stop = p.orders.find((o) => o.role === "stop");
          const held = p.bought - p.sold;
          return (
            <tr key={p.id}>
              <Td className="tabular-nums">{p.openedAt ? clock(p.openedAt) : "—"}</Td>
              <Td>{p.contract.name}</Td>
              <Td className={p.state === "closed" ? "text-muted" : "text-down font-medium"}>{STATE[p.state]}</Td>
              <Td numeric>{held > 0 && p.sold > 0 ? `${quantity.format(held)} of ${quantity.format(p.bought)}` : quantity.format(p.bought || p.quantity)}</Td>
              <Td numeric>{p.buyAverage !== null ? price.format(p.buyAverage) : "—"}</Td>
              <Td numeric>{p.state !== "closed" && p.mark !== null ? price.format(p.mark) : "—"}</Td>
              <Td numeric>{stop?.trigger != null ? <span title={`${stop.status.toLowerCase()}${stop.message ? `: ${stop.message}` : ""}`}>{price.format(stop.trigger)} <span className="text-label text-muted">{stop.status.toLowerCase()}</span></span> : "—"}</Td>
              <Td numeric>{p.sellAverage !== null ? price.format(p.sellAverage) : "—"}</Td>
              <Td numeric>{p.state === "closed" ? <Pnl value={p.gross} /> : held > 0 ? <Pnl value={p.openGross} /> : "—"}</Td>
              <Td numeric>{inr.format(p.charges)}</Td>
              <Td numeric>{p.bought > 0 ? <Pnl value={p.net + (p.state === "closed" ? 0 : p.openGross)} /> : "—"}</Td>
              <Td className="max-w-[24rem] truncate text-label">
                <span title={p.alert ?? p.note ?? p.closeReason ?? ""} className={p.alert ? "text-down" : "text-muted"}>
                  {p.alert ?? p.note ?? (p.closeReason ? `Selling: ${p.closeReason}` : "")}
                </span>
              </Td>
            </tr>
          );
        })}
      </DataTable>
    </div>
  );
}

function orderPrice(order: LiveOrder) {
  if (order.type === "MARKET") return "market";
  if (order.type === "STOP_LOSS") return `${price.format(order.trigger ?? 0)} → ${price.format(order.price ?? 0)}`;
  return price.format(order.price ?? 0);
}

function Log({ live }: { live: LiveStatus }) {
  const orders = live.positions.flatMap((p) => p.orders.map((o) => ({ ...o, contract: p.contract.name }))).sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="mt-2 space-y-1">
      {orders.length > 0 && (
        <details>
          <summary className="cursor-pointer text-label text-muted hover:text-fg">Orders sent to Dhan · {orders.length}</summary>
          <div className="mt-1 -mx-3">
            <DataTable
              caption="Orders sent to Dhan"
              minWidth="min-w-[60rem]"
              columns={["Sent", { label: "Contract", align: "left" }, { label: "Order", align: "left" }, "Price", "Qty", "Filled", "Average", { label: "Status", align: "left" }, { label: "Dhan says", align: "left" }, { label: "Order id", align: "left" }]}
            >
              {orders.map((o) => (
                <tr key={o.correlationId}>
                  <Td className="tabular-nums">{clock(o.createdAt)}</Td>
                  <Td>{o.contract}</Td>
                  <Td>
                    {ROLE[o.role]} <span className="text-label text-muted">{o.side} {o.type.replace("_", "-")} {o.validity}</span>
                  </Td>
                  <Td numeric>{orderPrice(o)}</Td>
                  <Td numeric>{quantity.format(o.quantity)}</Td>
                  <Td numeric>{quantity.format(o.filledQty)}</Td>
                  <Td numeric>{o.averagePrice !== null ? price.format(o.averagePrice) : "—"}</Td>
                  <Td className={o.status === "REJECTED" || o.status === "NOT_PLACED" ? "text-down" : o.status === "TRADED" ? "text-up" : ""}>{o.status.toLowerCase().replace("_", " ")}</Td>
                  <Td className="max-w-[18rem] truncate text-label text-muted">
                    <span title={o.message ?? ""}>{o.message ?? ""}</span>
                  </Td>
                  <Td className="text-label text-muted tabular-nums">{o.orderId ?? o.correlationId}</Td>
                </tr>
              ))}
            </DataTable>
          </div>
        </details>
      )}
      {live.events.length > 0 && (
        <details>
          <summary className="cursor-pointer text-label text-muted hover:text-fg">Live log · {live.events.length}</summary>
          <ol className="mt-1 max-h-64 space-y-0.5 overflow-y-auto text-label">
            {live.events.map((e, i) => (
              <li key={i} className={e.level === "info" ? "text-muted" : e.level === "warn" ? "text-warn" : "text-down"}>
                <span className="tabular-nums">{clock(e.at)}</span> {e.message}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
