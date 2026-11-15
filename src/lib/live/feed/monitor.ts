// What /api/market/feed sends the Live Feed page. Shared by the server hub and the browser.

import type { FeedState } from "./dhan-feed.ts";
import type { Packet } from "./packets.ts";

/** Dhan's limits, from dhanhq.co/docs/v2/live-market-feed: 5 WebSockets per account, 5,000 instruments each. */
export const MAX_CONNECTIONS = 5;
export const MAX_INSTRUMENTS_PER_CONNECTION = 5_000;
/** The connection app pages subscribe on. It always exists and can't be closed. */
export const MAIN_CONNECTION = 1;

export interface Quote {
  ltp?: number;
  ltt?: number;
  prevClose?: number;
  at: number;
}

export type FeedEventBody = (
  | { type: "packet"; packet: Packet }
  | { type: "subscribe" | "unsubscribe"; keys: string[] }
  | { type: "state"; state: FeedState }
  | { type: "log"; message: string }
) & {
  /** The connection the event happened on; absent for hub-wide notes. */
  connection?: number;
};

export type FeedEvent = { id: number; at: number } & FeedEventBody;

export interface FeedConnection {
  id: number;
  name: string;
  main: boolean;
  feed: FeedState;
  createdAt: number;
  lastTickAt: number | null;
  /** Instruments assigned to this connection. */
  instruments: number;
  frames: number;
  bytes: number;
  packets: Record<string, number>;
}

export interface FeedInstrument {
  key: string;
  /** Name given when it was added on the Live Feed page. */
  name: string | null;
  connection: number;
  /** Open browser tabs whose pages show this instrument. */
  tabs: number;
  /** Added on the Live Feed page; stays subscribed until removed there. */
  pinned: boolean;
  /** Nobody wants it any more; it unsubscribes from Dhan at this time. */
  releaseAt: number | null;
  quote: Quote | null;
}

export interface FeedHealth {
  startedAt: number;
  lastTickAt: number | null;
  /** Browser tabs receiving quotes over /api/market/stream. */
  quoteStreams: number;
  monitors: number;
  capture: boolean;
  connections: FeedConnection[];
  instruments: FeedInstrument[];
}

export interface MonitorSnapshot {
  health: FeedHealth;
  events: FeedEvent[];
}

export type FeedActionResult = { ok: boolean; message: string };
