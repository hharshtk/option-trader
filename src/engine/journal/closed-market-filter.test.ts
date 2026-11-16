import assert from "node:assert/strict";
import test from "node:test";
import { createSessionCalendar } from "../market/session-calendar.ts";
import { createClosedMarketFilter } from "./closed-market-filter.ts";

const calendar = createSessionCalendar();
const ist = (value: string) => Date.parse(`${value}+05:30`);

const SEGMENT = { IDX_I: 0, NSE_EQ: 1, MCX_COMM: 5 } as const;

/** A 16-byte ticker packet (code 2), as Dhan sends it. */
function ticker(segment: keyof typeof SEGMENT, securityId: number, ltp: number, ltt: number) {
  const packet = Buffer.alloc(16);
  packet.writeUInt8(2, 0);
  packet.writeInt16LE(16, 1);
  packet.writeUInt8(SEGMENT[segment], 3);
  packet.writeInt32LE(securityId, 4);
  packet.writeFloatLE(ltp, 8);
  packet.writeInt32LE(ltt, 12);
  return packet;
}

test("after the close, repeats of the last price are skipped even as the timestamp moves", () => {
  const filter = createClosedMarketFilter(calendar);
  const at = ist("2026-11-16T16:44:00");
  assert.equal(filter.shouldJournal(ticker("IDX_I", 13, 25291.1, 1), at), true, "first packet: kept");
  assert.equal(filter.shouldJournal(ticker("IDX_I", 13, 25291.1, 2), at + 100), false);
  assert.equal(filter.shouldJournal(ticker("IDX_I", 13, 25291.1, 3), at + 200), false);
  assert.equal(filter.shouldJournal(ticker("IDX_I", 25, 61575.9, 3), at + 200), true, "another instrument: kept");
  assert.equal(filter.shouldJournal(ticker("IDX_I", 13, 25300, 4), at + 300), true, "a new price: kept");
});

test("a frame is kept when any one of its packets is new", () => {
  const filter = createClosedMarketFilter(calendar);
  const at = ist("2026-11-16T20:00:00");
  filter.shouldJournal(ticker("IDX_I", 13, 25291.1, 1), at);
  const mixed = Buffer.concat([ticker("IDX_I", 13, 25291.1, 2), ticker("NSE_EQ", 2885, 1500, 2)]);
  assert.equal(filter.shouldJournal(mixed, at + 1), true);
  assert.equal(filter.shouldJournal(mixed, at + 2), false);
});

test("during market hours nothing is skipped, and the next close starts fresh", () => {
  const filter = createClosedMarketFilter(calendar);
  const open = ist("2026-11-16T10:00:00");
  for (let i = 0; i < 3; i += 1) {
    assert.equal(filter.shouldJournal(ticker("IDX_I", 13, 25291.1, i), open + i), true);
  }
  filter.shouldJournal(ticker("IDX_I", 13, 25291.1, 9), ist("2026-11-15T12:00:00")); // Sunday
  filter.shouldJournal(ticker("IDX_I", 13, 25291.1, 9), open); // clears what Sunday tracked
  assert.equal(filter.shouldJournal(ticker("IDX_I", 13, 25291.1, 10), ist("2026-11-16T15:30:00")), true);
});

test("in pre-open, cash equity passes while the closed index segment is still filtered", () => {
  const filter = createClosedMarketFilter(calendar);
  const preOpen = ist("2026-11-16T09:05:00");
  assert.equal(filter.shouldJournal(ticker("NSE_EQ", 2885, 1500, 1), preOpen), true);
  assert.equal(filter.shouldJournal(ticker("NSE_EQ", 2885, 1500, 2), preOpen + 1), true);
  filter.shouldJournal(ticker("IDX_I", 13, 25291.1, 1), preOpen);
  assert.equal(filter.shouldJournal(ticker("IDX_I", 13, 25291.1, 2), preOpen + 1), false);
});

test("segments the calendar doesn't know and unreadable frames are always kept", () => {
  const filter = createClosedMarketFilter(calendar);
  const at = ist("2026-11-16T20:00:00");
  filter.shouldJournal(ticker("MCX_COMM", 1, 6000, 1), at);
  assert.equal(filter.shouldJournal(ticker("MCX_COMM", 1, 6000, 2), at + 1), true);
  assert.equal(filter.shouldJournal(Buffer.from([0x63, 0x01]), at + 2), true);
});
