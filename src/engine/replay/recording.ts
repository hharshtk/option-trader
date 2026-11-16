// A journal file loaded for replay: the whole file in memory, plus an index of where each frame
// sits and when it arrived. Frames stay in the file's buffer (no copies), so a 1-million-frame
// day costs the file's size plus 16 bytes a frame.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { MAGIC, readRecords } from "../journal/format.ts";

export interface Recording {
  date: string;
  /** The whole file, control records included. */
  bytes: Buffer;
  /** Frames in the file. */
  count: number;
  /** When each frame arrived, ms since the epoch. Never decreasing (see `indexRecording`). */
  times: Float64Array;
  /** The frame's bytes, a view into the file's buffer. */
  frame(index: number): Uint8Array;
  /** First and last frame time; 0 when the file has no frames. */
  startAt: number;
  endAt: number;
  /** Index of the first frame that arrived at or after `time` (`count` when none did). */
  indexAt(time: number): number;
}

export class RecordingError extends Error {
  name = "RecordingError";
}

/** Reads `<directory>/<date>.bin`. Throws RecordingError when it is missing or isn't a journal. */
export async function loadRecording(directory: string, date: string): Promise<Recording> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RecordingError(`"${date}" isn't a date (YYYY-MM-DD).`);
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(directory, `${date}.bin`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RecordingError(`No journal for ${date}.`);
    throw error;
  }
  return indexRecording(date, bytes);
}

/**
 * Indexes the frames in a journal file's bytes. Control records are skipped: the replay stands in
 * for Dhan, which only ever sent frames. A last record cut off mid-write is ignored. Receive times
 * that step back (a clock adjustment, or two runs appended to one file) are held at the previous
 * frame's time, so the file plays in the order it was written.
 */
export function indexRecording(date: string, bytes: Buffer): Recording {
  if (bytes.length < MAGIC.length || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new RecordingError(`The ${date} journal isn't a journal file (bad magic).`);
  }

  let capacity = 1024;
  let times = new Float64Array(capacity);
  let offsets = new Uint32Array(capacity);
  let lengths = new Uint32Array(capacity);
  let count = 0;
  let last = 0;

  readRecords(bytes, MAGIC.length, (record) => {
    if (!record.frame) return;
    if (count === capacity) {
      capacity *= 2;
      times = grow(times, capacity);
      offsets = grow(offsets, capacity);
      lengths = grow(lengths, capacity);
    }
    last = Math.max(last, record.recvTs);
    times[count] = last;
    offsets[count] = record.frame.byteOffset - bytes.byteOffset;
    lengths[count] = record.frame.length;
    count += 1;
  });

  times = times.subarray(0, count);
  return {
    date,
    bytes,
    count,
    times,
    frame: (index) => bytes.subarray(offsets[index], offsets[index] + lengths[index]),
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
  };
}

function grow<T extends Float64Array | Uint32Array>(array: T, capacity: number): T {
  const next = new (array.constructor as new (length: number) => T)(capacity);
  next.set(array);
  return next;
}
