// The journal's on-disk format. One file per IST trading day: data/engine/journal/YYYY-MM-DD.bin.
//
//   file   = MAGIC (8 bytes) record*
//   record = length u32 | type u8 | reserved u8 | connection u16 | seq f64 | recvTs f64 | payload
//
// All little-endian. `length` counts everything after itself. `seq` increases by one per record
// within a file, across every connection, so a day has a single order. `recvTs` is the engine's
// receive time in ms. A frame record's payload is the raw WebSocket frame exactly as Dhan sent
// it; a control record's payload is UTF-8 JSON (`{ kind, ...data }`). f64 holds integers
// exactly up to 2^53, far beyond any seq or timestamp here.

export const MAGIC = Buffer.from("OTJRNL01", "ascii");
export const HEADER_BYTES = 24;

export const RecordType = { frame: 1, control: 2 } as const;
export type RecordTypeName = keyof typeof RecordType;

export interface JournalRecord {
  type: RecordTypeName;
  connection: number;
  seq: number;
  recvTs: number;
  /** The raw frame, for frame records. */
  frame?: Buffer;
  /** The parsed JSON, for control records. */
  control?: { kind: string; [field: string]: unknown };
}

export function encodeRecord(
  type: RecordTypeName,
  connection: number,
  seq: number,
  recvTs: number,
  payload: Buffer,
): Buffer {
  const record = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  record.writeUInt32LE(HEADER_BYTES - 4 + payload.length, 0);
  record.writeUInt8(RecordType[type], 4);
  record.writeUInt8(0, 5);
  record.writeUInt16LE(connection, 6);
  record.writeDoubleLE(seq, 8);
  record.writeDoubleLE(recvTs, 16);
  payload.copy(record, HEADER_BYTES);
  return record;
}

export class JournalFormatError extends Error {
  name = "JournalFormatError";
}

/**
 * Decodes every complete record in a journal file's bytes. A truncated last record (the engine
 * stopped mid-write) is reported through `truncatedBytes` instead of throwing.
 */
export function decodeJournal(bytes: Buffer): { records: JournalRecord[]; truncatedBytes: number } {
  if (bytes.length < MAGIC.length || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new JournalFormatError("Not a journal file (bad magic)");
  }
  const records: JournalRecord[] = [];
  const end = readRecords(bytes, MAGIC.length, (record) =>
    records.push(record.frame ? { ...record, frame: Buffer.from(record.frame) } : record),
  );
  return { records, truncatedBytes: bytes.length - end };
}

/**
 * Reads the complete records in `bytes` from `offset`, which must be the start of a record, and
 * returns the offset just past the last one. A record cut off at the end is left for the caller
 * to retry once more bytes arrive, so a file can be read while it is being written. Frames are
 * views into `bytes`, not copies: copy one to keep it after `bytes` is reused.
 */
export function readRecords(bytes: Buffer, offset: number, onRecord: (record: JournalRecord) => void): number {
  while (offset + 4 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    if (length < HEADER_BYTES - 4) throw new JournalFormatError(`Bad record length ${length} at byte ${offset}`);
    if (offset + 4 + length > bytes.length) break;
    const typeCode = bytes.readUInt8(offset + 4);
    const type = typeCode === RecordType.frame ? "frame" : typeCode === RecordType.control ? "control" : null;
    if (!type) throw new JournalFormatError(`Unknown record type ${typeCode} at byte ${offset}`);
    const payload = bytes.subarray(offset + HEADER_BYTES, offset + 4 + length);
    onRecord({
      type,
      connection: bytes.readUInt16LE(offset + 6),
      seq: bytes.readDoubleLE(offset + 8),
      recvTs: bytes.readDoubleLE(offset + 16),
      ...(type === "frame" ? { frame: payload } : { control: JSON.parse(payload.toString("utf8")) }),
    });
    offset += 4 + length;
  }
  return offset;
}
