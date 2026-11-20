import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { PROTOCOL_VERSION, type EngineStatus } from "../../lib/engine/protocol.ts";
import { instrumentKey, type Instrument } from "../../lib/live/feed/packets.ts";
import { createTelemetryHub } from "../telemetry/hub.ts";
import { createLogHub } from "../telemetry/logger.ts";
import { createControlServer } from "./server.ts";

const TOKEN = "t".repeat(40);
const PORT = 31_000 + Math.floor(Math.random() * 1_000);

/** A stand-in for the feed hub that records calls and streams one quote event. */
function fakeHub() {
  const calls: string[] = [];
  const encoder = new TextEncoder();
  const sseOnce = (event: string, data: unknown, signal: AbortSignal, onClose: () => void) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        signal.addEventListener("abort", () => {
          onClose();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });
  const hub = {
    stream: (instruments: Instrument[], signal: AbortSignal) => {
      calls.push(`stream ${instruments.map(instrumentKey).join(",")}`);
      return sseOnce("quotes", { "IDX_I:13": { ltp: 1, at: 0 } }, signal, () => calls.push("stream closed"));
    },
    monitor: (signal: AbortSignal) => sseOnce("snapshot", { health: {}, events: [] }, signal, () => calls.push("monitor closed")),
    pin: (request: unknown) => (calls.push(`pin ${JSON.stringify(request)}`), { ok: true, message: "pinned" }),
    unpin: (key: string) => (calls.push(`unpin ${key}`), { ok: true, message: "unpinned" }),
    closeConnection: (id: number) => (calls.push(`close ${id}`), { ok: true, message: "closed" }),
  };
  return { hub: hub as unknown as import("../../lib/live/feed/feed-hub.ts").FeedHub, calls };
}

function setup() {
  let clock = 1_000;
  const now = () => clock;
  const telemetry = createTelemetryHub(now);
  const logs = createLogHub({ now });
  logs.subscribe((entry) => telemetry.publish("log", entry));
  const status = { protocol: PROTOCOL_VERSION, overall: "ok" } as EngineStatus;
  const feed = fakeHub();
  const server = createControlServer({
    feed: () => feed.hub,
    host: "127.0.0.1",
    port: PORT,
    token: TOKEN,
    status: () => status,
    telemetry,
    logs,
    log: logs.logger("api"),
    depth: (key) => ({ source: "replay", at: 42, instruments: [{ key: "NSE_FNO:61471", name: "NIFTY NOV FUT" }], book: key ? { key, name: null, at: 41, bids: [], asks: [] } : null }),
    chain: (underlying, expiry) => ({ source: "live", at: 42, underlying, expiries: expiry ? [expiry] : [], snapshot: null }),
    decide: async () => ({ days: [], holds: [5], rows: [], rules: [], costCheckFactor: 3, moveMinutes: 10, assumptions: { stopPct: 20, targetPct: 30, stopMoves: 1, targetMoves: 2, opposite: true, slippage: 0.05, entries: "", squareOff: "" }, exitModes: ["fixed"], fields: [], build: { state: "idle", at: null, message: null } }),
    predictions: async () => ({ horizon: 15, days: [], rows: [], build: { state: "idle", at: null, message: null } }),
  });
  return { server, telemetry, logs, feed, tick: (ms: number) => (clock += ms) };
}

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { Authorization: `Bearer ${TOKEN}`, ...headers } });
}

