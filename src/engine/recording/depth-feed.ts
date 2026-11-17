// One connection to Dhan's 20-level depth feed. It holds the instruments the recorder asks for,
// reconnects with backoff like the main feed, and hands every raw frame to the depth journal.
//
// Dhan documents no unsubscribe for this feed, so removing an instrument reconnects with the
// new list. The recorder only adds during a session, so that happens once a day at most.

import type { Credentials, FeedSocket, FeedState } from "../../lib/live/feed/dhan-feed.ts";
import {
  DEPTH_MAX_INSTRUMENTS,
  DEPTH_REQUEST,
  DEPTH_SEGMENTS,
  depthFeedUrl,
  depthSubscribeMessages,
  parseDepthFrame,
} from "../../lib/live/feed/depth-packets.ts";
import { instrumentKey, type Instrument } from "../../lib/live/feed/packets.ts";

const SOCKET_OPEN = 1;
const AUTH_ERROR_CODES = new Set([807, 808, 809, 810]);
const TOO_MANY_CONNECTIONS = 805;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const RATE_LIMIT_PAUSE_MS = 60_000;

export interface DepthFeedStatus {
  state: FeedState;
  instruments: number;
  frames: number;
  /** Bid and ask packets received by this engine run. */
  packets: number;
  lastFrameAt: number | null;
  /** Instruments asked for beyond the connection's limit, or outside NSE. */
  dropped: number;
}

export interface DepthFeed {
  /** Makes the connection carry exactly these instruments (NSE only, at most 50). */
  set(instruments: readonly Instrument[]): void;
  status(): DepthFeedStatus;
  /** Reconnects a connection stopped by a rejected token, once the token has changed. */
  retryStopped(): void;
  shutdown(): void;
}

export function createDepthFeed({
  readCredentials,
  currentToken,
  onFrame,
  onEvent,
  log,
  openSocket = (url) => new WebSocket(url) as unknown as FeedSocket,
  random = Math.random,
  now = Date.now,
}: {
  readCredentials: () => Credentials;
  currentToken: () => string | undefined;
  onFrame: (frame: ArrayBuffer, receivedAt: number) => void;
  /** State changes and subscriptions, for the depth journal. */
  onEvent?: (kind: "state" | "subscribe", data: Record<string, unknown>, at: number) => void;
  log: (message: string) => void;
  openSocket?: (url: string) => FeedSocket;
  random?: () => number;
  now?: () => number;
}): DepthFeed {
  let wanted = new Map<string, Instrument>();
  /** What the open socket has been sent. */
  const sent = new Set<string>();
  let socket: FeedSocket | null = null;
  let state: FeedState = { state: "idle" };
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let tokenAtStop: string | undefined;
  let frames = 0;
  let packets = 0;
  let lastFrameAt: number | null = null;
  let dropped = 0;

  function setState(next: FeedState) {
    const quiet = next.state === "idle" && state.state === "idle";
    state = next;
    if (!quiet) onEvent?.("state", { state: next }, now());
  }

  function sendNew() {
    if (socket?.readyState !== SOCKET_OPEN) return;
    const fresh = [...wanted.values()].filter((instrument) => !sent.has(instrumentKey(instrument)));
    if (fresh.length === 0) return;
    for (const message of depthSubscribeMessages(fresh)) socket.send(message);
    for (const instrument of fresh) sent.add(instrumentKey(instrument));
    onEvent?.("subscribe", { instruments: fresh.map(instrumentKey) }, now());
  }

  function connect() {
    if (socket || wanted.size === 0 || retryTimer) return;
    let credentials: Credentials;
    try {
      credentials = readCredentials();
    } catch (error) {
      tokenAtStop = currentToken();
      setState({ state: "stopped", reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    attempt += 1;
    setState({ state: "connecting", attempt });
    const ws = openSocket(depthFeedUrl(credentials.clientId, credentials.accessToken));
    ws.binaryType = "arraybuffer";
    socket = ws;
    sent.clear();
    let disconnectReason: number | null = null;

    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      attempt = 0;
      setState({ state: "live", since: now() });
      sendNew();
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      if (socket !== ws) return;
      const receivedAt = now();
      if (!(event.data instanceof ArrayBuffer)) {
        log(`text message from Dhan's depth feed: ${String(event.data).slice(0, 200)}`);
        return;
      }
      frames += 1;
      lastFrameAt = receivedAt;
      onFrame(event.data, receivedAt);
      for (const packet of parseDepthFrame(event.data)) {
        if (packet.kind === "depth") packets += 1;
        else if (packet.kind === "disconnect") disconnectReason = packet.reason;
      }
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      if (socket !== ws) return;
      socket = null;
      sent.clear();
      const why = disconnectReason === null ? `socket closed (${event.code}${event.reason ? `, ${event.reason}` : ""})` : `Dhan disconnect ${disconnectReason}`;
      afterClose(disconnectReason, why);
    });
    ws.addEventListener("error", () => {});
  }

  function afterClose(reason: number | null, why: string) {
    if (reason !== null && AUTH_ERROR_CODES.has(reason)) {
      tokenAtStop = currentToken();
      setState({ state: "stopped", reason: `${why}: access token rejected` });
      return;
    }
    if (wanted.size === 0) {
      setState({ state: "idle" });
      return;
    }
    let delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempt, 5)) * (0.75 + random() * 0.5);
    if (reason === TOO_MANY_CONNECTIONS) delay = Math.max(delay, RATE_LIMIT_PAUSE_MS);
    delay = Math.round(delay);
    log(`depth feed: ${why}; reconnecting in ${Math.round(delay / 1000)}s`);
    setState({ state: "reconnecting", attempt: attempt + 1, retryAt: now() + delay, reason: why });
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, delay);
  }

  function closeSocket() {
    const ws = socket;
    socket = null;
    sent.clear();
    if (!ws) return;
    if (ws.readyState === SOCKET_OPEN) ws.send(JSON.stringify({ RequestCode: DEPTH_REQUEST.disconnect }));
    ws.close();
  }

  return {
    set(instruments) {
      const next = new Map<string, Instrument>();
      dropped = 0;
      for (const instrument of instruments) {
        if (!DEPTH_SEGMENTS.has(instrument.segment) || next.size >= DEPTH_MAX_INSTRUMENTS) {
          dropped += 1;
          continue;
        }
        next.set(instrumentKey(instrument), instrument);
      }
      const removed = [...wanted.keys()].some((key) => !next.has(key));
      wanted = next;

      if (wanted.size === 0) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
        if (socket) {
          closeSocket();
          log("depth feed: nothing to record; disconnected");
        }
        if (state.state !== "idle" && state.state !== "stopped") setState({ state: "idle" });
        return;
      }
      if (state.state === "stopped") return;
      if (removed && socket) {
        // No documented unsubscribe: start over with the new list.
        closeSocket();
        connect();
      } else if (socket) sendNew();
      else connect();
    },

    status: () => ({ state, instruments: wanted.size, frames, packets, lastFrameAt, dropped }),

    retryStopped() {
      if (state.state !== "stopped" || currentToken() === tokenAtStop) return;
      attempt = 0;
      setState({ state: "idle" });
      connect();
    },

    shutdown() {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      wanted = new Map();
      closeSocket();
      setState({ state: "idle" });
    },
  };
}
