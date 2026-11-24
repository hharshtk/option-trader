import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JournalSession } from "../../lib/engine/protocol.ts";
import { chainView, createLiveSideData, depthView, replaySideData, type SideFiles } from "../replay/side-data.ts";
import { bufferSource, type ByteSource } from "./byte-source.ts";
import { encodeRecord, MAGIC } from "./format.ts";
import { createChainIndex, createDepthIndex } from "./side-index.ts";
import { createSideSeries } from "./side-series.ts";

const OPEN = Date.UTC(2026, 10, 18, 3, 45); // 09:15 IST
const FUT = 61471;
const OPT = 64456;

function side(code: number, id: number, levels: [number, number, number][]) {
  const packet = Buffer.alloc(12 + 20 * 16);
  packet.writeInt16LE(packet.length, 0);
  packet.writeUInt8(code, 2);
  packet.writeUInt8(2, 3); // NSE_FNO
  packet.writeInt32LE(id, 4);
  levels.forEach(([price, qty, orders], i) => {
    packet.writeDoubleLE(price, 12 + i * 16);
    packet.writeUInt32LE(qty, 12 + i * 16 + 8);
    packet.writeUInt32LE(orders, 12 + i * 16 + 12);
  });
  return packet;
}
const bid = (id: number, price: number, qty: number, orders = 1) => side(41, id, [[price, qty, orders], [price - 0.5, qty, orders]]);
const ask = (id: number, price: number, qty: number, orders = 1) => side(51, id, [[price, qty, orders]]);

/** A depth file: the future from 09:15, the option added at 09:16; one frame every 20 s. */
function depthFile() {
  let seq = 0;
  const records = [MAGIC, encodeRecord("control", 1, ++seq, OPEN - 60_000, Buffer.from(JSON.stringify({ kind: "subscribe", instruments: [`NSE_FNO:${FUT}`] })))];
  records.push(encodeRecord("control", 1, ++seq, OPEN + 60_000, Buffer.from(JSON.stringify({ kind: "subscribe", instruments: [`NSE_FNO:${OPT}`] }))));
  for (let i = 0; i < 9; i += 1) {
    const at = OPEN + i * 20_000;
    const packets = [bid(FUT, 25_300 + i, 100 * (i + 1)), ask(FUT, 25_305 + i, 300)];
    if (i >= 3) packets.push(bid(OPT, 170, 50), ask(OPT, 170.5, 60));
    records.push(encodeRecord("frame", 1, ++seq, at, Buffer.concat(packets)));
  }
  return Buffer.concat(records);
}

function oc(spot: number, ceOi: number) {
  const strikes: Record<string, unknown> = {};
  for (const strike of [spot - 50, spot, spot + 50]) {
    const ce = Math.max(1, spot - strike) + 60;
    const pe = Math.max(1, strike - spot) + 60;
    strikes[strike.toFixed(6)] = {
      ce: { top_bid_price: ce - 0.5, top_ask_price: ce + 0.5, oi: ceOi, previous_oi: 10 },
      pe: { top_bid_price: pe - 0.5, top_ask_price: pe + 0.5, oi: 200, previous_oi: 20 },
    };
  }
  return strikes;
}

/** Chain snapshots 5 s into 09:15, 09:16 and 09:17 for the nearest expiry, and 09:16 for the next. */
function chainFile() {
  let seq = 0;
  const snap = (at: number, expiry: string, spot: number, ceOi: number) =>
    encodeRecord("control", 0, ++seq, at, Buffer.from(JSON.stringify({ kind: "option-chain", underlying: "NIFTY", expiry, minute: at - 5_000, lastPrice: spot, oc: oc(spot, ceOi) })));
  return Buffer.concat([
    MAGIC,
    encodeRecord("control", 0, ++seq, OPEN - 1, Buffer.from(JSON.stringify({ kind: "file-open" }))),
    snap(OPEN + 5_000, "2026-11-23", 25_300, 100),
    snap(OPEN + 65_000, "2026-11-23", 25_350, 150),
    snap(OPEN + 66_000, "2026-12-01", 25_350, 10),
    snap(OPEN + 125_000, "2026-11-23", 25_400, 300),
  ]);
}

