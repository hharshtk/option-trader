// Indexes over the research recorder's side files, `<date>.depth.bin` (20-level books) and
// `<date>.chain.bin` (option chain snapshots), for looking things up as of a time: the replay at
// its position, and the per-minute series in the journal session (live and replayed alike).
// Both files hold few, large records, so they are indexed by walking record headers (about
// 0.2 s for 18 November's 2.3 GB depth file) and read back a record at a time. A file still
// being written is indexed again from where the last walk stopped.

import type { BookLevel, ChainSnapshot } from "../../lib/engine/protocol.ts";
import { parseDepthFrame } from "../../lib/live/feed/depth-packets.ts";
import { walkHeaders, type ByteSource } from "./byte-source.ts";
import { HEADER_BYTES, RecordType } from "./format.ts";

/** How far back a book is looked for: past this, a contract counts as having no book. */
export const BOOK_LOOKBACK_MS = 10 * 60_000;

export interface Book {
  /** When the newer of its bid and ask updates arrived. */
  at: number;
  /** Best first, levels with no orders left out. */
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface DepthIndex {
  /** Indexes what was written since the last call. */
  refresh(): Promise<void>;
  /** Receive time of the last frame indexed; 0 when none. */
  lastAt(): number;
  /** Contracts subscribed at or before `at`, in the order they were added. */
  keysAt(at: number): string[];
  /** The contract's latest bid and ask levels at or before `at`, looking back at most `lookbackMs`. */
  book(key: string, at: number, lookbackMs?: number): Book | null;
  close(): void;
}

export function createDepthIndex(source: ByteSource): DepthIndex {
  let capacity = 1024;
  let times = new Float64Array(capacity);
  let offsets = new Float64Array(capacity);
  let lengths = new Uint32Array(capacity);
  let count = 0;
  let last = 0;
  let walked: number | undefined;
  const subscribed: { at: number; keys: string[] }[] = [];

  return {
    async refresh() {
      walked = await walkHeaders(
        source,
        ({ type, recvTs, offset, payloadLength, head }) => {
          if (type === RecordType.control) {
            const control = JSON.parse(head.toString("utf8")) as { kind?: string; instruments?: unknown };
            if (control.kind === "subscribe" && Array.isArray(control.instruments)) subscribed.push({ at: recvTs, keys: control.instruments.map(String) });
            return;
          }
          if (count === capacity) {
            capacity *= 2;
            times = grow(times, capacity);
            offsets = grow(offsets, capacity);
            lengths = grow(lengths, capacity);
          }
          // Held from going back, so the times can be searched.
          last = Math.max(last, recvTs);
          times[count] = last;
          offsets[count] = offset + HEADER_BYTES;
          lengths[count] = payloadLength;
          count += 1;
        },
        { peek: (type) => (type === RecordType.control ? Infinity : 0), from: walked },
      );
    },
    lastAt: () => (count > 0 ? times[count - 1] : 0),
    keysAt(at) {
      const keys = new Set<string>();
      for (const s of subscribed) {
        if (s.at > at) break;
        for (const key of s.keys) keys.add(key);
      }
      return [...keys];
    },
    book(key, at, lookbackMs = BOOK_LOOKBACK_MS) {
      let bids: { levels: BookLevel[]; at: number } | null = null;
      let asks: { levels: BookLevel[]; at: number } | null = null;
      // Walk back from `at` to the latest bid and ask update of this contract. Each frame holds
      // most contracts, so this is usually one or two frames.
      for (let i = lastAtOrBefore(times, count, at); i >= 0 && times[i] >= at - lookbackMs && !(bids && asks); i -= 1) {
        const packets = parseDepthFrame(source.read(offsets[i], lengths[i]));
        for (let p = packets.length - 1; p >= 0; p -= 1) {
          const packet = packets[p];
          if (packet.kind !== "depth" || packet.key !== key) continue;
          if (packet.side === "bid") bids ??= { levels: liveLevels(packet.levels), at: times[i] };
          else asks ??= { levels: liveLevels(packet.levels), at: times[i] };
        }
      }
      if (!bids && !asks) return null;
      return { at: Math.max(bids?.at ?? 0, asks?.at ?? 0), bids: bids?.levels ?? [], asks: asks?.levels ?? [] };
    },
    close: () => source.close(),
  };
}

export interface ChainIndex {
  refresh(): Promise<void>;
  /** Expiries of `underlying` with a snapshot at or before `at`, nearest first. */
  expiries(underlying: string, at: number): string[];
  /** Index of the latest snapshot of the expiry at or before `at`, or −1: a stable id for caching what is read from it. */
  latest(underlying: string, expiry: string, at: number): number;
  /** The snapshot `latest` named. */
  snapshot(underlying: string, expiry: string, index: number): ChainSnapshot | null;
  close(): void;
}

export function createChainIndex(source: ByteSource): ChainIndex {
  const series = new Map<string, { underlying: string; expiry: string; times: number[]; offsets: number[] }>();
  let walked: number | undefined;
  // A snapshot record starts {"kind":"option-chain","underlying":"NIFTY","expiry":"2026-11-23",…
  // (the recorder writes its fields in that order), so its head is enough to file it.
  const HEAD = /^\{"kind":"option-chain","underlying":"([A-Z]+)","expiry":"(\d{4}-\d{2}-\d{2})"/;
  return {
    async refresh() {
      walked = await walkHeaders(
        source,
        ({ type, recvTs, offset, head }) => {
          const match = type === RecordType.control ? HEAD.exec(head.toString("utf8")) : null;
          if (!match) return;
          const [, underlying, expiry] = match;
          const id = `${underlying} ${expiry}`;
          let s = series.get(id);
          if (!s) series.set(id, (s = { underlying, expiry, times: [], offsets: [] }));
          // Snapshots of one expiry are written in order.
          s.times.push(recvTs);
          s.offsets.push(offset);
        },
        { peek: 120, from: walked },
      );
    },
    expiries(underlying, at) {
      return [...series.values()].filter((s) => s.underlying === underlying && s.times[0] <= at).map((s) => s.expiry).sort();
    },
    latest(underlying, expiry, at) {
      const s = series.get(`${underlying} ${expiry}`);
      return s ? lastAtOrBefore(s.times, s.times.length, at) : -1;
    },
    snapshot(underlying, expiry, index) {
      const s = series.get(`${underlying} ${expiry}`);
      if (!s || index < 0 || index >= s.times.length) return null;
      const length = source.read(s.offsets[index], 4).readUInt32LE(0);
      const record = source.read(s.offsets[index], 4 + length);
      return toChainSnapshot(JSON.parse(record.subarray(HEADER_BYTES).toString("utf8")), s.times[index]);
    },
    close: () => source.close(),
  };
}

/** Levels with orders on them, rounded to the paisa (the depth feed sends doubles). */
export function liveLevels(levels: readonly BookLevel[]): BookLevel[] {
  return levels.filter((l) => l.price > 0 && l.qty > 0).map((l) => ({ price: Math.round(l.price * 100) / 100, qty: l.qty, orders: l.orders }));
}

/** A chain file record's fields as a snapshot; null when they don't look like one. */
export function toChainSnapshot(data: Record<string, unknown>, at: number): ChainSnapshot | null {
  const { underlying, expiry, minute, lastPrice, oc } = data;
  if (typeof underlying !== "string" || typeof expiry !== "string" || typeof lastPrice !== "number" || !oc || typeof oc !== "object") return null;
  return { underlying, expiry, at, minute: typeof minute === "number" ? minute : at, lastPrice, oc: oc as Record<string, unknown> };
}

/** Index of the last of the first `count` times at or before `at`, or −1. The times must not decrease. */
function lastAtOrBefore(times: ArrayLike<number>, count: number, at: number) {
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (times[mid] <= at) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

function grow<T extends Float64Array | Uint32Array>(array: T, capacity: number): T {
  const next = new (array.constructor as new (length: number) => T)(capacity);
  next.set(array);
  return next;
}
