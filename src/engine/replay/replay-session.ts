// The replayed day as far as the replay has reached: what `GET /v1/journal/session` answers for
// that day during a replay, so the Session view and Pulse build up minute by minute as they do
// live, instead of showing the whole recorded day at once. Fed from the same journal file with
// the same aggregator as a live day; only records received up to the replay's position count.

import type { JournalSession } from "../../lib/engine/protocol.ts";
import { createRecordCursor } from "../journal/byte-source.ts";
import { createDayAggregator } from "../journal/session-reader.ts";
import { createSideSeries } from "../journal/side-series.ts";
import type { SessionAggregator } from "../journal/session-summary.ts";
import type { SessionCalendar } from "../market/session-calendar.ts";
import type { Recording } from "./recording.ts";
import type { SideFiles } from "./side-data.ts";

export interface ReplaySession {
  /** The day as of recorded time `position`. */
  read(position: number): Promise<JournalSession>;
}

/** `sides`: the day's depth and chain files, read up to the position too. */
export function createReplaySession(recording: Recording, calendar: SessionCalendar, sides: SideFiles | null = null): ReplaySession {
  const { date } = recording;
  const series = createSideSeries(() => sides);
  let aggregator: SessionAggregator = createDayAggregator(date, calendar);
  const cursor = createRecordCursor(recording.source);
  let reached = -Infinity;
  let busy: Promise<unknown> = Promise.resolve();

  async function advance(position: number) {
    // A seek back: start the day over.
    if (position < reached) {
      aggregator = createDayAggregator(date, calendar);
      cursor.reset();
    }
    await cursor.advance(position, (record) => aggregator.add(record));
    reached = position;
  }

  return {
    async read(position) {
      const started = performance.now();
      // One catch-up at a time; a second request waits for the first and reuses its work.
      const work = busy.then(() => advance(position));
      busy = work.catch(() => {});
      await work;
      const summary = aggregator.summary({ builtAt: position, readMs: 0, bytes: cursor.offset });
      const day = series.apply(summary, position);
      return { ...day, readMs: Math.round((performance.now() - started) * 10) / 10 };
    },
  };
}
