import { loadDhanCredentials } from "./config.ts";
import { DhanApiError } from "./errors.ts";
import {
  bucketFor,
  dhanRateLimiter,
  RATE_LIMIT_COOLDOWN_MS,
  type RateLimitBucket,
} from "./rate-limit.ts";

const BASE_URL = "https://api.dhan.co/v2";
const TIMEOUT_MS = 10_000;

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

interface RequestOptions {
  body?: unknown;
  /** Share one response across callers for this long. Errors are never cached. */
  cacheTtlMs?: number;
}

interface CacheEntry {
  expiresAt: number;
  promise: Promise<unknown>;
}

const store = globalThis as typeof globalThis & {
  __dhanResponseCache?: Map<string, CacheEntry>;
};
const responseCache = (store.__dhanResponseCache ??= new Map());

export function dhanRequest<T>(
  method: HttpMethod,
  path: string,
  { body, cacheTtlMs = 0 }: RequestOptions = {},
): Promise<T> {
  if (cacheTtlMs <= 0) return send<T>(method, path, body);

  const key = `${method} ${path} ${body === undefined ? "" : JSON.stringify(body)}`;
  const now = Date.now();
  const cached = responseCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise as Promise<T>;

  for (const [staleKey, entry] of responseCache) {
    if (entry.expiresAt <= now) responseCache.delete(staleKey);
  }

  const promise = send<T>(method, path, body);
  const entry: CacheEntry = { expiresAt: Infinity, promise };
  responseCache.set(key, entry);
  promise.then(
    () => {
      entry.expiresAt = Date.now() + cacheTtlMs;
    },
    () => {
      if (responseCache.get(key) === entry) responseCache.delete(key);
    },
  );
  return promise;
}

async function send<T>(method: HttpMethod, path: string, body: unknown): Promise<T> {
  const { clientId, accessToken } = await loadDhanCredentials();
  await waitForSlot(bucketFor(method, path));

  let response: Response;
  const sentAt = Date.now();
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "access-token": accessToken,
        "client-id": clientId,
        Accept: "application/json",
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    const reason =
      cause instanceof Error && cause.name === "TimeoutError"
        ? `timed out after ${TIMEOUT_MS / 1000}s`
        : "network error";
    throw new DhanApiError(`Could not reach Dhan (${reason})`, { status: 0, cause });
  }

  recordServerTime(response.headers.get("date"), sentAt, Date.now());
  const text = await response.text();
  const payload = parseJson(text);
  const failure = readFailure(payload);

  if (!response.ok || failure) {
    const error = new DhanApiError(
      failure?.message ??
        `Dhan returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      { status: response.status, code: failure?.code, type: failure?.type },
    );
    if (error.isRateLimitError) dhanRateLimiter.pause(Date.now() + RATE_LIMIT_COOLDOWN_MS);
    throw error;
  }

  return payload as T;
}

export interface ServerClockSample {
  /** Dhan's clock minus ours. Positive: ours is behind. */
  offsetMs: number;
  /** The estimate is within ± this. */
  uncertaintyMs: number;
  measuredAt: number;
}

const clockStore = globalThis as typeof globalThis & { __dhanServerClock?: ServerClockSample };

/** The latest clock-offset estimate from a Dhan REST response, or null before the first call. */
export function dhanServerClock(): ServerClockSample | null {
  return clockStore.__dhanServerClock ?? null;
}

// The Date header has 1 s resolution: Dhan's true time is in [date, date + 1 s) somewhere
// between sending and receiving. Taking the middle of both ranges bounds the error.
function recordServerTime(header: string | null, sentAt: number, receivedAt: number) {
  const date = header ? Date.parse(header) : Number.NaN;
  if (Number.isNaN(date)) return;
  const roundTrip = receivedAt - sentAt;
  const sample: ServerClockSample = {
    offsetMs: Math.round(date + 500 - (sentAt + receivedAt) / 2),
    uncertaintyMs: Math.round(500 + roundTrip / 2),
    measuredAt: receivedAt,
  };
  // Keep the tighter of two recent samples; a slow response says less about the clock.
  const previous = clockStore.__dhanServerClock;
  if (previous && receivedAt - previous.measuredAt < 60_000 && previous.uncertaintyMs < sample.uncertaintyMs) return;
  clockStore.__dhanServerClock = sample;
}

async function waitForSlot(bucket: RateLimitBucket) {
  const slot = dhanRateLimiter.reserve(bucket);
  if (!slot.ok) throw localRateLimitError(slot.reason, slot.retryAt);

  const delay = slot.startAt - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

  const pausedUntil = dhanRateLimiter.pausedUntil();
  if (pausedUntil > Date.now()) throw localRateLimitError("paused", pausedUntil);
}

function localRateLimitError(reason: "paused" | "queue-full", retryAt: number) {
  const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
  return new DhanApiError(
    reason === "paused"
      ? `Requests to Dhan are paused after a rate-limit warning. Resuming in ${seconds}s.`
      : `Too many Dhan requests queued. Try again in ${seconds}s.`,
    { status: 429 },
  );
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface Failure {
  message: string;
  code?: string;
  type?: string;
}

// Trading APIs fail with {errorType, errorCode, errorMessage}; data APIs
// (quotes, option chain) fail with {status: "failed", data: {"806": "..."}}.
function readFailure(payload: unknown): Failure | null {
  if (!isRecord(payload)) return null;

  if ("errorCode" in payload || "errorMessage" in payload) {
    return {
      message: asString(payload.errorMessage) ?? "Dhan request failed",
      code: asString(payload.errorCode),
      type: asString(payload.errorType),
    };
  }

  if (payload.status === "failed") {
    const [entry] = isRecord(payload.data) ? Object.entries(payload.data) : [];
    return entry
      ? { code: entry[0], message: String(entry[1]) }
      : { message: "Dhan request failed" };
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
