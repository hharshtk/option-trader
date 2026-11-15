// Checks the Dhan account at start and every 15 minutes (profile: data plan, token validity),
// and on every status tick checks the access token and the clock offset from Dhan's REST
// Date headers. Results feed component health, which the web shows.

import type { ClockStatus, DhanAccountStatus, TokenStatus } from "../lib/engine/protocol.ts";
import { getProfile } from "../lib/dhan/api.ts";
import { dhanServerClock } from "../lib/dhan/client.ts";
import { getAccessTokenExpiry, getTokenStore } from "../lib/dhan/config.ts";
import { DhanApiError, describeDhanError } from "../lib/dhan/errors.ts";
import type { Health } from "./telemetry/health.ts";
import type { Logger } from "./telemetry/logger.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface DhanWatch {
  /** Reads the token from Redis before the first tick, so start-up doesn't report it missing. */
  ready(): Promise<void>;
  /** Calls /profile now. Never throws. */
  check(): Promise<void>;
  /** Re-reads the token store and updates token and clock health. Cheap; call every tick. */
  tick(): void;
  account(): DhanAccountStatus | null;
  token(): TokenStatus;
  clock(): ClockStatus | null;
}

export function createDhanWatch({
  log,
  health,
  now,
  onTokenChange,
}: {
  log: Logger;
  health: Health;
  now: () => number;
  /** Called when the token in Redis or .env.local changes, e.g. to reconnect stopped sockets. */
  onTokenChange?: () => void;
}): DhanWatch {
  let account: DhanAccountStatus | null = null;
  let lastToken: string | undefined;
  const store = getTokenStore();

  function tokenStatus(): TokenStatus {
    const token = store.current();
    const expiry = token ? getAccessTokenExpiry(token) : null;
    return { source: store.source(), expiresAt: expiry?.toISOString() ?? null };
  }

  function checkToken() {
    const token = store.current();
    if (token !== lastToken) {
      const changed = lastToken !== undefined;
      lastToken = token;
      if (changed) {
        log.info("access token changed", { source: store.source() });
        onTokenChange?.();
      }
    }
    const { expiresAt } = tokenStatus();
    if (!token) return health.set("token", "failing", "No access token. Save one on the Settings page.");
    if (!expiresAt) return health.set("token", "degraded", "Can't read the token's expiry");
    const left = Date.parse(expiresAt) - now();
    if (left <= 0) return health.set("token", "failing", "Expired. Save a new token on the Settings page.");
    if (left < 2 * HOUR) return health.set("token", "degraded", `Expires in ${Math.ceil(left / 60_000)} min`);
    health.set("token", "ok");
  }

  function checkClock() {
    const sample = dhanServerClock();
    if (!sample) return;
    // Only flag what the measurement can actually show.
    const beyond = Math.abs(sample.offsetMs) - sample.uncertaintyMs;
    const text = `${sample.offsetMs > 0 ? "behind" : "ahead of"} Dhan by about ${Math.abs(sample.offsetMs)} ms`;
    if (beyond > 5_000) health.set("clock", "failing", `Clock ${text}`);
    else if (beyond > 1_000) health.set("clock", "degraded", `Clock ${text}`);
    else health.set("clock", "ok");
  }

  return {
    async ready() {
      await store.refresh({ force: true });
    },
    async check() {
      try {
        const profile = await getProfile();
        account = {
          checkedAt: now(),
          clientId: profile.dhanClientId,
          dataPlan: profile.dataPlan,
          dataValidity: profile.dataValidity,
          tokenValidity: profile.tokenValidity,
          activeSegments: profile.activeSegment
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        };
        health.set("dhan", "ok");
        const validUntil = parseDhanDate(profile.dataValidity);
        if (profile.dataPlan !== "Active") {
          health.set("data-plan", "failing", "Data API plan is not active. Quotes and the feed need it.");
        } else if (validUntil !== null && validUntil - now() < 7 * DAY) {
          const days = Math.max(0, Math.ceil((validUntil - now()) / DAY));
          health.set("data-plan", "degraded", `Data API plan ends in ${days} day${days === 1 ? "" : "s"} (${profile.dataValidity})`);
        } else {
          health.set("data-plan", "ok");
        }
        log.info("Dhan profile checked", { dataPlan: profile.dataPlan, dataValidity: profile.dataValidity });
      } catch (error) {
        const { message } = describeDhanError(error);
        const state = error instanceof DhanApiError && error.status === 0 ? "degraded" : "failing";
        health.set("dhan", state, message);
        log.warn("Dhan profile check failed", { error: message });
      }
      checkClock();
    },
    tick() {
      void store.refresh();
      checkToken();
      checkClock();
    },
    account: () => account,
    token: tokenStatus,
    clock() {
      const sample = dhanServerClock();
      return sample && { ...sample };
    },
  };
}

/** Dhan sends dates as "YYYY-MM-DD HH:mm:ss.S" or "DD/MM/YYYY HH:mm", in IST. Null if neither. */
export function parseDhanDate(value: string): number | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(value);
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?/.exec(value);
  const [year, month, day, hour, minute] = iso
    ? [iso[1], iso[2], iso[3], iso[4], iso[5]]
    : dmy
      ? [dmy[3], dmy[2], dmy[1], dmy[4], dmy[5]]
      : [];
  if (!year) return null;
  const time = Date.parse(`${year}-${month}-${day}T${hour ?? "23"}:${minute ?? "59"}:00+05:30`);
  return Number.isNaN(time) ? null : time;
}
