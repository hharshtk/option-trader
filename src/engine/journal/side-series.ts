// Adds the side files to a journal session: the near-month future's 20-level book and the
// nearest expiry's option chain, read at each minute's end, as `derivatives.book` and
// `derivatives.chain`, and the future's five-level OFI read 1.5 s after it, as `derivatives.ofi`. The same code runs on the live day (files still growing) and on a
// replayed day (cut at the replay's position), so Pulse, trading and the decision API see the
// same numbers either way. A finished minute is read once and kept.

import type { JournalSession, SessionBook, SessionChain, SessionOfi } from "../../lib/engine/protocol.ts";
import { readChain, type ChainReading } from "../../lib/insight/chain.ts";
import { tradingMinutesToExpiry } from "../../lib/insight/derivatives.ts";
import type { SideFiles } from "../replay/side-data.ts";
import type { OfiEvent } from "./depth-ofi.ts";

const MINUTE_MS = 60_000;
/** The underlying whose chain the session carries. */
const UNDERLYING = "NIFTY";

interface BookMinute {
  bidQty: number;
  askQty: number;
  bidOrders: number;
  askOrders: number;
  spread: number | null;
}

export interface SideSeries {
  /** The session with `derivatives.book`, `.chain` and `.ofi` added, as of `position` (Infinity: everything so far). */
  apply(session: JournalSession, position: number): Promise<JournalSession>;
}

