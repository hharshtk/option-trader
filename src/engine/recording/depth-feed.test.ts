import assert from "node:assert/strict";
import test from "node:test";
import type { FeedSocket } from "../../lib/live/feed/dhan-feed.ts";
import { createDepthFeed } from "./depth-feed.ts";

class FakeSocket implements FeedSocket {
  binaryType = "blob";
  readyState = 0;
  sent: unknown[] = [];
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
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const frames: number[] = [];
  const events: string[] = [];
  let token = "t1";
  const feed = createDepthFeed({
    readCredentials: () => ({ clientId: "100", accessToken: token }),
    currentToken: () => token,
    onFrame: (frame) => frames.push(frame.byteLength),
    onEvent: (kind, data) => events.push(kind === "state" ? (data.state as { state: string }).state : `subscribe ${(data.instruments as string[]).length}`),
    log: () => {},
    openSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5,
  });
  return { feed, sockets, frames, events, setToken: (next: string) => (token = next) };
}

const fut = (id: string) => ({ segment: "NSE_FNO" as const, securityId: id });

test("connects on the first instrument, subscribes on open, and sends only additions", () => {
  const { feed, sockets, events } = setup();
  feed.set([fut("1"), fut("2"), { segment: "IDX_I", securityId: "13" }]);
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /twentydepth\?token=t1&clientId=100&authType=2/);
  assert.equal(feed.status().dropped, 1, "indices have no depth feed");
  sockets[0].open();
  assert.deepEqual(sockets[0].sent, [{ RequestCode: 23, InstrumentCount: 2, InstrumentList: [{ ExchangeSegment: "NSE_FNO", SecurityId: "1" }, { ExchangeSegment: "NSE_FNO", SecurityId: "2" }] }]);

  feed.set([fut("1"), fut("2"), fut("3")]);
  assert.equal(sockets.length, 1);
  assert.deepEqual((sockets[0].sent[1] as { InstrumentList: unknown[] }).InstrumentList, [{ ExchangeSegment: "NSE_FNO", SecurityId: "3" }]);
  assert.deepEqual(events, ["connecting", "live", "subscribe 2", "subscribe 1"]);
});

test("a removal reconnects with the new list; an empty list disconnects", () => {
  const { feed, sockets } = setup();
  feed.set([fut("1"), fut("2")]);
  sockets[0].open();
  feed.set([fut("2")]);
  assert.ok(sockets[0].closed);
  assert.deepEqual(sockets[0].sent.at(-1), { RequestCode: 12 });
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.equal((sockets[1].sent[0] as { InstrumentCount: number }).InstrumentCount, 1);

  feed.set([]);
  assert.ok(sockets[1].closed);
  assert.equal(feed.status().state.state, "idle");
});

test("frames reach the journal; a rejected token stops until the token changes", () => {
  const { feed, sockets, frames, setToken } = setup();
  feed.set([fut("1")]);
  sockets[0].open();
  const disconnect = new DataView(new ArrayBuffer(14));
  disconnect.setInt16(0, 14, true);
  disconnect.setUint8(2, 50);
  disconnect.setInt16(12, 807, true);
  sockets[0].emit("message", { data: disconnect.buffer });
  sockets[0].emit("close", { code: 1000, reason: "" });
  assert.deepEqual(frames, [14]);
  assert.equal(feed.status().state.state, "stopped");

  feed.retryStopped();
  assert.equal(sockets.length, 1, "same token: stays stopped");
  setToken("t2");
  feed.retryStopped();
  assert.equal(sockets.length, 2);
  assert.match(sockets[1].url, /token=t2/);
  feed.shutdown();
});
