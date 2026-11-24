// The frozen five-level OFI of NIFTY's near-month future (docs/nifty-futures-ofi-experiment-2026-11-23.md),
// read from a day's `.depth` file in receive order. One reader for everything that uses it: the
// recorded-day comparison, and the journal session's per-minute series that Pulse, the trader,
// replay and the decision lab read. The live trader and the scoreboard see the same numbers.

import { parseDepthFrame } from "../../lib/live/feed/depth-packets.ts";
import { parseInstrumentKey, type Instrument } from "../../lib/live/feed/packets.ts";
import { createSnapshotOfi, type OfiReading } from "../replay/snapshot-ofi.ts";
import { createRecordCursor, type ByteSource } from "./byte-source.ts";
import { HEADER_BYTES, type JournalRecord } from "./format.ts";

const MINUTE_MS = 60_000;
/** A minute's reading is taken this long after it closes: when the trader reads its signals (trader.ts) and the day table reads the day (day-table.ts). */
export const OFI_CUTOFF_DELAY_MS = 1_500;
/**
 * Bytes read per step. The reads are synchronous, and the live engine reads during the session,
 * so a step is kept short even on a file no longer in memory (about 25 ms at the VM's disk speed).
 */
const CHUNK_BYTES = 1024 * 1024;
/** Depth-file controls that interrupt the book. */
const RESETS = new Set(["file-open", "state", "gap"]);

/** When minute `t`'s reading is taken. */
export const ofiCutoff = (open: number, t: number) => open + (t + 1) * MINUTE_MS + OFI_CUTOFF_DELAY_MS;

/** A main-journal interruption (engine start or stop, a global or suspend gap). With `key`, the front future changed to it. */
export interface OfiEvent {
  at: number;
  key?: string | null;
}

export interface DepthOfiReader {
  /** Hands the records received by `until` to the reducer, with `events` (sorted by time) applied at their times. */
  advance(until: number, events: readonly OfiEvent[]): Promise<void>;
  /** The reading at `at`, after advance(at). */
  score(at: number): OfiReading;
  /** The file already holds a record received after `at`, so nothing received by then is still being written. */
  settled(at: number): boolean;
}

/** Reads one front future's book from session open. `key`: the future, until an event names another. */
export function createDepthOfiReader(source: ByteSource, open: number, key: string | null = null): DepthOfiReader {
  const cursor = createRecordCursor(source, { chunkBytes: CHUNK_BYTES });
  const ofi = createSnapshotOfi();
  let instrument: Instrument | null = key ? parseInstrumentKey(key) : null;
  let events: readonly OfiEvent[] = [];
  let appliedTo = -Infinity;
  let lastAt = open;

  /** Main-journal events come before depth records received at the same time. */
  function apply(until: number) {
    for (const event of events) {
      if (event.at > until) break;
      if (event.at <= appliedTo) continue;
      if (event.key !== undefined) instrument = event.key ? parseInstrumentKey(event.key) : null;
      ofi.reset();
    }
    appliedTo = Math.max(appliedTo, until);
  }

  function add({ recvTs: at, control, frame }: JournalRecord) {
    if (at < open) return;
    // A receive time that moves backward is discarded, and the book starts over.
    if (at < lastAt) return ofi.reset();
    lastAt = at;
    apply(at);
    if (control && RESETS.has(control.kind)) return ofi.reset();
    if (!frame || !instrument) return;
    const packets = parseDepthFrame(frame, instrument);
    if (packets.some((packet) => packet.kind === "disconnect")) return ofi.reset();
    const depth = packets.filter((packet) => packet.kind === "depth");
    if (depth.length) ofi.observe(at, depth);
  }

  return {
    async advance(until, list) {
      events = list;
      await cursor.advance(until, add);
      apply(until);
    },
    score: (at) => ofi.score(at),
    settled(at) {
      // The cursor stops at the first record received after `until`, or at one still being written.
      const offset = cursor.offset;
      if (offset === 0 || source.size() - offset < HEADER_BYTES) return false;
      return source.read(offset, HEADER_BYTES).readDoubleLE(16) > at;
    },
  };
}

export interface OfiDay {
  open: number;
  /** The near-month future. */
  key: string;
  /** The main journal's interruptions so far, sorted. */
  events: readonly OfiEvent[];
}

export interface DepthOfi {
  /**
   * Each of the first `minutes` minutes' reading at its cutoff, null for a cutoff after
   * `position`. A reading is kept once the file holds what came after its cutoff; until then (the
   * live day's latest minute) it is taken from what has been written and read again next time.
   */
  readings(day: OfiDay, minutes: number, position: number): Promise<(OfiReading | null)[]>;
}

/** Per-minute readings over a day's depth file, read forward once and kept. */
export function createDepthOfi(source: ByteSource): DepthOfi {
  let day: { open: number; key: string; reader: DepthOfiReader; kept: OfiReading[] } | null = null;
  let busy: Promise<unknown> = Promise.resolve();

  async function read({ open, key, events }: OfiDay, minutes: number, position: number) {
    // Another future: start the day over with it.
    if (!day || day.open !== open || day.key !== key) day = { open, key, reader: createDepthOfiReader(source, open, key), kept: [] };
    const { reader, kept } = day;
    const out: (OfiReading | null)[] = [];
    let unsettled = false;
    for (let t = 0; t < minutes; t += 1) {
      const cutoff = ofiCutoff(open, t);
      if (cutoff > position) out.push(null);
      else if (t < kept.length) out.push(kept[t]);
      else if (unsettled) {
        // An earlier cutoff is still being written, so nothing after it has been read: the book as it stood then.
        out.push(reader.score(cutoff));
      } else {
        await reader.advance(cutoff, events);
        const reading = reader.score(cutoff);
        if (reader.settled(cutoff)) kept.push(reading);
        else unsettled = true;
        out.push(reading);
      }
    }
    return out;
  }

  return {
    readings(ofiDay, minutes, position) {
      // One read at a time: the reader only moves forward.
      const work = busy.then(() => read(ofiDay, minutes, position));
      busy = work.catch(() => {});
      return work;
    },
  };
}
