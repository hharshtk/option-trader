import { connection } from "next/server";
import { isSignedIn } from "@/lib/auth";
import { engineConfig, forwardToEngine } from "@/lib/engine/web";
import { getFeedHub } from "@/lib/live/feed/hub";
import { parseInstrumentKey, type Instrument } from "@/lib/live/feed/packets";

const MAX_INSTRUMENTS = 200;

// no-transform keeps compression middleware from buffering the stream.
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

// Latest quotes for one browser tab. With ENGINE_URL set the engine owns Dhan and this only
// forwards; otherwise the web's own hub serves it.
export async function GET(request: Request) {
  await connection();
  if (!(await isSignedIn())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const engine = engineConfig();
  if (engine) return forwardToEngine(engine, "/v1/quotes", request);

  const instruments = [...new Set((new URL(request.url).searchParams.get("i") ?? "").split(","))]
    .map(parseInstrumentKey)
    .filter((instrument): instrument is Instrument => instrument !== null)
    .slice(0, MAX_INSTRUMENTS);

  return new Response(getFeedHub().stream(instruments, request.signal), { headers: SSE_HEADERS });
}
