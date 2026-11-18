// Turns a day's journal records back into what happened that day: per-instrument prices, volume
// and VWAP, a per-minute benchmark bar and market breadth, and what the feed itself delivered
// (frames, packets, gaps, socket states, engine runs). Pure: records go in through add(), in
// file order, and summary() can be called at any point, so a file can be read while it grows.

import type { JournalSession, SessionDerivatives, SessionInstrument, SessionMinute, SessionOptionQuote } from "../../lib/engine/protocol.ts";
import { parseFrame, type Packet } from "../../lib/live/feed/packets.ts";
import type { JournalRecord } from "./format.ts";

const MINUTE_MS = 60_000;
const MAX_STATES = 50;
/** Strikes each side of the money summed into the per-minute call and put open interest. The recorder keeps 15. */
export const OI_BAND = 10;

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
  /** The underlying whose futures and options fill `derivatives` (Dhan's symbol). Its index should be `benchmark`. */
  underlying?: string;
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
  /** Futures and options only. */
  fno: FnoLine | null;
}

/** What a future or option's Full packets add: open interest, the book, and who traded. */
interface FnoLine {
  oi: number | null;
  /** Open interest received before the day started: the previous session's close. */
  oiBefore: number | null;
  bid: number | null;
  ask: number | null;
  /** Per session minute, holes where nothing arrived. */
  oiAt: number[];
  vwapAt: number[];
  bidQtyAt: number[];
  askQtyAt: number[];
  /** Quantity traded per minute by buyers taking the ask and by sellers hitting the bid. */
  buys: number[];
  sells: number[];
  /** The previous packet, to class the trades in the next one. Null until the day's first packet. */
  last: { volume: number; ltp: number; bid: number | null; ask: number | null; side: -1 | 0 | 1 } | null;
}

/** A contract as the recorder's `instruments` records describe it. */
interface Contract {
  kind: "future" | "option";
  underlying: string;
  name: string;
  expiry: string;
  strike: number | null;
  type: "CE" | "PE" | null;
  lotSize: number;
}

