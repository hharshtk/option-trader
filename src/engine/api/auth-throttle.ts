// Slows down token guessing once the control API is reachable from the internet (through
// Caddy). After `maxFailures` bad tokens from one client within `windowMs`, that client gets
// 429 until the window has passed. ENGINE_TOKEN is 256 bits, so this is about noise and log
// spam more than real risk.

import type { IncomingMessage } from "node:http";

export interface AuthThrottle {
  /** Milliseconds until this client may try again, or 0 when it isn't blocked. */
  blockedFor(client: string): number;
  /** Records a failure. Returns true the moment the client becomes blocked. */
  fail(client: string): boolean;
  succeed(client: string): void;
}

export function createAuthThrottle({
  now,
  maxFailures = 10,
  windowMs = 10 * 60_000,
  maxClients = 10_000,
}: {
  now: () => number;
  maxFailures?: number;
  windowMs?: number;
  maxClients?: number;
}): AuthThrottle {
  const failures = new Map<string, { count: number; since: number }>();

  function current(client: string) {
    const entry = failures.get(client);
    if (entry && now() - entry.since >= windowMs) {
      failures.delete(client);
      return undefined;
    }
    return entry;
  }

  return {
    blockedFor(client) {
      const entry = current(client);
      return entry && entry.count >= maxFailures ? entry.since + windowMs - now() : 0;
    },
    fail(client) {
      const entry = current(client);
      if (!entry) {
        // Bound memory under a scan from many addresses: forget the oldest client.
        if (failures.size >= maxClients) failures.delete(failures.keys().next().value!);
        failures.set(client, { count: 1, since: now() });
        return maxFailures === 1;
      }
      entry.count += 1;
      return entry.count === maxFailures;
    },
    succeed(client) {
      failures.delete(client);
    },
  };
}

/**
 * The client's address. Behind Caddy every request comes from 127.0.0.1, so the forwarded
 * header is used, but only when the direct peer is local: a remote client can't fake it.
 */
export function clientAddress(request: IncomingMessage): string {
  const peer = request.socket.remoteAddress ?? "unknown";
  const local = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (!local) return peer;
  const forwarded = request.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || peer;
}
