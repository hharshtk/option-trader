// Reading journal files without holding them in memory. A full day with order books is several
// gigabytes (18 November 2026: 2.2 GB main journal, 2.3 GB depth), more than Node reads in one
// go (2 GiB) and more than the VM should hold per replay. A ByteSource reads byte ranges on
// demand; a RecordCursor walks a file's records in order, a chunk at a time.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { HEADER_BYTES, MAGIC, readRecords, type JournalRecord } from "./format.ts";

export interface ByteSource {
  /** Bytes in the source now. A file being written grows. */
  size(): number;
  /** `length` bytes from `offset`, fewer at the end. The result may be a view: copy it to keep it past the next read. */
  read(offset: number, length: number): Buffer;
  close(): void;
}

/** A source over bytes already in memory (tests, small files). */
export function bufferSource(bytes: Buffer): ByteSource {
  return {
    size: () => bytes.length,
    read: (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)),
    close() {},
  };
}

/** A source over a file, opened read-only. Throws ENOENT when it doesn't exist. */
export function fileSource(file: string): ByteSource {
  let fd: number | null = openSync(file, "r");
  return {
    size() {
      if (fd === null) throw new Error(`${file} is closed`);
      return fstatSync(fd).size;
    },
    read(offset, length) {
      if (fd === null) throw new Error(`${file} is closed`);
      // A fresh buffer each read, so views handed out earlier stay valid.
      const buffer = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        const n = readSync(fd, buffer, filled, length - filled, offset + filled);
        if (n === 0) break;
        filled += n;
      }
      return filled === length ? buffer : buffer.subarray(0, filled);
    },
    close() {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}

/** Bytes read per step. Big enough that a day reads in a few hundred steps. */
export const CHUNK_BYTES = 8 * 1024 * 1024;

export interface RecordCursor {
  /** Byte offset of the next record not yet handed out. */
  readonly offset: number;
  /**
   * Hands out, in file order, every complete record received at or before `until` (ms), and
   * stops at the first one after it. A record still being written is left for the next call.
   * Yields to the event loop between chunks, so a whole day never stalls the engine.
   */
  advance(until: number, onRecord: (record: JournalRecord, offset: number) => void): Promise<void>;
  /** Back to the first record. */
  reset(): void;
}

export class NotAJournalError extends Error {
  name = "NotAJournalError";
}

export function createRecordCursor(source: ByteSource, { chunkBytes = CHUNK_BYTES } = {}): RecordCursor {
  let offset = 0;
  let checked = false;

  return {
    get offset() {
      return offset;
    },
    reset() {
      offset = checked ? MAGIC.length : 0;
    },
    async advance(until, onRecord) {
      if (!checked) {
        if (source.size() < MAGIC.length) return;
        if (!source.read(0, MAGIC.length).equals(MAGIC)) throw new NotAJournalError("Not a journal file (bad magic)");
        checked = true;
        offset = MAGIC.length;
      }
      for (;;) {
        const size = source.size();
        if (offset + HEADER_BYTES > size) return;
        const base = offset;
        const chunk = source.read(base, Math.min(chunkBytes, size - base));
        let at = 0;
        let stopped = false;
        while (at + HEADER_BYTES <= chunk.length) {
          const end = at + 4 + chunk.readUInt32LE(at);
          if (end > chunk.length) break;
          if (chunk.readDoubleLE(at + 16) > until) {
            stopped = true;
            break;
          }
          readRecords(chunk.subarray(0, end), at, (record) => onRecord(record, base + at));
          at = end;
        }
        if (at === 0 && !stopped) {
          // One record bigger than a chunk: read it whole.
          if (offset + 4 > size) return;
          const length = 4 + source.read(offset, 4).readUInt32LE(0);
          if (offset + length > size) return;
          const record = source.read(offset, length);
          if (record.readDoubleLE(16) > until) return;
          readRecords(record, 0, (r) => onRecord(r, base));
          offset += length;
        } else {
          offset = base + at;
        }
        if (stopped) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

/**
 * Walks a journal's records by their headers alone, reading each record's first `peek` bytes of
 * payload and skipping the rest: for files of few, large records (the depth file's frames are
 * about 28 KB, the chain file's snapshots about 80 KB), where reading every byte only to find
 * where records start would cost seconds. `onRecord` gets the type (1 frame, 2 control), the
 * receive time, where the record starts, its payload length and the peeked payload bytes.
 * Starts at `from` (a record's start, as an earlier walk returned) and returns where it stopped:
 * the end of the file, or the start of a record still being written.
 */
export async function walkHeaders(
  source: ByteSource,
  onRecord: (record: { type: number; recvTs: number; offset: number; payloadLength: number; head: Buffer }) => void,
  { peek = 0, perTurn = 5_000, from }: { peek?: number | ((type: number) => number); perTurn?: number; from?: number } = {},
): Promise<number | undefined> {
  const size = source.size();
  if (from === undefined) {
    if (size < MAGIC.length) return undefined;
    if (!source.read(0, MAGIC.length).equals(MAGIC)) throw new NotAJournalError("Not a journal file (bad magic)");
  }
  let offset = from ?? MAGIC.length;
  let walked = 0;
  while (offset + HEADER_BYTES <= size) {
    const header = source.read(offset, HEADER_BYTES);
    const length = header.readUInt32LE(0);
    if (length < HEADER_BYTES - 4) throw new Error(`Bad record length ${length} at byte ${offset}`);
    if (offset + 4 + length > size) break;
    const type = header.readUInt8(4);
    const payloadLength = length - (HEADER_BYTES - 4);
    const want = Math.min(payloadLength, typeof peek === "function" ? peek(type) : peek);
    onRecord({ type, recvTs: header.readDoubleLE(16), offset, payloadLength, head: want > 0 ? source.read(offset + HEADER_BYTES, want) : Buffer.alloc(0) });
    offset += 4 + length;
    walked += 1;
    if (walked % perTurn === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return offset;
}
