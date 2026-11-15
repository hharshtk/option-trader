import "server-only";
import path from "node:path";
import { getDhanCredentials } from "@/lib/dhan/config";
import { createFeedHub, type FeedHub } from "./feed-hub.ts";

// Dev hot reload re-evaluates server modules, and each route bundle can hold its own copy of
// this one. Keeping the hub on globalThis guarantees one set of Dhan sockets per server process.
// Bump HUB_REVISION when the hub's shape changes: a running dev server then shuts the old hub
// down (its tabs reconnect within seconds) instead of serving routes a hub they don't match.
const HUB_REVISION = 3;
const HUB = Symbol.for("option-trader.feed-hub");
const globalStore = globalThis as typeof globalThis & {
  [HUB]?: { revision: number; hub: Partial<FeedHub> };
};

export function getFeedHub(): FeedHub {
  const current = globalStore[HUB];
  if (current?.revision === HUB_REVISION) return current.hub as FeedHub;
  // Revision 1 stored the hub itself and had no shutdown; its socket closes after 5 idle minutes.
  current?.hub?.shutdown?.();
  const hub = createFeedHub({
    readCredentials: getDhanCredentials,
    currentToken: () => process.env.DHAN_ACCESS_TOKEN,
    captureDir: process.env.FEED_CAPTURE === "1" ? path.join(process.cwd(), "captures", "feed") : undefined,
  });
  globalStore[HUB] = { revision: HUB_REVISION, hub };
  return hub;
}
