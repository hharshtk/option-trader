import { connection } from "next/server";
import { isSignedIn } from "@/lib/auth";
import { describeDhanError } from "@/lib/dhan";
import { getOptionScripsStatus, listOptionChain, listOptionExpiries } from "@/lib/dhan/option-lookup";
import type { OptionChoices } from "@/lib/insight/option-trades";

// NIFTY option contracts for the Pulse page's option replay: the expiries on offer and, for one
// expiry, every strike between `min` and `max` with its CE and PE. Answers from the scrip file
// the app downloads daily; an older download still answers, flagged as stale.

const UNDERLYING = "NIFTY";
const LOOKUP = { allowStale: true };
const MAX_EXPIRIES = 6;

export async function GET(request: Request) {
  await connection();
  if (!(await isSignedIn())) return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const min = Number(params.get("min"));
  const max = Number(params.get("max"));
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min || max - min > 5_000) {
    return Response.json({ error: { message: "min and max must bracket at most 5,000 points." } }, { status: 400 });
  }

  try {
    const status = await getOptionScripsStatus();
    if (!status.info) {
      return Response.json({ error: { message: "Option instruments haven't been downloaded. Use Settings → Download option instruments." } }, { status: 409 });
    }
    const expiries = (await listOptionExpiries(UNDERLYING, "NSE", LOOKUP)).slice(0, MAX_EXPIRIES).map((e) => e.expiry);
    const wanted = params.get("expiry");
    const expiry = wanted && expiries.includes(wanted) ? wanted : expiries[0];
    if (!expiry) return Response.json({ error: { message: "No NIFTY expiries in the downloaded instruments." } }, { status: 404 });

    const chain = (await listOptionChain(UNDERLYING, expiry, "NSE", LOOKUP)).filter((s) => s.strike >= min && s.strike <= max);
    const lotSize = chain.find((s) => s.CE ?? s.PE)?.CE?.lotSize ?? chain.find((s) => s.PE)?.PE?.lotSize ?? null;
    const body: OptionChoices = {
      scrips: { tradingDate: status.info.tradingDate, current: status.current },
      expiries,
      expiry,
      lotSize,
      strikes: chain.map((s) => ({
        strike: s.strike,
        CE: s.CE ? { securityId: s.CE.securityId, name: s.CE.displayName } : undefined,
        PE: s.PE ? { securityId: s.PE.securityId, name: s.PE.displayName } : undefined,
      })),
    };
    return Response.json(body);
  } catch (error) {
    return Response.json({ error: describeDhanError(error) }, { status: 502 });
  }
}
