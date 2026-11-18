import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { bufferSource, createRecordCursor, fileSource, walkHeaders, type ByteSource } from "./byte-source.ts";
import { encodeRecord, MAGIC, type JournalRecord } from "./format.ts";

const T0 = Date.UTC(2026, 10, 18, 4, 0, 0);
const dir = mkdtempSync(path.join(tmpdir(), "byte-source-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Frames of `size` bytes at T0 + i seconds, with a control record first. */
function journal(sizes: number[]) {
  const records = [MAGIC, encodeRecord("control", 0, 1, T0 - 1, Buffer.from(JSON.stringify({ kind: "file-open" })))];
  sizes.forEach((size, i) => records.push(encodeRecord("frame", 1, i + 2, T0 + i * 1000, Buffer.alloc(size, i + 1))));
  return Buffer.concat(records);
}

async function collect(source: ByteSource, until = Infinity, chunkBytes?: number) {
  const seen: { type: string; at: number; offset: number; first: number | null; length: number }[] = [];
  const cursor = createRecordCursor(source, chunkBytes ? { chunkBytes } : undefined);
  await cursor.advance(until, (r: JournalRecord, offset) =>
    seen.push({ type: r.type, at: r.recvTs - T0, offset, first: r.frame ? r.frame[0] : null, length: r.frame?.length ?? 0 }),
  );
  return { seen, cursor };
}

describe("record cursor", () => {
  it("reads the same records whatever the chunk size, including records bigger than a chunk", async () => {
    const bytes = journal([10, 300, 5, 1000, 40]);
    const whole = await collect(bufferSource(bytes));
    const small = await collect(bufferSource(bytes), Infinity, 64);
    assert.deepEqual(small.seen, whole.seen);
    assert.deepEqual(whole.seen.map((r) => [r.type, r.length, r.first]), [["control", 0, null], ["frame", 10, 1], ["frame", 300, 2], ["frame", 5, 3], ["frame", 1000, 4], ["frame", 40, 5]]);
    assert.equal(whole.cursor.offset, bytes.length);
  });

  it("stops at the first record after a time, resumes from there and starts over on reset", async () => {
    const bytes = journal([10, 10, 10, 10]);
    const cursor = createRecordCursor(bufferSource(bytes), { chunkBytes: 50 });
    const at: number[] = [];
    await cursor.advance(T0 + 1500, (r) => at.push(r.recvTs - T0));
    assert.deepEqual(at, [-1, 0, 1000]);
    await cursor.advance(T0 + 2000, (r) => at.push(r.recvTs - T0));
    assert.deepEqual(at, [-1, 0, 1000, 2000]);
    cursor.reset();
    const again: number[] = [];
    await cursor.advance(T0, (r) => again.push(r.recvTs - T0));
    assert.deepEqual(again, [-1, 0]);
  });

  it("leaves a record still being written for the next call, on a file", async () => {
    const file = path.join(dir, "growing.bin");
    const bytes = journal([20, 20]);
    const cut = bytes.length - 7;
    writeFileSync(file, bytes.subarray(0, cut));
    const source = fileSource(file);
    const cursor = createRecordCursor(source);
    const lengths: number[] = [];
    await cursor.advance(Infinity, (r) => lengths.push(r.frame?.length ?? 0));
    assert.deepEqual(lengths, [0, 20]);
    appendFileSync(file, bytes.subarray(cut));
    await cursor.advance(Infinity, (r) => lengths.push(r.frame?.length ?? 0));
    assert.deepEqual(lengths, [0, 20, 20]);
    source.close();
    assert.throws(() => source.size(), /closed/);
  });

  it("refuses a file that isn't a journal", async () => {
    await assert.rejects(collect(bufferSource(Buffer.from("not a journal at all"))), /bad magic/);
  });
});

describe("walking headers", () => {
  it("finds every record without reading payloads, peeks where asked and resumes where it stopped", async () => {
    const bytes = journal([5000, 7000, 3000]);
    let reads = 0;
    const base = bufferSource(bytes);
    const counting: ByteSource = { ...base, read: (offset, length) => ((reads += length), base.read(offset, length)) };
    const seen: { type: number; length: number; head: string }[] = [];
    const end = await walkHeaders(counting, (r) => seen.push({ type: r.type, length: r.payloadLength, head: r.head.toString("hex") }), { peek: (type) => (type === 2 ? 100 : 2) });
    assert.equal(end, bytes.length);
    assert.deepEqual(seen.map((r) => [r.type, r.length]), [[2, 20], [1, 5000], [1, 7000], [1, 3000]]);
    assert.equal(seen[1].head, "0101");
    assert.ok(reads < 300, `read ${reads} bytes of ${bytes.length}`);

    const more = Buffer.concat([bytes, encodeRecord("frame", 1, 9, T0 + 9000, Buffer.alloc(8, 9))]);
    const later: number[] = [];
    const next = await walkHeaders(bufferSource(more.subarray(0, more.length - 3)), (r) => later.push(r.payloadLength), { from: end });
    assert.equal(later.length, 0, "a record cut short waits");
    assert.equal(next, end);
    await walkHeaders(bufferSource(more), (r) => later.push(r.payloadLength), { from: end });
    assert.deepEqual(later, [8]);
  });
});
