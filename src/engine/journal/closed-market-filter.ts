// Keeps the journal from filling with repeats while the market is closed. After the close Dhan
// keeps sending index ticker packets every fraction of a second: the same last price, only the
// timestamp moving (NIFTY sent about 36,000 of them between 15:31 and 16:47 IST, 4 with a new
// price). Left alone that is about 45 MB a day of nothing, nights and weekends included.
//
// A frame is skipped only when every packet in it (1) belongs to a segment that is closed right
// now and (2) repeats the last value journaled for that instrument, ignoring the timestamp. So
// nothing new is ever lost: the first packet of each instrument after a subscribe (the
// snapshot that gives the previous close), every price change, the pre-open auction and the
// close-time packets all still get through. While any packet's segment is open or in pre-open,
// frames pass untouched, with no parsing.

import { parseFrame, type Packet } from "../../lib/live/feed/packets.ts";
import type { SessionCalendar } from "../market/session-calendar.ts";

export interface ClosedMarketFilter {
  /** False when the frame only repeats what is already journaled and the market is closed. */
  shouldJournal(frame: ArrayBuffer | ArrayBufferView, at: number): boolean;
}

/** What a packet says, without the time it was stamped. Null for packets that are always kept. */
function fingerprint(packet: Packet): string | null {
  switch (packet.kind) {
    case "ticker":
      return `${packet.ltp}`;
    case "quote":
      return [
        packet.ltp, packet.ltq, packet.atp, packet.volume, packet.totalSellQty, packet.totalBuyQty,
        packet.oi, packet.open, packet.close, packet.high, packet.low,
      ].join(",");
    case "prevClose":
      return `${packet.prevClose},${packet.prevOi}`;
    case "oi":
      return `${packet.oi}`;
    default:
      return null;
  }
}

export function createClosedMarketFilter(calendar: SessionCalendar): ClosedMarketFilter {
  const segments = calendar.segments();
  const last = new Map<string, string>();
  let closedAtSecond = -1;
  let closed = new Set<string>();

  function closedSegments(at: number) {
    const second = Math.floor(at / 1000);
    if (second !== closedAtSecond) {
      closedAtSecond = second;
      closed = new Set(segments.filter((segment) => calendar.phaseAt(segment, at) === "closed"));
    }
    return closed;
  }

  return {
    shouldJournal(frame, at) {
      const closedNow = closedSegments(at);
      if (closedNow.size === 0) {
        // Market hours: pass everything, and forget what was tracked so the first packets
        // after the next close are journaled again.
        if (last.size > 0) last.clear();
        return true;
      }

      let packets: Packet[];
      try {
        packets = parseFrame(frame);
      } catch {
        return true; // Anything we can't read is kept as it came.
      }
      if (packets.length === 0) return true;
      let news = false;
      for (const packet of packets) {
        const value = fingerprint(packet);
        const key = "key" in packet ? packet.key : null;
        if (value === null || key === null) {
          news = true;
          continue;
        }
        // A segment the calendar doesn't know, or one that is open, is never filtered.
        if (!closedNow.has(key.slice(0, key.indexOf(":")))) {
          last.delete(key);
          news = true;
        } else if (last.get(key) !== value) {
          last.set(key, value);
          news = true;
        }
      }
      return news;
    },
  };
}
