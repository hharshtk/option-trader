// Reads journal files back into JournalSession summaries for the web's Session view. A day's file
// is read once; later requests read only the bytes appended since, so polling today's growing
// file stays cheap. Reads go in chunks with a yield between them, so a first read of a full day
// never stalls the feed.

import { open, stat } from "node:fs/promises";
import path from "node:path";
import { INDEX } from "../../lib/dhan/instruments.ts";
import type { JournalSession } from "../../lib/engine/protocol.ts";
import { INDEX_CONSTITUENTS } from "../../lib/index-constituents.ts";
import type { SessionCalendar } from "../market/session-calendar.ts";
import { MAGIC, readRecords } from "./format.ts";
import { createSessionAggregator, type InstrumentName, type SessionAggregator } from "./session-summary.ts";

// About 15 ms of decoding per chunk, so the feed never waits long.
const CHUNK_BYTES = 1024 * 1024;
/** Days kept in memory. Today plus a few looked up. */
const MAX_DAYS = 4;
const BENCHMARK = `IDX_I:${INDEX.NIFTY.securityId}`;

export interface JournalSessions {
  /** The day's summary, or null when there is no journal file for it. */
  read(date: string): Promise<JournalSession | null>;
}

interface Day {
  aggregator: SessionAggregator;
  /** Bytes of the file consumed so far. */
  position: number;
  /** The start of a record cut off at the end of the last read. */
  carry: Buffer;
  busy: Promise<unknown>;
}

export function createJournalSessions({
  directory,
  calendar,
  now,
}: {
  directory: string;
  calendar: SessionCalendar;
  now: () => number;
}): JournalSessions {
  const days = new Map<string, Day>();
  const names = instrumentNames();

  function fresh(date: string): Day {
    const session = calendar.session("NSE_EQ", date);
    return {
      aggregator: createSessionAggregator({
        date,
        session: session && { open: session.open, close: session.close },
        dayStart: session ? (session.preOpen?.start ?? session.open) : null,
        benchmark: BENCHMARK,
        names: (key) => names.get(key) ?? null,
      }),
      position: 0,
      carry: Buffer.alloc(0),
      busy: Promise.resolve(),
    };
  }

  async function catchUp(date: string, day: Day, file: string) {
    // Sized here, inside the queue, so overlapping requests never see the file shrink.
    const size = (await stat(file)).size;
    if (size < day.position) {
      // The file was replaced or truncated: start over.
      Object.assign(day, fresh(date), { busy: day.busy });
    }
    if (size <= day.position) return;
    const handle = await open(file, "r");
    try {
      while (day.position < size) {
        const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - day.position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, day.position);
        if (bytesRead === 0) break;
        let start = 0;
        if (day.position === 0) {
          if (bytesRead < MAGIC.length) break;
          if (!chunk.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`${date}.bin is not a journal file`);
          start = MAGIC.length;
        }
        day.position += bytesRead;
        const bytes = day.carry.length > 0 ? Buffer.concat([day.carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const end = readRecords(bytes, start, (record) => day.aggregator.add(record));
        day.carry = Buffer.from(bytes.subarray(end));
        // Let the feed and the API run between chunks.
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      await handle.close();
    }
  }

  return {
    async read(date) {
      const file = path.join(directory, `${date}.bin`);
      try {
        await stat(file);
      } catch {
        return null;
      }
      let day = days.get(date);
      if (!day) {
        day = fresh(date);
        days.set(date, day);
        while (days.size > MAX_DAYS) days.delete(days.keys().next().value!);
      }
      const started = performance.now();
      // One read at a time per day; a second request waits for the first and reuses its work.
      const work = day.busy.then(() => catchUp(date, day!, file));
      day.busy = work.catch(() => {});
      try {
        await work;
      } catch (error) {
        days.delete(date);
        throw error;
      }
      return day.aggregator.summary({
        builtAt: now(),
        readMs: Math.round((performance.now() - started) * 10) / 10,
        bytes: day.position - day.carry.length,
      });
    },
  };
}

/** Symbols for the indices and their constituents, keyed by instrument key. */
function instrumentNames() {
  const names = new Map<string, InstrumentName>();
  for (const [symbol, index] of Object.entries(INDEX)) {
    names.set(`IDX_I:${index.securityId}`, { symbol, name: null, sector: "Index" });
  }
  for (const [index, list] of Object.entries(INDEX_CONSTITUENTS)) {
    const segment = index === "SENSEX" || index === "BANKEX" ? "BSE_EQ" : "NSE_EQ";
    for (const stock of list) {
      const key = `${segment}:${stock.securityId}`;
      if (!names.has(key)) names.set(key, { symbol: stock.symbol, name: stock.name, sector: stock.sector });
    }
  }
  return names;
}
