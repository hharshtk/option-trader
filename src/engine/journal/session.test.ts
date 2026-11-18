import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionCalendar } from "../market/session-calendar.ts";
import { encodeRecord, MAGIC, readRecords, type JournalRecord } from "./format.ts";
import { createJournalSessions } from "./session-reader.ts";
import { createSessionAggregator } from "./session-summary.ts";

const ist = (value: string) => Date.parse(`${value}+05:30`);
const DATE = "2026-11-16";
const OPEN = ist(`${DATE}T09:15:00`);

function header(view: DataView, code: number, length: number, segment: number, securityId: number) {
  view.setUint8(0, code);
  view.setInt16(1, length, true);
  view.setUint8(3, segment);
  view.setInt32(4, securityId, true);
}

function ticker(securityId: number, ltp: number) {
  const view = new DataView(new ArrayBuffer(16));
  header(view, 2, 16, 0, securityId);
  view.setFloat32(8, ltp, true);
  return Buffer.from(view.buffer);
}

function prevClose(securityId: number, value: number) {
  const view = new DataView(new ArrayBuffer(16));
  header(view, 6, 16, 0, securityId);
  view.setFloat32(8, value, true);
  return Buffer.from(view.buffer);
}

function quote(securityId: number, q: { ltp: number; volume: number; atp: number; open: number; high: number; low: number }) {
  const view = new DataView(new ArrayBuffer(50));
  header(view, 4, 50, 1, securityId);
  view.setFloat32(8, q.ltp, true);
  view.setFloat32(18, q.atp, true);
  view.setInt32(22, q.volume, true);
  view.setInt32(26, 300, true);
  view.setInt32(30, 700, true);
  view.setFloat32(34, q.open, true);
  view.setFloat32(42, q.high, true);
  view.setFloat32(46, q.low, true);
  return Buffer.from(view.buffer);
}

let seq = 0;
const frame = (at: number, bytes: Buffer): JournalRecord => ({ type: "frame", connection: 1, seq: ++seq, recvTs: at, frame: bytes });
const control = (at: number, data: { kind: string; [field: string]: unknown }): JournalRecord => ({
  type: "control",
  connection: 1,
  seq: ++seq,
  recvTs: at,
  control: data,
});

function aggregator() {
  const calendar = createSessionCalendar();
  const session = calendar.session("NSE_EQ", DATE)!;
  return createSessionAggregator({
    date: DATE,
    session: { open: session.open, close: session.close },
    dayStart: session.preOpen!.start,
    benchmark: "IDX_I:13",
    names: (key) => (key === "NSE_EQ:2885" ? { symbol: "RELIANCE", name: "Reliance Industries", sector: "Energy" } : null),
  });
}

test("the morning snapshot is the reference; the day's ticks build bars, breadth and closes", () => {
  const agg = aggregator();
  const before = ist(`${DATE}T06:17:00`);
  agg.add(control(before, { kind: "engine-start", version: "abc" }));
  agg.add(control(before, { kind: "subscribe", keys: ["IDX_I:13"], mode: "ticker" }));
  agg.add(control(before, { kind: "subscribe", keys: ["NSE_EQ:2885"], mode: "quote" }));
  // Before the open Dhan's previous-close packet is a day stale; the snapshot price is Friday's close.
  agg.add(frame(before, ticker(13, 25000)));
  agg.add(frame(before, prevClose(13, 24800)));
  agg.add(frame(before, quote(2885, { ltp: 1300, volume: 9_000_000, atp: 1290, open: 1280, high: 1310, low: 1275 })));

  agg.add(frame(OPEN + 1_000, ticker(13, 25100)));
  agg.add(frame(OPEN + 20_000, ticker(13, 25150)));
  agg.add(frame(OPEN + 40_000, ticker(13, 25050)));
  agg.add(frame(OPEN + 50_000, quote(2885, { ltp: 1295, volume: 10_000, atp: 1297, open: 1299, high: 1301, low: 1294 })));
  // Nothing in minute 1; minute 2 has one tick each.
  agg.add(frame(OPEN + 125_000, ticker(13, 25200)));
  agg.add(frame(OPEN + 130_000, quote(2885, { ltp: 1305, volume: 25_000, atp: 1300, open: 1299, high: 1306, low: 1294 })));

  const s = agg.summary({ builtAt: OPEN + 131_000, readMs: 1, bytes: 1 });
  assert.equal(s.minutes.length, 3);
  assert.deepEqual(s.minutes[0].bar, [25100, 25150, 25050, 25050]);
  assert.equal(s.minutes[1].bar, null);
  assert.deepEqual(s.minutes[2].bar, [25200, 25200, 25200, 25200]);
  assert.equal(s.minutes[0].frames, 4);
  // RELIANCE was below Friday's 1,300 at the end of minute 0 and minute 1, above it now.
  assert.deepEqual(s.minutes.map((m) => [m.advancers, m.decliners]), [[0, 1], [0, 1], [1, 0]]);

  const nifty = s.instruments.find((i) => i.key === "IDX_I:13")!;
  assert.equal(nifty.reference, 25000);
  assert.equal(nifty.ltp, 25200);
  assert.deepEqual([nifty.open, nifty.high, nifty.low], [25100, 25200, 25050]);
  assert.deepEqual(nifty.closes, [25050, 25050, 25200]);
  assert.equal(nifty.packets, 4);

  const reliance = s.instruments.find((i) => i.key === "NSE_EQ:2885")!;
  assert.equal(reliance.symbol, "RELIANCE");
  assert.equal(reliance.mode, "quote");
  assert.equal(reliance.reference, 1300);
  assert.deepEqual([reliance.open, reliance.high, reliance.low, reliance.vwap], [1299, 1306, 1294, 1300]);
  assert.equal(reliance.volume, 25_000);
  assert.deepEqual([reliance.buyQty, reliance.sellQty], [700, 300]);
  assert.deepEqual(reliance.closes, [1295, 1295, 1305]);
  assert.equal(s.runs[0].version, "abc");
  assert.equal(s.file.packets.prevClose, 1);
});

