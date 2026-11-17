import assert from "node:assert/strict";
import test from "node:test";
import type { OptionChain } from "../../lib/dhan/types.ts";
import { instrumentKey, type FeedMode, type Instrument } from "../../lib/live/feed/packets.ts";
import { createSessionCalendar } from "../market/session-calendar.ts";
import { createHealth } from "../telemetry/health.ts";
import type { Logger } from "../telemetry/logger.ts";
import { buildContractBook } from "../trading/contracts.ts";
import type { DepthFeed } from "./depth-feed.ts";
import type { IndexFuture } from "./futures.ts";
import { createRecorder, RECORDED, type RecordedIndex } from "./recorder.ts";

const NIFTY = RECORDED[0];
const OPTION_WINDOWS = NIFTY.optionWindows;

const ist = (value: string) => Date.parse(`${value}+05:30`);
const DAY = "2026-11-18";
const EXPIRIES = ["2026-11-23", "2026-12-01", "2026-12-08", "2026-12-15"];

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function book(first = 100_000, low = 24_000, high = 27_000, step = 50, expiries = EXPIRIES) {
  const rows = [];
  let id = first;
  for (const expiry of expiries) {
    for (let strike = low; strike <= high; strike += step) {
      for (const type of ["CE", "PE"]) {
        rows.push({ security_id: String(id++), name: `NIFTY ${strike} ${type}`, strike, option_type: type, expiry, lot_size: 65, tick_size: 0.05, file_date: DAY });
      }
    }
  }
  return buildContractBook(rows, DAY, DAY)!;
}

const FUTURES: IndexFuture[] = [
  { securityId: "61471", feedKey: "NSE_FNO:61471", name: "NIFTY NOV FUT", expiry: "2026-11-23", lotSize: 65 },
  { securityId: "58875", feedKey: "NSE_FNO:58875", name: "NIFTY DEC FUT", expiry: "2026-12-29", lotSize: 65 },
  { securityId: "54749", feedKey: "NSE_FNO:54749", name: "NIFTY JAN FUT", expiry: "2027-01-25", lotSize: 65 },
];

/** An index ticker frame (NIFTY by default), as the feed sends it. */
function niftyTicker(ltp: number, securityId = 13) {
  const view = new DataView(new ArrayBuffer(16));
  view.setUint8(0, 2);
  view.setInt16(1, 16, true);
  view.setUint8(3, 0);
  view.setInt32(4, securityId, true);
  view.setFloat32(8, ltp, true);
  view.setInt32(12, 0, true);
  return view.buffer;
}

const BANK_EXPIRIES = ["2026-11-23", "2026-12-29", "2027-01-25"];
const BANK_FUTURES: IndexFuture[] = [
  { securityId: "61466", feedKey: "NSE_FNO:61466", name: "BANKNIFTY NOV FUT", expiry: "2026-11-23", lotSize: 30 },
  { securityId: "58872", feedKey: "NSE_FNO:58872", name: "BANKNIFTY DEC FUT", expiry: "2026-12-29", lotSize: 30 },
  { securityId: "54746", feedKey: "NSE_FNO:54746", name: "BANKNIFTY JAN FUT", expiry: "2027-01-25", lotSize: 30 },
];

