import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createDhanFeed } from "../../lib/live/feed/dhan-feed.ts";
import { parseFrame, type Packet } from "../../lib/live/feed/packets.ts";
import { defaultReplayStart, istTimeOn, replayWindow } from "../feed-switch.ts";
import { encodeRecord, MAGIC } from "../journal/format.ts";
import { createSessionCalendar } from "../market/session-calendar.ts";
import { createReplayPlayer, type ReplayTimers } from "./player.ts";
import { indexRecording, loadRecording } from "./recording.ts";
import { createReplaySession } from "./replay-session.ts";
import { retimeHealth, retimeSse, retimeStream, type Retimer } from "./retime.ts";

const T0 = Date.UTC(2026, 10, 16, 4, 0, 0); // 09:30 IST, Monday 16 November 2026
const NIFTY = { segment: "IDX_I", securityId: "13" } as const;
const RELIANCE = { segment: "NSE_EQ", securityId: "2885" } as const;
const IDX = 0;
const NSE_EQ = 1;

function header(code: number, size: number, segment: number, id: number) {
  const packet = Buffer.alloc(size);
  packet.writeUInt8(code, 0);
  packet.writeInt16LE(size, 1);
  packet.writeUInt8(segment, 3);
  packet.writeInt32LE(id, 4);
  return packet;
}

function ticker(segment: number, id: number, ltp: number, ltt: number) {
  const packet = header(2, 16, segment, id);
  packet.writeFloatLE(ltp, 8);
  packet.writeInt32LE(ltt, 12);
  return packet;
}

function prevClose(segment: number, id: number, close: number) {
  const packet = header(6, 16, segment, id);
  packet.writeFloatLE(close, 8);
  return packet;
}

function quote(segment: number, id: number, ltp: number, ltt: number, volume: number) {
  const packet = header(4, 50, segment, id);
  packet.writeFloatLE(ltp, 8);
  packet.writeInt16LE(10, 12);
  packet.writeInt32LE(ltt, 14);
  packet.writeFloatLE(ltp - 1, 18);
  packet.writeInt32LE(volume, 22);
  packet.writeFloatLE(ltp - 5, 34);
  return packet;
}

function full(segment: number, id: number, ltp: number, ltt: number) {
  const packet = header(8, 162, segment, id);
  packet.writeFloatLE(ltp, 8);
  packet.writeInt16LE(25, 12);
  packet.writeInt32LE(ltt, 14);
  packet.writeFloatLE(ltp - 1, 18);
  packet.writeInt32LE(5_000, 22);
  packet.writeInt32LE(700, 26);
  packet.writeInt32LE(900, 30);
  packet.writeInt32LE(123_456, 34);
  packet.writeFloatLE(ltp - 5, 46);
  packet.writeFloatLE(0, 50);
  packet.writeFloatLE(ltp + 5, 54);
  packet.writeFloatLE(ltp - 9, 58);
  return packet;
}

/** A journal file: control records mixed in, frames at the given offsets from T0. */
function journal(frames: [offsetMs: number, ...packets: Buffer[]][]) {
  const records: Buffer[] = [MAGIC];
  let seq = 0;
  records.push(encodeRecord("control", 0, ++seq, T0 - 1_000, Buffer.from(JSON.stringify({ kind: "engine-start" }))));
  for (const [offset, ...packets] of frames) {
    records.push(encodeRecord("frame", 1, ++seq, T0 + offset, Buffer.concat(packets)));
  }
  return indexRecording("2026-11-16", Buffer.concat(records));
}

/** Timers on a manual wall clock. */
function fakeTime() {
  let wall = 1_000_000;
  let order = 0;
  const pending: { at: number; order: number; fire: () => void }[] = [];
  const timers: ReplayTimers = {
    set(fire, ms) {
      const timer = { at: wall + ms, order: order++, fire };
      pending.push(timer);
      return timer;
    },
    clear(handle) {
      const index = pending.indexOf(handle as (typeof pending)[number]);
      if (index !== -1) pending.splice(index, 1);
    },
  };
  return {
    timers,
    now: () => wall,
    /** Moves the wall clock forward, firing due timers in order. */
    advance(ms: number) {
      const until = wall + ms;
      for (;;) {
        pending.sort((a, b) => a.at - b.at || a.order - b.order);
        const next = pending[0];
        if (!next || next.at > until) break;
        pending.shift();
        wall = Math.max(wall, next.at);
        next.fire();
      }
      wall = until;
    },
  };
}

