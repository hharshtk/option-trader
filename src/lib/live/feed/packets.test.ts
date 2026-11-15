import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseFrame,
  parseInstrumentKey,
  REQUEST_CODE,
  subscriptionMessages,
  type Instrument,
} from "./packets.ts";

function header(view: DataView, at: number, code: number, length: number, segment: number, securityId: number) {
  view.setUint8(at, code);
  view.setInt16(at + 1, length, true);
  view.setUint8(at + 3, segment);
  view.setInt32(at + 4, securityId, true);
}

function ticker(securityId: number, ltp: number, ltt: number, segment = 0) {
  const view = new DataView(new ArrayBuffer(16));
  header(view, 0, 2, 16, segment, securityId);
  view.setFloat32(8, ltp, true);
  view.setInt32(12, ltt, true);
  return view.buffer;
}

function concat(...frames: ArrayBuffer[]) {
  const out = new Uint8Array(frames.reduce((total, frame) => total + frame.byteLength, 0));
  let offset = 0;
  for (const frame of frames) {
    out.set(new Uint8Array(frame), offset);
    offset += frame.byteLength;
  }
  return out.buffer;
}

test("reads a ticker packet", () => {
  const [packet] = parseFrame(ticker(13, 24315.4, 1_763_100_000));
  assert.equal(packet.kind, "ticker");
  if (packet.kind !== "ticker") return;
  assert.equal(packet.key, "IDX_I:13");
  assert.ok(Math.abs(packet.ltp - 24315.4) < 0.01);
  assert.equal(packet.ltt, 1_763_100_000);
});

test("maps exchange segment codes, including the gap at 6", () => {
  assert.equal((parseFrame(ticker(1333, 1, 0, 1))[0] as { key: string }).key, "NSE_EQ:1333");
  assert.equal((parseFrame(ticker(52175, 1, 0, 2))[0] as { key: string }).key, "NSE_FNO:52175");
  assert.equal((parseFrame(ticker(1, 1, 0, 8))[0] as { key: string }).key, "BSE_FNO:1");
  assert.equal(parseFrame(ticker(1, 1, 0, 6))[0].kind, "unknown");
});

test("reads a previous-close packet", () => {
  const view = new DataView(new ArrayBuffer(16));
  header(view, 0, 6, 16, 0, 25);
  view.setFloat32(8, 51982.15, true);
  view.setInt32(12, 0, true);
  const [packet] = parseFrame(view.buffer);
  assert.equal(packet.kind, "prevClose");
  if (packet.kind !== "prevClose") return;
  assert.equal(packet.key, "IDX_I:25");
  assert.ok(Math.abs(packet.prevClose - 51982.15) < 0.01);
});

test("reads quote fields at the documented offsets", () => {
  const view = new DataView(new ArrayBuffer(50));
  header(view, 0, 4, 50, 1, 2885);
  view.setFloat32(8, 1339.7, true);
  view.setInt16(12, 10, true);
  view.setInt32(14, 1_763_100_123, true);
  view.setFloat32(18, 1337.25, true);
  view.setInt32(22, 987_654, true);
  view.setInt32(26, 40_000, true);
  view.setInt32(30, 55_000, true);
  view.setFloat32(34, 1330, true);
  view.setFloat32(38, 0, true);
  view.setFloat32(42, 1350.7, true);
  view.setFloat32(46, 1324, true);
  const [packet] = parseFrame(view.buffer);
  assert.equal(packet.kind, "quote");
  if (packet.kind !== "quote") return;
  assert.equal(packet.ltt, 1_763_100_123);
  assert.equal(packet.ltq, 10);
  assert.ok(Math.abs(packet.atp - 1337.25) < 0.01, "average traded price (VWAP)");
  assert.equal(packet.volume, 987_654);
  assert.equal(packet.totalSellQty, 40_000);
  assert.equal(packet.totalBuyQty, 55_000);
  assert.equal(packet.oi, undefined, "quote packets carry no OI");
  assert.ok(Math.abs(packet.high - 1350.7) < 0.01);
  assert.ok(Math.abs(packet.low - 1324) < 0.01);
});

test("reads a full packet's OHLC after the OI fields", () => {
  const view = new DataView(new ArrayBuffer(162));
  header(view, 0, 8, 162, 2, 52175);
  view.setFloat32(8, 182.45, true);
  view.setFloat32(18, 180.1, true);
  view.setInt32(34, 1_250_000, true);
  view.setFloat32(46, 170, true);
  view.setFloat32(54, 190.5, true);
  view.setFloat32(58, 165.25, true);
  const [packet] = parseFrame(view.buffer);
  assert.equal(packet.kind, "quote");
  if (packet.kind !== "quote") return;
  assert.equal(packet.oi, 1_250_000);
  assert.ok(Math.abs(packet.atp - 180.1) < 0.01);
  assert.ok(Math.abs(packet.open - 170) < 0.01);
  assert.ok(Math.abs(packet.high - 190.5) < 0.01);
  assert.ok(Math.abs(packet.low - 165.25) < 0.01);
});

test("reads a disconnect packet's reason code", () => {
  const view = new DataView(new ArrayBuffer(10));
  header(view, 0, 50, 10, 0, 0);
  view.setInt16(8, 805, true);
  assert.deepEqual(parseFrame(view.buffer), [{ kind: "disconnect", reason: 805 }]);
});

test("reads several packets from one frame", () => {
  const packets = parseFrame(concat(ticker(13, 1, 0), ticker(25, 2, 0)));
  assert.deepEqual(
    packets.map((packet) => (packet as { key: string }).key),
    ["IDX_I:13", "IDX_I:25"],
  );
});

test("stops at a truncated packet instead of reading past the frame", () => {
  const packets = parseFrame(ticker(13, 1, 0).slice(0, 12));
  assert.deepEqual(packets, [{ kind: "unknown", code: 2, length: 12, key: null }]);
});

test("reports undocumented packet codes by their header length", () => {
  const view = new DataView(new ArrayBuffer(12));
  header(view, 0, 7, 12, 0, 0);
  const [packet] = parseFrame(view.buffer);
  assert.equal(packet.kind, "unknown");
  assert.equal((packet as { code: number }).code, 7);
});

test("splits subscriptions into messages of at most 100 instruments", () => {
  const instruments: Instrument[] = Array.from({ length: 250 }, (_, index) => ({
    segment: "NSE_EQ",
    securityId: String(index + 1),
  }));
  const messages = subscriptionMessages(REQUEST_CODE.subscribeTicker, instruments).map((message) =>
    JSON.parse(message),
  );
  assert.deepEqual(
    messages.map((message) => message.InstrumentCount),
    [100, 100, 50],
  );
  assert.equal(messages[0].RequestCode, 15);
  assert.deepEqual(messages[0].InstrumentList[0], { ExchangeSegment: "NSE_EQ", SecurityId: "1" });
});

test("accepts only well-formed instrument keys", () => {
  assert.deepEqual(parseInstrumentKey("IDX_I:13"), { segment: "IDX_I", securityId: "13" });
  assert.equal(parseInstrumentKey("IDX_I:13:1"), null);
  assert.equal(parseInstrumentKey("NSE:13"), null);
  assert.equal(parseInstrumentKey("NSE_EQ:abc"), null);
  assert.equal(parseInstrumentKey("NSE_EQ"), null);
});