function setup(indices: readonly RecordedIndex[] = [NIFTY]) {
  let time = ist(`${DAY}T08:00:00`);
  const held = new Map<string, number>();
  const modes = new Map<string, FeedMode>();
  const hub = {
    acquire(instruments: Instrument[], mode: FeedMode = "ticker") {
      for (const instrument of instruments) {
        const key = instrumentKey(instrument);
        held.set(key, (held.get(key) ?? 0) + 1);
        modes.set(key, mode);
      }
    },
    release(instruments: Instrument[]) {
      for (const instrument of instruments) {
        const key = instrumentKey(instrument);
        held.set(key, (held.get(key) ?? 0) - 1);
      }
    },
  };
  let live: typeof hub | null = hub;
  const depthSets: string[][] = [];
  const depth: DepthFeed = {
    set: (instruments) => depthSets.push(instruments.map(instrumentKey)),
    status: () => ({ state: { state: "idle" }, instruments: depthSets.at(-1)?.length ?? 0, frames: 0, packets: 0, lastFrameAt: null, dropped: 0 }),
    retryStopped() {},
    shutdown() {},
  };
  const controls: { kind: string; data: Record<string, unknown> }[] = [];
  const chains: { kind: string; data: Record<string, unknown> }[] = [];
  const fetched: string[] = [];
  const books: Record<string, ReturnType<typeof book>> = { NIFTY: book(), BANKNIFTY: book(900_000, 55_000, 60_000, 100, BANK_EXPIRIES) };
  const futures: Record<string, IndexFuture[]> = { NIFTY: FUTURES, BANKNIFTY: BANK_FUTURES };
  const recorder = createRecorder({
    log: silent,
    health: createHealth(() => time),
    now: () => time,
    calendar: createSessionCalendar(),
    hub: () => live,
    journal: { control: (kind, data) => controls.push({ kind, data }) },
    depth,
    chainJournal: { control: (kind, data) => chains.push({ kind, data }) },
    loadContracts: async (_date, _live, underlying) => ({ book: books[underlying], problem: null }),
    loadFutures: async (_date, underlying) => ({ futures: futures[underlying], problem: null }),
    fetchChain: async (underlying, expiry): Promise<OptionChain> => {
      fetched.push(underlying === "NIFTY" ? expiry : `${underlying} ${expiry}`);
      const oc: OptionChain["oc"] = {};
      for (let strike = 20_000; strike <= 30_000; strike += 50) oc[`${strike}.000000`] = {};
      return { last_price: 25_400, oc };
    },
    depthFile: () => null,
    chainFile: () => null,
    indices,
  });
  return {
    recorder,
    held,
    modes,
    depthSets,
    controls,
    chains,
    fetched,
    at: (clock: string) => (time = ist(`${DAY}T${clock}`)),
    replay: (on: boolean) => (live = on ? null : hub),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const heldKeys = (held: Map<string, number>) => [...held].filter(([, count]) => count > 0).map(([key]) => key);

test("outside the window it holds nothing and says when it starts", () => {
  const r = setup();
  r.recorder.tick();
  assert.equal(r.held.size, 0);
  const status = r.recorder.status();
  assert.equal(status.state, "idle");
  assert.match(status.note, /Starts at 08:45 IST/);
});

test("in the window it holds futures and three expiries' windows in full mode, and describes them", async () => {
  const r = setup();
  r.at("08:46:00");
  r.recorder.tick();
  await settle();
  r.recorder.tick();
  // No index level yet: futures only.
  assert.deepEqual(heldKeys(r.held).sort(), FUTURES.map((f) => f.feedKey).sort());

  r.recorder.onFrame(niftyTicker(25_410));
  r.recorder.tick();
  const expected = FUTURES.length + OPTION_WINDOWS.reduce((sum, each) => sum + (2 * each + 1) * 2, 0);
  assert.equal(heldKeys(r.held).length, expected);
  assert.ok([...r.modes.values()].every((mode) => mode === "full"));

  const described = r.controls.filter((c) => c.kind === "instruments").flatMap((c) => c.data.items as { key: string; kind: string; strike?: number; expiry: string }[]);
  assert.equal(described.length, expected);
  const atm = described.filter((item) => item.kind === "option" && item.strike === 25_400 && item.expiry === EXPIRIES[0]);
  assert.equal(atm.length, 2, "the ATM call and put");
  assert.ok(!described.some((item) => item.expiry === EXPIRIES[3]), "only three expiries");

  const depth = r.depthSets.at(-1)!;
  assert.equal(depth.length, 2 + 22, "two futures and ATM±5 of the nearest expiry");
  assert.ok(depth.includes("NSE_FNO:61471") && depth.includes("NSE_FNO:58875") && !depth.includes("NSE_FNO:54749"));
  assert.equal(r.recorder.status().state, "recording");
});

test("the window follows the index without releasing anything, and depth only grows", async () => {
  const r = setup();
  r.at("09:20:00");
  r.recorder.onFrame(niftyTicker(25_400));
  r.recorder.tick();
  await settle();
  r.recorder.tick();
  const before = heldKeys(r.held).length;
  const depthBefore = r.depthSets.at(-1)!.length;

  r.recorder.onFrame(niftyTicker(25_550)); // three strikes up
  r.recorder.tick();
  assert.equal(heldKeys(r.held).length, before + OPTION_WINDOWS.length * 3 * 2);
  assert.ok([...r.held.values()].every((count) => count === 1), "each instrument acquired once");
  assert.equal(r.depthSets.at(-1)!.length, depthBefore + 3 * 2);

  r.recorder.onFrame(niftyTicker(25_400)); // back: nothing new
  const calls = r.depthSets.length;
  r.recorder.tick();
  assert.equal(heldKeys(r.held).length, before + OPTION_WINDOWS.length * 3 * 2);
  assert.equal(r.depthSets.length, calls);
});

test("option chains: three expiries once a minute while open, strikes within 10% of the index", async () => {
  const r = setup();
  r.at("09:14:00");
  r.recorder.onFrame(niftyTicker(25_400));
  r.recorder.tick();
  await settle();
  r.recorder.tick();
  assert.equal(r.fetched.length, 0, "not before the open");

  r.at("09:15:06");
  r.recorder.tick();
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(r.fetched, EXPIRIES.slice(0, 3));
  assert.equal(r.chains.length, 3);
  const strikes = Object.keys(r.chains[0].data.oc as object).map(Number);
  assert.ok(Math.min(...strikes) >= 22_860 && Math.max(...strikes) <= 27_940);
  assert.equal(r.chains[0].data.minute, ist(`${DAY}T09:15:00`));

  r.at("09:15:40");
  r.recorder.tick();
  await settle();
  assert.equal(r.fetched.length, 3, "once per minute");
  r.at("09:16:05");
  r.recorder.tick();
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(r.fetched.length, 6);
  assert.equal(r.recorder.status().chain.snapshots, 6);
});

test("after the window, and during a replay, everything is released", async () => {
  const r = setup();
  r.at("15:00:00");
  r.recorder.onFrame(niftyTicker(25_400));
  r.recorder.tick();
  await settle();
  r.recorder.tick();
  assert.ok(heldKeys(r.held).length > 0);

  r.at("15:41:00");
  r.recorder.tick();
  assert.equal(heldKeys(r.held).length, 0);
  assert.deepEqual(r.depthSets.at(-1), []);
  assert.equal(r.recorder.status().state, "idle");

  const s = setup();
  s.at("10:00:00");
  s.replay(true);
  s.recorder.tick();
  await settle();
  s.recorder.tick();
  assert.equal(s.held.size, 0);
  assert.match(s.recorder.status().note, /replaying/);
});

test("BANKNIFTY alongside NIFTY: its own futures, windows and chains; depth for its two near futures only", async () => {
  const r = setup(RECORDED);
  r.at("09:15:06");
  r.recorder.onFrame(niftyTicker(25_400));
  r.recorder.onFrame(niftyTicker(57_340, 25));
  r.recorder.tick();
  for (let i = 0; i < 5; i++) await settle();
  r.recorder.tick();

  const bank = RECORDED[1];
  const niftyCount = FUTURES.length + NIFTY.optionWindows.reduce((sum, each) => sum + (2 * each + 1) * 2, 0);
  const bankCount = BANK_FUTURES.length + bank.optionWindows.reduce((sum, each) => sum + (2 * each + 1) * 2, 0);
  assert.equal(heldKeys(r.held).length, niftyCount + bankCount);

  const items = r.controls.filter((c) => c.kind === "instruments").flatMap((c) => c.data.items as { underlying: string; kind: string; strike?: number; expiry: string }[]);
  const bankItems = items.filter((item) => item.underlying === "BANKNIFTY");
  assert.equal(bankItems.length, bankCount);
  assert.ok(bankItems.some((item) => item.kind === "option" && item.strike === 57_300 && item.expiry === "2026-11-23"), "ATM strike on 100-point spacing");
  assert.ok(!bankItems.some((item) => item.expiry === BANK_EXPIRIES[2] && item.kind === "option"), "two expiries");

  const depth = r.depthSets.at(-1)!;
  assert.equal(depth.length, 2 + 22 + 2);
  assert.ok(depth.includes("NSE_FNO:61466") && depth.includes("NSE_FNO:58872") && !depth.includes("NSE_FNO:54746"));

  for (let i = 0; i < 10; i++) await settle();
  assert.deepEqual(r.fetched, [...EXPIRIES.slice(0, 3), "BANKNIFTY 2026-11-23", "BANKNIFTY 2026-12-29"]);
  assert.deepEqual(r.chains.map((c) => c.data.underlying), ["NIFTY", "NIFTY", "NIFTY", "BANKNIFTY", "BANKNIFTY"]);

  const status = r.recorder.status();
  assert.deepEqual(status.indices.map((index) => [index.name, index.spot, index.futures.length, index.expiries.length]), [
    ["NIFTY", 25_400, 3, 3],
    ["BANKNIFTY", 57_340, 3, 2],
  ]);
});
