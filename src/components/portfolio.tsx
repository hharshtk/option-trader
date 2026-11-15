import type { ReactNode } from "react";
import type { DhanHolding, DhanPosition } from "@/lib/dhan";
import { inr, price, quantity } from "@/lib/format";
import { EmptyState, Field, Pnl } from "./ui";

export function Holdings({ holdings }: { holdings: DhanHolding[] }) {
  if (holdings.length === 0) {
    return <EmptyState>No holdings in your demat account.</EmptyState>;
  }

  const rows = holdings.map((holding) => {
    const invested = holding.avgCostPrice * holding.totalQty;
    const current = holding.lastTradedPrice * holding.totalQty;
    return { holding, invested, current, pnl: current - invested };
  });
  const invested = sum(rows, (row) => row.invested);
  const current = sum(rows, (row) => row.current);
  const pnl = current - invested;

  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Invested" value={inr.format(invested)} />
        <Field label="Current value" value={inr.format(current)} />
        <Field label="Total P&L" value={<Pnl value={pnl} percent={ratio(pnl, invested)} />} />
      </dl>
      <Table
        caption="Holdings"
        minWidth="min-w-[40rem]"
        columns={["Symbol", "Qty", "Avg cost", "LTP", "Current value", "P&L"]}
      >
        {rows.map(({ holding, current, invested, pnl }) => (
          <tr key={holding.isin}>
            <Cell className="font-medium">{holding.tradingSymbol}</Cell>
            <Cell numeric>{quantity.format(holding.totalQty)}</Cell>
            <Cell numeric>{price.format(holding.avgCostPrice)}</Cell>
            <Cell numeric>{price.format(holding.lastTradedPrice)}</Cell>
            <Cell numeric>{inr.format(current)}</Cell>
            <Cell numeric>
              <Pnl value={pnl} percent={ratio(pnl, invested)} />
            </Cell>
          </tr>
        ))}
      </Table>
    </div>
  );
}

export function Positions({ positions }: { positions: DhanPosition[] }) {
  if (positions.length === 0) {
    return <EmptyState>No positions today.</EmptyState>;
  }

  const rows = positions.toSorted(
    (a, b) => Number(a.netQty === 0) - Number(b.netQty === 0),
  );
  const openCount = positions.filter((position) => position.netQty !== 0).length;

  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Open positions" value={quantity.format(openCount)} />
        <Field
          label="Realized P&L"
          value={<Pnl value={sum(positions, (p) => p.realizedProfit)} />}
        />
        <Field
          label="Unrealized P&L"
          value={<Pnl value={sum(positions, (p) => p.unrealizedProfit)} />}
        />
      </dl>
      <Table
        caption="Positions"
        minWidth="min-w-[48rem]"
        columns={["Instrument", "Net qty", "Buy avg", "Sell avg", "Realized", "Unrealized"]}
      >
        {rows.map((position) => (
          <tr
            key={`${position.exchangeSegment}:${position.securityId}:${position.productType}`}
            className={position.netQty === 0 ? "text-zinc-500 dark:text-zinc-500" : undefined}
          >
            <Cell>
              <div className="font-medium">{position.tradingSymbol}</div>
              <div className="text-xs text-zinc-600 dark:text-zinc-400">
                {position.exchangeSegment} · {position.productType} · {position.positionType}
              </div>
            </Cell>
            <Cell numeric>{quantity.format(position.netQty)}</Cell>
            <Cell numeric>{position.buyQty ? price.format(position.buyAvg) : "—"}</Cell>
            <Cell numeric>{position.sellQty ? price.format(position.sellAvg) : "—"}</Cell>
            <Cell numeric>
              <Pnl value={position.realizedProfit} />
            </Cell>
            <Cell numeric>
              <Pnl value={position.unrealizedProfit} />
            </Cell>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function Table({
  caption,
  columns,
  minWidth,
  children,
}: {
  caption: string;
  columns: string[];
  minWidth: string;
  children: ReactNode;
}) {
  return (
    // Focusable so keyboard users can scroll the table sideways on narrow screens.
    <div
      tabIndex={0}
      className="-mx-5 overflow-x-auto px-5 focus-visible:outline-2 focus-visible:outline-zinc-500"
    >
      <table className={`w-full text-sm ${minWidth}`}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-zinc-200 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
            {columns.map((column, index) => (
              <th
                key={column}
                scope="col"
                className={`pb-2 font-normal ${index === 0 ? "pr-4 text-left" : "pl-4 text-right"}`}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">{children}</tbody>
      </table>
    </div>
  );
}

function Cell({
  numeric,
  className = "",
  children,
}: {
  numeric?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <td
      className={`py-2.5 ${numeric ? "pl-4 text-right tabular-nums" : "pr-4"} ${className}`}
    >
      {children}
    </td>
  );
}

function sum<T>(items: T[], pick: (item: T) => number) {
  return items.reduce((total, item) => total + pick(item), 0);
}

function ratio(part: number, whole: number) {
  return whole === 0 ? undefined : part / whole;
}
