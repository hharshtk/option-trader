import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { PROTOCOL_VERSION, type EngineStatus } from "../../lib/engine/protocol.ts";
import { createTelemetryHub } from "../telemetry/hub.ts";
import { createLogHub } from "../telemetry/logger.ts";
import { createControlServer } from "./server.ts";

const TOKEN = "t".repeat(40);
const PORT = 31_000 + Math.floor(Math.random() * 1_000);

function setup() {
  let clock = 1_000;
  const now = () => clock;
  const telemetry = createTelemetryHub(now);
  const logs = createLogHub({ now });
  logs.subscribe((entry) => telemetry.publish("log", entry));
  const status = { protocol: PROTOCOL_VERSION, overall: "ok" } as EngineStatus;
  const server = createControlServer({
    host: "127.0.0.1",
    port: PORT,
    token: TOKEN,
    status: () => status,
    telemetry,
    logs,
    log: logs.logger("api"),
  });
  return { server, telemetry, logs, tick: (ms: number) => (clock += ms) };
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
  const { server, telemetry, logs } = setup();
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

  await t.test("serves the log backlog with filters", async () => {
    const log = logs.logger("feed");
    log.info("one");
    log.warn("two");
    const body = (await (await get("/v1/logs?level=warn")).json()) as { entries: { message: string }[] };
    assert.deepEqual(body.entries.map((e) => e.message), ["two"]);
  });

  await t.test("telemetry sends hello, then the backlog, then live messages", async () => {
    const reading = readEvents("/v1/telemetry?topics=status,log", 4);
    // Give the connection a moment to subscribe before publishing live.
    await new Promise((resolve) => setTimeout(resolve, 50));
    telemetry.publish("status", { overall: "ok" } as EngineStatus);
    const events = await reading;
    // hello, the two buffered log lines, then the live status.
    assert.deepEqual(events.map((e) => e.event), ["hello", "log", "log", "status"]);
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
});
