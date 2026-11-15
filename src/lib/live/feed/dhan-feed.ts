import {
  instrumentKey,
  parseFrame,
  REQUEST_CODE,
  SUBSCRIBE_CODE,
  subscriptionMessages,
  UNSUBSCRIBE_CODE,
  type FeedMode,
  type Instrument,
  type Packet,
} from "./packets.ts";

interface Subscription {
  instrument: Instrument;
  mode: FeedMode;
}

/** One subscribe (or unsubscribe) message set per mode, with that mode's request code. */
function messagesByMode(subscriptions: Iterable<Subscription>, codes: Record<FeedMode, number>): string[] {
  const groups = new Map<FeedMode, Instrument[]>();
  for (const { instrument, mode } of subscriptions) groups.set(mode, [...(groups.get(mode) ?? []), instrument]);
  return [...groups].flatMap(([mode, instruments]) => subscriptionMessages(codes[mode], instruments));
}

export type FeedState =
  | { state: "idle" }
  | { state: "connecting"; attempt: number }
  | { state: "live"; since: number }
  | { state: "reconnecting"; attempt: number; retryAt: number; reason: string }
  | { state: "stopped"; reason: string };

export interface FeedSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "message" | "error", listener: (event: never) => void): void;
}

export interface Credentials {
  clientId: string;
  accessToken: string;
}

export interface FeedOptions {
  readCredentials: () => Credentials;
  onPacket: (packet: Packet, receivedAt: number) => void;
  onState: (state: FeedState) => void;
  onFrame?: (frame: ArrayBuffer, receivedAt: number) => void;
  log: (message: string) => void;
  openSocket?: (url: string) => FeedSocket;
  random?: () => number;
}

const SOCKET_OPEN = 1;
const AUTH_ERROR_CODES = new Set([807, 808, 809, 810]);
const TOO_MANY_CONNECTIONS = 805;

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
export const RATE_LIMIT_PAUSE_MS = 60_000;
export const FAILING_PAUSE_MS = 5 * 60_000;
export const FAILURES_BEFORE_PAUSE = 5;
export const IDLE_DISCONNECT_MS = 5 * 60_000;

