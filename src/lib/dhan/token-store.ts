// Holds the Dhan access token in Redis (Upstash REST API), so it can be replaced at any time
// without editing .env.local or restarting. Plain Node with no Next.js imports, so the engine
// can use it too. A token in Redis wins over DHAN_ACCESS_TOKEN; the env var is the fallback
// when Redis isn't configured, can't be reached, or the stored token's 24 hours are up.

export const TOKEN_KEY = "dhan:access_token";
export const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_CACHE_MS = 30_000;

export type TokenSource = "redis" | "env" | "none";

export interface TokenStoreOptions {
  /** Upstash REST URL. Redis is off when this or `token` is missing. */
  url?: string;
  /** Upstash REST token. */
  token?: string;
  /** Fallback token. Read on every call, so a changed env var is picked up. */
  envToken?: () => string | undefined;
  fetch?: typeof fetch;
  key?: string;
  ttlSeconds?: number;
  /** How long a Redis read is trusted before reading again. Upstash bills per command. */
  cacheMs?: number;
  now?: () => number;
  onError?: (message: string) => void;
}

export interface TokenStore {
  readonly configured: boolean;
  /** The last known token, synchronously: Redis's value if it has one, else the env token. */
  current(): string | undefined;
  source(): TokenSource;
  /** Re-reads Redis once the cached read is older than `cacheMs`. Never throws. */
  refresh(options?: { force?: boolean }): Promise<string | undefined>;
  /** Stores the token for `ttlSeconds` (24 hours). Throws if Redis refuses. */
  save(token: string): Promise<void>;
}

export function createTokenStore(options: TokenStoreOptions = {}): TokenStore {
  const url = options.url?.trim().replace(/\/+$/, "");
  const redisToken = options.token?.trim();
  const configured = Boolean(url && redisToken);
  const send = options.fetch ?? fetch;
  const key = options.key ?? TOKEN_KEY;
  const ttl = options.ttlSeconds ?? TOKEN_TTL_SECONDS;
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const now = options.now ?? Date.now;
  const envToken = options.envToken ?? (() => process.env.DHAN_ACCESS_TOKEN);

  let stored: string | undefined;
  let readAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<string | undefined> | undefined;
  let lastError: string | undefined;

  // The command travels in the body, not the URL, so the token stays out of access logs.
  async function command(args: (string | number)[]): Promise<unknown> {
    const response = await send(url!, {
      method: "POST",
      headers: { Authorization: `Bearer ${redisToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    const payload = (await response.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!response.ok || payload?.error) throw new Error(payload?.error ?? `Redis returned HTTP ${response.status}`);
    return payload?.result;
  }

  function current() {
    return stored ?? (envToken()?.trim() || undefined);
  }

  async function read() {
    try {
      const result = await command(["GET", key]);
      stored = typeof result === "string" && result.trim() ? result.trim() : undefined;
      lastError = undefined;
    } catch (error) {
      // Keep the last known token. Report once per outage, not on every read.
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) options.onError?.(`Could not read the Dhan token from Redis: ${message}`);
      lastError = message;
    }
    readAt = now();
    return current();
  }

  return {
    configured,
    current,
    source: () => (stored ? "redis" : current() ? "env" : "none"),
    refresh({ force = false } = {}) {
      if (!configured || (!force && now() - readAt < cacheMs)) return Promise.resolve(current());
      inFlight ??= read().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    async save(token) {
      if (!configured) {
        throw new Error("Redis isn't configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.");
      }
      const value = token.trim();
      if (!value) throw new Error("The token is empty.");
      await command(["SET", key, value, "EX", ttl]);
      stored = value;
      readAt = now();
      lastError = undefined;
    },
  };
}
