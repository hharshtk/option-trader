// Turns a day's journal records back into what happened that day: per-instrument prices, volume
// and VWAP, a per-minute benchmark bar and market breadth, and what the feed itself delivered
// (frames, packets, gaps, socket states, engine runs). Pure: records go in through add(), in
// file order, and summary() can be called at any point, so a file can be read while it grows.

import type { JournalSession, SessionInstrument, SessionMinute } from "../../lib/engine/protocol.ts";
import { parseFrame } from "../../lib/live/feed/packets.ts";
import type { JournalRecord } from "./format.ts";

const MINUTE_MS = 60_000;
const MAX_STATES = 50;

export interface InstrumentName {
  symbol: string;
  name: string | null;
  sector: string | null;
}

export interface SessionAggregatorOptions {
  date: string;
  /** The exchange session that day, or null on a weekend or holiday. */
  session: { open: number; close: number } | null;
  /**
   * When the day's own data starts (NSE pre-open, 09:00 IST). Prices received earlier are the
   * snapshot Dhan sends on subscribe: the previous session's close. Null treats every packet as
   * the day's own.
   */
  dayStart: number | null;
  /** Instrument key of the index drawn as the day's bars, e.g. `IDX_I:13`. */
  benchmark: string;
  names: (key: string) => InstrumentName | null;
}

export interface SessionAggregator {
  add(record: JournalRecord): void;
  summary(extra: { builtAt: number; readMs: number; bytes: number }): JournalSession;
}

interface Line {
  key: string;
  mode: string | null;
  packets: number;
  /** From Dhan's previous-close packet, received during the day. */
  prevClose: number | null;
  /** Last price received before the day started. */
  before: number | null;
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  vwap: number | null;
  volume: number | null;
  buyQty: number | null;
  sellQty: number | null;
  firstAt: number | null;
  lastAt: number | null;
  /** Last price in each session minute; holes where it didn't tick. */
  closes: number[];
}

