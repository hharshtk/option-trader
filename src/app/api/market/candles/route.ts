import { connection } from "next/server";
import { isSignedIn } from "@/lib/auth";
import { describeDhanError, getIntradayCandles, getProfile, INDEX } from "@/lib/dhan";
import { replayBars } from "@/lib/replay-candles";

const INTERVAL_MINUTES = 5;
const IST_OFFSET_SECONDS = 5.5 * 3600;
const LOOKBACK_DAYS = 7;

const istDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });

export async function GET(request: Request) {
  await connection();
  if (!(await isSignedIn())) {
    return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
  }

  const name = new URL(request.url).searchParams.get("index");
  if (!name || !Object.hasOwn(INDEX, name)) {
    return Response.json({ error: { message: "Unknown index" } }, { status: 400 });
  }
  const index = INDEX[name as keyof typeof INDEX];
  // Set by the chart while the engine replays a recorded day.
  const replayDate = new URL(request.url).searchParams.get("date");
  const until = Number(new URL(request.url).searchParams.get("until"));
  const replay = replayDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(replayDate) && Number.isFinite(until) && until > 0;

  try {
    const profile = await getProfile();
    if (profile.dataPlan !== "Active") {
      return Response.json(
        { error: { message: "Charts need Dhan's Data API plan, which isn't active on this account." } },
        { status: 409 },
      );
    }

    const now = Date.now();
    const candles = await getIntradayCandles({
      securityId: String(index.securityId),
      exchangeSegment: index.segment,
      instrument: "INDEX",
      interval: replay ? "1" : (String(INTERVAL_MINUTES) as "5"),
      fromDate: replay ? replayDate : istDate.format(now - LOOKBACK_DAYS * 86_400_000),
      toDate: replay ? istDate.format(Date.parse(`${replayDate}T12:00:00+05:30`) + 86_400_000) : istDate.format(now + 86_400_000),
    });

    // Times shift by +5:30 so the chart, which labels axes in UTC, reads in IST.
    const bars = (candles.timestamp ?? [])
      .map((timestamp, i) => ({
        time: timestamp + IST_OFFSET_SECONDS,
        open: candles.open[i],
        high: candles.high[i],
        low: candles.low[i],
        close: candles.close[i],
      }))
      .filter((bar) => [bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite))
      .sort((a, b) => a.time - b.time);

    if (replay) {
      return Response.json({ interval: INTERVAL_MINUTES, session: replayDate, bars: replayBars(bars, replayDate, until, INTERVAL_MINUTES) });
    }

    const newest = bars.at(-1);
    if (!newest) return Response.json({ interval: INTERVAL_MINUTES, session: null, bars: [] });

    if ((now / 1000 - newest.time) / 86_400 > LOOKBACK_DAYS + 1) {
      return Response.json(
        { error: { message: "Dhan returned candle times outside the requested range." } },
        { status: 502 },
      );
    }

    const sessionDay = Math.floor(newest.time / 86_400);
    const session = bars.filter((bar) => Math.floor(bar.time / 86_400) === sessionDay);

    return Response.json({
      interval: INTERVAL_MINUTES,
      session: new Date(sessionDay * 86_400_000).toISOString().slice(0, 10),
      bars: session,
    });
  } catch (error) {
    return Response.json({ error: describeDhanError(error) }, { status: 502 });
  }
}
