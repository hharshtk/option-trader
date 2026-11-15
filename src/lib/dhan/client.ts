import "server-only";
import { loadDhanCredentials } from "./config";
import { DhanApiError } from "./errors";
import {
  bucketFor,
  dhanRateLimiter,
  RATE_LIMIT_COOLDOWN_MS,
  type RateLimitBucket,
} from "./rate-limit";

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
