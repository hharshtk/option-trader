// Normalized events the kernel dispatches, one at a time in `seq` order. The same types serve
// live runs, journal replays and candle backtests; only the source and the clock differ.

/** Instrument id in the form `SEGMENT:SECURITY_ID`, the same as the feed's instrumentKey. */
export type InstrumentId = string;

export interface EventMeta {
  /** Increases by one per event within a run. Fixes the order, and so every result. */
  seq: number;
  /** When the engine received the data, from the run's clock. */
  recvTs: number;
  /** Exchange time, once `ltt` is understood for the segment. */
  eventTs?: number;
}

export type MarketEvent = EventMeta &
  (
    | { kind: "tick"; instrument: InstrumentId; ltp: number; ltq?: number; volume?: number; atp?: number }
    | { kind: "quote"; instrument: InstrumentId; bid: number; ask: number; bidQty: number; askQty: number }
    | { kind: "oi"; instrument: InstrumentId; oi: number }
    | { kind: "prevClose"; instrument: InstrumentId; prevClose: number; prevOi: number }
    | {
        kind: "bar";
        instrument: InstrumentId;
        interval: "1m";
        start: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume?: number;
        oi?: number;
        iv?: number;
      }
    | {
        kind: "gap";
        reason: "reconnect" | "suspend" | "resubscribe";
        from: number;
        to: number;
        connection?: number;
      }
    | { kind: "session"; segment: string; phase: "open" | "close" }
  );

export type MarketEventKind = MarketEvent["kind"];

export type Resolution = "tick" | "bar";