export function createDhanFeed({
  readCredentials,
  onPacket,
  onState,
  onFrame,
  log,
  openSocket = (url) => new WebSocket(url) as unknown as FeedSocket,
  random = Math.random,
}: FeedOptions) {
  const subscribed = new Map<string, Subscription>();
  let socket: FeedSocket | null = null;
  let state: FeedState = { state: "idle" };
  let attempt = 0;
  let failedHandshakes = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function setState(next: FeedState) {
    state = next;
    onState(next);
  }

  function send(messages: string[]) {
    if (socket?.readyState !== SOCKET_OPEN) return;
    for (const message of messages) socket.send(message);
  }

  function connect() {
    if (socket || subscribed.size === 0) return;

    let credentials: Credentials;
    try {
      credentials = readCredentials();
    } catch (error) {
      setState({ state: "stopped", reason: error instanceof Error ? error.message : String(error) });
      return;
    }

    attempt += 1;
    setState({ state: "connecting", attempt });

    // The token travels in the URL, so this URL must never be logged.
    const url =
      `wss://api-feed.dhan.co?version=2&token=${encodeURIComponent(credentials.accessToken)}` +
      `&clientId=${encodeURIComponent(credentials.clientId)}&authType=2`;
    const ws = openSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    let opened = false;
    let disconnectReason: number | null = null;

    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      attempt = 0;
      failedHandshakes = 0;
      setState({ state: "live", since: Date.now() });
      send(messagesByMode(subscribed.values(), SUBSCRIBE_CODE));
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      const receivedAt = Date.now();
      if (!(event.data instanceof ArrayBuffer)) {
        log(`text message from Dhan: ${String(event.data).slice(0, 200)}`);
        return;
      }
      onFrame?.(event.data, receivedAt);
      for (const packet of parseFrame(event.data)) {
        if (packet.kind === "disconnect") disconnectReason = packet.reason;
        onPacket(packet, receivedAt);
      }
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      if (socket !== ws) return;
      socket = null;
      if (!opened) failedHandshakes += 1;
      afterClose(
        disconnectReason,
        disconnectReason === null
          ? `socket closed (${event.code}${event.reason ? `, ${event.reason}` : ""})`
          : `Dhan disconnect ${disconnectReason}`,
      );
    });

    ws.addEventListener("error", () => {});
  }

  function afterClose(dhanReason: number | null, why: string) {
    if (dhanReason !== null && AUTH_ERROR_CODES.has(dhanReason)) {
      setState({ state: "stopped", reason: `${why}: access token rejected. Renew it in .env.local, then reload the page.` });
      return;
    }
    if (subscribed.size === 0) {
      setState({ state: "idle" });
      return;
    }

    let delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempt, 5));
    delay *= 0.75 + random() * 0.5;
    if (dhanReason === TOO_MANY_CONNECTIONS) delay = Math.max(delay, RATE_LIMIT_PAUSE_MS);
    if (failedHandshakes >= FAILURES_BEFORE_PAUSE) delay = Math.max(delay, FAILING_PAUSE_MS);
    delay = Math.round(delay);

    log(`${why}; reconnecting in ${Math.round(delay / 1000)}s`);
    setState({ state: "reconnecting", attempt: attempt + 1, retryAt: Date.now() + delay, reason: why });
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, delay);
  }

  function closeSocket() {
    const ws = socket;
    socket = null;
    if (!ws) return;
    if (ws.readyState === SOCKET_OPEN) ws.send(JSON.stringify({ RequestCode: REQUEST_CODE.disconnect }));
    ws.close();
  }

  return {
    /**
     * Subscribes instruments in a mode. An instrument already subscribed in another mode is
     * switched: unsubscribed from the old mode first, since Dhan doesn't document what a
     * second subscription in a different mode does.
     */
    subscribe(instruments: Instrument[], mode: FeedMode = "ticker") {
      const added: Subscription[] = [];
      const switched: Subscription[] = [];
      for (const instrument of instruments) {
        const key = instrumentKey(instrument);
        const existing = subscribed.get(key);
        if (existing?.mode === mode) continue;
        if (existing) switched.push(existing);
        const subscription = { instrument, mode };
        subscribed.set(key, subscription);
        added.push(subscription);
      }
      clearTimeout(idleTimer);
      idleTimer = undefined;

      if (state.state === "stopped" || retryTimer) return;
      if (socket) {
        send(messagesByMode(switched, UNSUBSCRIBE_CODE));
        send(messagesByMode(added, SUBSCRIBE_CODE));
      } else connect();
    },

    unsubscribe(instruments: Instrument[]) {
      const removed: Subscription[] = [];
      for (const instrument of instruments) {
        const key = instrumentKey(instrument);
        const existing = subscribed.get(key);
        if (!existing) continue;
        subscribed.delete(key);
        removed.push(existing);
      }
      send(messagesByMode(removed, UNSUBSCRIBE_CODE));
      if (subscribed.size === 0 && !idleTimer) {
        idleTimer = setTimeout(() => {
          idleTimer = undefined;
          if (subscribed.size > 0) return;
          clearTimeout(retryTimer);
          retryTimer = undefined;
          closeSocket();
          log("no subscribers; disconnected from Dhan");
          setState({ state: "idle" });
        }, IDLE_DISCONNECT_MS);
      }
    },

    reload() {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      closeSocket();
      attempt = 0;
      failedHandshakes = 0;
      setState({ state: "idle" });
      connect();
    },

    shutdown() {
      clearTimeout(retryTimer);
      clearTimeout(idleTimer);
      retryTimer = undefined;
      idleTimer = undefined;
      subscribed.clear();
      closeSocket();
      setState({ state: "idle" });
    },

    getState: () => state,
    subscriptionCount: () => subscribed.size,
    modeOf: (key: string): FeedMode | null => subscribed.get(key)?.mode ?? null,
  };
}

export type DhanFeed = ReturnType<typeof createDhanFeed>;
