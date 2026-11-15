import "server-only";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { isSignedIn } from "@/lib/auth";
import {
  describeDhanError,
  getAccessTokenExpiry,
  getDhanCredentials,
  getLtp,
  getProfile,
  INDEX,
  type DhanErrorDescription,
} from "@/lib/dhan";

export async function requireSession() {
  await connection();
  if (!(await isSignedIn())) redirect("/login");
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: DhanErrorDescription };

export function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error: describeDhanError(error) }),
  );
}

export function tokenExpiryIso(): string | null {
  try {
    return getAccessTokenExpiry(getDhanCredentials().accessToken)?.toISOString() ?? null;
  } catch {
    return null;
  }
}

export const MARKET_INDICES = [
  { key: "NIFTY", name: "NIFTY 50", exchange: "NSE" },
  { key: "BANKNIFTY", name: "BANK NIFTY", exchange: "NSE" },
  { key: "FINNIFTY", name: "FIN NIFTY", exchange: "NSE" },
  { key: "MIDCPNIFTY", name: "MIDCAP SELECT", exchange: "NSE" },
  { key: "SENSEX", name: "SENSEX", exchange: "BSE" },
  { key: "BANKEX", name: "BANKEX", exchange: "BSE" },
] as const satisfies readonly { key: keyof typeof INDEX; name: string; exchange: string }[];

export type IndexKey = (typeof MARKET_INDICES)[number]["key"];

export const HEADLINE_INDICES = MARKET_INDICES.filter(
  ({ key }) => key === "NIFTY" || key === "BANKNIFTY",
);

export type IndexQuotes =
  | { status: "ok"; fetchedAt: string; prices: Partial<Record<IndexKey, number>> }
  | { status: "no-plan" }
  | { status: "error"; error: DhanErrorDescription };

// One LTP request covers every index on screen, so the header and the page
// share a single call (React's cache per render, dhanRequest's cache across renders).
export const getIndexQuotes = cache(async (): Promise<IndexQuotes> => {
  try {
    const profile = await getProfile();
    if (profile.dataPlan !== "Active") return { status: "no-plan" };

    const ltp = await getLtp({
      IDX_I: MARKET_INDICES.map(({ key }) => INDEX[key].securityId),
    });
    const prices: Partial<Record<IndexKey, number>> = {};
    for (const { key } of MARKET_INDICES) {
      const last = ltp.IDX_I?.[INDEX[key].securityId]?.last_price;
      if (last !== undefined) prices[key] = last;
    }
    return { status: "ok", fetchedAt: new Date().toISOString(), prices };
  } catch (error) {
    return { status: "error", error: describeDhanError(error) };
  }
});
