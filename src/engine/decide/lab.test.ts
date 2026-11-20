import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { getParquetStore } from "../../lib/db/parquet-store.ts";
import { encodeRecord, MAGIC } from "../journal/format.ts";
import { createSessionCalendar } from "../market/session-calendar.ts";
import { buildDayTable } from "./day-table.ts";
import { createDecisionLab } from "./lab.ts";

const DATE = "2026-11-18";
const OPEN = Date.UTC(2026, 10, 18, 3, 45); // 09:15 IST
const MIN = 60_000;
const IDX = 0;
const FNO = 2;

function header(code: number, size: number, segment: number, id: number) {
  const packet = Buffer.alloc(size);
  packet.writeUInt8(code, 0);
  packet.writeInt16LE(size, 1);
  packet.writeUInt8(segment, 3);
  packet.writeInt32LE(id, 4);
  return packet;
}

function ticker(id: number, ltp: number) {
  const packet = header(2, 16, IDX, id);
  packet.writeFloatLE(ltp, 8);
  return packet;
}

/** A Full packet with a book: bid and ask at the best level. */
function full(id: number, ltp: number, bid: number, ask: number, volume: number) {
  const packet = header(8, 162, FNO, id);
  packet.writeFloatLE(ltp, 8);
  packet.writeInt16LE(65, 12);
  packet.writeFloatLE(ltp, 18);
  packet.writeInt32LE(volume, 22);
  packet.writeInt32LE(1_000_000, 34); // OI
  packet.writeInt32LE(650, 62); // bid qty
  packet.writeInt32LE(650, 66); // ask qty
  packet.writeInt16LE(3, 70);
  packet.writeInt16LE(3, 72);
  packet.writeFloatLE(bid, 74);
  packet.writeFloatLE(ask, 78);
  return packet;
}

/**
 * 09:15 to 10:15: NIFTY rises a point a minute from 25,000, its 25,000 call a rupee a minute from
 * 100 (bid 100, ask 100.5) and its put falls a rupee a minute from 120. At 12:00 the call jumps to
 * 500, which nothing before 12:00 may see.
 */
function journal() {
  let seq = 0;
  const items = [
    { key: "NSE_FNO:1", kind: "option", underlying: "NIFTY", name: "NIFTY 23 NOV 25000 CALL", expiry: "2026-11-23", strike: 25_000, type: "CE", lotSize: 65 },
    { key: "NSE_FNO:2", kind: "option", underlying: "NIFTY", name: "NIFTY 23 NOV 25000 PUT", expiry: "2026-11-23", strike: 25_000, type: "PE", lotSize: 65 },
    // A later expiry: not quoted.
    { key: "NSE_FNO:3", kind: "option", underlying: "NIFTY", name: "NIFTY 01 DEC 25000 CALL", expiry: "2026-12-01", strike: 25_000, type: "CE", lotSize: 65 },
  ];
  const records = [MAGIC, encodeRecord("control", 0, ++seq, OPEN - 30 * MIN, Buffer.from(JSON.stringify({ kind: "instruments", source: "recorder", date: DATE, items })))];
  // Before the day starts, Dhan's snapshot: the previous close, which Pulse measures from.
  records.push(encodeRecord("frame", 1, ++seq, OPEN - 30 * MIN, ticker(13, 24_990)));
  for (let t = 0; t <= 60; t += 1) {
    const at = OPEN + t * MIN + 10_000;
    records.push(encodeRecord("frame", 1, ++seq, at, Buffer.concat([ticker(13, 25_000 + t), full(1, 100.25 + t, 100 + t, 100.5 + t, 1_000 * t), full(2, 120.25 - t, 120 - t, 120.5 - t, 1_000 * t), full(3, 300, 299, 301, 1)])));
  }
  records.push(encodeRecord("frame", 1, ++seq, OPEN + 165 * MIN, Buffer.concat([ticker(13, 25_100), full(1, 500, 499, 501, 999_999)])));
  return Buffer.concat(records);
}