/** Reads SSE frames until `count` events arrived, then closes the connection. */
function readEvents(path: string, count: number, headers: Record<string, string> = {}) {
  return new Promise<{ event: string; id?: string; data: unknown }[]>((resolve, reject) => {
    const events: { event: string; id?: string; data: unknown }[] = [];
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Got ${events.length} of ${count} events: ${events.map((e) => e.event).join(", ")}`));
    }, 3_000);
    const req = request(
      { host: "127.0.0.1", port: PORT, path, headers: { Authorization: `Bearer ${TOKEN}`, ...headers } },
      (res) => {
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (frame.startsWith(":")) continue;
            const fields = Object.fromEntries(
              frame.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
            );
            events.push({ event: fields.event, id: fields.id, data: JSON.parse(fields.data) });
            if (events.length === count) {
              clearTimeout(timer);
              req.destroy();
              resolve(events);
            }
          }
        });
      },
    );
    req.on("error", (error) => {
      if (events.length < count) reject(error);
    });
    req.end();
  });
}

test("control API", { timeout: 15_000 }, async (t) => {
  const { server, telemetry, logs, feed } = setup();
  await server.listen();
  t.after(() => server.close());

  await t.test("rejects requests without the token", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/v1/status`);
    assert.equal(response.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${PORT}/v1/status`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
  });

  await t.test("serves status and 404s unknown routes", async () => {
    assert.deepEqual(await (await get("/v1/status")).json(), { protocol: PROTOCOL_VERSION, overall: "ok" });
    assert.equal((await get("/v1/nope")).status, 404);
  });

  await t.test("serves 20-level books and option chains, checking what is asked", async () => {
    const depth = (await (await get("/v1/depth?key=NSE_FNO:61471")).json()) as { book: { key: string } };
    assert.equal(depth.book.key, "NSE_FNO:61471");
    assert.equal((await get("/v1/depth?key=../etc")).status, 400);
    const chain = (await (await get("/v1/chain?expiry=2026-11-23")).json()) as { underlying: string; expiries: string[] };
    assert.deepEqual([chain.underlying, chain.expiries], ["NIFTY", ["2026-11-23"]]);
    assert.equal((await get("/v1/chain?underlying=nifty")).status, 400);
    assert.equal((await get("/v1/chain?expiry=tomorrow")).status, 400);
    const lab = (await (await get("/v1/decide")).json()) as { holds: number[]; build: { state: string } };
    assert.deepEqual([lab.holds, lab.build.state], [[5], "idle"]);
    const board = (await (await get("/v1/predictions")).json()) as { horizon: number; rows: unknown[] };
    assert.deepEqual([board.horizon, board.rows], [15, []]);
  });

  await t.test("serves the log backlog with filters", async () => {
    const log = logs.logger("feed");
    log.info("one");
    log.warn("two");
    const body = (await (await get("/v1/logs?level=warn")).json()) as { entries: { message: string }[] };
    assert.deepEqual(body.entries.map((e) => e.message), ["two"]);
  });

  await t.test("telemetry sends hello, then the backlog, then live messages", async () => {
    const buffered = telemetry.backlog(new Set(["status", "log"] as const), 0).length;
    const reading = readEvents("/v1/telemetry?topics=status,log", buffered + 2);
    // Give the connection a moment to subscribe before publishing live.
    await new Promise((resolve) => setTimeout(resolve, 50));
    telemetry.publish("status", { overall: "ok" } as EngineStatus);
    const events = await reading;
    // hello, every buffered log line in seq order, then the live status.
    assert.ok(buffered >= 2);
    assert.deepEqual(
      events.map((e) => e.event),
      ["hello", ...Array<string>(buffered).fill("log"), "status"],
    );
    const ids = events.slice(1).map((e) => Number(e.id));
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  });

  await t.test("telemetry resumes after Last-Event-ID and skips other topics", async () => {
    const seqBefore = telemetry.seq;
    logs.logger("x").info("after");
    telemetry.publish("metrics", { at: 0, windowMs: 0, counters: {}, gauges: {}, histograms: {} });
    const events = await readEvents("/v1/telemetry?topics=log", 2, { "Last-Event-ID": String(seqBefore) });
    assert.equal(events[1].event, "log");
    assert.equal(Number(events[1].id), seqBefore + 1);
    assert.equal((events[1].data as { data: { message: string } }).data.message, "after");
  });

  await t.test("streams quotes for the requested instruments and releases them on disconnect", async () => {
    const events = await readEvents("/v1/quotes?i=IDX_I:13,bogus,IDX_I:13", 1);
    assert.equal(events[0].event, "quotes");
    assert.deepEqual(events[0].data, { "IDX_I:13": { ltp: 1, at: 0 } });
    assert.equal(feed.calls[0], "stream IDX_I:13", "invalid and duplicate keys are dropped");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(feed.calls.includes("stream closed"), "closing the connection aborts the hub stream");
  });

  await t.test("streams the Live Feed monitor", async () => {
    const events = await readEvents("/v1/feed", 1);
    assert.equal(events[0].event, "snapshot");
  });

  await t.test("forwards Live Feed actions and validates their input", async () => {
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${PORT}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.deepEqual(await (await post("/v1/feed/pin", { key: "NSE_EQ:1333", connection: "new", name: "HDFC" })).json(), {
      ok: true,
      message: "pinned",
    });
    assert.equal((await post("/v1/feed/pin", { key: 5 })).status, 400);
    assert.equal((await (await post("/v1/feed/unpin", { key: "NSE_EQ:1333" })).json()).message, "unpinned");
    assert.equal((await (await post("/v1/feed/connections/2/close", {})).json()).message, "closed");
    assert.ok(feed.calls.includes('pin {"key":"NSE_EQ:1333","connection":"new","name":"HDFC"}'));
    assert.ok(feed.calls.includes("close 2"));
    assert.equal((await post("/v1/status", {})).status, 404, "POST only reaches feed actions");
  });

  await t.test("blocks a client after repeated bad tokens, while others still get in", async () => {
    for (let i = 0; i < 10; i += 1) {
      await fetch(`http://127.0.0.1:${PORT}/v1/status`, {
        headers: { Authorization: "Bearer wrong", "X-Forwarded-For": "203.0.113.50" },
      });
    }
    const blocked = await fetch(`http://127.0.0.1:${PORT}/v1/status`, {
      headers: { Authorization: `Bearer ${TOKEN}`, "X-Forwarded-For": "203.0.113.50" },
    });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    assert.equal((await get("/v1/status")).status, 200);
  });
});
