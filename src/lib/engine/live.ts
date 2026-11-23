// Live orders with Dhan: the one-lot pilot of 22 Nov 2026 (constitution, amendment log). Types shared
// by the engine's live desk (src/engine/trading/live-desk.ts) and the web. How it works: docs/trading.md#live-pilot.

import type { OptionRef } from "./trading.ts";

/**
 * Dhan's order states, and three of the desk's own: NEW (not sent yet), SENDING (the request is in
 * flight), UNKNOWN (the request failed without an answer, so whether Dhan took it is looked up by
 * correlation id) and NOT_PLACED (Dhan refused it, or has no record of it).
 */
export type LiveOrderStatus =
  | "NEW"
  | "SENDING"
  | "UNKNOWN"
  | "NOT_PLACED"
  | "TRANSIT"
  | "PENDING"
  | "PART_TRADED"
  | "TRIGGERED"
  | "TRADED"
  | "REJECTED"
  | "CANCELLED"
  | "EXPIRED"
  | "CLOSED";

/** Nothing more will happen to an order in one of these states. */
export const FINAL_ORDER_STATES: ReadonlySet<LiveOrderStatus> = new Set(["NOT_PLACED", "TRADED", "REJECTED", "CANCELLED", "EXPIRED", "CLOSED"]);

export interface LiveOrder {
  /** Ours, sent with the order: up to 30 letters, digits and hyphens. Finds the order when its answer was lost. */
  correlationId: string;
  orderId: string | null;
  /** The buy, the stop-loss order resting at Dhan, or a sale by the engine. */
  role: "entry" | "stop" | "exit";
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET" | "STOP_LOSS";
  validity: "DAY" | "IOC";
  quantity: number;
  /** Limit price; null for a market order. */
  price: number | null;
  /** A stop-loss order's trigger. */
  trigger: number | null;
  status: LiveOrderStatus;
  filledQty: number;
  averagePrice: number | null;
  /** Dhan's reason for a rejection, or why it wasn't sent. */
  message: string | null;
  /** The engine's quote when it was sent. */
  bid: number | null;
  ask: number | null;
  ltp: number | null;
  /** Wall clock. */
  createdAt: number;
  updatedAt: number;
  cancelRequested: boolean;
  /** When the desk next asks Dhan about it. */
  checkAt: number;
}

/** One real position, mirroring one paper position. */
export interface LivePosition {
  /** The paper position's id. */
  id: string;
  runId: string;
  contract: OptionRef;
  /** One lot. */
  quantity: number;
  state: "buying" | "open" | "selling" | "closed";
  /** Why it is being or was sold. */
  closeReason: string | null;
  /** The paper stop's distance below the entry, as a fraction; the stop at Dhan keeps it. */
  stopFraction: number | null;
  /** Buy first, then the stop, then the sales. */
  orders: LiveOrder[];
  openedAt: number | null;
  closedAt: number | null;
  bought: number;
  buyAverage: number | null;
  sold: number;
  sellAverage: number | null;
  /** Rupees: on what has been sold, before and after the charges of every executed order. */
  gross: number;
  charges: number;
  net: number;
  /** The last price, and the open part's gain or loss at it before charges. */
  mark: number | null;
  openGross: number;
  /** What happened, in a line. */
  note: string | null;
  /** Something a person must look at in the Dhan app. */
  alert: string | null;
}

export interface LiveEvent {
  at: number;
  level: "info" | "warn" | "error";
  message: string;
}

export interface LiveTotals {
  /** Positions bought for real today, and how many closed ahead after charges. */
  trades: number;
  wins: number;
  gross: number;
  charges: number;
  net: number;
  /** The open position's gain or loss before charges. */
  open: number;
}

export interface LiveStatus {
  /** False on any engine but the main one (port 3100), which alone may place orders. */
  allowed: boolean;
  /** Why not, when not allowed. */
  notAllowed: string | null;
  /** Real orders follow the paper book today. */
  on: boolean;
  /** The day the desk holds, YYYY-MM-DD IST. */
  date: string | null;
  /** When live was switched on today, and why it switched itself off, if it did. */
  since: number | null;
  offReason: string | null;
  /** The daily loss limit set as Dhan's P&L exit with the kill switch, when live was switched on. */
  lossLimit: number | null;
  /** Dhan's answers when live was switched on: P&L exit, cash available, whitelisted IP. */
  checks: { pnlExit: string | null; balance: number | null; ip: string | null } | null;
  positions: LivePosition[];
  totals: LiveTotals;
  /** Newest first. */
  events: LiveEvent[];
  /** The first thing a person must look at, if any. */
  alert: string | null;
  /** Positions in the Dhan account the engine didn't open, from the last check. */
  otherPositions: string[];
}

export type LiveCommand =
  /** Switches live on for `date`, which must be today's live run: the page sends the date it showed. */
  | { action: "live-on"; date: string }
  /** No new real orders; real positions held are still sold with their paper positions. */
  | { action: "live-off" }
  /** Dhan's own exit: sells every position and cancels every open order in the account, then live goes off. */
  | { action: "live-exit-all" };
