import assert from "node:assert/strict";
import { test } from "node:test";
import { depthFeedUrl, depthSubscribeMessages, parseDepthFrame, DEPTH_MAX_INSTRUMENTS } from "./depth-packets.ts";
import type { Instrument } from "./packets.ts";

function side(code: number, segment: number, securityId: number, levels: [number, number, number][]) {
  const view = new DataView(new ArrayBuffer(12 + 20 * 16));
  view.setInt16(0, view.byteLength, true);
  view.setUint8(2, code);
  view.setUint8(3, segment);
  view.setInt32(4, securityId, true);
  view.setUint32(8, 7, true);
  levels.forEach(([price, qty, orders], i) => {
    view.setFloat64(12 + i * 16, price, true);
    view.setUint32(12 + i * 16 + 8, qty, true);
    view.setUint32(12 + i * 16 + 12, orders, true);
  });
  return new Uint8Array(view.buffer);
}

test("reads stacked bid and ask packets of 20 levels each", () => {
  const bid = side(41, 2, 61471, [[25410.5, 650, 3], [25410, 1300, 5]]);
  const ask = side(51, 2, 61471, [[25411, 975, 4]]);
  const frame = new Uint8Array(bid.length + ask.length);
  frame.set(bid);
  frame.set(ask, bid.length);

  const packets = parseDepthFrame(frame.buffer);
  assert.equal(packets.length, 2);
  const [first, second] = packets;
  assert.ok(first.kind === "depth" && second.kind === "depth");
  assert.equal(first.side, "bid");
  assert.equal(first.key, "NSE_FNO:61471");
  assert.equal(first.levels.length, 20);
  assert.deepEqual(first.levels[0], { price: 25410.5, qty: 650, orders: 3 });
  assert.deepEqual(first.levels[1], { price: 25410, qty: 1300, orders: 5 });
  assert.deepEqual(first.levels[2], { price: 0, qty: 0, orders: 0 });
  assert.equal(second.side, "ask");
  assert.deepEqual(second.levels[0], { price: 25411, qty: 975, orders: 4 });
});

test("reads a journal Buffer view, a disconnect and unknown codes", () => {
  const bid = side(41, 1, 1333, [[1612.4, 10, 1]]);
  const padded = Buffer.concat([Buffer.from([9, 9, 9]), Buffer.from(bid)]).subarray(3);
  const [packet] = parseDepthFrame(padded);
  assert.ok(packet.kind === "depth");
  assert.equal(packet.key, "NSE_EQ:1333");

  const disconnect = new DataView(new ArrayBuffer(14));
  disconnect.setInt16(0, 14, true);
  disconnect.setUint8(2, 50);
  disconnect.setInt16(12, 805, true);
  assert.deepEqual(parseDepthFrame(disconnect.buffer), [{ kind: "disconnect", reason: 805 }]);

  const odd = new DataView(new ArrayBuffer(12));
  odd.setInt16(0, 12, true);
  odd.setUint8(2, 99);
  assert.deepEqual(parseDepthFrame(odd.buffer), [{ kind: "unknown", code: 99, length: 12 }]);
});

test("a cut-off packet is reported as unknown, not read past the frame", () => {
  const bid = side(41, 2, 1, [[1, 1, 1]]);
  const packets = parseDepthFrame(bid.subarray(0, 100));
  assert.equal(packets.length, 1);
  assert.equal(packets[0].kind, "unknown");
});

test("subscribe messages use code 23 and at most 50 instruments each", () => {
  const instruments: Instrument[] = Array.from({ length: DEPTH_MAX_INSTRUMENTS + 2 }, (_, i) => ({ segment: "NSE_FNO", securityId: String(i + 1) }));
  const messages = depthSubscribeMessages(instruments).map((message) => JSON.parse(message));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].RequestCode, 23);
  assert.equal(messages[0].InstrumentCount, 50);
  assert.deepEqual(messages[1].InstrumentList, [
    { ExchangeSegment: "NSE_FNO", SecurityId: "51" },
    { ExchangeSegment: "NSE_FNO", SecurityId: "52" },
  ]);
  assert.match(depthFeedUrl("100", "a b"), /^wss:\/\/depth-api-feed\.dhan\.co\/twentydepth\?token=a%20b&clientId=100&authType=2$/);
});