describe("decision lab", () => {
  const root = mkdtempSync(path.join(tmpdir(), "decide-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const journalDir = path.join(root, "journal");
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(path.join(journalDir, `${DATE}.bin`), journal());
  // A weekend has no session.
  writeFileSync(path.join(journalDir, "2026-11-15.bin"), Buffer.concat([MAGIC]));

  it("builds each minute as it stood then: the state and the nearest expiry's quotes, nothing later", async () => {
    const table = (await buildDayTable(journalDir, DATE, createSessionCalendar()))!;
    assert.equal(table.expiry, "2026-11-23");
    assert.deepEqual(table.sides, { depth: false, chain: false });
    const state = (t: number) => table.states.find((s) => s.t === t)!;
    // Pulse needs two minutes: the first state is at the close of 09:16, as the trader's first reading is.
    assert.equal(table.states[0].t, 1);
    assert.equal(state(1).nifty, 25_001);
    assert.equal(state(1).nifty_change_pct, 0.044);
    assert.equal(state(30).nifty, 25_030);
    assert.equal(state(30).at, OPEN + 30 * MIN);
    // Minute 30's quotes are those of its close: the call at 130/130.5, not 12:00's 500.
    const quotes = table.quotes.find((q) => q.t === 30)!.quotes;
    assert.deepEqual(
      quotes.map((q) => [q.type, q.bid, q.ask]).sort(),
      [
        ["CE", 130, 130.5],
        ["PE", 90, 90.5],
      ],
    );
    // Each quote carries its last price's range since the previous minute's quote: from that price (129.25) to this minute's trade.
    const call30 = quotes.find((q) => q.type === "CE")!;
    assert.deepEqual([call30.low, call30.high], [129.25, 130.25]);
    // Minutes with no data (10:16 to 11:58) have no state, as the trader gets no reading then.
    assert.deepEqual(table.states.map((st) => st.t).slice(-4), [59, 60, 164, 165]);
    assert.equal(table.quotes.find((q) => q.t === 60)!.quotes.find((q) => q.type === "CE")!.bid, 160);
    // 11:59 is read at 12:00:01.5, as the trader reads it: the jump at 12:00:00 is in, as it would be live.
    assert.equal(table.quotes.find((q) => q.t === 164)!.quotes.find((q) => q.type === "CE")!.bid, 499);
    assert.equal(table.states.at(-1)!.t, 165);
  });

  it("stores the day's tables, scores every rule on them and reads the scorecard back", async () => {
    const store = getParquetStore(path.join(root, "store"));
    const lab = createDecisionLab({ store, directory: journalDir, calendar: createSessionCalendar(), version: "test", now: () => 42 });
    assert.deepEqual(lab.recordedDates(), [DATE], "the weekend file is left out");
    assert.deepEqual(await lab.build(), [DATE]);
    assert.deepEqual(await lab.build(), [], "built days aren't built again");
    const scored = await lab.score();
    assert.deepEqual(scored.days.map((d) => [d.date, d.pricedMinutes > 0, d.expiry]), [[DATE, true, "2026-11-23"]]);
    // No signal's schedules buy calls (rising) and puts (falling) between 09:25 and 10:15.
    const random = scored.rows.find((r) => r.rule === "random" && r.hold === 5)!;
    assert.ok(random.trades > 0);
    const read = await lab.view({ state: "idle", at: null, message: null });
    assert.deepEqual(read.rows, scored.rows, "the stored trades give the same scorecard");
    assert.ok(read.fields.some((f) => f.name === "fut_book20") && read.fields.some((f) => f.name === "chain_iv"), "a rule sees the book and the chain");

    // The prediction scoreboard reads the stored outcomes and calls back.
    const board = await lab.predictions({ state: "idle", at: null, message: null });
    assert.equal(board.horizon, 15);
    assert.deepEqual(board.days.map((d) => d.date), [DATE]);
    assert.ok(board.days[0].minutes > 0 && board.days[0].niftyMove !== null);
    const coin = board.rows.find((r) => r.id === "coin")!;
    assert.ok(coin.priced > 0, "the coin flip is priced at minutes with both options quoted");
    // NIFTY rises through the morning, so "keeps going since the open" calls up and is right.
    const trend = board.rows.find((r) => r.id === "trend-open")!;
    assert.ok(trend.calls > 0 && trend.right > 0);
  });
});
