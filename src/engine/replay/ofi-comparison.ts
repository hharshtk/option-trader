import { existsSync } from "node:fs";
import path from "node:path";
import { AUCTION_MINUTE, HORIZON, PREDICTORS } from "../../lib/decide/predict.ts";
import { entryAt, LIMITS, type MinuteQuote } from "../../lib/decide/simulate.ts";
import { minuteState } from "../../lib/decide/state.ts";
import type { OfiReplayComparison, OfiReplayDelay } from "../../lib/engine/ofi.ts";
import { DEFAULT_TRADING_CONFIG } from "../../lib/engine/trading.ts";
import { computePulse } from "../../lib/insight/pulse.ts";
import { parseDepthFrame } from "../../lib/live/feed/depth-packets.ts";
import { parseFrame, parseInstrumentKey } from "../../lib/live/feed/packets.ts";
import { paise, roundTripCharges } from "../../lib/trading/charges.ts";
import { READ_DELAY_MS } from "../decide/day-table.ts";
import { createRecordCursor, fileSource } from "../journal/byte-source.ts";
import type { JournalRecord } from "../journal/format.ts";
import { createDayAggregator } from "../journal/session-reader.ts";
import { createSessionCalendar, type Session } from "../market/session-calendar.ts";
import { fillPrice } from "../trading/paper-broker.ts";
import { NIFTY_CONSTITUENTS } from "../trading/strategy.ts";
import { createSnapshotOfi, type OfiReading } from "./snapshot-ofi.ts";

const MINUTE_MS = 60_000;
const MAX_QUOTE_AGE_MS = 2_000;
const PRIMARY_DELAY_MS = 300;
const DELAYS = [0, 100, PRIMARY_DELAY_MS, 500, 1_000, 3_000];
const MAX_DELAY_MS = 3_000;
const FORWARD_FROM = "2026-11-25";
const BREADTH = PREDICTORS.find((predictor) => predictor.id === "signal:breadth")!;
const FILLS = { ...DEFAULT_TRADING_CONFIG.fills, slippage: 0.05 };
const RUN_BOUNDARY = new Set(["file-open", "engine-start", "engine-stop", "replay-start", "replay-stop"]);

type FutureEvent = { at: number; key?: string | null };
type Option = Pick<MinuteQuote, "key" | "strike" | "type" | "lotSize"> & { expiry: string; tickSize: number };
type Quote = MinuteQuote & { at: number; connection: number; askQty: number; bidQty: number };
type Fill = { entry: number | null; net: number | null };
type Opportunity = { cutoff: number; vote: 1 | -1; option: Option; fills: Fill[] };

function roundPrice(price: number, quantity: number) {
  return price > 0 && quantity > 0 ? paise(price) : null;
}

