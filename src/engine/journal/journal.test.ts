import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { instrumentKey } from "../../lib/live/feed/packets.ts";
import { byMode, resolveUniverse } from "../market/universe.ts";
import { decodeJournal, encodeRecord, JournalFormatError, MAGIC } from "./format.ts";
import { createJournal } from "./writer.ts";

const istDate = (time: number) => new Date(time + 330 * 60_000).toISOString().slice(0, 10);
const ist = (value: string) => Date.parse(`${value}+05:30`);

test("records round-trip through the format, frames byte for byte", () => {
  const frame = Buffer.from([0x02, 0x10, 0x00, 0x01, 0xff, 0x00]);
  const bytes = Buffer.concat([
    MAGIC,
    encodeRecord("frame", 3, 1, 1_794_800_000_123, frame),
    encodeRecord("control", 0, 2, 1_794_800_000_456, Buffer.from(JSON.stringify({ kind: "gap", from: 1, to: 2 }))),
  ]);
  const { records, truncatedBytes } = decodeJournal(bytes);
  assert.equal(truncatedBytes, 0);
  assert.deepEqual(records[0], { type: "frame", connection: 3, seq: 1, recvTs: 1_794_800_000_123, frame });
  assert.deepEqual(records[1].control, { kind: "gap", from: 1, to: 2 });
  assert.equal(records[1].seq, 2);
});

test("a truncated last record is reported, not thrown; a foreign file is rejected", () => {
  const whole = encodeRecord("frame", 1, 1, 1, Buffer.from("abcdef"));
  const bytes = Buffer.concat([MAGIC, whole, whole.subarray(0, 10)]);
  const { records, truncatedBytes } = decodeJournal(bytes);
  assert.equal(records.length, 1);
  assert.equal(truncatedBytes, 10);
  assert.throws(() => decodeJournal(Buffer.from("hello world")), JournalFormatError);
});

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("writer numbers records across connections, opens a file per IST day, and writes opening records", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "journal-"));
  let clock = ist("2026-11-16T23:59:59");
  const opened: string[] = [];
  const journal = createJournal({
    directory,
    istDate,
    now: () => clock,
    onOpen: (date) => {
      opened.push(date);
      journal.control("file-open", { date }, clock);
    },
  });

  journal.frame(1, Buffer.from([1, 2, 3]), clock);
  journal.frame(2, new Uint8Array([4]).buffer, clock);
  journal.control("subscribe", { keys: ["IDX_I:13"] }, clock, 1);
  clock = ist("2026-11-17T00:00:01");
  journal.frame(1, Buffer.from([5]), clock);
  journal.control("gap", { reason: "reconnect", from: 1, to: 2 }, clock, 1);
  assert.equal(journal.status().gaps, 1);
  await journal.close();
  await settle();

  assert.deepEqual(opened, ["2026-11-16", "2026-11-17"]);
  const first = decodeJournal(readFileSync(path.join(directory, "2026-11-16.bin"))).records;
  assert.deepEqual(first.map((r) => [r.seq, r.type, r.connection]), [
    [1, "control", 0],
    [2, "frame", 1],
    [3, "frame", 2],
    [4, "control", 1],
  ]);
  assert.equal(first[0].control?.kind, "file-open");
  assert.deepEqual(first[1].frame, Buffer.from([1, 2, 3]));

  const second = decodeJournal(readFileSync(path.join(directory, "2026-11-17.bin"))).records;
  assert.deepEqual(second.map((r) => r.control?.kind ?? "frame"), ["file-open", "frame", "gap"]);
  assert.equal(second[0].seq, 1, "each day starts its own sequence");

  assert.deepEqual(
    journal.days().map((d) => d.date),
    ["2026-11-17", "2026-11-16"],
  );
});

test("a restart on the same day appends to that day's file", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "journal-"));
  const at = ist("2026-11-16T10:00:00");
  for (const run of [1, 2]) {
    const journal = createJournal({ directory, istDate, now: () => at });
    journal.control("engine-start", { run }, at);
    journal.frame(1, Buffer.from([run]), at);
    await journal.close();
    await settle();
  }
  const records = decodeJournal(readFileSync(path.join(directory, "2026-11-16.bin"))).records;
  assert.deepEqual(records.map((r) => [r.seq, r.control?.run ?? r.frame?.[0]]), [
    [1, 1],
    [2, 1],
    [1, 2],
    [2, 2],
  ]);
});

test("decoding survives a file whose last write was cut off", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "journal-"));
  const file = path.join(directory, "cut.bin");
  writeFileSync(file, MAGIC);
  appendFileSync(file, encodeRecord("frame", 1, 1, 1, Buffer.from("ok")));
  appendFileSync(file, encodeRecord("frame", 1, 2, 2, Buffer.from("cut")).subarray(0, 7));
  const { records, truncatedBytes } = decodeJournal(readFileSync(file));
  assert.equal(records.length, 1);
  assert.equal(truncatedBytes, 7);
});

test("the default universe is the NIFTY index and its constituents", () => {
  const universe = resolveUniverse();
  const keys = universe.instruments.map(instrumentKey);
  assert.equal(universe.problems.length, 0);
  assert.ok(keys.includes("IDX_I:13"), "NIFTY index");
  assert.ok(keys.includes("NSE_EQ:1333"), "HDFCBANK");
  assert.equal(keys.length, new Set(keys).size, "no duplicates");
  assert.ok(keys.length >= 50);
});

test("the default universe streams constituents in quote mode and the index in ticker mode", () => {
  const universe = resolveUniverse();
  assert.equal(universe.modes.get("IDX_I:13"), "ticker");
  assert.equal(universe.modes.get("NSE_EQ:1333"), "quote");
  const groups = Object.fromEntries(byMode(universe).map(([mode, list]) => [mode, list.length]));
  assert.equal(groups.ticker, 1);
  assert.equal(groups.quote, universe.instruments.length - 1);
});

test("an instrument listed twice gets the richer mode; unknown modes fall back to ticker", () => {
  const universe = resolveUniverse({
    version: 1,
    name: "test",
    include: [
      { kind: "instrument", key: "NSE_EQ:1333", mode: "quote" },
      { kind: "instrument", key: "NSE_EQ:1333" },
      { kind: "instrument", key: "NSE_EQ:2885", mode: "bogus" as never },
    ],
    instruments: [],
  });
  assert.equal(universe.modes.get("NSE_EQ:1333"), "quote");
  assert.equal(universe.modes.get("NSE_EQ:2885"), "ticker");
  assert.equal(universe.problems.length, 1);
});

test("universe reports entries it can't resolve", () => {
  const universe = resolveUniverse({
    version: 1,
    name: "test",
    include: [{ kind: "index", index: "NOPE" }, { kind: "instrument", key: "bad" }],
    instruments: ["NSE_EQ:1333", "NSE_EQ:1333"],
  });
  assert.equal(universe.instruments.length, 1);
  assert.equal(universe.problems.length, 2);
});
