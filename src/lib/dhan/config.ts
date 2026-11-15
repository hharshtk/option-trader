import "server-only";
import { DhanConfigError } from "./errors";
import { createTokenStore, type TokenStore } from "./token-store.ts";

export interface DhanCredentials {
  clientId: string;
  accessToken: string;
}

// One store per server process. Dev hot reload re-evaluates modules, so it lives on globalThis.
const STORE = Symbol.for("option-trader.dhan-token-store");
const globalStore = globalThis as typeof globalThis & { [STORE]?: TokenStore };

export function getTokenStore(): TokenStore {
  globalStore[STORE] ??= createTokenStore({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    onError: (message) => console.warn(`[dhan] ${message}. Using the last known token.`),
  });
  return globalStore[STORE];
}

/** Synchronous: uses the last token read from Redis, or DHAN_ACCESS_TOKEN. */
export function getDhanCredentials(): DhanCredentials {
  const clientId = process.env.DHAN_CLIENT_ID?.trim();
  const accessToken = getTokenStore().current();

  if (!clientId || !accessToken) {
    const missing = [
      !clientId && "DHAN_CLIENT_ID in .env.local",
      !accessToken && "an access token (save one on the Settings page, or set DHAN_ACCESS_TOKEN in .env.local)",
    ].filter(Boolean);
    throw new DhanConfigError(`Missing ${missing.join(" and ")}`);
  }

  return { clientId, accessToken };
}

/** Re-reads Redis when the cached token is more than 30 seconds old, then returns credentials. */
export async function loadDhanCredentials(): Promise<DhanCredentials> {
  await getTokenStore().refresh();
  return getDhanCredentials();
}

export function getAccessTokenExpiry(accessToken: string): Date | null {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"),
    );
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}
