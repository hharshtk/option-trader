// The replayed day as far as the replay has reached: what `GET /v1/journal/session` answers for
// that day during a replay, so the Session view and Pulse build up minute by minute as they do
// live, instead of showing the whole recorded day at once. Fed from the same journal file with
// the same aggregator as a live day; only records received up to the replay's position count.

import type { JournalSession } from "../../lib/engine/protocol.ts";
import { HEADER_BYTES, MAGIC, readRecords } from "../journal/format.ts";
import { createDayAggregator } from "../journal/session-reader.ts";
import type { SessionAggregator } from "../journal/session-summary.ts";
import type { SessionCalendar } from "../market/session-calendar.ts";
import type { Recording } from "./recording.ts";

/** Records decoded between yields, so catching up on a whole day never stalls the feed. */
const RECORDS_PER_TURN = 20_000;

export interface ReplaySession {
  /** The day as of recorded time `position`. */
  read(position: number): Promise<JournalSession>;
}

export function createReplaySession(recording: Recording, calendar: SessionCalendar): ReplaySession {
  const { bytes, date } = recording;
  let aggregator: SessionAggregator = createDayAggregator(date, calendar);
  /** Start of the next record not yet fed to the aggregator. */
  let offset = MAGIC.length;
  let reached = -Infinity;
  let busy: Promise<unknown> = Promise.resolve();

  async function advance(position: number) {
    // A seek back: start the day over.
    if (position < reached) {
      aggregator = createDayAggregator(date, calendar);
      offset = MAGIC.length;
    }
    let fed = 0;
    while (offset + HEADER_BYTES <= bytes.length) {
      const end = offset + 4 + bytes.readUInt32LE(offset);
      if (end > bytes.length || bytes.readDoubleLE(offset + 16) > position) break;
      readRecords(bytes.subarray(0, end), offset, (record) => aggregator.add(record));
      offset = end;
      fed += 1;
      if (fed % RECORDS_PER_TURN === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    reached = position;
  }

  return {
    async read(position) {
      const started = performance.now();
      // One catch-up at a time; a second request waits for the first and reuses its work.
      const work = busy.then(() => advance(position));
      busy = work.catch(() => {});
      await work;
      return aggregator.summary({
        builtAt: position,
        readMs: Math.round((performance.now() - started) * 10) / 10,
        bytes: offset,
      });
    },
  };
}