/** The real feed client, connected to the replay instead of Dhan. */
function feedOn(player: ReturnType<typeof createReplayPlayer>) {
  const packets: Packet[] = [];
  const states: string[] = [];
  const feed = createDhanFeed({
    readCredentials: () => ({ clientId: "replay", accessToken: "replay" }),
    onPacket: (packet) => packets.push(packet),
    onState: (state) => states.push(state.state),
    log: () => {},
    openSocket: player.openSocket,
  });
  return { feed, packets, states };
}

const prices = (packets: Packet[], key: string) =>
  packets.filter((p) => (p.kind === "ticker" || p.kind === "quote") && p.key === key).map((p) => (p as { ltp: number }).ltp);

describe("loading a journal file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "replay-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("indexes from disk and reads frames back as an in-memory index does, with the contracts described", async () => {
    const records: Buffer[] = [MAGIC];
    const items = [{ key: "NSE_FNO:61471", kind: "future", underlying: "NIFTY", name: "NIFTY NOV FUT", expiry: "2026-11-23", lotSize: 65 }];
    records.push(encodeRecord("control", 0, 1, T0 - 1, Buffer.from(JSON.stringify({ kind: "instruments", source: "recorder", items }))));
    for (let i = 0; i < 2_000; i += 1) records.push(encodeRecord("frame", 1, i + 2, T0 + i * 10, ticker(IDX, 13, 100 + i, i)));
    const bytes = Buffer.concat(records);
    writeFileSync(path.join(dir, "2026-11-16.bin"), bytes);
    const fromDisk = await loadRecording(dir, "2026-11-16");
    const inMemory = indexRecording("2026-11-16", bytes);
    assert.equal(fromDisk.count, 2_000);
    assert.deepEqual([...fromDisk.times], [...inMemory.times]);
    for (const i of [0, 1, 999, 1_999, 5]) assert.deepEqual(Buffer.from(fromDisk.frame(i)), Buffer.from(inMemory.frame(i)));
    assert.deepEqual(Buffer.from(fromDisk.slice(7, 8, 12)), Buffer.from(inMemory.frame(7).subarray(8, 12)));
    assert.equal(fromDisk.contracts.get("NSE_FNO:61471")?.name, "NIFTY NOV FUT");
    fromDisk.close();
    await assert.rejects(loadRecording(dir, "2026-11-17"), /No journal for 2026-11-17/);
  });
});

describe("indexRecording", () => {
  it("indexes frames only, keeps times from going back, and finds a time", () => {
    const recording = journal([
      [0, ticker(IDX, 13, 100, 1)],
      [500, ticker(IDX, 13, 101, 2)],
      [400, ticker(IDX, 13, 102, 3)], // arrived "earlier": held at 500
      [2_000, ticker(IDX, 13, 103, 4)],
    ]);
    assert.equal(recording.count, 4);
    assert.deepEqual([...recording.times].map((t) => t - T0), [0, 500, 500, 2_000]);
    assert.equal(recording.indexAt(T0 + 501), 3);
    assert.equal(recording.indexAt(T0 + 500), 1);
    assert.equal(recording.indexAt(T0 + 9_999), 4);
    assert.deepEqual(parseFrame(recording.frame(1))[0], { kind: "ticker", code: 2, key: "IDX_I:13", ltp: 101, ltt: 2 });
  });
});

