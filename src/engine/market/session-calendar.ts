// Trading days and hours per segment, from config/engine/calendar.json. All times are IST,
// computed from a fixed +05:30 offset (India has no daylight saving), so nothing depends on
// the server's time zone. This VM runs in UTC.

import defaultCalendar from "../../../config/engine/calendar.json" with { type: "json" };

export interface CalendarData {
  version: number;
  utcOffsetMinutes: number;
  coveredYears: number[];
  segments: Record<
    string,
    { exchange: string; open: string; close: string; preOpen?: { start: string; end: string } }
  >;
  holidays: Record<string, { date: string; name: string }[]>;
  specialSessions: {
    date: string;
    name: string;
    exchange: string;
    open: string | null;
    close: string | null;
  }[];
}

export type SessionPhase = "pre-open" | "open" | "closed";

export interface Session {
  /** IST trading date, YYYY-MM-DD. */
  date: string;
  open: number;
  close: number;
  preOpen?: { start: number; end: number };
  special?: string;
}

export interface SessionCalendar {
  segments(): string[];
  /** The IST calendar date of an instant, YYYY-MM-DD. Journal files are named by it. */
  istDate(time: number): string;
  /** False for dates in years the calendar has no holiday list for. */
  isCovered(date: string): boolean;
  holiday(segment: string, date: string): string | null;
  /** The segment's session on an IST date, or null when it doesn't trade that day. */
  session(segment: string, date: string): Session | null;
  phaseAt(segment: string, time: number): SessionPhase;
  /** The next session that hasn't closed yet at `time` (may be the current one). */
  nextSession(segment: string, time: number): Session | null;
}

const DAY_MS = 86_400_000;
const MAX_LOOKAHEAD_DAYS = 30;

export function createSessionCalendar(data: CalendarData = defaultCalendar as CalendarData): SessionCalendar {
  const offsetMs = data.utcOffsetMinutes * 60_000;
  const holidays = new Map<string, Map<string, string>>();
  for (const [exchange, list] of Object.entries(data.holidays)) {
    holidays.set(exchange, new Map(list.map((h) => [h.date, h.name])));
  }

  function segmentInfo(segment: string) {
    const info = data.segments[segment];
    if (!info) throw new Error(`Unknown segment ${segment} in the session calendar`);
    return info;
  }

  function istDate(time: number) {
    return new Date(time + offsetMs).toISOString().slice(0, 10);
  }

  /** The instant of an IST wall-clock time on an IST date. */
  function at(date: string, hhmm: string) {
    const [hours, minutes] = hhmm.split(":").map(Number);
    return Date.parse(`${date}T00:00:00Z`) + (hours * 60 + minutes) * 60_000 - offsetMs;
  }

  function holiday(segment: string, date: string) {
    return holidays.get(segmentInfo(segment).exchange)?.get(date) ?? null;
  }

  function session(segment: string, date: string): Session | null {
    const info = segmentInfo(segment);
    const special = data.specialSessions.find((s) => s.date === date && s.exchange === info.exchange);
    if (special) {
      return special.open && special.close
        ? { date, open: at(date, special.open), close: at(date, special.close), special: special.name }
        : null;
    }
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6 || holiday(segment, date)) return null;
    return {
      date,
      open: at(date, info.open),
      close: at(date, info.close),
      ...(info.preOpen && { preOpen: { start: at(date, info.preOpen.start), end: at(date, info.preOpen.end) } }),
    };
  }

  return {
    segments: () => Object.keys(data.segments),
    istDate,
    isCovered: (date) => data.coveredYears.includes(Number(date.slice(0, 4))),
    holiday,
    session,
    phaseAt(segment, time) {
      const today = session(segment, istDate(time));
      if (!today) return "closed";
      if (time >= today.open && time < today.close) return "open";
      if (today.preOpen && time >= today.preOpen.start && time < today.preOpen.end) return "pre-open";
      return "closed";
    },
    nextSession(segment, time) {
      for (let day = 0; day <= MAX_LOOKAHEAD_DAYS; day += 1) {
        const candidate = session(segment, istDate(time + day * DAY_MS));
        if (candidate && candidate.close > time) return candidate;
      }
      return null;
    },
  };
}