/** A source that shows only the first `visible` bytes, as a file being written does. */
function growing(bytes: Buffer) {
  let visible = MAGIC.length;
  const source: ByteSource & { show(n: number): void } = {
    size: () => visible,
    read: (offset, length) => bytes.subarray(offset, Math.min(visible, offset + length)),
    close() {},
    show: (n) => (visible = n),
  };
  return source;
}

const files = (depth: Buffer, chain: Buffer): SideFiles => {
  const f: SideFiles = {
    depth: createDepthIndex(bufferSource(depth)),
    chain: createChainIndex(bufferSource(chain)),
    // Read in depth-ofi.test.ts.
    ofi: null,
    problems: [],
    refresh: async () => {
      await f.depth!.refresh();
      await f.chain!.refresh();
    },
    close() {},
  };
  return f;
};

describe("depth index", () => {
  it("finds a contract's latest bid and ask at a time, and the contracts subscribed by then", async () => {
    const index = createDepthIndex(bufferSource(depthFile()));
    await index.refresh();
    assert.deepEqual(index.keysAt(OPEN), [`NSE_FNO:${FUT}`]);
    assert.deepEqual(index.keysAt(OPEN + 60_000), [`NSE_FNO:${FUT}`, `NSE_FNO:${OPT}`]);
    const book = index.book(`NSE_FNO:${FUT}`, OPEN + 45_000)!;
    assert.equal(book.at, OPEN + 40_000);
    assert.deepEqual(book.bids, [{ price: 25_302, qty: 300, orders: 1 }, { price: 25_301.5, qty: 300, orders: 1 }]);
    assert.deepEqual(book.asks, [{ price: 25_307, qty: 300, orders: 1 }]);
    assert.equal(index.book(`NSE_FNO:${OPT}`, OPEN + 45_000), null, "not in the book yet");
    assert.equal(index.book(`NSE_FNO:${FUT}`, OPEN - 1), null);
    assert.equal(index.book(`NSE_FNO:${FUT}`, OPEN + 10 * 60_000 + 160_001), null, "too long ago");
  });

  it("indexes what a growing file gains", async () => {
    const bytes = depthFile();
    const source = growing(bytes);
    const index = createDepthIndex(source);
    source.show(bytes.length - 500);
    await index.refresh();
    const before = index.lastAt();
    source.show(bytes.length);
    await index.refresh();
    assert.ok(index.lastAt() > before);
    assert.equal(index.lastAt(), OPEN + 160_000);
  });
});

describe("chain index and side data", () => {
  it("gives the latest snapshot of an expiry at a time", async () => {
    const index = createChainIndex(bufferSource(chainFile()));
    await index.refresh();
    assert.deepEqual(index.expiries("NIFTY", OPEN + 10_000), ["2026-11-23"]);
    assert.deepEqual(index.expiries("NIFTY", OPEN + 70_000), ["2026-11-23", "2026-12-01"]);
    const i = index.latest("NIFTY", "2026-11-23", OPEN + 100_000);
    assert.equal(i, 1);
    const snapshot = index.snapshot("NIFTY", "2026-11-23", i)!;
    assert.equal(snapshot.lastPrice, 25_350);
    assert.equal(snapshot.at, OPEN + 65_000);
    assert.equal(index.latest("NIFTY", "2026-11-23", OPEN), -1);
  });

  it("answers the depth and chain views at a replay's position, NIFTY's future first", async () => {
    const f = files(depthFile(), chainFile());
    await f.refresh();
    const contracts = new Map<string, Record<string, unknown>>([
      [`NSE_FNO:${FUT}`, { kind: "future", underlying: "NIFTY", name: "NIFTY NOV FUT", expiry: "2026-11-23" }],
      [`NSE_FNO:${OPT}`, { kind: "option", underlying: "NIFTY", name: "NIFTY 23 NOV 25300 CALL", expiry: "2026-11-23", strike: 25_300, type: "CE" }],
    ]);
    let at = OPEN + 90_000;
    const sides = replaySideData(f, contracts, () => at);
    const view = depthView(sides, null);
    assert.equal(view.source, "replay");
    assert.deepEqual(view.instruments.map((i) => i.name), ["NIFTY NOV FUT", "NIFTY 23 NOV 25300 CALL"]);
    assert.equal(view.book?.name, "NIFTY NOV FUT");
    assert.equal(view.book?.bids[0].price, 25_304);
    assert.equal(depthView(sides, `NSE_FNO:${OPT}`).book?.asks[0].price, 170.5);
    assert.equal(chainView(sides, "NIFTY", null).snapshot?.lastPrice, 25_350);
    assert.equal(chainView(sides, "NIFTY", "2026-12-01").snapshot?.expiry, "2026-12-01");
    at = OPEN;
    assert.equal(chainView(sides, "NIFTY", null).snapshot, null);
  });
});

