import type { DhanHolding, DhanPosition } from "@/lib/dhan";
import { positionInstrument } from "@/lib/live/instruments";
import { inr, price, quantity } from "@/lib/format";
import { LivePrice } from "./live/live-quote";
import { DataTable, EmptyState, Field, Pnl, Td } from "./ui";

export function summarizeHoldings(holdings: DhanHolding[]) {
  const rows = holdings.map((holding) => {
    const invested = holding.avgCostPrice * holding.totalQty;
    const current = holding.lastTradedPrice * holding.totalQty;
    return { holding, invested, current, pnl: current - invested };
  });
  const invested = sum(rows, (row) => row.invested);
  const current = sum(rows, (row) => row.current);
  const pnl = current - invested;
  return { rows, invested, current, pnl, pnlRatio: ratio(pnl, invested) };
}

export type HoldingsSummary = ReturnType<typeof summarizeHoldings>;

export function summarizePositions(positions: DhanPosition[]) {
  return {
    rows: positions.toSorted((a, b) => Number(a.netQty === 0) - Number(b.netQty === 0)),
    openCount: positions.filter((position) => position.netQty !== 0).length,
    realized: sum(positions, (position) => position.realizedProfit),
    unrealized: sum(positions, (position) => position.unrealizedProfit),
  };
}

export type PositionsSummary = ReturnType<typeof summarizePositions>;

export function HoldingsStats({ summary }: { summary: HoldingsSummary }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
      <Field label="Holdings" value={quantity.format(summary.rows.length)} size="lg" />
      <Field label="Invested" value={inr.format(summary.invested)} size="lg" />
      <Field label="Current value" value={inr.format(summary.current)} size="lg" />
      <Field
        label="Unrealized P&L"
        value={<Pnl value={summary.pnl} percent={summary.pnlRatio} />}
        size="lg"
      />
    </dl>
  );
}

export function PositionsStats({ summary }: { summary: PositionsSummary }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
      <Field label="Open positions" value={quantity.format(summary.openCount)} size="lg" />
      <Field label="Realized P&L" value={<Pnl value={summary.realized} />} size="lg" />
      <Field label="Unrealized P&L" value={<Pnl value={summary.unrealized} />} size="lg" />
    </dl>
  );
}

export function HoldingsTable({
  summary,
  limit,
  detailed = false,
}: {
  summary: HoldingsSummary;
  limit?: number;
  detailed?: boolean;
}) {
  if (summary.rows.length === 0) {
    return (
      <div className="p-3">
        <EmptyState>No holdings in your demat account.</EmptyState>
      </div>
    );
  }

  const rows = limit === undefined ? summary.rows : summary.rows.slice(0, limit);
  const columns = detailed
    ? ["Symbol", "Qty", "Avg cost", "LTP", "Invested", "Current value", "P&L"]
    : ["Symbol", "Qty", "Avg cost", "LTP", "Current value", "P&L"];

  return (
    <DataTable caption="Holdings" columns={columns} minWidth={detailed ? "min-w-[52rem]" : "min-w-[40rem]"}>
      {rows.map(({ holding, invested, current, pnl }) => (
        <tr key={holding.isin}>
          <Td>
            <span className="font-medium">{holding.tradingSymbol}</span>
            {detailed && <span className="ml-2 text-label text-muted">{holding.exchange}</span>}
          </Td>
          <Td numeric>{quantity.format(holding.totalQty)}</Td>
          <Td numeric>{price.format(holding.avgCostPrice)}</Td>
          <Td numeric>{price.format(holding.lastTradedPrice)}</Td>
          {detailed && <Td numeric>{inr.format(invested)}</Td>}
          <Td numeric>{inr.format(current)}</Td>
          <Td numeric>
            <Pnl value={pnl} percent={ratio(pnl, invested)} />
          </Td>
        </tr>
      ))}
    </DataTable>
  );
}

export function PositionsTable({
  summary,
  detailed = false,
}: {
  summary: PositionsSummary;
  detailed?: boolean;
}) {
  if (summary.rows.length === 0) {
    return (
      <div className="p-3">
        <EmptyState>No positions today.</EmptyState>
      </div>
    );
  }

  const columns = detailed
    ? ["Instrument", "Net qty", "LTP", "Buy qty", "Buy avg", "Sell qty", "Sell avg", "Realized", "Unrealized"]
    : ["Instrument", "Net qty", "LTP", "Buy avg", "Sell avg", "Realized", "Unrealized"];

  return (
    <DataTable caption="Positions" columns={columns} minWidth={detailed ? "min-w-[62rem]" : "min-w-[50rem]"}>
      {summary.rows.map((position) => (
        <tr
          key={`${position.exchangeSegment}:${position.securityId}:${position.productType}`}
          className={position.netQty === 0 ? "text-muted" : undefined}
        >
          <Td className="py-1">
            <div className="font-medium">{position.tradingSymbol}</div>
            <div className="text-label text-muted">
              {position.exchangeSegment} · {position.productType} · {position.positionType}
            </div>
          </Td>
          <Td numeric className="font-medium">
            {quantity.format(position.netQty)}
          </Td>
          <Td numeric>
            {position.netQty === 0 ? "—" : <LivePrice instrument={positionInstrument(position)} />}
          </Td>
          {detailed && <Td numeric>{quantity.format(position.buyQty)}</Td>}
          <Td numeric>{position.buyQty ? price.format(position.buyAvg) : "—"}</Td>
          {detailed && <Td numeric>{quantity.format(position.sellQty)}</Td>}
          <Td numeric>{position.sellQty ? price.format(position.sellAvg) : "—"}</Td>
          <Td numeric>
            <Pnl value={position.realizedProfit} />
          </Td>
          <Td numeric>
            <Pnl value={position.unrealizedProfit} />
          </Td>
        </tr>
      ))}
    </DataTable>
  );
}

function sum<T>(items: T[], pick: (item: T) => number) {
  return items.reduce((total, item) => total + pick(item), 0);
}

function ratio(part: number, whole: number) {
  return whole === 0 ? undefined : part / whole;
}