/** Replay the shared breadth and entry rules, with the frozen experiment's exact fill times. */
async function replayBreadth(file: string, session: Session, calendar: ReturnType<typeof createSessionCalendar>) {
  const { date, open, close } = session;
  const auction = Math.min(close, open + AUCTION_MINUTE * MINUTE_MS);
  const source = fileSource(file);
  const cursor = createRecordCursor(source, { chunkBytes: 1024 * 1024 });
  const aggregator = createDayAggregator(date, calendar);
  const options = new Map<string, Option>();
  const futures = new Map<string, string>();
  const latest = new Map<string, Quote>();
  const connectionStart = new Map<number, number>();
  const events: FutureEvent[] = [];
  const opportunities = new Map<number, Opportunity>();
  let nearest: string | null = null;
  let front: string | null = null;
  let runStart = 0;
  let lastFrameAt = 0;
  let votes = 0;

  function add(record: JournalRecord) {
    aggregator.add(record);
    const { control, frame, recvTs: at, connection } = record;
    if (control) {
      const gap = control.kind === "gap";
      if (RUN_BOUNDARY.has(control.kind) || (gap && (connection === 0 || control.reason === "suspend"))) {
        runStart = Math.max(runStart, at);
        events.push({ at });
      }
      if (control.kind === "state" || (gap && connection > 0)) {
        connectionStart.set(connection, Math.max(connectionStart.get(connection) ?? 0, at));
      }
      if (control.kind !== "instruments" || !Array.isArray(control.items)) return;
      for (const item of control.items) {
        if (item?.underlying !== "NIFTY" || typeof item.key !== "string" || typeof item.expiry !== "string" || item.expiry < date) continue;
        if (item.kind === "future") futures.set(item.key, item.expiry);
        if (item.kind === "option" && (item.type === "CE" || item.type === "PE") && typeof item.strike === "number") {
          options.set(item.key, {
            key: item.key, expiry: item.expiry, type: item.type, strike: item.strike,
            lotSize: typeof item.lotSize === "number" ? item.lotSize : 0,
            tickSize: item.tickSize > 0 ? item.tickSize : LIMITS.tick,
          });
          if (nearest === null || item.expiry < nearest) nearest = item.expiry;
        }
      }
      const next = [...futures].sort(([a, x], [b, y]) => x.localeCompare(y) || a.localeCompare(b))[0]?.[0] ?? null;
      if (next !== front) {
        front = next;
        events.push({ at, key: front });
      }
      return;
    }

    if (!frame) return;
    lastFrameAt = Math.max(lastFrameAt, at);
    if (options.size === 0 || frame.length < 162) return;
    // Most records carry one packet. Avoid a second decode for stock and unrelated option quotes.
    if (frame.length === 162 && (frame[0] !== 8 || frame[3] !== 2 || !options.has(`NSE_FNO:${frame.readInt32LE(4)}`))) return;
    for (const packet of parseFrame(frame)) {
      if (packet.kind !== "quote" || !packet.depth) continue;
      const option = options.get(packet.key);
      if (!option) continue;
      const top = packet.depth[0];
      latest.set(packet.key, {
        ...option, at, connection,
        ltp: packet.ltp > 0 ? paise(packet.ltp) : null,
        bid: roundPrice(top.bid, top.bidQty), ask: roundPrice(top.ask, top.askQty),
        bidQty: top.bidQty, askQty: top.askQty,
      });
    }
  }

  function usable(key: string, at: number, units: number, side: "BUY" | "SELL") {
    const q = latest.get(key);
    if (!q || !q.bid || !q.ask || q.ask < q.bid) return null;
    if (q.at > at || at - q.at > MAX_QUOTE_AGE_MS || q.at < runStart || q.at < (connectionStart.get(q.connection) ?? 0)) return null;
    return (side === "BUY" ? q.askQty : q.bidQty) >= units ? q : null;
  }

  function price(side: "BUY" | "SELL", option: Option, quote: Quote) {
    return fillPrice({ side, reason: side === "BUY" ? "entry" : "time", trigger: null, contract: option }, {
      ...quote, ltp: quote.ltp ?? 0, oi: null, volume: null, candleOpen: null,
    }, FILLS).price;
  }

  function entry(candidate: Opportunity, at: number, index: number) {
    const option = candidate.option;
    const q = usable(option.key, at, option.lotSize, "BUY");
    candidate.fills[index] = { entry: q ? price("BUY", option, q) : null, net: null };
  }

  function exit(candidate: Opportunity, at: number, index: number) {
    const fill = candidate.fills[index];
    if (fill.entry === null) return;
    const option = candidate.option;
    const q = usable(option.key, at, option.lotSize, "SELL");
    if (!q) return;
    const sell = price("SELL", option, q);
    const charges = roundTripCharges(fill.entry * option.lotSize, sell * option.lotSize).total;
    fill.net = paise((sell - fill.entry) * option.lotSize - charges);
  }

  try {
    for (let t = 0; ; t++) {
      const minute = open + t * MINUTE_MS;
      const cutoff = minute + MINUTE_MS + READ_DELAY_MS;
      if (cutoff + MAX_DELAY_MS >= auction) break;

      await cursor.advance(cutoff, add);
      const closing = opportunities.get(t - HORIZON);
      if (closing) exit(closing, cutoff, 0);

      let opening: Opportunity | undefined;
      if (cutoff + HORIZON * MINUTE_MS + MAX_DELAY_MS < auction) {
        const pulse = computePulse(aggregator.summary({ builtAt: cutoff, readMs: 0, bytes: cursor.offset }), NIFTY_CONSTITUENTS);
        const state = pulse && minuteState(pulse, minute);
        const vote = state && BREADTH.call(state, []);
        if (vote) {
          votes++;
          const found = entryAt([...latest.values()].filter((q) => options.get(q.key)?.expiry === nearest), state.nifty, vote > 0 ? "CE" : "PE");
          if ("entry" in found && found.entry.book) {
            const option = options.get(found.entry.quote.key)!;
            if (Number.isInteger(option.lotSize) && option.lotSize > 0 && usable(option.key, cutoff, option.lotSize, "BUY")) {
              opening = { cutoff, vote, option, fills: [] };
              opportunities.set(t, opening);
              entry(opening, cutoff, 0);
            }
          }
        }
      }
      if (opening || closing) {
        for (let i = 1; i < DELAYS.length; i++) {
          const at = cutoff + DELAYS[i];
          await cursor.advance(at, add);
          if (opening) entry(opening, at, i);
          if (closing) exit(closing, at, i);
        }
      }
    }
    await cursor.advance(auction, add);
  } finally {
    source.close();
  }
  return { votes, hasOptionQuotes: latest.size > 0, partialRecording: lastFrameAt < auction - MINUTE_MS, events, opportunities: [...opportunities.values()] };
}