/** A Full packet for an NSE_FNO contract: price, volume, VWAP, OI and the best bid and ask (one level). */
function full(securityId: number, q: { ltp: number; volume: number; oi: number; bid?: number; ask?: number; bidQty?: number; askQty?: number; atp?: number }) {
  const view = new DataView(new ArrayBuffer(162));
  header(view, 8, 162, 2, securityId);
  view.setFloat32(8, q.ltp, true);
  view.setFloat32(18, q.atp ?? q.ltp, true);
  view.setInt32(22, q.volume, true);
  view.setInt32(34, q.oi, true);
  view.setInt32(62, q.bidQty ?? 0, true);
  view.setInt32(66, q.askQty ?? 0, true);
  view.setFloat32(74, q.bid ?? 0, true);
  view.setFloat32(78, q.ask ?? 0, true);
  return Buffer.from(view.buffer);
}

test("futures and options: open interest, who traded, the book and near-the-money totals per minute", () => {
  const agg = aggregator();
  const before = ist(`${DATE}T08:45:00`);
  // 21 strikes either side of 25,000 make a complete band of 10 each side; a call's id is the strike, a put's the strike + 1.
  const strikes = Array.from({ length: 21 }, (_, i) => 24_500 + i * 50);
  const items: Record<string, unknown>[] = [{ key: "NSE_FNO:900", kind: "future", underlying: "NIFTY", name: "NIFTY NOV FUT", expiry: "2026-11-24", lotSize: 65 }];
  for (const k of strikes) {
    items.push({ key: `NSE_FNO:${k}`, kind: "option", underlying: "NIFTY", name: `NIFTY ${k} CALL`, expiry: "2026-11-17", strike: k, type: "CE", lotSize: 65 });
    items.push({ key: `NSE_FNO:${k + 1}`, kind: "option", underlying: "NIFTY", name: `NIFTY ${k} PUT`, expiry: "2026-11-17", strike: k, type: "PE", lotSize: 65 });
  }
  // A later expiry is ignored: the nearest one is read.
  items.push({ key: "NSE_FNO:777", kind: "option", underlying: "NIFTY", name: "far", expiry: "2026-11-24", strike: 25_000, type: "CE", lotSize: 65 });
  agg.add(control(before, { kind: "instruments", source: "recorder", date: DATE, items }));
  // Yesterday's figures arrive with the morning snapshot.
  agg.add(frame(before, full(900, { ltp: 25_050, volume: 5_000_000, oi: 10_000_000, bid: 25_049, ask: 25_051, bidQty: 650, askQty: 650 })));
  for (const k of strikes) {
    agg.add(frame(before, full(k, { ltp: 100, volume: 1, oi: 1_000 })));
    agg.add(frame(before, full(k + 1, { ltp: 100, volume: 1, oi: 2_000 })));
  }

  agg.add(frame(OPEN + 500, ticker(13, 25_010)));
  // The day's first future packet starts the count; then a buy at the ask, a sell at the bid, and an uptick between them.
  agg.add(frame(OPEN + 1_000, full(900, { ltp: 25_060, volume: 100, oi: 10_010_000, bid: 25_059, ask: 25_061, bidQty: 650, askQty: 1_300, atp: 25_055 })));
  agg.add(frame(OPEN + 2_000, full(900, { ltp: 25_061, volume: 300, oi: 10_010_000, bid: 25_060, ask: 25_062, bidQty: 650, askQty: 1_300 })));
  agg.add(frame(OPEN + 3_000, full(900, { ltp: 25_060, volume: 350, oi: 10_020_000, bid: 25_059, ask: 25_061, bidQty: 650, askQty: 1_300 })));
  agg.add(frame(OPEN + 61_000, full(900, { ltp: 25_060.5, volume: 450, oi: 10_030_000, bid: 25_059, ask: 25_061, bidQty: 1_950, askQty: 650, atp: 25_058 })));
  for (const k of strikes) {
    agg.add(frame(OPEN + 2_000, full(k, { ltp: k === 25_000 ? 120 : 50, volume: 10, oi: 1_100 })));
    agg.add(frame(OPEN + 2_000, full(k + 1, { ltp: k === 25_000 ? 110 : 50, volume: 10, oi: 2_300 })));
  }
  // One strike's OI changes in minute 1.
  agg.add(frame(OPEN + 62_000, full(25_000 + 1, { ltp: 115, volume: 20, oi: 2_965 })));

  const s = agg.summary({ builtAt: OPEN + 63_000, readMs: 1, bytes: 1 });
  const f = s.derivatives!.future!;
  assert.equal(f.name, "NIFTY NOV FUT");
  assert.equal(f.oiBefore, 10_000_000);
  assert.deepEqual(f.oi, [10_020_000, 10_030_000]);
  assert.deepEqual(f.closes, [25_060, 25_060.5]);
  // The last packet of each minute sets it (the helper sends the price as VWAP when none is given).
  assert.deepEqual(f.vwap, [25_060, 25_058]);
  // 200 bought at the ask, then 50 sold at the bid in minute 0; 100 traded on an uptick in minute 1.
  assert.deepEqual(f.buys, [200, 100]);
  assert.deepEqual(f.sells, [50, 0]);
  assert.deepEqual([f.bidQty, f.askQty], [[650, 1_950], [1_300, 650]]);

  const o = s.derivatives!.options!;
  assert.equal(o.expiry, "2026-11-17");
  assert.equal(o.step, 50);
  assert.deepEqual(o.atm, [25_000, 25_000]);
  assert.deepEqual(o.callOi, [21 * 1_100, 21 * 1_100]);
  assert.deepEqual(o.putOi, [21 * 2_300, 20 * 2_300 + 2_965]);
  assert.deepEqual(o.straddle, [230, 235]);
  const atm = o.strikes.find((row) => row.strike === 25_000)!;
  assert.deepEqual([atm.put?.oi, atm.put?.oiBefore], [2_965, 2_000]);
  // Contracts are named from the instruments record.
  assert.equal(s.instruments.find((i) => i.key === "NSE_FNO:900")?.symbol, "NIFTY NOV FUT");
});