export function createSideSeries(files: () => SideFiles | null): SideSeries {
  // A finished minute's book, by contract and minute; a chain reading, by expiry and snapshot.
  const books = new Map<string, BookMinute | null>();
  const readings = new Map<string, { reading: ChainReading | null; at: number | null }>();

  function bookSeries(session: JournalSession, key: string, position: number): SessionBook | null {
    const depth = files()?.depth;
    if (!depth || !session.session) return null;
    const { open } = session.session;
    const out: SessionBook = { key, bidQty: [], askQty: [], bidOrders: [], askOrders: [], spread: [] };
    let any = false;
    for (let t = 0; t < session.minutes.length; t += 1) {
      const end = open + (t + 1) * MINUTE_MS - 1;
      const at = Math.min(end, position);
      // Final once the minute is over and the file holds what came after it.
      const final = end <= position && depth.lastAt() > end;
      const id = `${key} ${t}`;
      let minute = final ? books.get(id) : undefined;
      if (minute === undefined) {
        const book = depth.book(key, at);
        minute = book && {
          bidQty: book.bids.reduce((a, l) => a + l.qty, 0),
          askQty: book.asks.reduce((a, l) => a + l.qty, 0),
          bidOrders: book.bids.reduce((a, l) => a + l.orders, 0),
          askOrders: book.asks.reduce((a, l) => a + l.orders, 0),
          spread: book.bids[0] && book.asks[0] ? Math.round((book.asks[0].price - book.bids[0].price) * 100) / 100 : null,
        };
        if (final) books.set(id, minute);
      }
      if (minute) any = true;
      out.bidQty.push(minute?.bidQty ?? null);
      out.askQty.push(minute?.askQty ?? null);
      out.bidOrders.push(minute?.bidOrders ?? null);
      out.askOrders.push(minute?.askOrders ?? null);
      out.spread.push(minute?.spread ?? null);
    }
    return any ? out : null;
  }

  function chainSeries(session: JournalSession, position: number): SessionChain | null {
    const chain = files()?.chain;
    if (!chain || !session.session) return null;
    const { open } = session.session;
    const day = { open: session.session.open, close: session.session.close };
    const expiries = chain.expiries(UNDERLYING, position).filter((e) => e >= session.date);
    const [expiry, nextExpiry = null] = expiries;
    if (!expiry) return null;

    const readingAt = (e: string, at: number): { reading: ChainReading | null; at: number | null } => {
      const index = chain.latest(UNDERLYING, e, at);
      if (index < 0) return { reading: null, at: null };
      const id = `${e} ${index}`;
      let found = readings.get(id);
      if (!found) {
        const snapshot = chain.snapshot(UNDERLYING, e, index);
        found = {
          reading: snapshot ? readChain(snapshot, tradingMinutesToExpiry(snapshot.at, e, session.date, day)) : null,
          at: snapshot?.at ?? null,
        };
        readings.set(id, found);
      }
      return found;
    };

    const out: SessionChain = {
      expiry,
      nextExpiry,
      at: [],
      spot: [],
      atm: [],
      forward: [],
      ivPct: [],
      skewPct: [],
      straddle: [],
      callOi: [],
      putOi: [],
      callOiChange: [],
      putOiChange: [],
      callWall: [],
      callWallOi: [],
      putWall: [],
      putWallOi: [],
      nextIvPct: [],
      nextStraddle: [],
    };
    let any = false;
    for (let t = 0; t < session.minutes.length; t += 1) {
      const at = Math.min(open + (t + 1) * MINUTE_MS - 1, position);
      const { reading: r, at: when } = readingAt(expiry, at);
      const next = nextExpiry ? readingAt(nextExpiry, at).reading : null;
      if (r) any = true;
      out.at.push(r ? when : null);
      out.spot.push(r?.spot ?? null);
      out.atm.push(r?.atm ?? null);
      out.forward.push(r?.forward ?? null);
      out.ivPct.push(r?.ivPct ?? null);
      out.skewPct.push(r?.skewPct ?? null);
      out.straddle.push(r?.straddle ?? null);
      out.callOi.push(r?.callOi ?? null);
      out.putOi.push(r?.putOi ?? null);
      out.callOiChange.push(r?.callOiChange ?? null);
      out.putOiChange.push(r?.putOiChange ?? null);
      out.callWall.push(r?.callWall?.strike ?? null);
      out.callWallOi.push(r?.callWall?.oi ?? null);
      out.putWall.push(r?.putWall?.strike ?? null);
      out.putWallOi.push(r?.putWall?.oi ?? null);
      out.nextIvPct.push(next?.ivPct ?? null);
      out.nextStraddle.push(next?.straddle ?? null);
    }
    return any ? out : null;
  }

  async function ofiSeries(session: JournalSession, key: string, position: number): Promise<SessionOfi | null> {
    const ofi = files()?.ofi;
    if (!ofi || !session.session) return null;
    // Live, the position is Infinity: readings are taken up to now.
    const until = Math.min(position, session.builtAt);
    const readings = await ofi.readings({ open: session.session.open, key, events: interruptions(session) }, session.minutes.length, until);
    if (!readings.some((r) => r)) return null;
    return { key, value: readings.map((r) => r?.value ?? null), status: readings.map((r) => r?.reason ?? null) };
  }

  return {
    async apply(session, position) {
      if (!files() || !session.session) return session;
      const derivatives = session.derivatives ?? { future: null, options: null };
      const key = derivatives.future?.key;
      const book = key ? bookSeries(session, key, position) : null;
      const chain = chainSeries(session, position);
      const ofi = key ? await ofiSeries(session, key, position) : null;
      if (!book && !chain && !ofi && !session.derivatives) return session;
      return { ...session, derivatives: { ...derivatives, book, chain, ofi } };
    },
  };
}

/** What in the main journal interrupts the OFI: each engine start and stop, and each gap of the whole feed or of the engine. */
function interruptions(session: JournalSession): OfiEvent[] {
  const times = [
    ...session.runs.flatMap((run) => (run.stoppedAt === null ? [run.startedAt] : [run.startedAt, run.stoppedAt])),
    // A gap is recorded when it ends.
    ...session.gaps.filter((gap) => gap.connection === 0 || gap.reason === "suspend").map((gap) => gap.to),
  ];
  return times.filter(Number.isFinite).sort((a, b) => a - b).map((at) => ({ at }));
}
