// How many free-model answers the OpenRouter key has left today. Free models (ids ending ":free")
// allow 50 requests a day on an account that has bought less than $10 of credit, 1,000 after, and
// 20 a minute either way; the day is UTC. Live trading's decision gate draws on the same quota, so
// research stops while RESERVE are left.

/** Free answers research always leaves for live trading. */
export const RESERVE = 20;

export interface FreeQuota {
  used: number;
  limit: number;
  remaining: number;
}

export const isFreeModel = (model: string) => model.endsWith(":free");

/** Today's free-model quota for the key, from OpenRouter. Throws when it can't be read. */
export async function readFreeQuota(apiKey: string | undefined, fetcher: typeof fetch = fetch): Promise<FreeQuota> {
  const key = apiKey?.trim();
  if (!key) throw new Error("OPENROUTER_API_KEY is not set in .env.local");
  const response = await fetcher("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OpenRouter answered HTTP ${response.status} for the key's limits`);
  const body = (await response.json()) as { data?: { free_model_daily_requests?: Partial<FreeQuota> } };
  const quota = body.data?.free_model_daily_requests;
  if (typeof quota?.remaining !== "number" || typeof quota.limit !== "number") throw new Error("OpenRouter didn't report the free-model quota");
  return { used: quota.used ?? quota.limit - quota.remaining, limit: quota.limit, remaining: quota.remaining };
}

/**
 * How many more free questions research may ask, keeping `reserve` for live trading. OpenRouter's
 * count lags behind real requests by a minute or more, so every request is also counted here, and
 * the lower of the two estimates wins.
 */
export function createAllowance({ read, reserve }: { read: () => Promise<FreeQuota>; reserve: number }) {
  let start: number | null = null;
  let requests = 0;
  return {
    /** Call for every request sent, retries included. */
    counted() {
      requests += 1;
    },
    async next(): Promise<{ count: number; quota: FreeQuota }> {
      const quota = await read();
      start ??= quota.remaining;
      const remaining = Math.min(quota.remaining, start - requests);
      return { count: remaining - reserve, quota: { ...quota, remaining } };
    },
  };
}
