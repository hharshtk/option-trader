// The stream of what a run is doing, by topic. Every message gets the next seq, so a client
// that reconnects with the last seq it saw gets what it missed, as far as the buffers reach.

import type { TelemetryData, TelemetryMessage, TelemetryTopic } from "../../lib/engine/protocol.ts";
import { LIVE_RUN } from "../../lib/engine/protocol.ts";
import { Ring } from "./ring.ts";

/** Messages kept per topic for clients that connect or reconnect. */
const BACKLOG: Record<TelemetryTopic, number> = {
  status: 1,
  metrics: 12,
  log: 500,
  feed: 1,
  trading: 1,
  bars: 200,
  gaps: 200,
};

export type TelemetryListener = (message: TelemetryMessage) => void;

export interface TelemetryHub {
  publish<T extends TelemetryTopic>(topic: T, data: TelemetryData[T], at?: number): TelemetryMessage<T>;
  /** Buffered messages on these topics with seq above `afterSeq`, oldest first. */
  backlog(topics: ReadonlySet<TelemetryTopic>, afterSeq: number): TelemetryMessage[];
  subscribe(topics: ReadonlySet<TelemetryTopic>, listener: TelemetryListener): () => void;
  readonly seq: number;
  readonly run: string;
}

export function createTelemetryHub(now: () => number, run = LIVE_RUN): TelemetryHub {
  let seq = 0;
  const rings = new Map<TelemetryTopic, Ring<TelemetryMessage>>();
  const listeners = new Set<{ topics: ReadonlySet<TelemetryTopic>; listener: TelemetryListener }>();

  return {
    publish(topic, data, at) {
      const wall = now();
      const message = { run, seq: ++seq, topic, at: at ?? wall, wall, data } as TelemetryMessage<typeof topic>;
      let ring = rings.get(topic);
      if (!ring) rings.set(topic, (ring = new Ring(BACKLOG[topic])));
      ring.push(message);
      for (const entry of listeners) {
        if (entry.topics.has(topic)) entry.listener(message);
      }
      return message;
    },
    backlog(topics, afterSeq) {
      const out: TelemetryMessage[] = [];
      for (const topic of topics) {
        for (const message of rings.get(topic)?.toArray() ?? []) if (message.seq > afterSeq) out.push(message);
      }
      return out.sort((a, b) => a.seq - b.seq);
    },
    subscribe(topics, listener) {
      const entry = { topics, listener };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    get seq() {
      return seq;
    },
    run,
  };
}
