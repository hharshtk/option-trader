// During a replay, shows the web recorded times instead of the wall clock. The live feed code
// is untouched: it stamps frames with Date.now() as always, and this rewrites the times in what
// leaves the engine (quote streams, the Live Feed stream, `feed` telemetry) using the player's
// map from wall-clock stamps to recorded times. It also adds the replay's clock, so the web can
// measure ages from recorded time.

import type { EngineFeedHealth, ReplayClock } from "../../lib/engine/protocol.ts";
import type { FeedState } from "../../lib/live/feed/dhan-feed.ts";
import type { FeedHub } from "../../lib/live/feed/feed-hub.ts";
import type { FeedEvent, FeedHealth, Quote } from "../../lib/live/feed/monitor.ts";

export interface Retimer {
  /** A past wall-clock stamp as recorded time. */
  at(wall: number): number;
  /** A wall-clock deadline (a retry, a release) as the same distance ahead on the recorded clock. */
  deadline(wall: number): number;
  clock(): ReplayClock;
}

export function createRetimer(player: { toRecorded(wall: number): number; reading(): ReplayClock }, now: () => number): Retimer {
  return {
    at: (wall) => player.toRecorded(wall),
    deadline: (wall) => player.reading().now + (wall - now()),
    clock: () => player.reading(),
  };
}

function retimeState<T extends FeedState>(state: T, t: Retimer): T {
  if (state.state === "live") return { ...state, since: t.at(state.since) };
  if (state.state === "reconnecting") return { ...state, retryAt: t.deadline(state.retryAt) };
  return state;
}

function retimeQuote(quote: Quote, t: Retimer): Quote {
  return { ...quote, at: t.at(quote.at) };
}

function retimeQuotes(quotes: Record<string, Quote>, t: Retimer) {
  return Object.fromEntries(Object.entries(quotes).map(([key, quote]) => [key, retimeQuote(quote, t)]));
}

const maybe = (value: number | null, map: (wall: number) => number) => (value === null ? null : map(value));

export function retimeHealth(health: FeedHealth, t: Retimer): EngineFeedHealth {
  return {
    ...health,
    clock: t.clock(),
    startedAt: t.at(health.startedAt),
    lastTickAt: maybe(health.lastTickAt, t.at),
    connections: health.connections.map((connection) => ({
      ...connection,
      feed: retimeState(connection.feed, t),
      createdAt: t.at(connection.createdAt),
      lastTickAt: maybe(connection.lastTickAt, t.at),
    })),
    instruments: health.instruments.map((instrument) => ({
      ...instrument,
      releaseAt: maybe(instrument.releaseAt, t.deadline),
      quote: instrument.quote && retimeQuote(instrument.quote, t),
    })),
  };
}

function retimeEvents(events: FeedEvent[], t: Retimer): FeedEvent[] {
  return events.map((event) =>
    event.type === "state" ? { ...event, at: t.at(event.at), state: retimeState(event.state, t) } : { ...event, at: t.at(event.at) },
  );
}

const SSE_EVENT = /^event: ([a-z]+)\ndata: ([^\n]*)\n\n$/;

/** Rewrites the times in one server-sent event from the hub; anything else passes unchanged. */
export function retimeSse(text: string, t: Retimer): string {
  const match = SSE_EVENT.exec(text);
  if (!match) return text;
  const [, name, json] = match;
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return text;
  }
  let next: unknown;
  switch (name) {
    case "quotes":
      next = retimeQuotes(data as Record<string, Quote>, t);
      break;
    case "status": {
      // A tab's quote stream status: a feed state plus the last tick.
      const status = data as FeedState & { lastTickAt: number | null };
      next = { ...retimeState(status, t), lastTickAt: maybe(status.lastTickAt, t.at), clock: t.clock() };
      break;
    }
    case "health":
      next = retimeHealth(data as FeedHealth, t);
      break;
    case "events":
      next = retimeEvents(data as FeedEvent[], t);
      break;
    case "snapshot": {
      const snapshot = data as { health: FeedHealth; events: FeedEvent[] };
      next = { health: retimeHealth(snapshot.health, t), events: retimeEvents(snapshot.events, t) };
      break;
    }
    default:
      return text;
  }
  return `event: ${name}\ndata: ${JSON.stringify(next)}\n\n`;
}

/** The hub's SSE stream with every event retimed. Cancelling it cancels the hub's stream. */
export function retimeStream(stream: ReadableStream<Uint8Array>, t: Retimer): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  // The hub enqueues one whole event per chunk, so each chunk is retimed on its own.
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(encoder.encode(retimeSse(decoder.decode(chunk), t)));
      },
    }),
  );
}

/** The hub as the API and telemetry see it during a replay: the same hub, reporting recorded times. */
export function retimeHub(hub: FeedHub, t: Retimer): FeedHub {
  return {
    ...hub,
    health: () => retimeHealth(hub.health(), t),
    stream: (instruments, signal) => retimeStream(hub.stream(instruments, signal), t),
    monitor: (signal) => retimeStream(hub.monitor(signal), t),
  };
}
