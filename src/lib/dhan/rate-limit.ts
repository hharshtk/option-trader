export type RateLimitBucket = "order" | "data" | "quote" | "optionChain" | "nonTrading";

interface Limit {
  max: number;
  windowMs: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Published at dhanhq.co/docs/v2. Enforced as sliding windows, which is stricter
// than Dhan's own counting, with a margin so network jitter can't bunch requests.
const LIMITS: Record<RateLimitBucket, Limit[]> = {
  order: [
    { max: 10, windowMs: SECOND },
    { max: 250, windowMs: MINUTE },
    { max: 1000, windowMs: HOUR },
    { max: 7000, windowMs: DAY },
  ],
  data: [
    { max: 5, windowMs: SECOND },
    { max: 100_000, windowMs: DAY },
  ],
  quote: [{ max: 1, windowMs: SECOND }],
  optionChain: [{ max: 1, windowMs: 3 * SECOND }],
  nonTrading: [{ max: 20, windowMs: SECOND }],
};

const JITTER_MARGIN_MS = 150;
const MAX_QUEUE_WAIT_MS = 10 * SECOND;
export const RATE_LIMIT_COOLDOWN_MS = 60 * SECOND;

const ORDER_PATH = /^\/(orders|super\/orders|forever\/orders|alerts\/orders|alerts\/multi\/orders|positions)(\/|$)/;

export function bucketFor(method: string, path: string): RateLimitBucket {
  if (path.startsWith("/marketfeed/")) return "quote";
  if (path.startsWith("/optionchain")) return "optionChain";
  if (path.startsWith("/charts/") || path.startsWith("/data/")) return "data";
  if (method !== "GET" && ORDER_PATH.test(path)) return "order";
  return "nonTrading";
}

export type Reservation =
  | { ok: true; startAt: number }
  | { ok: false; reason: "paused" | "queue-full"; retryAt: number };

export function createRateLimiter() {
  const log: Record<RateLimitBucket, number[]> = {
    order: [],
    data: [],
    quote: [],
    optionChain: [],
    nonTrading: [],
  };
  let pausedUntil = 0;

  return {
    reserve(bucket: RateLimitBucket, now = Date.now()): Reservation {
      if (now < pausedUntil) return { ok: false, reason: "paused", retryAt: pausedUntil };

      const times = log[bucket];
      let startAt = Math.max(now, times.at(-1) ?? 0);
      for (const { max, windowMs } of LIMITS[bucket]) {
        if (times.length >= max) {
          startAt = Math.max(startAt, times[times.length - max] + windowMs + JITTER_MARGIN_MS);
        }
      }

      if (startAt - now > MAX_QUEUE_WAIT_MS) {
        return { ok: false, reason: "queue-full", retryAt: startAt };
      }

      times.push(startAt);
      const keep = Math.max(...LIMITS[bucket].map((limit) => limit.max));
      if (times.length > keep) times.splice(0, times.length - keep);
      return { ok: true, startAt };
    },

    pause(until: number) {
      pausedUntil = Math.max(pausedUntil, until);
    },

    pausedUntil() {
      return pausedUntil;
    },
  };
}

// Kept on globalThis so route handlers, pages and dev hot reloads share one limiter.
const store = globalThis as typeof globalThis & {
  __dhanRateLimiter?: ReturnType<typeof createRateLimiter>;
};
export const dhanRateLimiter = (store.__dhanRateLimiter ??= createRateLimiter());
