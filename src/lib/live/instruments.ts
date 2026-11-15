import { INDEX } from "@/lib/dhan/instruments";

export type IndexName = keyof typeof INDEX;

export function indexInstrument(name: IndexName) {
  return `IDX_I:${INDEX[name].securityId}`;
}

export function positionInstrument(position: { exchangeSegment: string; securityId: string }) {
  return `${position.exchangeSegment}:${position.securityId}`;
}
