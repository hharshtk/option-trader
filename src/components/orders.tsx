import type { DhanOrder, OrderStatus } from "@/lib/dhan";
import { price, quantity } from "@/lib/format";
import { DataTable, EmptyState, Td } from "./ui";

const STATUS_TONE: Record<OrderStatus, string> = {
  TRADED: "text-up",
  PART_TRADED: "text-warn",
  PENDING: "text-warn",
  TRANSIT: "text-warn",
  TRIGGERED: "text-warn",
  REJECTED: "text-down",
  CANCELLED: "text-muted",
  EXPIRED: "text-muted",
  CLOSED: "text-muted",
};

const OPEN_STATUSES = new Set<OrderStatus>(["TRANSIT", "PENDING", "PART_TRADED", "TRIGGERED"]);

export function countOrders(orders: DhanOrder[]) {
  return {
    total: orders.length,
    traded: orders.filter((order) => order.orderStatus === "TRADED").length,
    open: orders.filter((order) => OPEN_STATUSES.has(order.orderStatus)).length,
    rejected: orders.filter((order) => order.orderStatus === "REJECTED").length,
  };
}

export function OrdersTable({ orders }: { orders: DhanOrder[] }) {
  if (orders.length === 0) {
    return (
      <div className="p-3">
        <EmptyState>No orders today.</EmptyState>
      </div>
    );
  }

  const rows = orders.toSorted((a, b) => b.createTime.localeCompare(a.createTime));

  return (
    <DataTable
      caption="Today's orders"
      minWidth="min-w-[64rem]"
      columns={[
        "Time",
        { label: "Instrument", align: "left" },
        { label: "Side", align: "left" },
        { label: "Type", align: "left" },
        { label: "Product", align: "left" },
        "Filled / Qty",
        "Price",
        "Trigger",
        "Avg price",
        { label: "Status", align: "left" },
      ]}
    >
      {rows.map((order) => (
        <tr key={order.orderId}>
          <Td className="font-mono text-label text-muted">{clockTime(order.createTime)}</Td>
          <Td>
            <span className="font-medium">{order.tradingSymbol}</span>
            <span className="ml-2 text-label text-muted">{order.exchangeSegment}</span>
          </Td>
          <Td className={`font-medium ${order.transactionType === "BUY" ? "text-up" : "text-down"}`}>
            {order.transactionType}
          </Td>
          <Td>{order.orderType.replaceAll("_", " ")}</Td>
          <Td>{order.productType}</Td>
          <Td numeric>
            {quantity.format(order.filledQty)} / {quantity.format(order.quantity)}
          </Td>
          <Td numeric>
            {order.orderType === "MARKET" || order.orderType === "STOP_LOSS_MARKET"
              ? "Market"
              : price.format(order.price)}
          </Td>
          <Td numeric>{order.triggerPrice > 0 ? price.format(order.triggerPrice) : "—"}</Td>
          <Td numeric>
            {order.averageTradedPrice > 0 ? price.format(order.averageTradedPrice) : "—"}
          </Td>
          <Td className="py-1">
            <span className={`font-medium ${STATUS_TONE[order.orderStatus] ?? ""}`}>
              {order.orderStatus.replaceAll("_", " ")}
            </span>
            {order.orderStatus === "REJECTED" && order.omsErrorDescription && (
              <div className="max-w-xs truncate text-label text-muted" title={order.omsErrorDescription}>
                {order.omsErrorDescription}
              </div>
            )}
          </Td>
        </tr>
      ))}
    </DataTable>
  );
}

function clockTime(value: string) {
  return /\d{2}:\d{2}:\d{2}/.exec(value)?.[0] ?? value;
}