test("a day without instruments records has no derivatives", () => {
  const agg = aggregator();
  agg.add(frame(OPEN + 1_000, ticker(13, 25000)));
  assert.equal(agg.summary({ builtAt: 0, readMs: 0, bytes: 0 }).derivatives, undefined);
});

test("a previous-close packet received during the day is used when there was no morning snapshot", () => {
  const agg = aggregator();
  agg.add(frame(OPEN + 1_000, prevClose(13, 24900)));
  agg.add(frame(OPEN + 1_000, ticker(13, 25000)));
  assert.equal(agg.summary({ builtAt: 0, readMs: 0, bytes: 0 }).instruments[0].reference, 24900);
});

test("readRecords leaves a record cut off at the end for the next read", () => {
  const one = encodeRecord("frame", 1, 1, 10, Buffer.from("abc"));
  const two = encodeRecord("frame", 1, 2, 20, Buffer.from("defg"));
  const bytes = Buffer.concat([one, two.subarray(0, 7)]);
  const seen: number[] = [];
  const end = readRecords(bytes, 0, (r) => seen.push(r.seq));
  assert.deepEqual(seen, [1]);
  assert.equal(end, one.length);
});

test("the reader follows a file as it grows, reading only what was appended", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "journal-session-"));
  const file = path.join(directory, `${DATE}.bin`);
  const sessions = createJournalSessions({ directory, calendar: createSessionCalendar(), now: () => 0 });
  assert.equal(await sessions.read("2026-11-17"), null);

  const first = encodeRecord("frame", 1, 1, OPEN + 1_000, ticker(13, 25000));
  const second = encodeRecord("frame", 1, 2, OPEN + 61_000, ticker(13, 25100));
  // The second record arrives in two writes, as it would mid-flush.
  writeFileSync(file, Buffer.concat([MAGIC, first, second.subarray(0, 10)]));
  let s = (await sessions.read(DATE))!;
  assert.equal(s.file.frames, 1);
  assert.equal(s.file.bytes, MAGIC.length + first.length);

  appendFileSync(file, second.subarray(10));
  s = (await sessions.read(DATE))!;
  assert.equal(s.file.frames, 2);
  assert.equal(s.minutes.length, 2);
  assert.equal(s.instruments[0].ltp, 25100);
});