async function replayDepth(file: string, open: number, events: FutureEvent[], opportunities: Opportunity[]) {
  const source = fileSource(file);
  const cursor = createRecordCursor(source);
  const ofi = createSnapshotOfi();
  const readings: OfiReading[] = [];
  events.sort((a, b) => a.at - b.at);
  let eventIndex = 0;
  let lastAt = open;
  let instrument: ReturnType<typeof parseInstrumentKey> = null;

  function applyMainControls(until: number) {
    while (eventIndex < events.length && events[eventIndex].at <= until) {
      const { key } = events[eventIndex++];
      if (key !== undefined) instrument = key ? parseInstrumentKey(key) : null;
      ofi.reset();
    }
  }

  function add({ recvTs: at, control, frame }: JournalRecord) {
    if (at < open) return;
    if (at < lastAt) return ofi.reset();
    lastAt = at;
    applyMainControls(at);
    if (control && ["file-open", "state", "gap"].includes(control.kind)) return ofi.reset();
    if (!frame || !instrument) return;
    const packets = parseDepthFrame(frame, instrument);
    if (packets.some((packet) => packet.kind === "disconnect")) return ofi.reset();
    const depth = packets.filter((packet) => packet.kind === "depth");
    if (depth.length) ofi.observe(at, depth);
  }

  try {
    for (const { cutoff } of opportunities) {
      await cursor.advance(cutoff, add);
      applyMainControls(cutoff);
      readings.push(ofi.score(cutoff));
    }
  } finally {
    source.close();
  }
  return readings;
}

/** The paired, fixed-hold experiment for one recorded day, independent of the paper trader. */
export async function compareOfiReplay(directory: string, date: string): Promise<OfiReplayComparison> {
  const calendar = createSessionCalendar();
  const session = /^\d{4}-\d{2}-\d{2}$/.test(date) ? calendar.session("NSE_EQ", date) : null;
  if (!session || !Number.isFinite(session.open) || calendar.istDate(session.open) !== date) throw new Error("Choose a recorded NSE trading day.");
  const main = await replayBreadth(path.join(directory, `${date}.bin`), session, calendar);
  const depth = path.join(directory, `${date}.depth.bin`);
  const hasDepth = existsSync(depth);
  const readings = hasDepth && main.opportunities.length ? await replayDepth(depth, session.open, main.events, main.opportunities) : [];
  const abstentions = { missing: 0, stale: 0, invalid: 0, warmup: 0 };
  const gates = main.opportunities.map(({ vote }, index) => {
    const reading = readings[index] ?? { value: null, reason: "missing" as const };
    if (reading.value === null) {
      abstentions[reading.reason]++;
      return "abstention";
    }
    if (reading.reason === "flat") return "flat";
    return Math.sign(reading.value) === vote ? "agree" : "disagreement";
  });

  const delays = DELAYS.map((delayMs, i): OfiReplayDelay => {
    const breadth = { trades: 0, net: 0 };
    const confirmed = { trades: 0, net: 0 };
    const skipped = {
      disagreement: { count: 0, breadthNet: 0 },
      abstention: { count: 0, breadthNet: 0 },
      flat: { count: 0, breadthNet: 0 },
    };
    let missedEntries = 0;
    let unpricedExits = 0;
    for (const [index, opportunity] of main.opportunities.entries()) {
      const gate = gates[index];
      if (gate !== "agree") skipped[gate].count++;
      const fill = opportunity.fills[i];
      if (fill.entry === null) missedEntries++;
      else if (fill.net === null) unpricedExits++;
      else {
        const cents = Math.round(fill.net * 100);
        breadth.trades++;
        breadth.net += cents;
        if (gate === "agree") {
          confirmed.trades++;
          confirmed.net += cents;
        } else skipped[gate].breadthNet += cents;
      }
    }
    const graded = gates.length - unpricedExits;
    const liftPerOpportunity = graded ? (confirmed.net - breadth.net) / 100 / graded : null;
    breadth.net /= 100;
    confirmed.net /= 100;
    for (const group of Object.values(skipped)) group.breadthNet /= 100;
    return { delayMs, breadth, confirmed, liftPerOpportunity, missedEntries, unpricedExits, skipped };
  });

  return {
    date, exploratory: date < FORWARD_FROM, votes: main.votes, opportunities: gates.length,
    covered: gates.length - Object.values(abstentions).reduce((total, value) => total + value, 0),
    hasDepth, hasOptionQuotes: main.hasOptionQuotes, partialRecording: main.partialRecording,
    abstentions, primaryDelayMs: PRIMARY_DELAY_MS, delays,
  };
}
