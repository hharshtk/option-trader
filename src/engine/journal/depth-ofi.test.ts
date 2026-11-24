import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bufferSource, type ByteSource } from "./byte-source.ts";
import { createDepthOfi, ofiCutoff, type OfiDay } from "./depth-ofi.ts";
import { encodeRecord, MAGIC } from "./format.ts";

const OPEN = Date.UTC(2026, 10, 25, 3, 45); // 09:15 IST
const FUT = 61471;
const KEY = `NSE_FNO:${FUT}`;
const CUTOFF = ofiCutoff(OPEN, 0); // 09:16:01.5

/** One side of the future's book: five levels a point apart, `qty` at each. */
function side(code: 41 | 51, best: number, qty: number) {
  const packet = Buffer.alloc(12 + 20 * 16);
  packet.writeInt16LE(packet.length, 0);
  packet.writeUInt8(code, 2);
  packet.writeUInt8(2, 3); // NSE_FNO
  packet.writeInt32LE(FUT, 4);
  for (let i = 0; i < 5; i += 1) {
    packet.writeDoubleLE(code === 41 ? best - i : best + i, 12 + i * 16);
    packet.writeUInt32LE(qty, 12 + i * 16 + 8);
    packet.writeUInt32LE(1, 12 + i * 16 + 12);
  }
  return packet;
}
const book = (bidQty: number) => Buffer.concat([side(41, 25_300, bidQty), side(51, 25_301, 120)]);

/** Both sides every 500 ms from 09:15 to 09:16:01, then `extra` frames: [receive time, bid quantity]. */
function depthRecords(extra: [number, number][]) {
  let seq = 0;
  const records: Buffer[] = [MAGIC];
  for (let at = OPEN; at <= OPEN + 61_000; at += 500) records.push(encodeRecord("frame", 1, ++seq, at, book(200)));
  for (const [at, qty] of extra) records.push(encodeRecord("frame", 1, ++seq, at, book(qty)));
  return records;
}

/** A source showing only the first `visible` bytes, as a file being written does. */
function growing(bytes: Buffer) {
  let visible = bytes.length;
  const source: ByteSource & { show(n: number): void } = {
    size: () => visible,
    read: (offset, length) => bytes.subarray(offset, Math.min(visible, offset + length)),
    close() {},
    show: (n) => (visible = n),
  };
  return source;
}

const day = (events: OfiDay["events"] = []): OfiDay => ({ open: OPEN, key: KEY, events });
const size = (records: Buffer[]) => records.reduce((n, r) => n + r.length, 0);

describe("depth OFI", () => {
  it("reads a minute at its cutoff, from nothing received after it", async () => {
    // The bid grows by 40 at every rank 100 ms before the cutoff; 100 ms after it the ask would pull the other way.
    const records = depthRecords([[CUTOFF - 100, 240]]);
    records.push(encodeRecord("frame", 1, 999, CUTOFF + 100, Buffer.concat([side(41, 25_300, 240), side(51, 25_301, 4_000)])));
    const [reading] = await createDepthOfi(bufferSource(Buffer.concat(records))).readings(day(), 1, Infinity);
    // In the window: 119 books of 200 + 120 and the last of 240 + 120.
    const meanDepth = (119 * 320 + 360) / 120;
    const expected = (40 / meanDepth) * (1 + 1 / 2 + 1 / 3 + 1 / 4 + 1 / 5);
    assert.equal(reading!.reason, "ok");
    assert.ok(Math.abs(reading!.value! - expected) < 1e-12);
  });

  it("starts over at a main-journal interruption, so the minute is still warming up", async () => {
    const source = bufferSource(Buffer.concat(depthRecords([[CUTOFF + 100, 200]])));
    const [reading] = await createDepthOfi(source).readings(day([{ at: OPEN + 30_000 }]), 1, Infinity);
    assert.deepEqual(reading, { value: null, reason: "warmup" });
  });

  it("gives nothing for a cutoff after the position", async () => {
    const source = bufferSource(Buffer.concat(depthRecords([[CUTOFF + 100, 200]])));
    assert.deepEqual(await createDepthOfi(source).readings(day(), 2, CUTOFF + 30_000), [{ value: 0, reason: "flat" }, null]);
  });

  it("reads a cutoff again until the file holds what came after it", async () => {
    // Written late: a frame received 50 ms before the cutoff lands after the one received 100 ms before it.
    const records = depthRecords([[CUTOFF - 100, 240], [CUTOFF - 50, 280], [CUTOFF + 100, 280]]);
    const source = growing(Buffer.concat(records));
    const ofi = createDepthOfi(source);
    source.show(size(records.slice(0, -2)));
    const [early] = await ofi.readings(day(), 1, CUTOFF);
    source.show(size(records));
    const [settled] = await ofi.readings(day(), 1, CUTOFF);
    assert.equal(early!.reason, "ok");
    assert.equal(settled!.reason, "ok");
    // The late frame adds 40 more at every rank.
    assert.ok(settled!.value! > early!.value! * 1.9);
    assert.deepEqual((await ofi.readings(day(), 1, Infinity))[0], settled);
  });
});
