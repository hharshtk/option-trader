import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  createDhanFeed,
  FAILING_PAUSE_MS,
  IDLE_DISCONNECT_MS,
  RATE_LIMIT_PAUSE_MS,
  type FeedSocket,
  type FeedState,
} from "./dhan-feed.ts";
import type { Instrument } from "./packets.ts";

class FakeSocket implements FeedSocket {
  binaryType = "blob";
  readyState = 0;
  sent: string[] = [];
  closed = false;
  url: string;
  private listeners = new Map<string, ((event: never) => void)[]>();

  constructor(url: string) {
    this.url = url;
  }

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

  drop(code = 1006) {
    this.readyState = 3;
    this.emit("close", { code, reason: "" });
  }

  receiveDisconnect(reason: number) {
    const view = new DataView(new ArrayBuffer(10));
    view.setUint8(0, 50);
    view.setInt16(1, 10, true);
    view.setInt16(8, reason, true);
    this.emit("message", { data: view.buffer });
  }
}

const NIFTY: Instrument = { segment: "IDX_I", securityId: "13" };
const BANKNIFTY: Instrument = { segment: "IDX_I", securityId: "25" };

function setup() {
  const sockets: FakeSocket[] = [];
  const states: FeedState[] = [];
  const feed = createDhanFeed({
    readCredentials: () => ({ clientId: "1100000000", accessToken: "token" }),
    onPacket: () => {},
    onState: (state) => states.push(state),
    log: () => {},
    openSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5,
  });
  return { feed, sockets, states, last: () => states.at(-1) };
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"] }));
afterEach(() => mock.timers.reset());

test("connects on the first subscription and subscribes once the socket opens", () => {
  const { feed, sockets, last } = setup();
  assert.equal(sockets.length, 0);
  feed.subscribe([NIFTY]);
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /^wss:\/\/api-feed\.dhan\.co\?version=2&token=token&clientId=1100000000&authType=2$/);
  sockets[0].open();
  assert.equal(last()?.state, "live");
  assert.deepEqual(JSON.parse(sockets[0].sent[0]).InstrumentList, [{ ExchangeSegment: "IDX_I", SecurityId: "13" }]);
});

test("never opens a second socket while one exists", () => {
  const { feed, sockets } = setup();
  feed.subscribe([NIFTY]);
  feed.subscribe([BANKNIFTY]);
  assert.equal(sockets.length, 1);
  sockets[0].open();
  feed.subscribe([{ segment: "NSE_EQ", securityId: "1333" }]);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].sent.length, 2);
});

test("backs off after a drop, then resubscribes everything on the new socket", () => {
  const { feed, sockets, last } = setup();
  feed.subscribe([NIFTY, BANKNIFTY]);
  sockets[0].open();
  sockets[0].drop();
  assert.equal(last()?.state, "reconnecting");
  mock.timers.tick(999);
  assert.equal(sockets.length, 1);
  mock.timers.tick(2_000);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.equal(JSON.parse(sockets[1].sent[0]).InstrumentCount, 2);
});

test("waits at least a minute after Dhan's 805 disconnect", () => {
  const { feed, sockets } = setup();
  feed.subscribe([NIFTY]);
  sockets[0].open();
  sockets[0].receiveDisconnect(805);
  sockets[0].drop(1000);
  mock.timers.tick(RATE_LIMIT_PAUSE_MS - 1);
  assert.equal(sockets.length, 1);
  mock.timers.tick(1);
  assert.equal(sockets.length, 2);
});

test("stops for good on token errors instead of retrying", () => {
  const { feed, sockets, last } = setup();
  feed.subscribe([NIFTY]);
  sockets[0].open();
  sockets[0].receiveDisconnect(807);
  sockets[0].drop(1000);
  assert.equal(last()?.state, "stopped");
  mock.timers.tick(FAILING_PAUSE_MS * 2);
  feed.subscribe([BANKNIFTY]);
  assert.equal(sockets.length, 1);
});

test("slows to five-minute retries after repeated failed handshakes", () => {
  const { feed, sockets } = setup();
  feed.subscribe([NIFTY]);
  for (let failure = 0; failure < 4; failure++) {
    sockets.at(-1)?.drop();
    mock.timers.tick(30_000);
  }
  assert.equal(sockets.length, 5);
  sockets.at(-1)?.drop();
  mock.timers.tick(FAILING_PAUSE_MS - 1);
  assert.equal(sockets.length, 5);
  mock.timers.tick(1);
  assert.equal(sockets.length, 6);
});

test("disconnects after five idle minutes with no subscribers", () => {
  const { feed, sockets, last } = setup();
  feed.subscribe([NIFTY]);
  sockets[0].open();
  feed.unsubscribe([NIFTY]);
  assert.equal(JSON.parse(sockets[0].sent.at(-1) ?? "{}").RequestCode, 16);
  mock.timers.tick(IDLE_DISCONNECT_MS - 1);
  assert.equal(sockets[0].closed, false);
  mock.timers.tick(1);
  assert.equal(sockets[0].closed, true);
  assert.equal(last()?.state, "idle");
});

test("a resubscribe during the idle wait keeps the socket", () => {
  const { feed, sockets } = setup();
  feed.subscribe([NIFTY]);
  sockets[0].open();
  feed.unsubscribe([NIFTY]);
  mock.timers.tick(60_000);
  feed.subscribe([NIFTY]);
  mock.timers.tick(IDLE_DISCONNECT_MS);
  assert.equal(sockets[0].closed, false);
  assert.equal(sockets.length, 1);
});

test("reload reconnects with fresh credentials after a stop", () => {
  const { feed, sockets, last } = setup();
  feed.subscribe([NIFTY]);
  sockets[0].open();
  sockets[0].receiveDisconnect(809);
  sockets[0].drop(1000);
  assert.equal(last()?.state, "stopped");
  feed.reload();
  assert.equal(sockets.length, 2);
  assert.equal(last()?.state, "connecting");
});