describe("replay player through the Dhan feed client", () => {
  const recording = journal([
    [0, prevClose(IDX, 13, 99), ticker(IDX, 13, 100, 1), quote(NSE_EQ, 2885, 1_300, 1, 10)],
    [1_000, ticker(IDX, 13, 101, 2)],
    [2_000, quote(NSE_EQ, 2885, 1_301, 2, 20), ticker(IDX, 13, 102, 3)],
    [3_000, ticker(IDX, 13, 103, 4)],
    [60_000, ticker(IDX, 13, 110, 60)],
  ]);

  it("connects, sends a snapshot on subscribe, then frames at the recorded pace", () => {
    const time = fakeTime();
    const player = createReplayPlayer({ recording, now: time.now, timers: time.timers });
    const { feed, packets, states } = feedOn(player);
    feed.subscribe([NIFTY], "ticker");
    player.play();
    time.advance(0);
    assert.deepEqual(states, ["connecting", "live"]);
    // Snapshot: previous close and the price at the start; RELIANCE isn't subscribed.
    assert.deepEqual(
      packets.map((p) => p.kind),
      ["prevClose", "ticker"],
    );
    assert.deepEqual(prices(packets, "IDX_I:13"), [100]);
    time.advance(999);
    assert.deepEqual(prices(packets, "IDX_I:13"), [100]);
    time.advance(1);
    assert.deepEqual(prices(packets, "IDX_I:13"), [100, 101]);
    time.advance(2_000);
    assert.deepEqual(prices(packets, "IDX_I:13"), [100, 101, 102, 103]);
    assert.equal(prices(packets, "NSE_EQ:2885").length, 0);
    feed.shutdown();
    player.shutdown();
  });

  it("cuts a Quote recording down to Ticker packets for a Ticker subscription", () => {
    const time = fakeTime();
    const player = createReplayPlayer({ recording, now: time.now, timers: time.timers });
    const { feed, packets } = feedOn(player);
    feed.subscribe([RELIANCE], "ticker");
    player.play();
    time.advance(2_000);
    const reliance = packets.filter((p) => "key" in p && p.key === "NSE_EQ:2885");
    assert.deepEqual(reliance, [
      { kind: "ticker", code: 2, key: "NSE_EQ:2885", ltp: 1_300, ltt: 1 },
      { kind: "ticker", code: 2, key: "NSE_EQ:2885", ltp: 1_301, ltt: 2 },
    ]);
    feed.shutdown();
    player.shutdown();
  });

  it("sends Quote packets as recorded to a Quote subscription, with no previous close", () => {
    const time = fakeTime();
    const player = createReplayPlayer({ recording, now: time.now, timers: time.timers });
    const { feed, packets } = feedOn(player);
    feed.subscribe([RELIANCE, NIFTY], "quote");
    player.play();
    time.advance(2_000);
    assert.ok(!packets.some((p) => p.kind === "prevClose"));
    const last = packets.filter((p) => "key" in p && p.key === "NSE_EQ:2885").at(-1);
    assert.equal(last?.kind, "quote");
    assert.equal(last?.kind === "quote" && last.volume, 20);
    // Ticker-recorded NIFTY still arrives for a Quote subscription, as recorded.
    assert.deepEqual(prices(packets, "IDX_I:13"), [100, 101, 102]);
    feed.shutdown();
    player.shutdown();
  });

  it("stops sending an instrument once unsubscribed", () => {
    const time = fakeTime();
    const player = createReplayPlayer({ recording, now: time.now, timers: time.timers });
    const { feed, packets } = feedOn(player);
    feed.subscribe([NIFTY], "ticker");
    player.play();
    time.advance(1_000);
    feed.unsubscribe([NIFTY]);
    time.advance(5_000);
    assert.deepEqual(prices(packets, "IDX_I:13"), [100, 101]);
    feed.shutdown();
    player.shutdown();
  });

  it("starts from a time with that time's state, and plays faster at a higher speed", () => {
    const time = fakeTime();
    const player = createReplayPlayer({ recording, now: time.now, timers: time.timers, from: T0 + 2_500, speed: 10 });
    const { feed, packets } = feedOn(player);
    feed.subscribe([NIFTY], "ticker");
    player.play();
    time.advance(0);
    assert.deepEqual(prices(packets, "IDX_I:13"), [102]);
    time.advance(50); // 500 ms of recording
    assert.deepEqual(prices(packets, "IDX_I:13"), [102, 103]);
    time.advance(5_750); // to 60.5 s
    assert.deepEqual(prices(packets, "IDX_I:13"), [102, 103, 110]);
    assert.equal(player.status().state, "ended");
    feed.shutdown();
    player.shutdown();
  });

  it("pauses, resumes where it was, and changes speed without jumping", () => {
    const time = fakeTime();
    const player = createReplayPlayer({ recording, now: time.now, timers: time.timers });
    const { feed, packets } = feedOn(player);
    feed.subscribe([NIFTY], "ticker");
    player.play();
    time.advance(1_500);
    player.pause();
    assert.equal(player.status().at, T0 + 1_500);
    time.advance(10_000);
    assert.deepEqual(prices(packets, "IDX_I:13"), [100, 101]);
    player.play();
    player.setSpeed(2);
    time.advance(250); // 500 ms of recording: reaches 2 s
    assert.deepEqual(prices(packets, "IDX_I:13"), [100, 101, 102]);
    assert.equal(player.status().at, T0 + 2_000);
    feed.shutdown();
    player.shutdown();
  });

  it("rebuilds the same state from a checkpoint as from the start", async () => {
    const frames: [number, ...Buffer[]][] = [];
    for (let i = 0; i < 95; i += 1) frames.push([i * 100, ticker(IDX, 13, 1_000 + i, i), ...(i % 7 === 0 ? [quote(NSE_EQ, 2885, 2_000 + i, i, 10 * i)] : [])]);
    const big = journal(frames);
    const stateAt = (player: ReturnType<typeof createReplayPlayer>, time: ReturnType<typeof fakeTime>, at: number) => {
      const { feed, packets } = feedOn(player);
      feed.subscribe([NIFTY], "ticker");
      feed.subscribe([RELIANCE], "quote");
      time.advance(0);
      player.seek(at);
      time.advance(0);
      const result = [prices(packets, "IDX_I:13").at(-1), prices(packets, "NSE_EQ:2885").at(-1), player.status().frames];
      feed.shutdown();
      return result;
    };
    const time = fakeTime();
    const player = createReplayPlayer({ recording: big, now: time.now, timers: time.timers, checkpointFrames: 10 });
    // Let the background pass save every checkpoint.
    await new Promise((resolve) => setImmediate(resolve));
    for (const at of [T0 + 9_000, T0 + 2_050, T0 + 6_300, T0 + 50, T0 + 9_400]) {
      const fresh = fakeTime();
      const scratch = createReplayPlayer({ recording: big, now: fresh.now, timers: fresh.timers, checkpointFrames: 1_000_000 });
      assert.deepEqual(stateAt(player, time, at), stateAt(scratch, fresh, at), `at +${at - T0} ms`);
      scratch.shutdown();
    }
    player.shutdown();
  });

  it("seeks back and forth, resending every subscribed instrument's state", () => {
    const time = fakeTime();
    const player = createReplayPlayer({ recording, now: time.now, timers: time.timers });
    const { feed, packets } = feedOn(player);
    feed.subscribe([NIFTY], "ticker");
    player.play();
    time.advance(3_000);
    player.seek(T0 + 1_200);
    assert.equal(prices(packets, "IDX_I:13").at(-1), 101);
    player.seek(T0 + 59_000);
    assert.equal(prices(packets, "IDX_I:13").at(-1), 103);
    assert.equal(player.status().frames, 4);
    feed.shutdown();
    player.shutdown();
  });

  it("answers a disconnect request by closing, and closes sockets on shutdown", () => {
    const time = fakeTime();
    const player = createReplayPlayer({ recording, now: time.now, timers: time.timers });
    const { feed } = feedOn(player);
    feed.subscribe([NIFTY], "ticker");
    time.advance(0);
    assert.equal(player.status().sockets, 1);
    feed.shutdown(); // sends RequestCode 12, then closes
    assert.equal(player.status().sockets, 0);

    const second = feedOn(player);
    second.feed.subscribe([NIFTY], "ticker");
    time.advance(0);
    player.shutdown();
    time.advance(0);
    assert.equal(second.states.at(-1), "reconnecting");
    second.feed.shutdown();
  });

  it("cuts a Full recording down to a Quote or a Ticker", () => {
    const fullRecording = journal([[0, full(2, 49_081, 25_000, 7)]]);
    const time = fakeTime();
    const player = createReplayPlayer({ recording: fullRecording, now: time.now, timers: time.timers });
    const asQuote = feedOn(player);
    asQuote.feed.subscribe([{ segment: "NSE_FNO", securityId: "49081" }], "quote");
    time.advance(0);
    assert.deepEqual(asQuote.packets, [
      {
        kind: "quote",
        code: 4,
        key: "NSE_FNO:49081",
        ltp: 25_000,
        ltq: 25,
        ltt: 7,
        atp: 24_999,
        volume: 5_000,
        totalSellQty: 700,
        totalBuyQty: 900,
        open: 24_995,
        close: 0,
        high: 25_005,
        low: 24_991,
      },
    ]);
    asQuote.feed.shutdown();

    const asTicker = feedOn(player);
    asTicker.feed.subscribe([{ segment: "NSE_FNO", securityId: "49081" }], "ticker");
    time.advance(0);
    assert.deepEqual(asTicker.packets, [{ kind: "ticker", code: 2, key: "NSE_FNO:49081", ltp: 25_000, ltt: 7 }]);
    asTicker.feed.shutdown();
    player.shutdown();
  });
});

