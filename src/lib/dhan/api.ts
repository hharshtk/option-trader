import { dhanRequest } from "./client.ts";
import type {
  DailyCandleRequest,
  DhanFundLimit,
  DhanHolding,
  DhanOrder,
  DhanPosition,
  DhanProfile,
  InstrumentsBySegment,
  IntradayCandleRequest,
  IntradayCandles,
  LtpData,
  OptionChain,
  Underlying,
} from "./types.ts";

interface DataEnvelope<T> {
  data: T;
  status: "success";
}

export function getProfile() {
  return dhanRequest<DhanProfile>("GET", "/profile", { cacheTtlMs: 30_000 });
}

export function getFundLimit() {
  return dhanRequest<DhanFundLimit>("GET", "/fundlimit", { cacheTtlMs: 5_000 });
}

export function getPositions() {
  return dhanRequest<DhanPosition[]>("GET", "/positions", { cacheTtlMs: 5_000 });
}

export function getHoldings() {
  return dhanRequest<DhanHolding[]>("GET", "/holdings", { cacheTtlMs: 5_000 });
}

export function getOrders() {
  return dhanRequest<DhanOrder[]>("GET", "/orders", { cacheTtlMs: 5_000 });
}

// The calls below need the Dhan Data API subscription; check
// getProfile().dataPlan first rather than calling them unsubscribed.

export async function getLtp(instruments: InstrumentsBySegment) {
  const { data } = await dhanRequest<DataEnvelope<LtpData>>("POST", "/marketfeed/ltp", {
    body: instruments,
    cacheTtlMs: 1_000,
  });
  return data;
}

export async function getOptionExpiries(underlying: Underlying) {
  const { data } = await dhanRequest<DataEnvelope<string[]>>(
    "POST",
    "/optionchain/expirylist",
    {
      body: { UnderlyingScrip: underlying.securityId, UnderlyingSeg: underlying.segment },
      cacheTtlMs: 300_000,
    },
  );
  return data;
}

export function getIntradayCandles(request: IntradayCandleRequest) {
  return dhanRequest<IntradayCandles>("POST", "/charts/intraday", {
    body: { ...request, oi: false },
    cacheTtlMs: 60_000,
  });
}

/**
 * Daily bars since the instrument's listing, one request for any range. The close is the
 * exchange's official close (the auction price since NSE's closing auction), which is the
 * previous close the feed measures changes from.
 */
export function getDailyCandles(request: DailyCandleRequest) {
  return dhanRequest<IntradayCandles>("POST", "/charts/historical", { body: { ...request, oi: false } });
}

/** `expiry` is "YYYY-MM-DD", taken from getOptionExpiries. */
export async function getOptionChain(underlying: Underlying, expiry: string) {
  const { data } = await dhanRequest<DataEnvelope<OptionChain>>("POST", "/optionchain", {
    body: {
      UnderlyingScrip: underlying.securityId,
      UnderlyingSeg: underlying.segment,
      Expiry: expiry,
    },
    cacheTtlMs: 3_000,
  });
  return data;
}