describe("side series in the session", () => {
  const session = (minutes: number) =>
    ({
      date: "2026-11-18",
      session: { open: OPEN, close: OPEN + 375 * 60_000 },
      minutes: Array.from({ length: minutes }, (_, i) => ({ at: OPEN + i * 60_000 })),
      derivatives: { future: { key: `NSE_FNO:${FUT}`, lotSize: 65 }, options: { lotSize: 65 } },
    }) as unknown as JournalSession;

  it("reads the future's 20-level book and the chain at each minute's end, up to the position", async () => {
    const f = files(depthFile(), chainFile());
    await f.refresh();
    const series = createSideSeries(() => f);
    const day = await series.apply(session(3), OPEN + 150_000);
    const book = day.derivatives!.book!;
    // Minute ends 09:15:59 (frame at 40 s) and 09:16:59 (100 s); 09:17 stops at the position (140 s).
    assert.deepEqual(book.bidQty, [600, 1200, 1600]);
    assert.deepEqual(book.askQty, [300, 300, 300]);
    assert.deepEqual(book.bidOrders, [2, 2, 2]);
    assert.deepEqual(book.spread, [5, 5, 5]);
    const chain = day.derivatives!.chain!;
    assert.equal(chain.expiry, "2026-11-23");
    assert.equal(chain.nextExpiry, "2026-12-01");
    assert.deepEqual(chain.spot, [25_300, 25_350, 25_400]);
    assert.deepEqual(chain.callOi, [300, 450, 900]);
    assert.deepEqual(chain.callOiChange, [270, 420, 870]);
    assert.deepEqual(chain.nextStraddle.map((v) => v !== null), [false, true, true]);
    // Before the 09:17 snapshot: minute 09:17 still reads 09:16's.
    assert.deepEqual((await series.apply(session(3), OPEN + 124_000)).derivatives!.chain!.spot, [25_300, 25_350, 25_350]);
    // A day without side files is left alone.
    const plain = session(2);
    assert.equal(await createSideSeries(() => null).apply(plain, Infinity), plain);
  });
});

describe("live side data", () => {
  it("keeps the latest book per contract, the latest chain per expiry and contract names", () => {
    let now = OPEN;
    const live = createLiveSideData(() => now);
    live.addControl("instruments", { items: [{ key: `NSE_FNO:${FUT}`, kind: "future", underlying: "NIFTY", name: "NIFTY NOV FUT", expiry: "2026-11-23" }] }, now);
    live.addDepthFrame(Buffer.concat([bid(FUT, 25_300, 100), ask(FUT, 25_301, 200)]), now);
    now += 1_000;
    live.addDepthFrame(bid(FUT, 25_302, 50), now);
    live.addControl("option-chain", { underlying: "NIFTY", expiry: "2026-11-23", minute: now, lastPrice: 25_300, oc: oc(25_300, 1) }, now);
    const view = depthView(live, null);
    assert.equal(view.source, "live");
    assert.equal(view.book?.name, "NIFTY NOV FUT");
    assert.equal(view.book?.at, now);
    assert.equal(view.book?.bids[0].price, 25_302);
    assert.equal(view.book?.asks[0].price, 25_301);
    assert.deepEqual(chainView(live, "NIFTY", null).expiries, ["2026-11-23"]);
    assert.equal(chainView(live, "BANKNIFTY", null).snapshot, null);
  });
});
