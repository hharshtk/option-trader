// Dhan's order API for the live desk: place, look up, cancel, positions, and the account's own
// protections (P&L exit, kill switch, exit everything). Every call goes through dhanRequest, so it
// shares the token, the rate limits and the error handling with the rest of the engine.
// Order placement needs this machine's IP whitelisted with Dhan; reads don't.

import { dhanRequest } from "../../lib/dhan/client.ts";
import { loadDhanCredentials } from "../../lib/dhan/config.ts";
import { DhanApiError, DhanConfigError } from "../../lib/dhan/errors.ts";
import type { LiveOrderStatus } from "../../lib/engine/live.ts";

export interface PlaceRequest {
  correlationId: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET" | "STOP_LOSS";
  validity: "DAY" | "IOC";
  securityId: string;
  quantity: number;
  price: number | null;
  trigger: number | null;
}

export interface BrokerOrder {
  orderId: string;
  status: LiveOrderStatus;
  filledQty: number;
  averagePrice: number | null;
  message: string | null;
}

export interface BrokerPosition {
  securityId: string;
  exchangeSegment: string;
  productType: string;
  tradingSymbol: string;
  netQty: number;
}

/**
 * A failed call. `unknown`: no answer came (timeout, network, Dhan's server error), so a placement
 * may or may not have reached the exchange. `fatal`: the account can't trade now (token, IP, kill
 * switch), so live should stop for the day.
 */
export class BrokerError extends Error {
  name = "BrokerError";
  readonly unknown: boolean;
  readonly fatal: boolean;
  constructor(message: string, { unknown, fatal }: { unknown: boolean; fatal: boolean }) {
    super(message);
    this.unknown = unknown;
    this.fatal = fatal;
  }
}

export interface LiveBroker {
  place(request: PlaceRequest): Promise<{ orderId: string; status: LiveOrderStatus }>;
  order(orderId: string): Promise<BrokerOrder>;
  /** Null when Dhan has no order with that correlation id. */
  orderByCorrelation(correlationId: string): Promise<BrokerOrder | null>;
  cancel(orderId: string): Promise<void>;
  positions(): Promise<BrokerPosition[]>;
  /** Sets the day's P&L exit: at this loss Dhan sells everything and turns its kill switch on. Returns Dhan's answer. */
  setLossExit(loss: number): Promise<string>;
  /** "ACTIVATE" when the kill switch is on (no trading today). */
  killSwitch(): Promise<string>;
  balance(): Promise<number | null>;
  whitelistedIp(): Promise<string | null>;
  /** Dhan's exit-all: sells every position and cancels every open order in the account. */
  exitAll(): Promise<string>;
}

const KNOWN_STATES = new Set<LiveOrderStatus>(["TRANSIT", "PENDING", "PART_TRADED", "TRIGGERED", "TRADED", "REJECTED", "CANCELLED", "EXPIRED", "CLOSED"]);

export function orderStatus(value: unknown): LiveOrderStatus {
  const text = String(value ?? "").toUpperCase();
  return KNOWN_STATES.has(text as LiveOrderStatus) ? (text as LiveOrderStatus) : "PENDING";
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const first = (value: unknown) => record(Array.isArray(value) ? value[0] : value);
const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function readOrder(value: unknown): BrokerOrder {
  const o = first(value);
  const average = num(o.averageTradedPrice);
  const message = [o.omsErrorDescription, o.omsErrorCode].find((v) => typeof v === "string" && v.trim() !== "") as string | undefined;
  return {
    orderId: String(o.orderId ?? ""),
    status: orderStatus(o.orderStatus),
    filledQty: num(o.filledQty) ?? 0,
    averagePrice: average !== null && average > 0 ? average : null,
    message: message ?? null,
  };
}

// The errors that mean the account can't place orders right now, whatever is sent.
const FATAL = /static ip|whitelist|kill ?switch|invalid token|token.*expired|not authori[sz]ed|access token|DH-901|DH-902|blocked/i;

function brokerError(error: unknown): BrokerError {
  if (error instanceof BrokerError) return error;
  if (error instanceof DhanConfigError) return new BrokerError(error.message, { unknown: false, fatal: true });
  if (error instanceof DhanApiError) {
    const unknown = error.status === 0 || error.status >= 500;
    const fatal = error.isAuthError || FATAL.test(`${error.code ?? ""} ${error.message}`);
    return new BrokerError(`${error.message}${error.code ? ` (${error.code})` : ""}`, { unknown, fatal });
  }
  return new BrokerError(error instanceof Error ? error.message : String(error), { unknown: true, fatal: false });
}

async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw brokerError(error);
  }
}

