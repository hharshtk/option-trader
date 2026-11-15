// What /api/market/feed sends the Live Feed page. Shared by the server hub and the browser.

import type { FeedState } from "./dhan-feed.ts";
import type { Packet } from "./packets.ts";

export interface Quote {
  ltp?: number;
  ltt?: number;
  prevClose?: number;
  at: number;
}

export type FeedEventBody =
  | { type: "packet"; packet: Packet }
  | { type: "subscribe" | "unsubscribe"; keys: string[] }
  | { type: "state"; state: FeedState }
  | { type: "log"; message: string };

export type FeedEvent = { id: number; at: number } & FeedEventBody;

export interface FeedInstrument {
  key: string;
  /** Open quote streams (browser tabs) asking for this instrument. */
  streams: number;
  /** No stream wants it; it unsubscribes from Dhan when the grace period ends. */
  releasing: boolean;
  quote: Quote | null;
}

export interface FeedHealth {
  feed: FeedState;
  startedAt: number;
  lastTickAt: number | null;
  quoteStreams: number;
  monitors: number;
  dhanSubscriptions: number;
  frames: number;
  bytes: number;
  packets: Record<string, number>;
  capture: boolean;
  instruments: FeedInstrument[];
}

export interface MonitorSnapshot {
  health: FeedHealth;
  events: FeedEvent[];
}
