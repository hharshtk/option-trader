// Appends every raw feed frame and every control event (connect, subscribe, gaps, engine start
// and stop) to today's journal file, in one sequence across all connections. The raw journal is
// the source of truth: if the parser changes, a day can be decoded again from it.

import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, type WriteStream } from "node:fs";
import path from "node:path";
import type { JournalDay, JournalStatus } from "../../lib/engine/protocol.ts";
import { encodeRecord, MAGIC, type RecordTypeName } from "./format.ts";

const DAYS_CACHE_MS = 10_000;
/** Above this much unwritten data the disk isn't keeping up. */
const BACKLOG_WARN_BYTES = 8 * 1024 * 1024;

export interface Journal {
  frame(connection: number, frame: ArrayBuffer | Buffer, recvTs: number): void;
  control(kind: string, data: Record<string, unknown>, recvTs: number, connection?: number): void;
  status(): JournalStatus;
  days(): JournalDay[];
  close(): Promise<void>;
}

export interface JournalOptions {
  directory: string;
  istDate: (time: number) => string;
  now: () => number;
  /** Called with the new file's date when a file is opened, to write its opening records. */
  onOpen?: (date: string) => void;
  onError?: (error: Error) => void;
  /** Called after each write completes with how long it took, in ms. */
  onWriteLatency?: (ms: number) => void;
}

export function createJournal(options: JournalOptions): Journal {
  const { directory, istDate, now, onOpen, onError, onWriteLatency } = options;
  mkdirSync(directory, { recursive: true });

  let stream: WriteStream | null = null;
  let date = "";
  let seq = 0;
  let bytes = 0;
  let frames = 0;
  let controls = 0;
  let gaps = 0;
  let lastWriteAt: number | null = null;
  let error: string | null = null;
  let opening = false;
  let daysCache: { at: number; days: JournalDay[] } | null = null;

  function open(day: string) {
    stream?.end();
    const file = path.join(directory, `${day}.bin`);
    const fresh = !existsSync(file);
    stream = createWriteStream(file, { flags: "a" });
    stream.on("error", (cause) => {
      error = cause.message;
      onError?.(cause);
    });
    date = day;
    // A restart on the same day appends to the existing file and continues its counts.
    if (fresh) {
      stream.write(MAGIC);
      seq = 0;
      bytes = MAGIC.length;
      frames = controls = gaps = 0;
    } else {
      bytes = statSync(file).size;
      // Seq restarts per process; the engine-start control record marks where.
      seq = 0;
      frames = controls = gaps = 0;
    }
    daysCache = null;
    opening = true;
    onOpen?.(day);
    opening = false;
  }

  function write(type: RecordTypeName, connection: number, recvTs: number, payload: Buffer) {
    const day = istDate(recvTs);
    if (day !== date && !opening) open(day);
    const record = encodeRecord(type, connection, ++seq, recvTs, payload);
    const started = performance.now();
    stream!.write(record, (cause) => {
      if (!cause) onWriteLatency?.(performance.now() - started);
    });
    bytes += record.length;
    lastWriteAt = now();
  }

  return {
    frame(connection, frame, recvTs) {
      frames += 1;
      write("frame", connection, recvTs, Buffer.isBuffer(frame) ? frame : Buffer.from(frame));
    },
    control(kind, data, recvTs, connection = 0) {
      controls += 1;
      if (kind === "gap") gaps += 1;
      write("control", connection, recvTs, Buffer.from(JSON.stringify({ kind, ...data }), "utf8"));
    },
    status() {
      const backlog = stream?.writableLength ?? 0;
      return {
        date: date || null,
        file: date ? path.join(directory, `${date}.bin`) : null,
        bytes,
        frames,
        controls,
        gaps,
        seq,
        lastWriteAt,
        backlogBytes: backlog,
        error,
        slow: backlog > BACKLOG_WARN_BYTES,
      };
    },
    days() {
      if (daysCache && now() - daysCache.at < DAYS_CACHE_MS) return daysCache.days;
      const days = readdirSync(directory)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.bin$/.test(name))
        .map((name) => ({ date: name.slice(0, 10), bytes: statSync(path.join(directory, name)).size }))
        .sort((a, b) => b.date.localeCompare(a.date));
      daysCache = { at: now(), days };
      return days;
    },
    close() {
      return new Promise((resolve) => {
        if (!stream) return resolve();
        stream.end(() => resolve());
        stream = null;
      });
    },
  };
}
