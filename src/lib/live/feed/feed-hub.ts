import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import { createDhanFeed, type Credentials, type DhanFeed, type FeedSocket, type FeedState } from "./dhan-feed.ts";
import {
  MAIN_CONNECTION,
  MAX_CONNECTIONS,
  MAX_INSTRUMENTS_PER_CONNECTION,
  type FeedActionResult,
  type FeedConnection,
  type FeedEvent,
  type FeedEventBody,
  type FeedHealth,
  type FeedInstrument,
  type MonitorSnapshot,
  type Quote,
} from "./monitor.ts";
import { instrumentKey, MODE_RANK, parseInstrumentKey, type FeedMode, type Instrument, type Packet } from "./packets.ts";

// The live feed runs inside the Next server. Dhan allows 5 WebSockets per account with 5,000
// instruments each. Connection 1, "Main", carries whatever app pages show; the Live Feed page
// can add instruments to any connection or open more. Each instrument streams on exactly one
// connection. Browser tabs get their quotes as server-sent events from /api/market/stream,
// and the Live Feed page watches everything through /api/market/feed.

const FLUSH_MS = 250;
const HEALTH_MS = 1_000;
const HEARTBEAT_MS = 15_000;
export const UNSUBSCRIBE_GRACE_MS = 30_000;
const EVENT_HISTORY = 1_000;
const MAX_EVENTS_PER_FLUSH = 500;
const MAX_NAME_LENGTH = 60;

export interface HubOptions {
  readCredentials: () => Credentials;
  /** The token configured now; a stopped connection retries once it differs from the rejected one. */
  currentToken: () => string | undefined;
  captureDir?: string;
  openSocket?: (url: string) => FeedSocket;
  /** Receives each log line, already prefixed with the connection's name where it applies. */
  print?: (message: string) => void;
  /** Every raw frame as received, before parsing. The engine journals these. */
  onFrame?: (connection: number, frame: ArrayBuffer, receivedAt: number) => void;
  /** Subscribe, unsubscribe, state and log events (not packets, which come from frames). */
  onEvent?: (event: FeedEventBody, at: number) => void;
}

function printWithTime(message: string) {
  const time = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  console.log(`[feed ${time}] ${message}`);
}

export interface PinRequest {
  key: string;
  name?: string;
  /** An existing connection's id, or "new" to open another connection for it. */
  connection: number | "new";
  connectionName?: string;
}

interface Connection {
  id: number;
  name: string;
  createdAt: number;
  feed: DhanFeed;
  state: FeedState;
  lastTickAt: number | null;
  frames: number;
  bytes: number;
  packets: Record<string, number>;
  tokenAtLastConnect?: string;
  tokenAtStop?: string;
}

