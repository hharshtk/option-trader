// Counters, gauges and latency histograms. The engine publishes a snapshot every few seconds
// on the `metrics` telemetry topic. Counters are cumulative; histograms cover the window since
// the previous snapshot, so the web shows recent latency, not an all-time average.

import type { HistogramSnapshot, MetricsSnapshot } from "../../lib/engine/protocol.ts";

// Bucket upper bounds in ms, from 0.05 ms to 30 s. Percentiles report the bucket's upper bound,
// which is precise enough to see whether latency is microseconds, milliseconds or seconds.
const BUCKETS = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
];

export class Histogram {
  #counts = new Array<number>(BUCKETS.length + 1).fill(0);
  #count = 0;
  #sum = 0;
  #min = Number.POSITIVE_INFINITY;
  #max = Number.NEGATIVE_INFINITY;

  record(value: number) {
    if (!Number.isFinite(value)) return;
    let index = BUCKETS.findIndex((bound) => value <= bound);
    if (index === -1) index = BUCKETS.length;
    this.#counts[index] += 1;
    this.#count += 1;
    this.#sum += value;
    if (value < this.#min) this.#min = value;
    if (value > this.#max) this.#max = value;
  }

  snapshot(): HistogramSnapshot {
    if (this.#count === 0) return { count: 0, sum: 0, min: 0, max: 0, p50: 0, p90: 0, p99: 0 };
    return {
      count: this.#count,
      sum: this.#sum,
      min: this.#min,
      max: this.#max,
      p50: this.#percentile(0.5),
      p90: this.#percentile(0.9),
      p99: this.#percentile(0.99),
    };
  }

  reset() {
    this.#counts.fill(0);
    this.#count = 0;
    this.#sum = 0;
    this.#min = Number.POSITIVE_INFINITY;
    this.#max = Number.NEGATIVE_INFINITY;
  }

  #percentile(q: number) {
    const rank = Math.ceil(q * this.#count);
    let seen = 0;
    for (let i = 0; i < this.#counts.length; i += 1) {
      seen += this.#counts[i];
      // Never report more than the largest value actually seen.
      if (seen >= rank) return Math.min(BUCKETS[i] ?? this.#max, this.#max);
    }
    return this.#max;
  }
}

export interface Metrics {
  increment(name: string, by?: number): void;
  gauge(name: string, value: number): void;
  observe(name: string, value: number): void;
  /** Takes a snapshot and starts a new histogram window. */
  snapshot(): MetricsSnapshot;
}

export function createMetrics(now: () => number): Metrics {
  const counters = new Map<string, number>();
  const gauges = new Map<string, number>();
  const histograms = new Map<string, Histogram>();
  let windowStart = now();

  return {
    increment(name, by = 1) {
      counters.set(name, (counters.get(name) ?? 0) + by);
    },
    gauge(name, value) {
      gauges.set(name, value);
    },
    observe(name, value) {
      let histogram = histograms.get(name);
      if (!histogram) histograms.set(name, (histogram = new Histogram()));
      histogram.record(value);
    },
    snapshot() {
      const at = now();
      const snapshot: MetricsSnapshot = {
        at,
        windowMs: at - windowStart,
        counters: Object.fromEntries(counters),
        gauges: Object.fromEntries(gauges),
        histograms: Object.fromEntries([...histograms].map(([name, h]) => [name, h.snapshot()])),
      };
      for (const histogram of histograms.values()) histogram.reset();
      windowStart = at;
      return snapshot;
    },
  };
}
