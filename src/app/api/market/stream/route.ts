import { connection } from "next/server";
import { isSignedIn } from "@/lib/auth";

const FEED_URL = `http://127.0.0.1:${process.env.FEED_PORT ?? "3010"}`;
const INSTRUMENT_KEY =
  /^(IDX_I|NSE_EQ|NSE_FNO|NSE_CURRENCY|BSE_EQ|MCX_COMM|BSE_CURRENCY|BSE_FNO):\d{1,10}$/;
const MAX_INSTRUMENTS = 200;

// no-transform keeps compression middleware from buffering the stream.
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

const OFFLINE = `retry: 15000\nevent: status\ndata: ${JSON.stringify({ state: "offline" })}\n\n`;

export async function GET(request: Request) {
  await connection();
  if (!(await isSignedIn())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const keys = [
    ...new Set((new URL(request.url).searchParams.get("i") ?? "").split(",")),
  ]
    .filter((key) => INSTRUMENT_KEY.test(key))
    .slice(0, MAX_INSTRUMENTS);

  try {
    const upstream = await fetch(`${FEED_URL}/stream?i=${encodeURIComponent(keys.join(","))}`, {
      cache: "no-store",
      signal: request.signal,
    });
    if (!upstream.ok || !upstream.body) throw new Error(`feed service returned ${upstream.status}`);
    return new Response(upstream.body, { headers: SSE_HEADERS });
  } catch {
    return new Response(OFFLINE, { headers: SSE_HEADERS });
  }
}