describe("replay window", () => {
  const calendar = createSessionCalendar();
  const ist = (date: string, time: string) => istTimeOn(date, time)!;

  it("is blocked during a session and in the 30 minutes before it", () => {
    assert.match(replayWindow(calendar, ist("2026-11-16", "10:00")).blocked ?? "", /is open/);
    assert.notEqual(replayWindow(calendar, ist("2026-11-16", "09:03")).blocked, null);
    assert.match(replayWindow(calendar, ist("2026-11-16", "08:31")).blocked ?? "", /opens at 09:00 IST/);
  });

  it("is open after the close and on weekends, until 30 minutes before the next session", () => {
    const evening = replayWindow(calendar, ist("2026-11-16", "16:00"));
    assert.equal(evening.blocked, null);
    assert.equal(evening.liveAt, ist("2026-11-17", "08:30"));
    const saturday = replayWindow(calendar, ist("2026-11-21", "11:00"));
    assert.equal(saturday.blocked, null);
    assert.equal(saturday.liveAt, ist("2026-11-23", "08:30"));
  });

  it("starts a trading day at its pre-open, and any other day at its first frame", () => {
    const day = journal([[-3_600_000, ticker(IDX, 13, 1, 1)], [0, ticker(IDX, 13, 2, 2)]]);
    assert.equal(defaultReplayStart(calendar, day), ist("2026-11-16", "09:00"));
    const sunday = indexRecording("2026-11-15", Buffer.concat([MAGIC, encodeRecord("frame", 1, 1, T0 - 86_400_000, ticker(IDX, 13, 1, 1))]));
    assert.equal(defaultReplayStart(calendar, sunday), T0 - 86_400_000);
  });

  it("reads IST times on a date", () => {
    assert.equal(istTimeOn("2026-11-16", "09:15"), Date.UTC(2026, 10, 16, 3, 45));
    assert.equal(istTimeOn("2026-11-16", "15:29:59"), Date.UTC(2026, 10, 16, 9, 59, 59));
    assert.equal(istTimeOn("2026-11-16", "25:00"), null);
    assert.equal(istTimeOn("2026-11-16", "9.15"), null);
  });
});

