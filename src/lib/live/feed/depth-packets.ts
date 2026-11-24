// Dhan's 20-level market depth feed, from dhanhq.co/docs/v2/full-market-depth. It is a separate
// WebSocket from the live market feed, with its own header: frames are little-endian and may
// stack several packets, each one side (bid or ask) of one instrument's book.
//
//   header = length i16 | code u8 | segment u8 | securityId i32 | sequence u32   (12 bytes)
//   body   = 20 × (price f64 | quantity u32 | orders u32)                        (320 bytes)
//
// `length` is the whole packet including the header. Only NSE equity and F&O are served.

import { segmentByCode, type Instrument } from "./packets.ts";

export const DEPTH_FEED_HOST = "wss://depth-api-feed.dhan.co/twentydepth";
/** Instruments one 20-level connection may carry. */
export const DEPTH_MAX_INSTRUMENTS = 50;
export const DEPTH_LEVELS = 20;
export const DEPTH_SEGMENTS: ReadonlySet<string> = new Set(["NSE_EQ", "NSE_FNO"]);

export const DEPTH_REQUEST = { subscribe: 23, disconnect: 12 } as const;
const RESPONSE = { bid: 41, ask: 51, disconnect: 50 } as const;

const HEADER_BYTES = 12;
const LEVEL_BYTES = 16;

export type DepthPacket =
  | { kind: "depth"; side: "bid" | "ask"; key: string; levels: DepthBookLevel[] }
  | { kind: "disconnect"; reason: number }
  | { kind: "unknown"; code: number; length: number };

export interface DepthBookLevel {
  price: number;
  qty: number;
  orders: number;
}

/** The token travels in the URL, so this URL must never be logged. */
export function depthFeedUrl(clientId: string, accessToken: string) {
  return `${DEPTH_FEED_HOST}?token=${encodeURIComponent(accessToken)}&clientId=${encodeURIComponent(clientId)}&authType=2`;
}

/** Subscribe messages, at most DEPTH_MAX_INSTRUMENTS each (the whole connection's limit). */
export function depthSubscribeMessages(instruments: readonly Instrument[]): string[] {
  const messages: string[] = [];
  for (let start = 0; start < instruments.length; start += DEPTH_MAX_INSTRUMENTS) {
    const batch = instruments.slice(start, start + DEPTH_MAX_INSTRUMENTS);
    messages.push(
      JSON.stringify({
        RequestCode: DEPTH_REQUEST.subscribe,
        InstrumentCount: batch.length,
        InstrumentList: batch.map(({ segment, securityId }) => ({ ExchangeSegment: segment, SecurityId: securityId })),
      }),
    );
  }
  return messages;
}

/** Accepts a frame's ArrayBuffer, or a view such as a Buffer read from the journal. */
export function parseDepthFrame(frame: ArrayBuffer | ArrayBufferView, instrument?: Instrument): DepthPacket[] {
  const view = ArrayBuffer.isView(frame) ? new DataView(frame.buffer, frame.byteOffset, frame.byteLength) : new DataView(frame);
  const packets: DepthPacket[] = [];
  const securityId = instrument ? Number(instrument.securityId) : null;
  let offset = 0;

  while (offset + HEADER_BYTES <= view.byteLength) {
    const length = view.getInt16(offset, true);
    const code = view.getUint8(offset + 2);
    if (length < HEADER_BYTES || offset + length > view.byteLength) {
      // A disconnect packet may be shorter than the length it claims; read its reason if present.
      if (code === RESPONSE.disconnect && offset + HEADER_BYTES + 2 <= view.byteLength) {
        packets.push({ kind: "disconnect", reason: view.getInt16(offset + HEADER_BYTES, true) });
      } else {
        packets.push({ kind: "unknown", code, length: view.byteLength - offset });
      }
      break;
    }
    if (!instrument || code === RESPONSE.disconnect || (
      (code === RESPONSE.bid || code === RESPONSE.ask) && view.getInt32(offset + 4, true) === securityId &&
      segmentByCode(view.getUint8(offset + 3)) === instrument.segment
    )) packets.push(readPacket(view, offset, code, length));
    offset += length;
  }
  return packets;
}

function readPacket(view: DataView, at: number, code: number, length: number): DepthPacket {
  if (code === RESPONSE.disconnect) {
    return { kind: "disconnect", reason: length >= HEADER_BYTES + 2 ? view.getInt16(at + HEADER_BYTES, true) : 0 };
  }
  if (code !== RESPONSE.bid && code !== RESPONSE.ask) return { kind: "unknown", code, length };
  const segment = segmentByCode(view.getUint8(at + 3));
  if (!segment) return { kind: "unknown", code, length };

  const levels: DepthBookLevel[] = [];
  const count = Math.min(DEPTH_LEVELS, Math.floor((length - HEADER_BYTES) / LEVEL_BYTES));
  for (let i = 0; i < count; i += 1) {
    const base = at + HEADER_BYTES + i * LEVEL_BYTES;
    levels.push({ price: view.getFloat64(base, true), qty: view.getUint32(base + 8, true), orders: view.getUint32(base + 12, true) });
  }
  return { kind: "depth", side: code === RESPONSE.bid ? "bid" : "ask", key: `${segment}:${view.getInt32(at + 4, true)}`, levels };
}
