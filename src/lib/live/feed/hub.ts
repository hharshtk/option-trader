import "server-only";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import { getDhanCredentials } from "@/lib/dhan/config";
import { createDhanFeed, type FeedState } from "./dhan-feed.ts";
import type { FeedEvent, FeedEventBody, FeedHealth, FeedInstrument, MonitorSnapshot, Quote } from "./monitor.ts";
import { instrumentKey, type Instrument, type Packet } from "./packets.ts";

// The live feed runs inside the Next server: one Dhan socket shared by every browser tab,
// fanned out to each tab as server-sent events by /api/market/stream. The Live Feed page
// watches it through /api/market/feed.

const FLUSH_MS = 250;
const HEALTH_MS = 1_000;
const HEARTBEAT_MS = 15_000;
const UNSUBSCRIBE_GRACE_MS = 30_000;
const MAX_INSTRUMENTS = 1_000;
const EVENT_HISTORY = 1_000;
const MAX_EVENTS_PER_FLUSH = 500;
const CAPTURE_DIR = path.join(process.cwd(), "captures", "feed");

interface Client {
  keys: Set<string>;
  send: (chunk: string) => void;
}

type Send = (chunk: string) => void;

const encoder = new TextEncoder();
const roundPrice = (value: number) => Math.round(value * 100) / 100;
const sse = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

function describeState(state: FeedState) {
  switch (state.state) {
    case "reconnecting":
      return `reconnecting (attempt ${state.attempt})`;
    case "stopped":
      return `stopped: ${state.reason}`;
    default:
      return state.state;
  }
}

