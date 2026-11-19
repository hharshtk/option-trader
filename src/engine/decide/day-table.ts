// Builds a recorded day's per-minute table: at each minute's close, everything a decision sees
// (the MinuteState) and the nearest NIFTY expiry's option quotes, for scoring rules against.
//
// The day is rebuilt as it stood at each minute, as the live trader sees it: the journal and its
// side files are read up to 1.5 s after the minute's close (when the trader reads its signals),
// the session is summarised and Pulse computed on it. Reading the day's end-of-day summary
// instead would leak the afternoon into the morning (each strike's open interest, for one). About
// 16 s of work for a full day (18 November 2026), plus reading the files.

import path from "node:path";
import type { MinuteQuote } from "../../lib/decide/simulate.ts";
import { minuteState, type MinuteState } from "../../lib/decide/state.ts";
import { computePulse } from "../../lib/insight/pulse.ts";
import { parseFrame } from "../../lib/live/feed/packets.ts";
import { createRecordCursor, fileSource } from "../journal/byte-source.ts";
import type { JournalRecord } from "../journal/format.ts";
import { createDayAggregator } from "../journal/session-reader.ts";
import { createSideSeries } from "../journal/side-series.ts";
import type { SessionCalendar } from "../market/session-calendar.ts";
import { loadSideFiles } from "../replay/side-data.ts";
import { NIFTY_CONSTITUENTS } from "../trading/strategy.ts";

const MINUTE_MS = 60_000;
/** The trader reads its signals this long after a minute closes. */
export const READ_DELAY_MS = 1_500;
const SESSION_MINUTES = 375;

export interface DayTable {
  date: string;
  states: MinuteState[];
  /** By minute, the nearest expiry's quotes at the moment its state was read. */
  quotes: { t: number; quotes: MinuteQuote[] }[];
  /** The nearest NIFTY expiry the quotes are of; null when the day recorded no NIFTY options. */
  expiry: string | null;
  /** Side files the day had. */
  sides: { depth: boolean; chain: boolean };
}

/** Builds `<directory>/<date>.bin`'s table. Null when the date had no session. Throws when the journal can't be read. */
export async function buildDayTable(directory: string, date: string, calendar: SessionCalendar): Promise<DayTable | null> {
  const session = calendar.session("NSE_EQ", date);
  if (!session) return null;
  const source = fileSource(path.join(directory, `${date}.bin`));
  const sides = await loadSideFiles(directory, date);
  try {
    const aggregator = createDayAggregator(date, calendar);
    const series = createSideSeries(() => sides);
    const cursor = createRecordCursor(source);
    const quotes = createQuoteTracker(date);
    const out: DayTable = { date, states: [], quotes: [], expiry: null, sides: { depth: sides.depth !== null, chain: sides.chain !== null } };
    let lastFrameAt = 0;

    for (let t = 0; t < SESSION_MINUTES; t += 1) {
      const position = session.open + (t + 1) * MINUTE_MS + READ_DELAY_MS;
      await cursor.advance(position, (record) => {
        if (record.frame) lastFrameAt = record.recvTs;
        aggregator.add(record);
        quotes.add(record);
      });
      // The file ends before this minute (an unfinished day): nothing more to build. A gap inside
      // the day (an engine restart) just carries on.
      if (lastFrameAt < session.open + t * MINUTE_MS && source.size() - cursor.offset < 24) break;
      const day = series.apply(aggregator.summary({ builtAt: position, readMs: 0, bytes: cursor.offset }), position);
      const pulse = computePulse(day, NIFTY_CONSTITUENTS);
      const state = pulse && minuteState(pulse, session.open + t * MINUTE_MS);
      if (!state) continue;
      out.states.push(state);
      const snapshot = quotes.snapshot();
      if (snapshot.length > 0) out.quotes.push({ t, quotes: snapshot });
    }
    out.expiry = quotes.expiry();
    return out;
  } finally {
    source.close();
    sides.close();
  }
}

/** Keeps the latest bid, ask and last price of the nearest NIFTY expiry's options, from the journal's Full packets. */
function createQuoteTracker(date: string) {
  const contracts = new Map<string, { strike: number; type: "CE" | "PE"; expiry: string; lotSize: number }>();
  const latest = new Map<string, { bid: number | null; ask: number | null; ltp: number | null; low: number | null; high: number | null }>();
  let nearest: string | null = null;

  return {
    add(record: JournalRecord) {
      const c = record.control;
      if (c) {
        if (c.kind === "instruments" && Array.isArray(c.items)) {
          for (const item of c.items as Record<string, unknown>[]) {
            if (item.kind !== "option" || item.underlying !== "NIFTY" || typeof item.key !== "string" || typeof item.strike !== "number") continue;
            if (item.type !== "CE" && item.type !== "PE") continue;
            const expiry = String(item.expiry);
            if (expiry < date) continue;
            contracts.set(item.key, { strike: item.strike, type: item.type, expiry, lotSize: typeof item.lotSize === "number" ? item.lotSize : 1 });
            if (nearest === null || expiry < nearest) nearest = expiry;
          }
        }
        return;
      }
      for (const packet of parseFrame(record.frame!)) {
        if (packet.kind !== "quote" || !contracts.has(packet.key)) continue;
        const best = packet.depth?.[0];
        const ltp = packet.ltp > 0 ? packet.ltp : null;
        const before = latest.get(packet.key);
        latest.set(packet.key, {
          bid: best && best.bid > 0 && best.bidQty > 0 ? best.bid : null,
          ask: best && best.ask > 0 && best.askQty > 0 ? best.ask : null,
          ltp,
          // The last price's range since the previous snapshot, so a stop or target crossed inside a minute is seen.
          low: ltp === null ? (before?.low ?? null) : Math.min(before?.low ?? ltp, ltp),
          high: ltp === null ? (before?.high ?? null) : Math.max(before?.high ?? ltp, ltp),
        });
      }
    },
    /** The quotes now; each contract's price range starts again from its last price. */
    snapshot(): MinuteQuote[] {
      const out: MinuteQuote[] = [];
      for (const [key, q] of latest) {
        const c = contracts.get(key)!;
        if (c.expiry === nearest) {
          out.push({ key, strike: c.strike, type: c.type, bid: round(q.bid), ask: round(q.ask), ltp: round(q.ltp), low: round(q.low), high: round(q.high), lotSize: c.lotSize });
        }
        q.low = q.high = q.ltp;
      }
      return out;
    },
    expiry: () => nearest,
  };
}

const round = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);
