// A journal file loaded for replay: an index of where each frame sits and when it arrived, with
// the frames themselves read from disk as the replay reaches them. A day with order books is
// several gigabytes (18 November 2026: 2.2 GB, 11.8 million frames), past what Node reads in one
// go and more than the VM should hold, so only the index stays in memory: 20 bytes a frame.

import path from "node:path";
import { bufferSource, createRecordCursor, fileSource, NotAJournalError, type ByteSource } from "../journal/byte-source.ts";
import { HEADER_BYTES, MAGIC, readRecords, type JournalRecord } from "../journal/format.ts";

/** Bytes read from disk at a time while playing. Frames are played in order, so most reads are one block ahead. */
const BLOCK_BYTES = 4 * 1024 * 1024;

export interface Recording {
  date: string;
  /** The file, for readers that walk its records themselves (the replayed session view). */
  source: ByteSource;
  /** Frames in the file. */
  count: number;
  /** When each frame arrived, ms since the epoch. Never decreasing (see `indexRecording`). */
  times: Float64Array;
  /** The frame's bytes. Valid until the caller drops it; read the next frame at will. */
  frame(index: number): Uint8Array;
  /** A `frame` with its own read-ahead, for a second pass over the file that shouldn't disturb the first. */
  reader(): (index: number) => Uint8Array;
  /** Bytes `start` to `end` of a frame, read on their own: for the odd packet looked up out of order. */
  slice(index: number, start: number, end: number): Uint8Array;
  /** First and last frame time; 0 when the file has no frames. */
  startAt: number;
  endAt: number;
  /** Index of the first frame that arrived at or after `time` (`count` when none did). */
  indexAt(time: number): number;
  /** What the recorder's `instruments` records say each contract is, by instrument key. */
  contracts: Map<string, Record<string, unknown>>;
  /** Closes the file. */
  close(): void;
}

export class RecordingError extends Error {
  name = "RecordingError";
}

/**
 * Indexes `<directory>/<date>.bin`. Throws RecordingError when it is missing or isn't a journal.
 * Yields while indexing, so a big day doesn't stall the engine (about 3 s for 18 November's 2.2 GB).
 */
export async function loadRecording(directory: string, date: string): Promise<Recording> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RecordingError(`"${date}" isn't a date (YYYY-MM-DD).`);
  let source: ByteSource;
  try {
    source = fileSource(path.join(directory, `${date}.bin`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RecordingError(`No journal for ${date}.`);
    throw error;
  }
  try {
    return await indexSource(date, source);
  } catch (error) {
    source.close();
    throw error;
  }
}

/** Indexes a journal already in memory. For tests and small files. */
export function indexRecording(date: string, bytes: Buffer): Recording {
  if (bytes.length < MAGIC.length || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new RecordingError(`The ${date} journal isn't a journal file (bad magic).`);
  }
  const index = createIndex();
  readRecords(bytes, MAGIC.length, (record) => index.add(record, record.frame ? record.frame.byteOffset - bytes.byteOffset : 0));
  return index.finish(date, bufferSource(bytes));
}

async function indexSource(date: string, source: ByteSource): Promise<Recording> {
  const index = createIndex();
  try {
    await createRecordCursor(source).advance(Infinity, (record, offset) => index.add(record, offset + HEADER_BYTES));
  } catch (error) {
    if (error instanceof NotAJournalError) throw new RecordingError(`The ${date} journal isn't a journal file (bad magic).`);
    throw error;
  }
  return index.finish(date, source);
}

/**
 * Indexes the frames in a journal, fed its records in file order. Control records are skipped
 * (the replay stands in for Dhan, which only ever sent frames) apart from the few readers need.
 * Receive times that step back (a clock adjustment, or two runs appended to one file) are held
 * at the previous frame's time, so the file plays in the order it was written.
 */
function createIndex() {
  let capacity = 1024;
  let times = new Float64Array(capacity);
  // Float64 holds offsets past 4 GB exactly.
  let offsets = new Float64Array(capacity);
  let lengths = new Uint32Array(capacity);
  let count = 0;
  let last = 0;
  const contracts = new Map<string, Record<string, unknown>>();

  return {
    /** `frameOffset`: where a frame record's frame starts in the file. */
    add(record: JournalRecord, frameOffset: number) {
      if (record.control) {
        const { kind, ...data } = record.control;
        if (kind === "instruments" && Array.isArray(data.items)) {
          for (const item of data.items as Record<string, unknown>[]) if (typeof item?.key === "string") contracts.set(item.key, item);
        }
        return;
      }
      if (count === capacity) {
        capacity *= 2;
        times = grow(times, capacity);
        offsets = grow(offsets, capacity);
        lengths = grow(lengths, capacity);
      }
      last = Math.max(last, record.recvTs);
      times[count] = last;
      offsets[count] = frameOffset;
      lengths[count] = record.frame!.length;
      count += 1;
    },
    finish(date: string, source: ByteSource): Recording {
      return build(date, source, times.subarray(0, count), offsets, lengths, count, contracts);
    },
  };
}

function build(
  date: string,
  source: ByteSource,
  times: Float64Array,
  offsets: Float64Array,
  lengths: Uint32Array,
  count: number,
  contracts: Recording["contracts"],
): Recording {
  const reader = () => {
    let block: Buffer | null = null;
    let blockStart = 0;
    return (index: number) => {
      const start = offsets[index];
      const length = lengths[index];
      if (!block || start < blockStart || start + length > blockStart + block.length) {
        block = source.read(start, Math.max(BLOCK_BYTES, length));
        blockStart = start;
      }
      return block.subarray(start - blockStart, start - blockStart + length);
    };
  };

  return {
    date,
    source,
    count,
    times,
    frame: reader(),
    reader,
    slice(index, start, end) {
      return source.read(offsets[index] + start, end - start);
    },
    startAt: count > 0 ? times[0] : 0,
    endAt: count > 0 ? times[count - 1] : 0,
    indexAt(time) {
      let low = 0;
      let high = count;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (times[mid] < time) low = mid + 1;
        else high = mid;
      }
      return low;
    },
    contracts,
    close: () => source.close(),
  };
}

function grow<T extends Float64Array | Uint32Array>(array: T, capacity: number): T {
  const next = new (array.constructor as new (length: number) => T)(capacity);
  next.set(array);
  return next;
}
