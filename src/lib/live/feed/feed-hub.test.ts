import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { FeedSocket } from "./dhan-feed.ts";
import { createFeedHub, UNSUBSCRIBE_GRACE_MS } from "./feed-hub.ts";
import { MAX_CONNECTIONS } from "./monitor.ts";
import type { Instrument } from "./packets.ts";

class FakeSocket implements FeedSocket {
  binaryType = "blob";
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, ((event: never) => void)[]>();

  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  /** [RequestCode, keys] for each subscription message sent. */
  requests() {
    return this.sent.map((message) => {
      const { RequestCode, InstrumentList = [] } = JSON.parse(message);
      return [
        RequestCode,
        InstrumentList.map((item: { ExchangeSegment: string; SecurityId: string }) => `${item.ExchangeSegment}:${item.SecurityId}`),
      ];
    });
  }
}

const NIFTY: Instrument = { segment: "IDX_I", securityId: "13" };
const BANKNIFTY: Instrument = { segment: "IDX_I", securityId: "25" };

let hub: ReturnType<typeof createFeedHub> | undefined;

function setup() {
  const sockets: FakeSocket[] = [];
  hub = createFeedHub({
    readCredentials: () => ({ clientId: "1100000000", accessToken: "token" }),
    currentToken: () => "token",
    print: () => {},
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { hub, sockets };
}

const connectionOf = (h: NonNullable<typeof hub>, key: string) =>
  h.health().instruments.find((instrument) => instrument.key === key)?.connection;

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] }));
afterEach(() => {
  hub?.shutdown();
  hub = undefined;
  mock.timers.reset();
});

test("starts with only Main, which has no socket until something subscribes", () => {
  const { hub, sockets } = setup();
  const [main] = hub.health().connections;
  assert.equal(hub.health().connections.length, 1);
  assert.deepEqual([main.id, main.name, main.main, main.feed.state], [1, "Main", true, "idle"]);
  assert.equal(sockets.length, 0);
});

test("app pages subscribe on Main and release after the grace period", () => {
  const { hub, sockets } = setup();
  hub.acquire([NIFTY, BANKNIFTY]);
  sockets[0].open();
  assert.deepEqual(sockets[0].requests(), [[15, ["IDX_I:13", "IDX_I:25"]]]);

  hub.release([BANKNIFTY]);
  assert.notEqual(hub.health().instruments.find(({ key }) => key === "IDX_I:25")?.releaseAt, null);
  mock.timers.tick(UNSUBSCRIBE_GRACE_MS);
  assert.deepEqual(sockets[0].requests().at(-1), [16, ["IDX_I:25"]]);
  assert.deepEqual(
    hub.health().instruments.map(({ key }) => key),
    ["IDX_I:13"],
  );
});

test("acquiring in a richer mode upgrades the instrument; a poorer mode never downgrades it", () => {
  const { hub, sockets } = setup();
  hub.acquire([NIFTY]);
  sockets[0].open();
  hub.acquire([NIFTY, BANKNIFTY], "quote");
  hub.acquire([NIFTY]);
  assert.deepEqual(sockets[0].requests(), [
    [15, ["IDX_I:13"]],
    [17, ["IDX_I:25"]],
    [16, ["IDX_I:13"]],
    [17, ["IDX_I:13"]],
  ]);
  assert.deepEqual(
    hub.health().instruments.map(({ key, mode, tabs }) => [key, mode, tabs]),
    [
      ["IDX_I:13", "quote", 3],
      ["IDX_I:25", "quote", 1],
    ],
  );
});

test("subscribe events carry the mode, for the journal", () => {
  const events: unknown[] = [];
  const sockets: FakeSocket[] = [];
  hub = createFeedHub({
    readCredentials: () => ({ clientId: "1100000000", accessToken: "token" }),
    currentToken: () => "token",
    print: () => {},
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onEvent: (event) => events.push(event),
  });
  hub.acquire([BANKNIFTY], "quote");
  assert.ok(events.some((e) => JSON.stringify(e) === JSON.stringify({ type: "subscribe", keys: ["IDX_I:25"], mode: "quote", connection: 1 })));
});

test("a tab coming back within the grace period keeps the subscription", () => {
  const { hub, sockets } = setup();
  hub.acquire([NIFTY]);
  sockets[0].open();
  hub.release([NIFTY]);
  hub.acquire([NIFTY]);
  mock.timers.tick(UNSUBSCRIBE_GRACE_MS);
  assert.equal(sockets[0].sent.length, 1);
});

test("adding to a new connection opens a second socket for it", () => {
  const { hub, sockets } = setup();
  hub.acquire([NIFTY]);
  const result = hub.pin({ key: "nse_eq:2885", name: "RELIANCE", connection: "new", connectionName: "Stocks" });
  assert.equal(result.ok, true, result.message);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.deepEqual(sockets[1].requests(), [[15, ["NSE_EQ:2885"]]]);

  const connections = hub.health().connections;
  assert.deepEqual(
    connections.map(({ id, name, instruments }) => [id, name, instruments]),
    [
      [1, "Main", 1],
      [2, "Stocks", 1],
    ],
  );
  const reliance = hub.health().instruments.find(({ key }) => key === "NSE_EQ:2885");
  assert.deepEqual([reliance?.connection, reliance?.pinned, reliance?.name], [2, true, "RELIANCE"]);
});