/** The adapter over Dhan's v2 REST API. */
export function createDhanBroker(): LiveBroker {
  const clientId = async () => (await loadDhanCredentials()).clientId;
  return {
    place: (request) =>
      call(async () => {
        const body = {
          dhanClientId: await clientId(),
          correlationId: request.correlationId,
          transactionType: request.side,
          exchangeSegment: "NSE_FNO",
          productType: "INTRADAY",
          orderType: request.type,
          validity: request.validity,
          securityId: request.securityId,
          quantity: request.quantity,
          disclosedQuantity: 0,
          price: request.type === "MARKET" ? 0 : request.price,
          triggerPrice: request.type === "STOP_LOSS" ? request.trigger : 0,
          afterMarketOrder: false,
        };
        const answer = record(await dhanRequest<unknown>("POST", "/orders", { body }));
        const orderId = String(answer.orderId ?? "");
        if (!orderId) throw new BrokerError("Dhan answered without an order id", { unknown: true, fatal: false });
        return { orderId, status: orderStatus(answer.orderStatus) };
      }),
    order: (orderId) => call(async () => readOrder(await dhanRequest<unknown>("GET", `/orders/${encodeURIComponent(orderId)}`))),
    async orderByCorrelation(correlationId) {
      try {
        const order = readOrder(await dhanRequest<unknown>("GET", `/orders/external/${encodeURIComponent(correlationId)}`));
        return order.orderId ? order : null;
      } catch (error) {
        // Dhan answered: it has no such order. No answer at all is retried by the caller.
        if (error instanceof DhanApiError && error.status >= 400 && error.status < 500 && !error.isRateLimitError && !error.isAuthError) return null;
        throw brokerError(error);
      }
    },
    cancel: (orderId) =>
      call(async () => {
        await dhanRequest<unknown>("DELETE", `/orders/${encodeURIComponent(orderId)}`);
      }),
    positions: () =>
      call(async () => {
        const list = await dhanRequest<unknown>("GET", "/positions");
        return (Array.isArray(list) ? list : []).map((item) => {
          const p = record(item);
          return {
            securityId: String(p.securityId ?? ""),
            exchangeSegment: String(p.exchangeSegment ?? ""),
            productType: String(p.productType ?? ""),
            tradingSymbol: String(p.tradingSymbol ?? p.securityId ?? ""),
            netQty: num(p.netQty) ?? 0,
          };
        });
      }),
    setLossExit: (loss) =>
      call(async () => {
        // Dhan's table says floats, its example sends strings: try the first, fall back to the second.
        // The profit side is set out of reach: the pilot exits on losses only.
        const send = (profitValue: number | string, lossValue: number | string) =>
          dhanRequest<unknown>("POST", "/pnlExit", { body: { profitValue, lossValue, productType: ["INTRADAY"], enableKillSwitch: true } });
        let answer: unknown;
        try {
          answer = await send(10_000_000, loss);
        } catch (error) {
          if (!(error instanceof DhanApiError) || error.status < 400 || error.status >= 500) throw error;
          answer = await send("10000000.00", loss.toFixed(2));
        }
        const a = record(answer);
        return [a.pnlExitStatus, a.message].filter(Boolean).join(": ") || "set";
      }),
    killSwitch: () => call(async () => String(record(await dhanRequest<unknown>("GET", "/killswitch")).killSwitchStatus ?? "")),
    balance: () =>
      call(async () => {
        const funds = record(await dhanRequest<unknown>("GET", "/fundlimit"));
        // Dhan spells it "availabelBalance".
        return num(funds.availabelBalance ?? funds.availableBalance);
      }),
    async whitelistedIp() {
      try {
        const answer = first(await dhanRequest<unknown>("GET", "/ip/getIP"));
        const ips = [answer.primaryIP, answer.secondaryIP].filter((v) => typeof v === "string" && v.trim() !== "");
        return ips.length > 0 ? ips.join(", ") : null;
      } catch {
        return null;
      }
    },
    exitAll: () =>
      call(async () => {
        const a = record(await dhanRequest<unknown>("DELETE", "/positions"));
        return [a.status, a.message].filter(Boolean).join(": ") || "sent";
      }),
  };
}