describe("retiming to recorded time", () => {
  const recording = journal([
    [0, ticker(IDX, 13, 100, 1)],
    [1_000, ticker(IDX, 13, 101, 2)],
    [1_000, ticker(IDX, 13, 102, 3)],
    [5_000, ticker(IDX, 13, 103, 4)],
  ]);

  it("maps a delivered frame's wall-clock stamp to its recorded time, and other stamps along the timeline", () => {
    const time = fakeTime();
    const player = createReplayPlayer({ recording, now: time.now, timers: time.timers, speed: 2 });
    const start = time.now();
    player.play();
    time.advance(0);
    assert.equal(player.toRecorded(start), T0);
    time.advance(500); // 1 s of recording: two frames in this millisecond, the last one wins
    assert.equal(player.toRecorded(time.now()), T0 + 1_000);
    assert.equal(player.toRecorded(start + 250), T0 + 500);
    player.pause();
    time.advance(10_000);
    assert.equal(player.toRecorded(time.now()), T0 + 1_000);
    assert.deepEqual(player.reading(), { now: T0 + 1_000, rate: 0, replay: "2026-11-16" });
    player.play();
    assert.equal(player.reading().rate, 2);
    player.shutdown();
  });

  const retimer: Retimer = {
    at: (wall) => wall - 1_000_000,
    deadline: (wall) => wall - 2_000_000,
    clock: () => ({ now: 42, rate: 1, replay: "2026-11-16" }),
  };

  it("rewrites quotes, tab status, Live Feed events and health", () => {
    const quotes = retimeSse(`event: quotes\ndata: ${JSON.stringify({ "IDX_I:13": { ltp: 1, at: 1_000_500 } })}\n\n`, retimer);
    assert.equal(quotes, `event: quotes\ndata: ${JSON.stringify({ "IDX_I:13": { ltp: 1, at: 500 } })}\n\n`);

    const status = JSON.parse(retimeSse(`event: status\ndata: ${JSON.stringify({ state: "live", since: 1_000_100, lastTickAt: 1_000_200 })}\n\n`, retimer).split("data: ")[1]);
    assert.deepEqual(status, { state: "live", since: 100, lastTickAt: 200, clock: { now: 42, rate: 1, replay: "2026-11-16" } });

    const events = [
      { id: 1, at: 1_000_300, type: "state", connection: 1, state: { state: "reconnecting", attempt: 1, retryAt: 2_000_900, reason: "x" } },
      { id: 2, at: 1_000_400, type: "log", message: "hi" },
    ];
    const retimed = JSON.parse(retimeSse(`event: events\ndata: ${JSON.stringify(events)}\n\n`, retimer).split("data: ")[1]);
    assert.deepEqual(retimed.map((event: { at: number }) => event.at), [300, 400]);
    assert.equal(retimed[0].state.retryAt, 900);

    const health = retimeHealth(
      {
        startedAt: 1_000_001,
        lastTickAt: null,
        quoteStreams: 0,
        monitors: 0,
        capture: false,
        connections: [
          { id: 1, name: "Main", main: true, feed: { state: "live", since: 1_000_002 }, createdAt: 1_000_003, lastTickAt: 1_000_004, instruments: 1, frames: 1, bytes: 16, packets: {} },
        ],
        instruments: [
          { key: "IDX_I:13", name: null, connection: 1, mode: "ticker", tabs: 1, pinned: false, releaseAt: null, quote: { ltp: 1, at: 1_000_005 } },
        ],
      },
      retimer,
    );
    assert.equal(health.startedAt, 1);
    assert.deepEqual(health.connections[0].feed, { state: "live", since: 2 });
    assert.equal(health.connections[0].lastTickAt, 4);
    assert.equal(health.instruments[0].quote?.at, 5);
    assert.equal(health.clock?.now, 42);

    assert.equal(retimeSse(": ping\n\n", retimer), ": ping\n\n");
    assert.equal(retimeSse("retry: 3000\n\n", retimer), "retry: 3000\n\n");
  });

  it("retimes a hub stream chunk by chunk", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("retry: 3000\n\n"));
        controller.enqueue(new TextEncoder().encode(`event: quotes\ndata: {"NSE_EQ:1":{"at":1000700}}\n\n`));
        controller.close();
      },
    });
    const text = await new Response(retimeStream(source, retimer)).text();
    assert.equal(text, `retry: 3000\n\nevent: quotes\ndata: {"NSE_EQ:1":{"at":700}}\n\n`);
  });
});

describe("replayed day for session views", () => {
  it("holds only what the replay has reached, and starts over on a seek back", async () => {
    const recording = journal([
      [0, ticker(IDX, 13, 100, 1)],
      [60_000, ticker(IDX, 13, 101, 2)],
      [120_000, ticker(IDX, 13, 102, 3)],
    ]);
    const session = createReplaySession(recording, createSessionCalendar());
    const minutesAt = async (offset: number) => {
      const day = await session.read(T0 + offset);
      return { minutes: day.minutes.length, frames: day.file.frames, close: day.minutes.at(-1)?.bar?.[3] ?? null, builtAt: day.builtAt - T0 };
    };
    // 09:30 IST is minute 16 of the session (from 09:15).
    assert.deepEqual(await minutesAt(30_000), { minutes: 16, frames: 1, close: 100, builtAt: 30_000 });
    assert.deepEqual(await minutesAt(90_000), { minutes: 17, frames: 2, close: 101, builtAt: 90_000 });
    assert.deepEqual(await minutesAt(200_000), { minutes: 18, frames: 3, close: 102, builtAt: 200_000 });
    assert.deepEqual(await minutesAt(10_000), { minutes: 16, frames: 1, close: 100, builtAt: 10_000 });
  });
});