test("an instrument streams on one connection only", () => {
  const { hub, sockets } = setup();
  hub.acquire([NIFTY]);
  const result = hub.pin({ key: "IDX_I:13", connection: "new" });
  assert.equal(result.ok, false);
  assert.match(result.message, /already streams on Main/);
  assert.equal(sockets.length, 1);
  assert.equal(hub.health().connections.length, 1);
});

test("pinning what a page already shows keeps it after the page closes", () => {
  const { hub, sockets } = setup();
  hub.acquire([NIFTY]);
  sockets[0].open();
  assert.equal(hub.pin({ key: "IDX_I:13", connection: 1 }).ok, true);
  hub.release([NIFTY]);
  mock.timers.tick(UNSUBSCRIBE_GRACE_MS);
  assert.equal(sockets[0].sent.length, 1);

  assert.equal(hub.unpin("IDX_I:13").ok, true);
  assert.deepEqual(sockets[0].requests().at(-1), [16, ["IDX_I:13"]]);
});

test("pages asking for a pinned instrument are served from its connection", () => {
  const { hub } = setup();
  hub.pin({ key: "NSE_EQ:2885", connection: "new" });
  hub.acquire([{ segment: "NSE_EQ", securityId: "2885" }]);
  assert.equal(connectionOf(hub, "NSE_EQ:2885"), 2);
  assert.equal(hub.health().connections[0].instruments, 0);
});

test("closing a connection disconnects it and moves what pages still show to Main", () => {
  const { hub, sockets } = setup();
  hub.acquire([NIFTY]);
  sockets[0].open();
  hub.pin({ key: "NSE_EQ:2885", connection: "new" });
  hub.pin({ key: "NSE_EQ:1333", connection: 2 });
  sockets[1].open();
  hub.acquire([{ segment: "NSE_EQ", securityId: "1333" }]);

  const result = hub.closeConnection(2);
  assert.equal(result.ok, true, result.message);
  assert.equal(sockets[1].closed, true);
  assert.deepEqual(sockets[1].requests().at(-1), [12, []]);
  assert.deepEqual(sockets[0].requests().at(-1), [15, ["NSE_EQ:1333"]]);
  assert.deepEqual(
    hub.health().instruments.map(({ key, connection, pinned }) => [key, connection, pinned]),
    [
      ["IDX_I:13", 1, false],
      ["NSE_EQ:1333", 1, false],
    ],
  );
  assert.equal(hub.closeConnection(1).ok, false);
});

test("stops at Dhan's connection limit", () => {
  const { hub } = setup();
  for (let index = 1; index < MAX_CONNECTIONS; index += 1) {
    assert.equal(hub.pin({ key: `NSE_EQ:${index}`, connection: "new" }).ok, true);
  }
  const result = hub.pin({ key: "NSE_EQ:999", connection: "new" });
  assert.equal(result.ok, false);
  assert.match(result.message, /5 connections/);
  assert.equal(hub.health().connections.length, MAX_CONNECTIONS);
});

test("rejects keys that aren't SEGMENT:SECURITY_ID", () => {
  const { hub } = setup();
  assert.equal(hub.pin({ key: "RELIANCE", connection: 1 }).ok, false);
  assert.equal(hub.pin({ key: "NSE_EQ:2885", connection: 7 }).ok, false);
});

/** Everything a stream has queued so far, as [event, data] pairs. */
async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const next = await Promise.race([reader.read(), new Promise<null>((resolve) => setImmediate(() => resolve(null)))]);
    if (!next || next.done) break;
    text += decoder.decode(next.value);
  }
  reader.releaseLock();
  return text
    .split("\n\n")
    .map((block) => [/^event: (.*)$/m.exec(block)?.[1], /^data: (.*)$/m.exec(block)?.[1]])
    .filter((pair): pair is [string, string] => !!pair[0] && !!pair[1])
    .map(([event, data]) => [event, JSON.parse(data)] as const);
}

test("a Live Feed page joining between flushes gets each event once", async () => {
  const { hub, sockets } = setup();
  const first = new AbortController();
  const second = new AbortController();
  const a = hub.monitor(first.signal);
  await drain(a);
  hub.acquire([NIFTY]);
  sockets[0].open();
  // These events wait for the next flush, and are already in the history a new page's snapshot holds.
  const b = hub.monitor(second.signal);
  mock.timers.tick(250);
  hub.acquire([BANKNIFTY]);
  mock.timers.tick(250);

  const ids: number[] = [];
  for (const [event, data] of await drain(b)) {
    if (event === "snapshot") ids.push(...data.events.map((e: { id: number }) => e.id));
    if (event === "events") ids.push(...data.map((e: { id: number }) => e.id));
  }
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length, `repeated ids in ${ids.join(",")}`);
  first.abort();
  second.abort();
});
