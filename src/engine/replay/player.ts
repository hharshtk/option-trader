// Plays a recorded day back through a stand-in for Dhan's market feed WebSocket. The feed code
// opens it exactly as it opens Dhan (`openSocket`), sends the same subscribe, unsubscribe and
// disconnect requests, and receives binary frames in Dhan's wire format, so everything downstream
// (hub, quote streams, Live Feed page) runs unchanged.
//
// What it mimics:
//   - Frames arrive at their recorded pace, scaled by `speed`.
//   - A socket receives only the instruments it subscribed, in the mode it asked for. A packet
//     recorded in a richer mode is cut down (Quote or Full to a Ticker, Full to a Quote); one
//     recorded in a poorer mode is sent as it is, since the missing fields were never recorded.
//   - Subscribing sends the instrument's latest state at once, as Dhan's subscribe snapshot does:
//     its last price packet, and in Ticker mode its previous close.
//   - Previous-close packets go to Ticker subscriptions only, and OI packets to Quote and Full
//     only, matching what Dhan was seen to send.
//   - Instruments with nothing recorded stay silent, like an instrument that doesn't trade.
//
// Time: the feed stamps frames with the wall clock when they arrive, as live. `toRecorded` maps
// such a stamp back to recorded time: exactly, from the frame delivered in that millisecond, or
// from the replay's timeline (play, pause, speed, seek) for anything else. The engine uses it to
// show recorded times on the web during a replay, without the live feed code knowing.

import type { ReplayClock } from "../../lib/engine/protocol.ts";

import type { FeedSocket } from "../../lib/live/feed/dhan-feed.ts";
import { MODE_RANK, packetSizeAt, REQUEST_CODE, segmentByCode, type FeedMode } from "../../lib/live/feed/packets.ts";
import { REPLAY_MAX_SPEED, REPLAY_MIN_SPEED } from "../../lib/engine/protocol.ts";
import type { Recording } from "./recording.ts";

const PACKET_HEADER_BYTES = 8;
const CODE = { ticker: 2, oi: 5, prevClose: 6, quote: 4, full: 8, disconnect: 50 } as const;
/** The subscription mode each price packet carries. Code 1 (index) is read as a ticker. */
const PRICE_RANK: Record<number, number> = { 1: 0, 2: 0, 4: 1, 8: 2 };
const SUBSCRIBE_MODES = new Map<number, FeedMode>([
  [REQUEST_CODE.subscribeTicker, "ticker"],
  [REQUEST_CODE.subscribeQuote, "quote"],
  [REQUEST_CODE.subscribeFull, "full"],
]);
const UNSUBSCRIBE_CODES = new Set<number>([
  REQUEST_CODE.unsubscribeTicker,
  REQUEST_CODE.unsubscribeQuote,
  REQUEST_CODE.unsubscribeFull,
]);