/** One subscribed instrument and why it's subscribed. */
interface Line {
  instrument: Instrument;
  connection: Connection;
  /** The richest mode anyone asked for. Never downgraded while subscribed. */
  mode: FeedMode;
  name: string | null;
  tabs: number;
  pinned: boolean;
  releaseAt: number | null;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

interface Client {
  keys: Set<string>;
  send: Send;
}

type Send = (chunk: string) => void;

const encoder = new TextEncoder();
const roundPrice = (value: number) => Math.round(value * 100) / 100;
const sse = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const ok = (message: string): FeedActionResult => ({ ok: true, message });
const fail = (message: string): FeedActionResult => ({ ok: false, message });
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function cleanName(value: string | undefined) {
  const name = value?.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  return name ? name : null;
}

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

const STATE_PRIORITY: FeedState["state"][] = ["stopped", "reconnecting", "connecting", "live"];

export function createFeedHub({
  readCredentials,
  currentToken,
  captureDir,
  openSocket,
  print = printWithTime,
  onFrame,
  onEvent,
}: HubOptions) {
  const startedAt = Date.now();
  const connections = new Map<number, Connection>();
  const lines = new Map<string, Line>();
  const quotes = new Map<string, Quote>();
  const dirty = new Set<string>();
  const clients = new Set<Client>();
  /** Live Feed pages watching, each with the last event id its snapshot already held. */
  const monitors = new Map<Send, { seen: number }>();
  const openStreams = new Set<() => void>();
  const reportedUnknown = new Set<number>();
  const history: FeedEvent[] = [];
  let unsentEvents: FeedEvent[] = [];
  let nextEventId = 1;
  let nextConnectionId = MAIN_CONNECTION;
  let capture: WriteStream | null = null;

  function record(event: FeedEventBody, at = Date.now()) {
    if (onEvent && event.type !== "packet") onEvent(event, at);
    const entry = { ...event, id: nextEventId++, at } as FeedEvent;
    history.push(entry);
    if (history.length > EVENT_HISTORY) history.shift();
    if (monitors.size > 0) unsentEvents.push(entry);
  }

  function log(message: string, connection?: Connection) {
    print(`${connection ? `${connection.name}: ` : ""}${message}`);
    record({ type: "log", message, connection: connection?.id });
  }

  function lastTickAt() {
    let latest: number | null = null;
    for (const connection of connections.values()) {
      if (connection.lastTickAt !== null) latest = Math.max(latest ?? 0, connection.lastTickAt);
    }
    return latest;
  }

  /** A tab's status is the most urgent state among the connections carrying its instruments. */
  function statusFor(client: Client) {
    const states: FeedState[] = [];
    for (const key of client.keys) {
      const line = lines.get(key);
      if (line) states.push(line.connection.state);
    }
    if (states.length === 0) states.push(main.state);
    const status =
      STATE_PRIORITY.map((name) => states.find((state) => state.state === name)).find(Boolean) ?? states[0];
    return sse("status", { ...status, lastTickAt: lastTickAt() });
  }

  function broadcastStatus() {
    for (const client of clients) client.send(statusFor(client));
  }

  function handlePacket(connection: Connection, packet: Packet, receivedAt: number) {
    connection.packets[packet.kind] = (connection.packets[packet.kind] ?? 0) + 1;
    record({ type: "packet", packet, connection: connection.id }, receivedAt);

    switch (packet.kind) {
      case "ticker":
      case "quote":
        connection.lastTickAt = receivedAt;
        update(packet.key, { ltp: roundPrice(packet.ltp), ltt: packet.ltt }, receivedAt);
        break;
      case "prevClose":
        update(packet.key, { prevClose: roundPrice(packet.prevClose) }, receivedAt);
        break;
      case "disconnect":
        log(`Dhan sent disconnect code ${packet.reason}`, connection);
        break;
      case "unknown":
        if (!reportedUnknown.has(packet.code)) {
          reportedUnknown.add(packet.code);
          log(`unparsed packet code ${packet.code} (${packet.length} bytes${packet.key ? `, ${packet.key}` : ""})`, connection);
        }
        break;
    }
  }

  function update(key: string, patch: Omit<Quote, "at">, at: number) {
    if (!lines.has(key)) return;
    quotes.set(key, { ...quotes.get(key), ...patch, at });
    dirty.add(key);
  }

  function handleFrame(connection: Connection, frame: ArrayBuffer, receivedAt: number) {
    connection.frames += 1;
    connection.bytes += frame.byteLength;
    onFrame?.(connection.id, frame, receivedAt);
    if (!captureDir) return;
    if (!capture) {
      mkdirSync(captureDir, { recursive: true });
      const day = new Date(receivedAt).toISOString().slice(0, 10);
      capture = createWriteStream(path.join(captureDir, `${day}.jsonl`), { flags: "a" });
    }
    capture.write(`${JSON.stringify({ t: receivedAt, c: connection.id, hex: Buffer.from(frame).toString("hex") })}\n`);
  }

  function openConnection(name: string): Connection {
    const id = nextConnectionId++;
    const connection: Connection = {
      id,
      name,
      createdAt: Date.now(),
      state: { state: "idle" },
      lastTickAt: null,
      frames: 0,
      bytes: 0,
      packets: {},
      // The callbacks below only run after createDhanFeed returns, once `connection` exists.
      feed: createDhanFeed({
        readCredentials() {
          const credentials = readCredentials();
          connection.tokenAtLastConnect = credentials.accessToken;
          return credentials;
        },
        onPacket: (packet, at) => handlePacket(connection, packet, at),
        onState(next) {
          connection.state = next;
          if (next.state === "stopped") connection.tokenAtStop = connection.tokenAtLastConnect;
          log(describeState(next), connection);
          record({ type: "state", state: next, connection: connection.id });
          broadcastStatus();
        },
        onFrame: (frame, at) => handleFrame(connection, frame, at),
        log: (message) => log(message, connection),
        openSocket,
      }),
    };
    connections.set(id, connection);
    return connection;
  }

  const main = openConnection("Main");

  function countOn(connection: Connection) {
    let count = 0;
    for (const line of lines.values()) if (line.connection === connection) count += 1;
    return count;
  }

  function label(key: string) {
    return lines.get(key)?.name ?? key;
  }

  function subscribe(connection: Connection, instruments: Instrument[], mode: FeedMode = "ticker") {
    if (instruments.length === 0) return;
    record({ type: "subscribe", keys: instruments.map(instrumentKey), mode, connection: connection.id });
    connection.feed.subscribe(instruments, mode);
  }

  /** Subscribes lines on a connection, one call per mode. */
  function subscribeLines(connection: Connection, moving: Line[]) {
    const byMode = new Map<FeedMode, Instrument[]>();
    for (const line of moving) byMode.set(line.mode, [...(byMode.get(line.mode) ?? []), line.instrument]);
    for (const [mode, instruments] of byMode) subscribe(connection, instruments, mode);
  }

  const wanted = (line: Line) => line.tabs > 0 || line.pinned;

  function cancelRelease(line: Line) {
    clearTimeout(line.releaseTimer);
    line.releaseTimer = undefined;
    line.releaseAt = null;
  }

  // A short grace period keeps moving between sections from churning Dhan subscriptions.
  function scheduleRelease(line: Line) {
    cancelRelease(line);
    line.releaseAt = Date.now() + UNSUBSCRIBE_GRACE_MS;
    line.releaseTimer = setTimeout(() => drop([line]), UNSUBSCRIBE_GRACE_MS);
  }

  /** Unsubscribes lines nobody wants any more. */
  function drop(candidates: Line[]) {
    const byConnection = new Map<Connection, Instrument[]>();
    for (const line of candidates) {
      const key = instrumentKey(line.instrument);
      if (lines.get(key) !== line || wanted(line)) continue;
      cancelRelease(line);
      lines.delete(key);
      quotes.delete(key);
      dirty.delete(key);
      byConnection.set(line.connection, [...(byConnection.get(line.connection) ?? []), line.instrument]);
    }
    for (const [connection, instruments] of byConnection) {
      record({ type: "unsubscribe", keys: instruments.map(instrumentKey), connection: connection.id });
      connection.feed.unsubscribe(instruments);
    }
  }

  // A stopped connection stays stopped until the token changes, so acting on the page after
  // renewing DHAN_ACCESS_TOKEN reconnects without restarting the server.
  function retryStopped() {
    const token = currentToken()?.trim();
    for (const connection of connections.values()) {
      if (connection.state.state === "stopped" && token !== connection.tokenAtStop) {
        log("access token changed; reconnecting", connection);
        connection.feed.reload();
      }
    }
  }

  /**
   * A browser tab (or the engine's always-on universe) started showing these instruments, in
   * `mode`. New ones go on Main. One already subscribed in a poorer mode is upgraded.
   */
  function acquire(instruments: Instrument[], mode: FeedMode = "ticker") {
    const added: Instrument[] = [];
    const upgraded: Line[] = [];
    let onMain = countOn(main);
    for (const instrument of instruments) {
      const key = instrumentKey(instrument);
      const line = lines.get(key);
      if (line) {
        cancelRelease(line);
        line.tabs += 1;
        if (MODE_RANK[mode] > MODE_RANK[line.mode]) {
          line.mode = mode;
          upgraded.push(line);
        }
        continue;
      }
      if (onMain >= MAX_INSTRUMENTS_PER_CONNECTION) {
        log(`full (${MAX_INSTRUMENTS_PER_CONNECTION} instruments); not subscribing ${key}`, main);
        continue;
      }
      lines.set(key, { instrument, connection: main, mode, name: null, tabs: 1, pinned: false, releaseAt: null });
      onMain += 1;
      added.push(instrument);
    }
    subscribe(main, added, mode);
    const upgradedByConnection = new Map<Connection, Line[]>();
    for (const line of upgraded) upgradedByConnection.set(line.connection, [...(upgradedByConnection.get(line.connection) ?? []), line]);
    for (const [connection, moving] of upgradedByConnection) subscribeLines(connection, moving);
    retryStopped();
  }

  function release(instruments: Instrument[]) {
    for (const instrument of instruments) {
      const line = lines.get(instrumentKey(instrument));
      if (!line || line.tabs === 0) continue;
      line.tabs -= 1;
      if (!wanted(line)) scheduleRelease(line);
    }
  }

  /** Adds an instrument from the Live Feed page; it stays subscribed until removed there. */
  function pin(request: PinRequest): FeedActionResult {
    const instrument = parseInstrumentKey(request.key.trim().toUpperCase());
    if (!instrument) {
      return fail(`"${request.key}" isn't an instrument. Pick one from the list, or type SEGMENT:SECURITY_ID such as NSE_EQ:2885.`);
    }
    const key = instrumentKey(instrument);
    const name = cleanName(request.name);
    const existing = lines.get(key);

    if (existing && existing.connection.id !== request.connection) {
      return fail(
        `${name ?? label(key)} already streams on ${existing.connection.name}. ` +
          "An instrument streams on one connection at a time.",
      );
    }

    let target: Connection | undefined;
    if (request.connection === "new") {
      if (connections.size >= MAX_CONNECTIONS) {
        return fail(`Dhan allows ${MAX_CONNECTIONS} connections per account, and all ${MAX_CONNECTIONS} are in use.`);
      }
      target = openConnection(cleanName(request.connectionName) ?? `Connection ${nextConnectionId}`);
      log("created from the Live Feed page", target);
    } else {
      target = connections.get(request.connection);
      if (!target) return fail("That connection has been closed. Pick another one.");
    }

    if (existing) {
      existing.pinned = true;
      if (name) existing.name = name;
      cancelRelease(existing);
      return ok(`${label(key)} was already on ${target.name}. It now stays subscribed until you remove it.`);
    }

    if (countOn(target) >= MAX_INSTRUMENTS_PER_CONNECTION) {
      return fail(`${target.name} already has ${MAX_INSTRUMENTS_PER_CONNECTION} instruments, Dhan's limit per connection.`);
    }

    lines.set(key, { instrument, connection: target, mode: "ticker", name, tabs: 0, pinned: true, releaseAt: null });
    subscribe(target, [instrument]);
    retryStopped();
    return ok(`Added ${name ?? key} to ${target.name}.`);
  }

  function unpin(rawKey: string): FeedActionResult {
    const line = lines.get(rawKey);
    if (!line?.pinned) return fail("That instrument isn't on your list any more.");
    line.pinned = false;
    if (line.tabs > 0) {
      return ok(`Removed ${label(rawKey)}. It stays subscribed while ${plural(line.tabs, "browser tab")} show it.`);
    }
    const name = label(rawKey);
    drop([line]);
    return ok(`Unsubscribed ${name}.`);
  }

  /** Closes a connection the page opened. Instruments app pages still show move to Main. */
  function closeConnection(id: number): FeedActionResult {
    if (id === main.id) return fail("Main carries the prices app pages show, so it can't be closed.");
    const connection = connections.get(id);
    if (!connection) return fail("That connection is already closed.");

    const moved: Line[] = [];
    const removed: string[] = [];
    for (const [key, line] of lines) {
      if (line.connection !== connection) continue;
      cancelRelease(line);
      if (line.tabs > 0) {
        line.connection = main;
        line.pinned = false;
        moved.push(line);
      } else {
        lines.delete(key);
        quotes.delete(key);
        dirty.delete(key);
        removed.push(key);
      }
    }

    connections.delete(id);
    if (removed.length > 0) record({ type: "unsubscribe", keys: removed, connection: id });
    connection.feed.shutdown();
    log("closed from the Live Feed page", connection);
    subscribeLines(main, moved);
    return ok(
      `Closed ${connection.name}.` +
        (moved.length > 0 ? ` ${plural(moved.length, "instrument")} that open pages show moved to Main.` : ""),
    );
  }

  function health(): FeedHealth {
    const counts = new Map<Connection, number>();
    for (const line of lines.values()) counts.set(line.connection, (counts.get(line.connection) ?? 0) + 1);

    const connectionList: FeedConnection[] = [...connections.values()].map((connection) => ({
      id: connection.id,
      name: connection.name,
      main: connection === main,
      feed: connection.state,
      createdAt: connection.createdAt,
      lastTickAt: connection.lastTickAt,
      instruments: counts.get(connection) ?? 0,
      frames: connection.frames,
      bytes: connection.bytes,
      packets: { ...connection.packets },
    }));

    const instruments: FeedInstrument[] = [...lines]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, line]) => ({
        key,
        name: line.name,
        connection: line.connection.id,
        mode: line.mode,
        tabs: line.tabs,
        pinned: line.pinned,
        releaseAt: line.releaseAt,
        quote: quotes.get(key) ?? null,
      }));

    return {
      startedAt,
      lastTickAt: lastTickAt(),
      quoteStreams: clients.size,
      monitors: monitors.size,
      capture: Boolean(captureDir),
      connections: connectionList,
      instruments,
    };
  }

  const flushTimer = setInterval(() => {
    if (unsentEvents.length > 0) {
      const events = unsentEvents.slice(-MAX_EVENTS_PER_FLUSH);
      unsentEvents = [];
      const batch = sse("events", events);
      for (const [send, monitor] of monitors) {
        // A page that joined since these events were recorded got some of them in its snapshot.
        if (monitor.seen < events[0].id) send(batch);
        else {
          const fresh = events.filter((event) => event.id > monitor.seen);
          if (fresh.length > 0) send(sse("events", fresh));
        }
        monitor.seen = 0;
      }
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
    for (const send of monitors.keys()) send(payload);
  }, HEALTH_MS);

  flushTimer.unref?.();
  healthTimer.unref?.();

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
      send(statusFor(client));

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
      monitors.set(send, { seen: history.at(-1)?.id ?? 0 });
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
    for (const line of lines.values()) cancelRelease(line);
    for (const close of [...openStreams]) close();
    for (const connection of connections.values()) connection.feed.shutdown();
    capture?.end();
  }

  log(`ready${captureDir ? ", recording raw frames" : ""}; connects to Dhan when the first instrument is subscribed`);
  return { stream, monitor, pin, unpin, closeConnection, health, acquire, release, retryStopped, shutdown };
}

export type FeedHub = ReturnType<typeof createFeedHub>;