function createFeedHub() {
  const startedAt = Date.now();
  const quotes = new Map<string, Quote>();
  const dirty = new Set<string>();
  const refs = new Map<string, number>();
  const pendingUnsubscribe = new Map<string, ReturnType<typeof setTimeout>>();
  const clients = new Set<Client>();
  const monitors = new Set<Send>();
  const openStreams = new Set<() => void>();
  const reportedUnknown = new Set<number>();
  const packetCounts: Record<string, number> = {};
  const history: FeedEvent[] = [];
  let unsentEvents: FeedEvent[] = [];
  let nextEventId = 1;
  let frames = 0;
  let bytes = 0;
  const captureEnabled = process.env.FEED_CAPTURE === "1";
  let feedState: FeedState = { state: "idle" };
  let lastTickAt: number | null = null;
  let capture: WriteStream | null = null;
  // The token in use when the feed stopped; a different one in the env is worth a retry.
  let tokenAtLastConnect: string | undefined;
  let tokenAtStop: string | undefined;

  function record(event: FeedEventBody, at = Date.now()) {
    const entry: FeedEvent = { ...event, id: nextEventId++, at };
    history.push(entry);
    if (history.length > EVENT_HISTORY) history.shift();
    if (monitors.size > 0) unsentEvents.push(entry);
  }

  function print(message: string) {
    const time = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    console.log(`[feed ${time}] ${message}`);
  }

  function log(message: string) {
    print(message);
    record({ type: "log", message });
  }

  function update(key: string, patch: Omit<Quote, "at">, at: number) {
    if (!refs.has(key) && !pendingUnsubscribe.has(key)) return;
    quotes.set(key, { ...quotes.get(key), ...patch, at });
    dirty.add(key);
  }

  function handlePacket(packet: Packet, receivedAt: number) {
    packetCounts[packet.kind] = (packetCounts[packet.kind] ?? 0) + 1;
    record({ type: "packet", packet }, receivedAt);

    switch (packet.kind) {
      case "ticker":
      case "quote":
        lastTickAt = receivedAt;
        update(packet.key, { ltp: roundPrice(packet.ltp), ltt: packet.ltt }, receivedAt);
        break;
      case "prevClose":
        update(packet.key, { prevClose: roundPrice(packet.prevClose) }, receivedAt);
        break;
      case "disconnect":
        log(`Dhan sent disconnect code ${packet.reason}`);
        break;
      case "unknown":
        if (!reportedUnknown.has(packet.code)) {
          reportedUnknown.add(packet.code);
          log(`unparsed packet code ${packet.code} (${packet.length} bytes${packet.key ? `, ${packet.key}` : ""})`);
        }
        break;
    }
  }

  function handleFrame(frame: ArrayBuffer, receivedAt: number) {
    frames += 1;
    bytes += frame.byteLength;
    if (!captureEnabled) return;
    if (!capture) {
      mkdirSync(CAPTURE_DIR, { recursive: true });
      const day = new Date(receivedAt).toISOString().slice(0, 10);
      capture = createWriteStream(path.join(CAPTURE_DIR, `${day}.jsonl`), { flags: "a" });
    }
    capture.write(`${JSON.stringify({ t: receivedAt, hex: Buffer.from(frame).toString("hex") })}\n`);
  }

  const statusPayload = () => ({ ...feedState, lastTickAt });

  const feed = createDhanFeed({
    readCredentials() {
      const credentials = getDhanCredentials();
      tokenAtLastConnect = credentials.accessToken;
      return credentials;
    },
    onPacket: handlePacket,
    onState(next) {
      feedState = next;
      if (next.state === "stopped") tokenAtStop = tokenAtLastConnect;
      print(describeState(next));
      record({ type: "state", state: next });
      const status = sse("status", statusPayload());
      for (const client of clients) client.send(status);
    },
    onFrame: handleFrame,
    log,
  });

  function subscribe(instruments: Instrument[]) {
    if (instruments.length === 0) return;
    record({ type: "subscribe", keys: instruments.map(instrumentKey) });
    feed.subscribe(instruments);
  }

  function acquire(instruments: Instrument[]) {
    const added: Instrument[] = [];
    for (const instrument of instruments) {
      const key = instrumentKey(instrument);
      clearTimeout(pendingUnsubscribe.get(key));
      pendingUnsubscribe.delete(key);
      const count = refs.get(key) ?? 0;
      if (count === 0 && refs.size >= MAX_INSTRUMENTS) {
        log(`instrument limit (${MAX_INSTRUMENTS}) reached; not subscribing ${key}`);
        continue;
      }
      refs.set(key, count + 1);
      if (count === 0) added.push(instrument);
    }
    subscribe(added);

    // A stopped feed stays stopped until the token changes, so reloading the page after
    // renewing DHAN_ACCESS_TOKEN reconnects without restarting the server.
    if (feedState.state === "stopped" && process.env.DHAN_ACCESS_TOKEN?.trim() !== tokenAtStop) {
      log("access token changed; reconnecting");
      feed.reload();
    }
  }

  // A short grace period keeps moving between sections from churning Dhan subscriptions.
  function release(instruments: Instrument[]) {
    for (const instrument of instruments) {
      const key = instrumentKey(instrument);
      const count = (refs.get(key) ?? 0) - 1;
      if (count > 0) {
        refs.set(key, count);
        continue;
      }
      refs.delete(key);
      pendingUnsubscribe.set(
        key,
        setTimeout(() => {
          pendingUnsubscribe.delete(key);
          if (refs.has(key)) return;
          quotes.delete(key);
          record({ type: "unsubscribe", keys: [key] });
          feed.unsubscribe([instrument]);
        }, UNSUBSCRIBE_GRACE_MS),
      );
    }
  }

  function health(): FeedHealth {
    const instruments: FeedInstrument[] = [...new Set([...refs.keys(), ...pendingUnsubscribe.keys()])]
      .sort()
      .map((key) => ({
        key,
        streams: refs.get(key) ?? 0,
        releasing: !refs.has(key),
        quote: quotes.get(key) ?? null,
      }));
    return {
      feed: feedState,
      startedAt,
      lastTickAt,
      quoteStreams: clients.size,
      monitors: monitors.size,
      dhanSubscriptions: feed.subscriptionCount(),
      frames,
      bytes,
      packets: { ...packetCounts },
      capture: captureEnabled,
      instruments,
    };
  }

  const flushTimer = setInterval(() => {
    if (unsentEvents.length > 0) {
      const batch = sse("events", unsentEvents.slice(-MAX_EVENTS_PER_FLUSH));
      unsentEvents = [];
      for (const send of monitors) send(batch);
    }

    if (dirty.size === 0) return;
    for (const client of clients) {
      const payload: Record<string, Quote> = {};
      for (const key of dirty) {
        const quote = quotes.get(key);
        if (quote && client.keys.has(key)) payload[key] = quote;
      }
      if (Object.keys(payload).length > 0) client.send(sse("quotes", payload));
    }
    dirty.clear();
  }, FLUSH_MS);

  const healthTimer = setInterval(() => {
    if (monitors.size === 0) return;
    const payload = sse("health", health());
    for (const send of monitors) send(payload);
  }, HEALTH_MS);

  flushTimer.unref();
  healthTimer.unref();

  // An SSE response that runs `open` once and its returned cleanup when either side closes.
  function sseStream(signal: AbortSignal, open: (send: Send) => () => void): ReadableStream<Uint8Array> {
    let close = () => {};

    return new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let cleanup = () => {};
        const send: Send = (chunk) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            close();
          }
        };
        const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);

        close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          openStreams.delete(close);
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed or errored by the consumer.
          }
        };
        openStreams.add(close);

        send("retry: 3000\n\n");
        const stop = open(send);
        if (closed) stop();
        else cleanup = stop;

        if (signal.aborted) close();
        else signal.addEventListener("abort", () => close(), { once: true });
      },
      cancel() {
        close();
      },
    });
  }

  /** Latest quotes for `instruments`, for one browser tab. */
  function stream(instruments: Instrument[], signal: AbortSignal) {
    return sseStream(signal, (send) => {
      const client: Client = { keys: new Set(instruments.map(instrumentKey)), send };
      clients.add(client);
      acquire(instruments);
      send(sse("status", statusPayload()));

      const snapshot: Record<string, Quote> = {};
      for (const key of client.keys) {
        const quote = quotes.get(key);
        if (quote) snapshot[key] = quote;
      }
      if (Object.keys(snapshot).length > 0) send(sse("quotes", snapshot));

      return () => {
        clients.delete(client);
        release(instruments);
      };
    });
  }

  /** Everything the hub sees, for the Live Feed page. Watching subscribes to nothing. */
  function monitor(signal: AbortSignal) {
    return sseStream(signal, (send) => {
      monitors.add(send);
      const snapshot: MonitorSnapshot = { health: health(), events: [...history] };
      send(sse("snapshot", snapshot));
      return () => {
        monitors.delete(send);
      };
    });
  }

  function shutdown() {
    clearInterval(flushTimer);
    clearInterval(healthTimer);
    for (const timer of pendingUnsubscribe.values()) clearTimeout(timer);
    for (const close of [...openStreams]) close();
    feed.shutdown();
    capture?.end();
  }

  log(`ready${captureEnabled ? ", recording raw frames" : ""}; connects to Dhan when the first tab subscribes`);
  return { stream, monitor, shutdown };
}

type FeedHub = ReturnType<typeof createFeedHub>;

// Dev hot reload re-evaluates server modules, and each route bundle can hold its own copy of
// this one. Keeping the hub on globalThis guarantees one Dhan socket per server process.
// Bump HUB_REVISION when the hub's shape changes: a running dev server then shuts the old hub
// down (its tabs reconnect within seconds) instead of serving routes a hub they don't match.
const HUB_REVISION = 2;
const HUB = Symbol.for("option-trader.feed-hub");
const globalStore = globalThis as typeof globalThis & {
  [HUB]?: { revision: number; hub: FeedHub };
};

export function getFeedHub(): FeedHub {
  const current = globalStore[HUB];
  if (current?.revision === HUB_REVISION) return current.hub;
  // Revision 1 stored the hub itself and had no shutdown; its socket closes after 5 idle minutes.
  (current?.hub as Partial<FeedHub> | undefined)?.shutdown?.();
  const hub = createFeedHub();
  globalStore[HUB] = { revision: HUB_REVISION, hub };
  return hub;
}
