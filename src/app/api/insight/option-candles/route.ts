import { connection } from "next/server";
import { isSignedIn } from "@/lib/auth";
import { describeDhanError, getIntradayCandles, getProfile } from "@/lib/dhan";
import type { OptionCandles } from "@/lib/insight/option-trades";

// One-minute candles for up to 20 NIFTY option contracts on one day, from Dhan's intraday
// charts API (Data API plan). Each call goes through the shared rate limiter (5 a second) and is
// cached for a minute, so a page refreshing every minute costs one call per contract.

const MAX_IDS = 20;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  await connection();
  if (!(await isSignedIn())) return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const date = params.get("date") ?? "";
  const ids = [...new Set((params.get("ids") ?? "").split(",").filter((id) => /^\d{1,10}$/.test(id)))];
  if (!DATE.test(date) || ids.length === 0 || ids.length > MAX_IDS) {
    return Response.json({ error: { message: `Pass date=YYYY-MM-DD and 1 to ${MAX_IDS} numeric ids.` } }, { status: 400 });
  }

  try {
    const profile = await getProfile();
    if (profile.dataPlan !== "Active") {
      return Response.json({ error: { message: "Option candles need Dhan's Data API plan, which isn't active on this account." } }, { status: 409 });
    }
    const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const body: OptionCandles = { date, candles: {}, errors: {} };
    await Promise.all(
      ids.map(async (id) => {
        try {
          const c = await getIntradayCandles({ securityId: id, exchangeSegment: "NSE_FNO", instrument: "OPTIDX", interval: "1", fromDate: date, toDate: next });
          // Dhan stamps each candle with the start of its minute, in epoch seconds.
          body.candles[id] = { t: (c.timestamp ?? []).map((s) => s * 1000), o: c.open ?? [], c: c.close ?? [], v: c.volume ?? [] };
        } catch (error) {
          body.errors[id] = describeDhanError(error).message;
        }
      }),
    );
    return Response.json(body);
  } catch (error) {
    return Response.json({ error: describeDhanError(error) }, { status: 502 });
  }
}
