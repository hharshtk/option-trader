# Real-time market data (Phase 5 proposal)

Status: proposal, not implemented. The cockpit UI shipped without any streaming changes.

## Where prices come from today

Every index price on screen comes from one REST call, `POST /marketfeed/ltp`, made during a server render (`getIndexQuotes` in `src/lib/cockpit.ts`). The header labels it "LTP snapshot", shows the fetch time, and ticks its age. After 60 seconds it turns amber and says "stale". The refresh button re-renders the route with `router.refresh()`. The client cache in `src/lib/dhan/client.ts` shares an LTP response for 1 second, and the limiter allows 1 quote request per second.

The REST path can't provide:

- Day change. The LTP endpoint returns only `last_price`.
- LTP for open positions. Dhan's positions response has no price field.
- Market open/closed status.
- Intraday charts.

The live feed fixes the first three. Charts need one extra REST endpoint plus the feed.

## Recommended shape

```
Dhan Live Market Feed v2 (wss, binary, little-endian)
        │  one socket; token read from server env
        ▼
feed service: long-running Node process, services/feed/
  ├─ subscription registry: instrument → reference count
  ├─ packet parser: binary → { segment, securityId, ltp, ltt, prevClose, ... }
  ├─ latest value per instrument
  └─ GET /stream?i=IDX_I:13,IDX_I:25  (Server-Sent Events, localhost only)
        ▲
        │  proxied by a Next route handler that checks the session cookie
        │
browser: one EventSource per tab → external store → components subscribe per instrument
```

### Why a separate process instead of a Next route

- **Hot reload.** Hot reload re-evaluates server modules in `next dev`. A socket opened inside the Next server can be duplicated on every edit. Dhan allows 5 feed connections per user and disconnects the oldest with error 805 when a sixth opens. 805 is the warning this account already received once.
- **Hosting.** Serverless hosting can't hold a socket at all. If the app ever moves to Vercel or similar, the feed service stays as is.
- **Isolation.** Reconnect loops and binary parsing stay out of the request path, so a stuck feed can't slow page renders.

The service lives in this repo, imports nothing from Next, and starts next to `next dev` (for example `npm run feed`). For a single user, the in-memory latest-value map is all the state it needs. Redis or Kafka would add nothing until there are several app instances.

### Browser side

- **One stream per tab.** A client provider in `src/app/(cockpit)/layout.tsx` opens one `EventSource` to `/api/market/stream`. That route handler checks `isSignedIn()` and pipes the feed service's SSE response. The browser never sees the Dhan token or the feed service's address.
- **Store outside React.** Quotes live in a `Map` keyed by `SEGMENT:securityId`, with listeners per key. `useQuote(key)` uses `useSyncExternalStore` and subscribes to that key only, so a NIFTY tick re-renders only the components showing NIFTY.
- **Coalesce ticks on the server.** The feed service keeps the latest value per instrument and flushes changed instruments every 250 ms. That caps any instrument at 4 updates a second however fast Dhan sends.
- **Live state stays separate from REST state.** Account, funds, positions and holdings stay as Server Components. Live prices overlay them through small client components such as `<LivePrice instrument fallback={snapshotLtp} />`. These show the REST snapshot until the first tick arrives, and say "Live" only while the stream is connected and the last tick is under 15 seconds old.

## Dhan Live Market Feed v2 facts

Sources: dhanhq.co/docs/v2/live-market-feed and the Annexure, read on 2026-11-15.

**Connection:** `wss://api-feed.dhan.co?version=2&token=<access token>&clientId=<client id>&authType=2`. The token is in the URL, so never log the URL.

**Limits:**
- 5 connections per user. A sixth disconnects the first with 805.
- 5,000 instruments per connection.
- 100 instruments per subscribe message.

**Subscribe message:**

```json
{"RequestCode":15,"InstrumentCount":2,"InstrumentList":[{"ExchangeSegment":"IDX_I","SecurityId":"13"},{"ExchangeSegment":"IDX_I","SecurityId":"25"}]}
```

**Request codes:**

| Code | Meaning |
|---|---|
| 15 / 16 | Ticker subscribe / unsubscribe |
| 17 / 18 | Quote subscribe / unsubscribe |
| 21 / 22 | Full subscribe / unsubscribe |
| 23 / 24 | Full market depth subscribe / unsubscribe |
| 12 | Disconnect |

**Response header:** 8 bytes, little-endian. Offsets below are 0-based for `DataView`.

| Offset | Type | Field |
|---|---|---|
| 0 | uint8 | response code |
| 1 | int16 | message length |
| 3 | uint8 | exchange segment |
| 4 | int32 | security ID |

**Exchange segment enum:**

| Segment | Value |
|---|---|
| IDX_I | 0 |
| NSE_EQ | 1 |
| NSE_FNO | 2 |
| NSE_CURRENCY | 3 |
| BSE_EQ | 4 |
| MCX_COMM | 5 |
| BSE_CURRENCY | 7 |
| BSE_FNO | 8 |

There is no 6.

**Response codes:**

