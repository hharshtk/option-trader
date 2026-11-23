import type { DepthBookLevel, DepthPacket } from "../../lib/live/feed/depth-packets.ts";

const LEVELS = 5;
const WINDOW_MS = 60_000;
const MAX_AGE_MS = 2_000;
const MIN_COVERAGE_MS = 45_000;

type Side = { at: number; levels: DepthBookLevel[] };
type Book = { bid: Side; ask: Side };
type Snapshot = { at: number; depth: number[]; flow: number[] | null };
export type OfiAbstention = "missing" | "stale" | "invalid" | "warmup";
export type OfiReading = { reason: OfiAbstention; value: null } | { reason: "ok" | "flat"; value: number };

function validSide(levels: DepthBookLevel[], side: "bid" | "ask") {
  return levels.length === LEVELS && levels.every(({ price, qty }, i) =>
    Number.isFinite(price) && price > 0 && qty > 0 && (i === 0 || (
      side === "bid" ? price < levels[i - 1].price : price > levels[i - 1].price
    )),
  );
}

/** Price-aware changes at each rank from one complete book to the next. */
function queueFlow(previous: Book, bid: Side, ask: Side) {
  return bid.levels.map((b, i) => {
    const a = ask.levels[i];
    const pb = previous.bid.levels[i];
    const pa = previous.ask.levels[i];
    return (b.price >= pb.price ? b.qty : 0) - (b.price <= pb.price ? pb.qty : 0)
      - (a.price <= pa.price ? a.qty : 0) + (a.price >= pa.price ? pa.qty : 0);
  });
}

/** Frozen five-rank OFI from received book updates. A frame containing both sides counts once. */
export function createSnapshotOfi() {
  let sides: Partial<Book> = {};
  let previous: Book | null = null;
  const snapshots: Snapshot[] = [];
  const intervals: { from: number; to: number }[] = [];
  let lastAt = 0;
  let validUntil: number | null = null;
  let reason: OfiAbstention = "missing";

  function reset(why: OfiAbstention = "missing") {
    sides = {};
    previous = null;
    snapshots.length = 0;
    intervals.length = 0;
    validUntil = null;
    reason = why;
  }

  function advance(at: number) {
    const to = Math.min(at, validUntil ?? lastAt);
    if (to > lastAt) {
      const last = intervals.at(-1);
      if (last?.to === lastAt) last.to = to;
      else intervals.push({ from: lastAt, to });
    }
    lastAt = at;
    if (Object.values(sides).some((side) => at - side.at > MAX_AGE_MS)) reset("stale");
    while (snapshots.length && snapshots[0].at <= at - WINDOW_MS) snapshots.shift();
    while (intervals.length && intervals[0].to <= at - WINDOW_MS) intervals.shift();
  }

  function observe(at: number, packets: readonly DepthPacket[]) {
    advance(at);
    const next: Partial<Record<"bid" | "ask", Side | null>> = {};
    for (const packet of packets) {
      if (packet.kind !== "depth") continue;
      const levels = packet.levels.slice(0, LEVELS);
      next[packet.side] = validSide(levels, packet.side) ? { at, levels } : null;
    }
    const invalid = next.bid === null || next.ask === null;
    if (invalid) reset("invalid");
    if (next.bid) sides.bid = next.bid;
    if (next.ask) sides.ask = next.ask;
    const { bid, ask } = sides;
    if (invalid || !bid || !ask) return;
    if (bid.levels[0].price >= ask.levels[0].price) {
      previous = null;
      validUntil = null;
      return;
    }
    snapshots.push({
      at,
      flow: previous ? queueFlow(previous, bid, ask) : null,
      depth: bid.levels.map((level, i) => level.qty + ask.levels[i].qty),
    });
    previous = { bid, ask };
    validUntil = Math.min(bid.at, ask.at) + MAX_AGE_MS;
  }

  function score(at: number): OfiReading {
    advance(at);
    if (validUntil === null) return { value: null, reason: sides.bid && sides.ask ? "invalid" : reason };
    const covered = intervals.reduce((ms, interval) => ms + interval.to - Math.max(interval.from, at - WINDOW_MS), 0);
    if (covered < MIN_COVERAGE_MS || !snapshots.some((snapshot) => snapshot.flow)) return { value: null, reason: "warmup" };
    const totals = Array<number>(LEVELS).fill(0);
    const depth = Array<number>(LEVELS).fill(0);
    for (const snapshot of snapshots) {
      for (let i = 0; i < LEVELS; i++) {
        totals[i] += snapshot.flow?.[i] ?? 0;
        depth[i] += snapshot.depth[i];
      }
    }
    const value = totals.reduce((sum, flow, i) => sum + flow / (depth[i] / snapshots.length) / (i + 1), 0);
    return { value, reason: Math.abs(value) <= 1e-12 ? "flat" : "ok" };
  }

  return { observe, reset, score };
}