export function createSessionAggregator(options: SessionAggregatorOptions): SessionAggregator {
  const { date, session, dayStart, benchmark, names } = options;
  const lines = new Map<string, Line>();
  const minutes: SessionMinute[] = [];
  const packets: Record<string, number> = {};
  const events: Record<string, number> = {};
  const runs: JournalSession["runs"] = [];
  const gaps: JournalSession["gaps"] = [];
  const states: JournalSession["states"] = [];
  let records = 0;
  let frames = 0;
  let controls = 0;
  let firstFrameAt: number | null = null;
  let lastFrameAt: number | null = null;
  /** Minutes before this index have final breadth. */
  let settled = 0;

  function line(key: string): Line {
    let found = lines.get(key);
    if (!found) {
      found = {
        key,
        mode: null,
        packets: 0,
        prevClose: null,
        before: null,
        ltp: null,
        open: null,
        high: null,
        low: null,
        vwap: null,
        volume: null,
        buyQty: null,
        sellQty: null,
        firstAt: null,
        lastAt: null,
        closes: [],
      };
      lines.set(key, found);
    }
    return found;
  }

  // The last price before the day started is the previous session's close.
  const reference = (l: Line) => l.before ?? l.prevClose;

  function breadth() {
    let advancers = 0;
    let decliners = 0;
    for (const l of lines.values()) {
      if (!l.key.startsWith("NSE_EQ:") && !l.key.startsWith("BSE_EQ:")) continue;
      const ref = reference(l);
      if (ref === null || l.ltp === null) continue;
      if (l.ltp > ref) advancers += 1;
      else if (l.ltp < ref) decliners += 1;
    }
    return { advancers, decliners };
  }

  /** The session minute `time` falls in, creating it (and any skipped ones) as needed. */
  function minuteAt(time: number): SessionMinute | null {
    if (!session || time < session.open || time >= session.close) return null;
    const index = Math.floor((time - session.open) / MINUTE_MS);
    if (index >= minutes.length) {
      // The minutes being left behind get the breadth as it stood when they ended.
      const { advancers, decliners } = breadth();
      for (; settled < minutes.length; settled += 1) Object.assign(minutes[settled], { advancers, decliners });
      while (minutes.length <= index) {
        minutes.push({ at: session.open + minutes.length * MINUTE_MS, frames: 0, packets: 0, bar: null, advancers, decliners });
      }
      settled = index;
    }
    return minutes[index];
  }

  function control(record: JournalRecord) {
    const data = record.control!;
    controls += 1;
    events[data.kind] = (events[data.kind] ?? 0) + 1;
    switch (data.kind) {
      case "engine-start":
        runs.push({ startedAt: record.recvTs, version: typeof data.version === "string" ? data.version : null, stoppedAt: null, reason: null });
        break;
      case "engine-stop": {
        const run = runs.at(-1);
        if (run && run.stoppedAt === null) Object.assign(run, { stoppedAt: record.recvTs, reason: String(data.reason ?? "") || null });
        break;
      }
      case "gap":
        gaps.push({ reason: String(data.reason ?? "unknown"), from: Number(data.from), to: Number(data.to), connection: record.connection });
        break;
      case "state": {
        const state = data.state as { state?: string; reason?: string } | undefined;
        states.push({ at: record.recvTs, connection: record.connection, state: state?.state ?? "unknown", reason: state?.reason ?? null });
        if (states.length > MAX_STATES) states.shift();
        break;
      }
      case "subscribe":
        if (Array.isArray(data.keys)) for (const key of data.keys) line(String(key)).mode = typeof data.mode === "string" ? data.mode : "ticker";
        break;
    }
  }

  function frame(record: JournalRecord) {
    const time = record.recvTs;
    frames += 1;
    firstFrameAt ??= time;
    lastFrameAt = time;
    const minute = minuteAt(time);
    if (minute) minute.frames += 1;

    for (const packet of parseFrame(record.frame!)) {
      packets[packet.kind] = (packets[packet.kind] ?? 0) + 1;
      if (minute) minute.packets += 1;
      if (packet.kind === "prevClose") {
        // Before the day starts Dhan still sends the close before the previous one (checked
        // 16 November 2026: Thursday's close on Monday morning), so only the day's own count.
        if (dayStart === null || time >= dayStart) line(packet.key).prevClose = packet.prevClose;
        continue;
      }
      if (packet.kind !== "ticker" && packet.kind !== "quote") continue;

      const l = line(packet.key);
      l.mode ??= packet.kind === "ticker" ? "ticker" : packet.code === 8 ? "full" : "quote";
      if (dayStart !== null && time < dayStart) {
        l.before = packet.ltp;
        continue;
      }
      const price = packet.ltp;
      l.packets += 1;
      l.firstAt ??= time;
      l.lastAt = time;
      l.ltp = price;
      if (packet.kind === "quote") {
        // The exchange's own day figures; zero means not set yet.
        if (packet.open > 0) l.open = packet.open;
        if (packet.high > 0) l.high = packet.high;
        if (packet.low > 0) l.low = packet.low;
        l.vwap = packet.atp > 0 ? packet.atp : l.vwap;
        l.volume = packet.volume;
        l.buyQty = packet.totalBuyQty;
        l.sellQty = packet.totalSellQty;
      } else if (minute || !session) {
        // Ticker mode carries no day figures: build them from the session's ticks.
        l.open ??= price;
        l.high = Math.max(l.high ?? price, price);
        l.low = Math.min(l.low ?? price, price);
      }
      if (minute) {
        l.closes[(minute.at - session!.open) / MINUTE_MS] = price;
        if (packet.key === benchmark) {
          const bar = minute.bar;
          minute.bar = bar ? [bar[0], Math.max(bar[1], price), Math.min(bar[2], price), price] : [price, price, price, price];
        }
      }
    }
  }

  return {
    add(record) {
      records += 1;
      if (record.type === "control") control(record);
      else frame(record);
    },

    summary({ builtAt, readMs, bytes }) {
      // The minute in progress shows breadth as of now.
      const out = minutes.map((m, index) => (index >= settled ? { ...m, ...breadth() } : { ...m }));
      const instruments: SessionInstrument[] = [...lines.values()]
        .filter((l) => l.packets > 0 || l.before !== null || l.prevClose !== null)
        .map((l) => {
          const name = names(l.key);
          const closes: (number | null)[] = [];
          let last: number | null = null;
          for (let i = 0; i < out.length; i += 1) {
            if (l.closes[i] !== undefined) last = round(l.closes[i]);
            closes.push(last);
          }
          return {
            key: l.key,
            symbol: name?.symbol ?? l.key,
            name: name?.name ?? null,
            sector: name?.sector ?? null,
            mode: l.mode,
            packets: l.packets,
            reference: roundOrNull(reference(l)),
            ltp: roundOrNull(l.ltp),
            open: roundOrNull(l.open),
            high: roundOrNull(l.high),
            low: roundOrNull(l.low),
            vwap: roundOrNull(l.vwap),
            volume: l.volume,
            buyQty: l.buyQty,
            sellQty: l.sellQty,
            firstAt: l.firstAt,
            lastAt: l.lastAt,
            closes,
          };
        });
      for (const m of out) if (m.bar) m.bar = m.bar.map(round) as SessionMinute["bar"];

      return {
        date,
        session,
        builtAt,
        readMs,
        file: { bytes, records, frames, controls, packets: { ...packets }, events: { ...events }, firstFrameAt, lastFrameAt },
        runs: runs.map((r) => ({ ...r })),
        gaps: [...gaps],
        states: [...states],
        benchmark,
        minutes: out,
        instruments,
      };
    },
  };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function roundOrNull(value: number | null) {
  return value === null ? null : round(value);
}
