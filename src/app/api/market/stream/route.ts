import { connection } from "next/server";
import { isSignedIn } from "@/lib/auth";
import { getFeedHub } from "@/lib/live/feed/hub";
import { parseInstrumentKey, type Instrument } from "@/lib/live/feed/packets";

const MAX_INSTRUMENTS = 200;

// no-transform keeps compression middleware from buffering the stream.
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

export async function GET(request: Request) {
  await connection();
  if (!(await isSignedIn())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const instruments = [...new Set((new URL(request.url).searchParams.get("i") ?? "").split(","))]
    .map(parseInstrumentKey)
    .filter((instrument): instrument is Instrument => instrument !== null)
    .slice(0, MAX_INSTRUMENTS);

  return new Response(getFeedHub().stream(instruments, request.signal), { headers: SSE_HEADERS });
}