| Code | Packet | Body (0-based offset, type) |
|---|---|---|
| 2 | Ticker | 8 LTP float32, 12 last trade time int32 epoch |
| 4 | Quote | 8 LTP f32, 12 LTQ i16, 14 LTT i32, 18 avg price f32, 22 volume i32, 26 total sell qty i32, 30 total buy qty i32, 34 open f32, 38 close f32 (post-market only), 42 high f32, 46 low f32 |
| 5 | OI | 8 open interest int32 |
| 6 | Previous close | 8 previous close float32, 12 previous OI int32. Sent whenever an instrument is subscribed, for any mode |
| 7 | Market status | Listed in the Annexure; the feed page doesn't document its layout |
| 8 | Full | Quote fields plus OI, day OI high/low (NSE_FNO only) and 5 depth levels of 20 bytes each |
| 50 | Disconnect | 8 reason code int16 (Data API errors: 805 too many connections, 807 token expired, 808 to 810 auth failures) |
| 1 | Index | Listed in the Annexure only |

**Keepalive:** the server pings every 10 seconds. The `ws` package answers pings automatically. After 40 seconds without a response, the server closes the socket.

Two cautions:

1. Dhan's byte tables mix 0-based and 1-based numbering. The offsets above assume 0-based. Capture raw frames during market hours and write the parser's tests against them before trusting any field.
2. The previous-close packet (code 6) gives day change for every subscribed instrument without the quote mode. Use ticker mode (15) plus that packet for the header, Market Watch and position LTPs. Move to quote mode (17) only where day OHLC and volume get displayed.

## Connection lifecycle

States, which the header shows in place of today's "LTP snapshot" label:

| State | Meaning |
|---|---|
| `connecting` | First connection attempt in progress |
| `live` | Connected and receiving ticks |
| `reconnecting (attempt n)` | Lost the socket; retrying |
| `stopped: <reason>` | Gave up; needs your action |

- **Normal drop:** reconnect with exponential backoff from 1 second to 30 seconds, with jitter. After reconnecting, resubscribe everything in the registry in batches of 100.
- **Disconnect 805:** wait at least 60 seconds before reconnecting, the same cooldown the REST limiter uses (`RATE_LIMIT_COOLDOWN_MS`). Never run more than one feed service per account, and remember a dev and a prod copy each count toward the 5-connection limit.
- **Disconnect 807 to 810 (token or auth):** stop retrying and report `stopped: access token expired`. A self-generated token lasts 24 hours, so renewal stays manual. Update `.env.local`, then send the service a reload signal; it re-reads the env file and reconnects.
- **Subscriptions:** reference-count each instrument across connected browser tabs. Subscribe on 0 → 1. Unsubscribe on 1 → 0 after a 30-second grace period, so moving between sections doesn't churn subscriptions.
- **Weekends and holidays:** no ticks arrive. Until packet 7 is verified, the UI shows "No ticks since HH:MM" and never claims the market is closed.

## Charts: TradingView Lightweight Charts

**Recommendation: use it** (`lightweight-charts`, 5.3.0 on npm as of 2026-11-15, Apache-2.0).

- **Series types.** Candlestick, line, area and histogram cover index charts, intraday candles and volume.
- **Incremental updates.** `series.setData(history)` runs once. After that, `series.update(bar)` either replaces the last bar (same timestamp) or appends a new one. A tick never re-sends the dataset.
- **Rendering.** It draws on canvas inside a client component. Load it with a dynamic import so pages without charts don't pay for it.
- **Attribution.** The license requires credit to TradingView. Version 5 shows a small logo by default (`layout.attributionLogo`); leave it on.

**Data:**

- History comes from `POST /charts/intraday`.
  - Body: `securityId`, `exchangeSegment`, `instrument`, `interval` (1, 5, 15, 25 or 60 minutes), `oi`, `fromDate`, `toDate`.
  - Response: parallel `open`/`high`/`low`/`close`/`volume`/`timestamp` arrays.
  - Limits: up to 90 days per call, 5 years back.
- `POST /charts/historical` covers daily candles.
- Neither endpoint is wrapped in `src/lib/dhan/api.ts` yet. The limiter already sends `/charts/*` through its `data` bucket (5 per second).

The client folds ticks into the current candle: same interval bucket → `update` the bar, new bucket → append. Charts only appear where Dhan returned real candles. With no data, the panel says so; it never draws placeholder lines.

**Placement:** a 5-minute line series in the Overview market panel, a full candlestick panel when you select an index in Market Watch, and contract charts from the option chain later.

## Order of work

1. **Feed service, no UI.** Connect, keepalive, reconnect, parse ticker and previous-close packets, log NIFTY and BANKNIFTY. Run it through one market session and save raw frames as parser fixtures. Check packet 7's layout here.
2. **Stream to the header.** SSE endpoint, the Next proxy route with the session check, the client store, `<LivePrice>` in the header and Market Watch. Show day change from the previous-close packet.
3. **Positions.** Subscribe open positions' NSE_FNO security IDs and add the LTP column to the positions tables. Add the market status chip if packet 7 checked out.
4. **Charts.** Add `getIntradayCandles` to `src/lib/dhan/api.ts` through the existing limiter, then build the chart component and live candle updates.

Each step ships on its own, and the REST snapshot stays as the fallback whenever the stream isn't live.
