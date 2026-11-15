// Dhan Live Market Feed v2 wire format, from dhanhq.co/docs/v2/live-market-feed and the Annexure.
// Frames are little-endian. Offsets here are 0-based; Dhan's tables mix 0- and 1-based numbering.

export const SEGMENTS = [
  "IDX_I",
  "NSE_EQ",
  "NSE_FNO",
  "NSE_CURRENCY",
  "BSE_EQ",
  "MCX_COMM",
  "BSE_CURRENCY",
  "BSE_FNO",
] as const;

export type Segment = (typeof SEGMENTS)[number];

const SEGMENT_CODES: Record<Segment, number> = {
  IDX_I: 0,
  NSE_EQ: 1,
  NSE_FNO: 2,
  NSE_CURRENCY: 3,
  BSE_EQ: 4,
  MCX_COMM: 5,
  BSE_CURRENCY: 7,
  BSE_FNO: 8,
};

const SEGMENT_BY_CODE = new Map(
  Object.entries(SEGMENT_CODES).map(([segment, code]) => [code, segment as Segment]),
);

export const REQUEST_CODE = {
  disconnect: 12,
  subscribeTicker: 15,
  unsubscribeTicker: 16,
} as const;

export const MAX_INSTRUMENTS_PER_MESSAGE = 100;

export interface Instrument {
  segment: Segment;
  securityId: string;
}

export function instrumentKey({ segment, securityId }: Instrument) {
  return `${segment}:${securityId}`;
}

export function parseInstrumentKey(key: string): Instrument | null {
  const [segment, securityId, extra] = key.split(":");
  if (extra !== undefined || securityId === undefined) return null;
  if (!(SEGMENTS as readonly string[]).includes(segment)) return null;
  if (!/^\d{1,10}$/.test(securityId)) return null;
  return { segment: segment as Segment, securityId };
}

export function subscriptionMessages(requestCode: number, instruments: Instrument[]): string[] {
  const messages: string[] = [];
  for (let start = 0; start < instruments.length; start += MAX_INSTRUMENTS_PER_MESSAGE) {
    const batch = instruments.slice(start, start + MAX_INSTRUMENTS_PER_MESSAGE);
    messages.push(
      JSON.stringify({
        RequestCode: requestCode,
        InstrumentCount: batch.length,
        InstrumentList: batch.map(({ segment, securityId }) => ({
          ExchangeSegment: segment,
          SecurityId: securityId,
        })),
      }),
    );
  }
  return messages;
}

export type Packet =
  | { kind: "ticker"; code: number; key: string; ltp: number; ltt: number }
  | { kind: "prevClose"; key: string; prevClose: number; prevOi: number }
  | {
      kind: "quote";
      code: number;
      key: string;
      ltp: number;
      ltt: number;
      volume: number;
      open: number;
      close: number;
      high: number;
      low: number;
    }
  | { kind: "oi"; key: string; oi: number }
  | { kind: "disconnect"; reason: number }
  | { kind: "unknown"; code: number; length: number; key: string | null };

const HEADER_BYTES = 8;

// Packet sizes by response code. Code 1 (index) is listed in the Annexure without a layout;
// it's read as a ticker until captured frames say otherwise. Code 7 (market status) is
// undocumented, so it falls back to the length in the header and comes out as "unknown".
const PACKET_BYTES: Record<number, number> = { 1: 16, 2: 16, 4: 50, 5: 12, 6: 16, 8: 162, 50: 10 };

export function parseFrame(frame: ArrayBuffer): Packet[] {
  const view = new DataView(frame);
  const packets: Packet[] = [];
  let offset = 0;

  while (offset + HEADER_BYTES <= view.byteLength) {
    const code = view.getUint8(offset);
    const size = PACKET_BYTES[code] ?? view.getInt16(offset + 1, true);
    if (size < HEADER_BYTES || offset + size > view.byteLength) {
      packets.push({ kind: "unknown", code, length: view.byteLength - offset, key: null });
      break;
    }
    packets.push(readPacket(view, offset, code, size));
    offset += size;
  }

  return packets;
}

function readPacket(view: DataView, at: number, code: number, size: number): Packet {
  if (code === 50) return { kind: "disconnect", reason: view.getInt16(at + 8, true) };

  const segment = SEGMENT_BY_CODE.get(view.getUint8(at + 3));
  const key = segment ? `${segment}:${view.getInt32(at + 4, true)}` : null;
  if (key === null) return { kind: "unknown", code, length: size, key };

  const f32 = (offset: number) => view.getFloat32(at + offset, true);
  const i32 = (offset: number) => view.getInt32(at + offset, true);

  switch (code) {
    case 1:
    case 2:
      return { kind: "ticker", code, key, ltp: f32(8), ltt: i32(12) };
    case 4:
      return {
        kind: "quote",
        code,
        key,
        ltp: f32(8),
        ltt: i32(14),
        volume: i32(22),
        open: f32(34),
        close: f32(38),
        high: f32(42),
        low: f32(46),
      };
    case 5:
      return { kind: "oi", key, oi: i32(8) };
    case 6:
      return { kind: "prevClose", key, prevClose: f32(8), prevOi: i32(12) };
    case 8:
      return {
        kind: "quote",
        code,
        key,
        ltp: f32(8),
        ltt: i32(14),
        volume: i32(22),
        open: f32(46),
        close: f32(50),
        high: f32(54),
        low: f32(58),
      };
    default:
      return { kind: "unknown", code, length: size, key };
  }
}