/** Frames delivered in one turn before yielding, so a fast replay never stalls the engine. */
const BATCH_FRAMES = 2_000;
/** Longest wait between checks, so speed and pause changes and clock jumps take effect quickly. */
const MAX_WAIT_MS = 1_000;
/** Wall-clock milliseconds whose delivered frame is remembered for exact retiming. */
const RECENT_DELIVERIES = 50_000;
const MAX_SEGMENTS = 1_000;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export interface ReplayTimers {
  set(fire: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: ReplayTimers = {
  set: (fire, ms) => setTimeout(fire, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ReplayPlayerOptions {
  recording: Recording;
  /** Wall clock, ms. */
  now: () => number;
  /** Recorded time to start at; defaults to the first frame. */
  from?: number;
  speed?: number;
  log?: (message: string) => void;
  timers?: ReplayTimers;
  /** Called once each time the replay reaches the end of the file. */
  onEnd?: () => void;
}

export type ReplayState = "playing" | "paused" | "ended";

export interface ReplayPlayer {
  /** Pass to the feed as its `openSocket`. */
  openSocket(url: string): FeedSocket;
  play(): void;
  pause(): void;
  setSpeed(speed: number): void;
  /** Jumps to a recorded time and sends every subscribed instrument's state at that time. */
  seek(time: number): void;
  /** The recorded time matching a wall-clock stamp the feed made during this replay. */
  toRecorded(wall: number): number;
  /** The replay's clock as browsers need it: recorded time now, rate (0 unless playing), day. */
  reading(): ReplayClock;
  status(): {
    state: ReplayState;
    speed: number;
    at: number;
    startAt: number;
    endAt: number;
    frames: number;
    totalFrames: number;
    sockets: number;
  };
  /** Stops playing and closes every socket. */
  shutdown(): void;
}

interface Span {
  start: number;
  end: number;
  code: number;
  key: string | null;
}

interface ReplaySocket {
  readyState: number;
  subscriptions: Map<string, FeedMode>;
  emit(packets: Uint8Array[]): void;
  close(code?: number, reason?: string): void;
}

export function clampSpeed(speed: number) {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(REPLAY_MAX_SPEED, Math.max(REPLAY_MIN_SPEED, speed));
}

/** Splits a frame into its packets. Bytes that don't form a whole packet are dropped. */
export function splitFrame(bytes: Uint8Array): Span[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const spans: Span[] = [];
  let offset = 0;
  while (offset + PACKET_HEADER_BYTES <= view.byteLength) {
    const size = packetSizeAt(view, offset);
    if (size < PACKET_HEADER_BYTES || offset + size > view.byteLength) break;
    const code = view.getUint8(offset);
    const segment = segmentByCode(view.getUint8(offset + 3));
    const key = code !== CODE.disconnect && segment ? `${segment}:${view.getInt32(offset + 4, true)}` : null;
    spans.push({ start: offset, end: offset + size, code, key });
    offset += size;
  }
  return spans;
}

/** A Ticker packet (code 2) from a Quote or Full packet: same header, last price and time. */
function toTicker(packet: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  out.set(packet.subarray(0, PACKET_HEADER_BYTES));
  out.set(packet.subarray(8, 12), 8); // LTP, f32
  out.set(packet.subarray(14, 18), 12); // LTT, i32
  out[0] = CODE.ticker;
  new DataView(out.buffer).setInt16(1, out.length, true);
  return out;
}

/** A Quote packet (code 4) from a Full packet: the shared fields, then day OHLC from its later offset. */
function fullToQuote(packet: Uint8Array): Uint8Array {
  const out = new Uint8Array(50);
  out.set(packet.subarray(0, 34)); // header, LTP, LTQ, LTT, ATP, volume, sell and buy quantity
  out.set(packet.subarray(46, 62), 34); // open, close, high, low
  out[0] = CODE.quote;
  new DataView(out.buffer).setInt16(1, out.length, true);
  return out;
}

/** The packet as a subscription in `mode` would receive it, or null when it wouldn't. */
function shape(packet: Uint8Array, code: number, mode: FeedMode): Uint8Array | null {
  const rank = PRICE_RANK[code];
  if (rank === undefined) {
    if (code === CODE.prevClose) return mode === "ticker" ? packet : null;
    if (code === CODE.oi) return mode === "ticker" ? null : packet;
    return packet;
  }
  if (rank <= MODE_RANK[mode]) return packet;
  return mode === "ticker" ? toTicker(packet) : fullToQuote(packet);
}

export function createReplayPlayer(options: ReplayPlayerOptions): ReplayPlayer {
  const { recording, now, log = () => {}, timers = DEFAULT_TIMERS, onEnd } = options;
  const { times, count, startAt, endAt } = recording;
  const sockets = new Set<ReplaySocket>();
  // The latest packets per instrument up to the position: what a subscribe snapshot sends.
  const lastPrice = new Map<string, Uint8Array>();
  const prevClose = new Map<string, Uint8Array>();
  const oi = new Map<string, Uint8Array>();

  let speed = clampSpeed(options.speed ?? 1);
  let state: ReplayState = "paused";
  let index = 0;
  let position = startAt;
  // While playing, position = anchorAt + (now - anchorWall) × speed.
  let anchorAt = startAt;
  let anchorWall = 0;
  let timer: unknown = null;
  let stopped = false;
  /** Wall ms → recorded time of the last frame delivered in that millisecond. */
  const recent = new Map<number, number>();
  /** From each wall time on, recorded time = at + (wall − segment.wall) × rate. */
  const timeline: { wall: number; at: number; rate: number }[] = [];

  /** Notes a change of position, speed or state on the timeline. */
  function mark() {
    timeline.push({ wall: now(), at: position, rate: state === "playing" ? speed : 0 });
    if (timeline.length > MAX_SEGMENTS) timeline.shift();
  }

  function toRecorded(wall: number) {
    const exact = recent.get(wall);
    if (exact !== undefined) return exact;
    let segment = timeline[0];
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      if (timeline[i].wall <= wall) {
        segment = timeline[i];
        break;
      }
    }
    if (!segment) return position;
    return Math.min(endAt, segment.at + Math.max(0, wall - segment.wall) * segment.rate);
  }

  function remember(bytes: Uint8Array, span: Span) {
    if (span.key === null) return;
    const packet = bytes.subarray(span.start, span.end);
    if (PRICE_RANK[span.code] !== undefined) lastPrice.set(span.key, packet);
    else if (span.code === CODE.prevClose) prevClose.set(span.key, packet);
    else if (span.code === CODE.oi) oi.set(span.key, packet);
  }

  function deliver(frameIndex: number) {
    const bytes = recording.frame(frameIndex);
    const spans = splitFrame(bytes);
    for (const span of spans) remember(bytes, span);
    // The feed stamps this frame with the wall clock as it arrives, in this same millisecond.
    recent.set(now(), times[frameIndex]);
    if (recent.size > RECENT_DELIVERIES) recent.delete(recent.keys().next().value!);
    for (const socket of sockets) {
      if (socket.readyState !== OPEN || socket.subscriptions.size === 0) continue;
      const packets: Uint8Array[] = [];
      for (const span of spans) {
        if (span.code === CODE.disconnect) continue;
        const packet = bytes.subarray(span.start, span.end);
        if (span.key === null) {
          packets.push(packet);
          continue;
        }
        const mode = socket.subscriptions.get(span.key);
        const shaped = mode && shape(packet, span.code, mode);
        if (shaped) packets.push(shaped);
      }
      if (packets.length > 0) socket.emit(packets);
    }
  }

  /** Sends each instrument's latest state to a socket, as Dhan does on subscribe. */
  function snapshot(socket: ReplaySocket, keys: Iterable<string>) {
    if (socket.readyState !== OPEN) return;
    const packets: Uint8Array[] = [];
    let wanted = 0;
    let silent = 0;
    for (const key of keys) {
      const mode = socket.subscriptions.get(key);
      if (!mode) continue;
      wanted += 1;
      const price = lastPrice.get(key);
      if (!price) silent += 1;
      for (const packet of [prevClose.get(key), oi.get(key), price]) {
        const shaped = packet && shape(packet, packet[0], mode);
        if (shaped) packets.push(shaped);
      }
    }
    if (packets.length > 0) socket.emit(packets);
    if (silent > 0) log(`${silent} of ${wanted} subscribed instruments have no recorded price yet at this point`);
  }

  function positionNow() {
    if (state !== "playing") return position;
    return Math.min(endAt, anchorAt + (now() - anchorWall) * speed);
  }

  function schedule(ms: number) {
    if (timer !== null) timers.clear(timer);
    timer = timers.set(pump, ms);
  }

  function cancel() {
    if (timer !== null) timers.clear(timer);
    timer = null;
  }

  function pump() {
    timer = null;
    if (state !== "playing" || stopped) return;
    const target = anchorAt + (now() - anchorWall) * speed;
    let sent = 0;
    while (index < count && times[index] <= target && sent < BATCH_FRAMES) {
      deliver(index);
      index += 1;
      sent += 1;
    }
    if (index >= count) {
      state = "ended";
      position = endAt;
      mark();
      log("reached the end of the recording");
      onEnd?.();
      return;
    }
    if (sent === BATCH_FRAMES) {
      schedule(0);
      return;
    }
    schedule(Math.min(MAX_WAIT_MS, Math.max(0, (times[index] - target) / speed)));
  }

  function seek(time: number) {
    const target = Math.min(endAt, Math.max(startAt, time));
    // Going back replays the state from the start of the file.
    if (index > 0 && target < times[index - 1]) {
      index = 0;
      lastPrice.clear();
      prevClose.clear();
      oi.clear();
    }
    while (index < count && times[index] <= target) {
      const bytes = recording.frame(index);
      for (const span of splitFrame(bytes)) remember(bytes, span);
      index += 1;
    }
    position = anchorAt = target;
    anchorWall = now();
    if (state === "ended" && index < count) state = "paused";
    mark();
    for (const socket of sockets) snapshot(socket, socket.subscriptions.keys());
    if (state === "playing") schedule(0);
  }

  function openSocket(): FeedSocket {
    const listeners: Record<string, ((event: unknown) => void)[]> = { open: [], message: [], close: [], error: [] };
    const fire = (type: string, event: unknown) => {
      for (const listener of listeners[type]) listener(event);
    };

    const socket: ReplaySocket & FeedSocket = {
      binaryType: "arraybuffer",
      readyState: CONNECTING,
      subscriptions: new Map(),

      emit(packets) {
        if (socket.readyState !== OPEN) return;
        let length = 0;
        for (const packet of packets) length += packet.length;
        const frame = new Uint8Array(length);
        let offset = 0;
        for (const packet of packets) {
          frame.set(packet, offset);
          offset += packet.length;
        }
        fire("message", { data: frame.buffer });
      },

      send(data: string) {
        if (socket.readyState !== OPEN) return;
        let request: { RequestCode?: unknown; InstrumentList?: { ExchangeSegment?: unknown; SecurityId?: unknown }[] };
        try {
          request = JSON.parse(data);
        } catch {
          log(`ignored a request that isn't JSON: ${data.slice(0, 80)}`);
          return;
        }
        const code = Number(request.RequestCode);
        if (code === REQUEST_CODE.disconnect) {
          socket.close(1000, "disconnect requested");
          return;
        }
        const keys = (request.InstrumentList ?? []).map((item) => `${item.ExchangeSegment}:${item.SecurityId}`);
        const mode = SUBSCRIBE_MODES.get(code);
        if (mode) {
          const added = keys.filter((key) => socket.subscriptions.get(key) !== mode);
          for (const key of added) socket.subscriptions.set(key, mode);
          // Dhan answers a subscribe with a snapshot shortly after, over the network.
          if (added.length > 0) timers.set(() => snapshot(socket, added), 0);
        } else if (UNSUBSCRIBE_CODES.has(code)) {
          for (const key of keys) socket.subscriptions.delete(key);
        } else {
          log(`ignored request code ${code}`);
        }
      },

      close(code = 1000, reason = "") {
        if (socket.readyState === CLOSING || socket.readyState === CLOSED) return;
        socket.readyState = CLOSING;
        sockets.delete(socket);
        timers.set(() => {
          socket.readyState = CLOSED;
          fire("close", { code, reason, wasClean: true });
        }, 0);
      },

      addEventListener(type, listener) {
        listeners[type]?.push(listener as (event: unknown) => void);
      },
    };

    // Connects on the next turn, after the caller has attached its listeners, as a real socket would.
    timers.set(() => {
      if (socket.readyState !== CONNECTING) return;
      if (stopped) {
        socket.close(1001, "replay stopped");
        return;
      }
      socket.readyState = OPEN;
      sockets.add(socket);
      fire("open", {});
    }, 0);
    return socket;
  }

  seek(options.from ?? startAt);

  return {
    openSocket,
    play() {
      if (stopped || state === "playing") return;
      if (state === "ended") seek(startAt);
      anchorAt = position;
      anchorWall = now();
      state = "playing";
      mark();
      schedule(0);
    },
    pause() {
      if (state !== "playing") return;
      position = positionNow();
      state = "paused";
      mark();
      cancel();
    },
    setSpeed(next) {
      const at = positionNow();
      speed = clampSpeed(next);
      anchorAt = position = at;
      anchorWall = now();
      mark();
      if (state === "playing") schedule(0);
    },
    seek,
    toRecorded,
    reading: () => ({ now: positionNow(), rate: state === "playing" ? speed : 0, replay: recording.date }),
    status: () => ({
      state,
      speed,
      at: positionNow(),
      startAt,
      endAt,
      frames: index,
      totalFrames: count,
      sockets: sockets.size,
    }),
    shutdown() {
      stopped = true;
      cancel();
      if (state === "playing") {
        position = positionNow();
        state = "paused";
      }
      for (const socket of [...sockets]) socket.close(1001, "replay stopped");
    },
  };
}