export function createSessionAggregator(options: SessionAggregatorOptions): SessionAggregator {
  const { date, session, dayStart, benchmark, names, underlying = "NIFTY" } = options;
  const lines = new Map<string, Line>();
  const contracts = new Map<string, Contract>();
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
        fno: key.startsWith("NSE_FNO:") ? { oi: null, oiBefore: null, bid: null, ask: null, oiAt: [], vwapAt: [], bidQtyAt: [], askQtyAt: [], buys: [], sells: [], last: null } : null,
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
      case "instruments":
        if (Array.isArray(data.items)) for (const item of data.items) describe(item);
        break;
    }
  }

  function describe(item: unknown) {
    if (!item || typeof item !== "object") return;
    const i = item as Record<string, unknown>;
    if (typeof i.key !== "string" || (i.kind !== "future" && i.kind !== "option") || typeof i.expiry !== "string") return;
    contracts.set(i.key, {
      kind: i.kind,
      underlying: String(i.underlying ?? ""),
      name: String(i.name ?? i.key),
      expiry: i.expiry,
      strike: typeof i.strike === "number" ? i.strike : null,
      type: i.type === "CE" || i.type === "PE" ? i.type : null,
      lotSize: typeof i.lotSize === "number" ? i.lotSize : 1,
    });
  }

  /** Open interest, the book and the classed trades from a future's or option's packet. */
  function fnoPacket(f: FnoLine, packet: Extract<Packet, { kind: "quote" }>, minuteIndex: number | null) {
    if (packet.oi !== undefined && packet.oi > 0) f.oi = packet.oi;
    const best = packet.depth?.[0];
    const bid = best && best.bid > 0 && best.bidQty > 0 ? best.bid : null;
    const ask = best && best.ask > 0 && best.askQty > 0 ? best.ask : null;
    const last = f.last;
    let side: -1 | 0 | 1 = last?.side ?? 0;
    if (last && packet.volume > last.volume) {
      // A trade at or through the ask was a buyer taking it; at or through the bid, a seller.
      // Between the two, the tick decides; an unchanged price keeps the last trade's side.
      if (last.ask !== null && packet.ltp >= last.ask) side = 1;
      else if (last.bid !== null && packet.ltp <= last.bid) side = -1;
      else if (packet.ltp > last.ltp) side = 1;
      else if (packet.ltp < last.ltp) side = -1;
      if (minuteIndex !== null && side !== 0) {
        const traded = packet.volume - last.volume;
        const into = side > 0 ? f.buys : f.sells;
        into[minuteIndex] = (into[minuteIndex] ?? 0) + traded;
      }
    }
    f.last = { volume: packet.volume, ltp: packet.ltp, bid, ask, side };
    f.bid = bid;
    f.ask = ask;
    if (minuteIndex === null) return;
    if (f.oi !== null) f.oiAt[minuteIndex] = f.oi;
    if (packet.atp > 0) f.vwapAt[minuteIndex] = packet.atp;
    if (packet.depth) {
      f.bidQtyAt[minuteIndex] = packet.depth.reduce((a, level) => a + Math.max(0, level.bidQty), 0);
      f.askQtyAt[minuteIndex] = packet.depth.reduce((a, level) => a + Math.max(0, level.askQty), 0);
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
      if (packet.kind === "oi") {
        // Quote mode sends open interest in its own packet.
        const f = line(packet.key).fno;
        if (f && packet.oi > 0) {
          if (dayStart !== null && time < dayStart) f.oiBefore = packet.oi;
          else {
            f.oi = packet.oi;
            if (minute) f.oiAt[(minute.at - session!.open) / MINUTE_MS] = packet.oi;
          }
        }
        continue;
      }
      if (packet.kind !== "ticker" && packet.kind !== "quote") continue;

      const l = line(packet.key);
      l.mode ??= packet.kind === "ticker" ? "ticker" : packet.code === 8 ? "full" : "quote";
      if (dayStart !== null && time < dayStart) {
        l.before = packet.ltp;
        if (l.fno && packet.kind === "quote") {
          if (packet.oi !== undefined && packet.oi > 0) l.fno.oiBefore = packet.oi;
          // The morning snapshot carries the previous day's totals: trades are classed from the day's first packet.
          l.fno.last = null;
        }
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
        if (l.fno) fnoPacket(l.fno, packet, minute ? (minute.at - session!.open) / MINUTE_MS : null);
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
          const contract = contracts.get(l.key);
          const name = names(l.key) ?? (contract ? { symbol: contract.name, name: null, sector: contract.kind === "future" ? "Futures" : "Options" } : null);
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
        ...(contracts.size > 0 ? { derivatives: derivatives(out.length) } : {}),
      };
    },
  };

  /** The underlying's near-month future and nearest option expiry, minute by minute. */
  function derivatives(n: number): SessionDerivatives {
    const traded = (key: string) => (lines.get(key)?.packets ?? 0) > 0;
    const ours = [...contracts].filter(([key, c]) => c.underlying === underlying && c.expiry >= date && traded(key));
    const byExpiry = (a: [string, Contract], b: [string, Contract]) => a[1].expiry.localeCompare(b[1].expiry);

    let future: SessionDerivatives["future"] = null;
    const near = ours.filter(([, c]) => c.kind === "future").sort(byExpiry)[0];
    if (near) {
      const [key, c] = near;
      const l = lines.get(key)!;
      const f = l.fno!;
      future = {
        key,
        name: c.name,
        expiry: c.expiry,
        lotSize: c.lotSize,
        oiBefore: f.oiBefore,
        closes: carried(l.closes, n, round),
        oi: carried(f.oiAt, n),
        vwap: carried(f.vwapAt, n, round),
        buys: Array.from({ length: n }, (_, i) => f.buys[i] ?? 0),
        sells: Array.from({ length: n }, (_, i) => f.sells[i] ?? 0),
        bidQty: carried(f.bidQtyAt, n),
        askQty: carried(f.askQtyAt, n),
      };
    }

    let options: SessionDerivatives["options"] = null;
    const calls = ours.filter(([, c]) => c.kind === "option" && c.strike !== null && c.type !== null);
    const expiry = calls.map(([, c]) => c.expiry).sort()[0];
    if (expiry) {
      const chain = new Map<number, { call: string | null; put: string | null }>();
      let lotSize = 1;
      for (const [key, c] of calls) {
        if (c.expiry !== expiry) continue;
        lotSize = c.lotSize;
        const row = chain.get(c.strike!) ?? { call: null, put: null };
        row[c.type === "CE" ? "call" : "put"] = key;
        chain.set(c.strike!, row);
      }
      const strikes = [...chain.keys()].sort((a, b) => a - b);
      let step = Infinity;
      for (let i = 1; i < strikes.length; i += 1) step = Math.min(step, strikes[i] - strikes[i - 1]);
      if (!Number.isFinite(step)) step = 50;
      const series = new Map<string, { closes: (number | null)[]; oi: (number | null)[] }>();
      const of = (key: string | null) => {
        if (!key) return null;
        let found = series.get(key);
        if (!found) {
          const l = lines.get(key);
          found = { closes: carried(l?.closes ?? [], n), oi: carried(l?.fno?.oiAt ?? [], n) };
          series.set(key, found);
        }
        return found;
      };
      const spot = carried(lines.get(benchmark)?.closes ?? [], n);
      const atm: (number | null)[] = [];
      const callOi: (number | null)[] = [];
      const putOi: (number | null)[] = [];
      const straddle: (number | null)[] = [];
      for (let t = 0; t < n; t += 1) {
        const level = spot[t];
        if (level === null || strikes.length === 0) {
          atm.push(null);
          callOi.push(null);
          putOi.push(null);
          straddle.push(null);
          continue;
        }
        const centre = strikes.reduce((best, k) => (Math.abs(k - level) < Math.abs(best - level) ? k : best), strikes[0]);
        atm.push(centre);
        const band = strikes.filter((k) => Math.abs(k - centre) <= OI_BAND * step + 1e-9);
        let c: number | null = band.length === 2 * OI_BAND + 1 ? 0 : null;
        let p: number | null = c;
        for (const k of band) {
          const row = chain.get(k)!;
          const co = of(row.call)?.oi[t] ?? null;
          const po = of(row.put)?.oi[t] ?? null;
          c = c === null || co === null ? null : c + co;
          p = p === null || po === null ? null : p + po;
        }
        callOi.push(c);
        putOi.push(p);
        const row = chain.get(centre)!;
        const cc = of(row.call)?.closes[t] ?? null;
        const pc = of(row.put)?.closes[t] ?? null;
        straddle.push(cc === null || pc === null ? null : round(cc + pc));
      }
      const quoteOf = (key: string | null): SessionOptionQuote | null => {
        const l = key ? lines.get(key) : undefined;
        if (!key || !l) return null;
        return { key, ltp: roundOrNull(l.ltp), bid: roundOrNull(l.fno?.bid ?? null), ask: roundOrNull(l.fno?.ask ?? null), oi: l.fno?.oi ?? null, oiBefore: l.fno?.oiBefore ?? null, volume: l.volume };
      };
      options = {
        expiry,
        lotSize,
        step,
        band: OI_BAND,
        atm,
        callOi,
        putOi,
        straddle,
        strikes: strikes.map((strike) => ({ strike, call: quoteOf(chain.get(strike)!.call), put: quoteOf(chain.get(strike)!.put) })),
      };
    }
    return { future, options };
  }
}

/** One value per minute: the last one set at or before it, null before the first. */
function carried(values: readonly number[], n: number, map: (value: number) => number = (v) => v): (number | null)[] {
  const out: (number | null)[] = [];
  let last: number | null = null;
  for (let i = 0; i < n; i += 1) {
    if (values[i] !== undefined) last = map(values[i]);
    out.push(last);
  }
  return out;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function roundOrNull(value: number | null) {
  return value === null ? null : round(value);
}
