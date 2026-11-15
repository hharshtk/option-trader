# Real-time market data

Status: built on 2026-11-15. The feed connected to Dhan that day, a Sunday, and decoded the ticker and previous-close packets Dhan sends on subscribe. Live ticks during a trading session haven't been observed yet.

## Running it

The feed runs inside the Next server, so `npm run dev` (or `npm start`) is all it needs. It can run up to 5 Dhan sockets ("connections"), Dhan's per-account limit, with up to 5,000 instruments each. Connection 1, **Main**, carries whatever app pages show. Every connection opens its socket only when its first instrument is subscribed, and closes it after 5 minutes with nothing subscribed. Feed log lines start with `[feed HH:MM:SS]` in the dev server output.

| Task | How |
|---|---|
| Watch the stream | The **Live Feed** page (`/live-feed`) shows how many sockets are open, each connection with its instruments and their latest quotes, why each instrument is subscribed (shown on N tabs, added by you), and a log of the last 1,000 decoded packets, subscribe requests and state changes, tagged by connection. Watching subscribes to nothing; it reads `/api/market/feed` |
| Stream another instrument | On the Live Feed page, use **Add an instrument**: pick one of the indices or their stocks, or type `SEGMENT:SECURITY_ID` (for example `NSE_FNO:43854`), and choose an existing connection or **+ New connection**. Added instruments stay subscribed until you remove them, but only until the server restarts; they aren't saved. Closing a connection you created disconnects its socket; instruments that open pages still show move to Main |
| Pick up a renewed token | Update `DHAN_ACCESS_TOKEN` in `.env.local`, then reload the page. A feed stopped by a rejected token reconnects when a tab subscribes with a different token in the env. Restarting the dev server also works |
| Record raw frames | Set `FEED_CAPTURE=1` in `.env.local` and restart the server. Frames go to `captures/feed/<date>.jsonl`, which git ignores |
| Run the parser and reconnect tests | `npm run test:feed` |

## How it fits together

```
Dhan Live Market Feed v2 (wss, binary, little-endian)
        │  up to 5 sockets per server process; credentials read from the env on every connect
        ▼
src/lib/live/feed (server only)
  ├─ packets.ts     binary parser and subscribe messages
  ├─ dhan-feed.ts   socket lifecycle: backoff, 805 pause, token stop, idle disconnect
  ├─ feed-hub.ts    connections, which connection carries each instrument and why, quotes, SSE streams
  ├─ hub.ts         the globalThis singleton wrapper (server-only)
  └─ monitor.ts     event and health shapes for the Live Feed page
        ▲
        │  src/app/api/market/stream: session check, then returns a stream from the hub
        │  src/app/api/market/feed: the same check, then the hub's monitor stream
        │  src/app/(cockpit)/live-feed/actions.ts: add / remove instruments, close connections
        │
browser: src/lib/live/store.ts, one EventSource per tab
         src/components/live/live-quote.tsx: useLiveQuote, <LivePrice>, <LiveChange>
```

- **One hub per process.** Dhan's stream has no message rate limit; the limit that matters is 5 connections per user, with a sixth dropping the oldest with code 805. The hub never opens more than 5, but anything else using the same Dhan account (another server, another app) counts against the same 5. Each instrument streams on exactly one connection, so a tick never arrives twice. Dev hot reload re-evaluates server modules, and each route bundle can hold its own copy of a module, so the hub lives on `globalThis` and is created once per server process. A server restart closes the old socket with the old process. Because of this, edits to `src/lib/live/feed/*` take effect only after restarting `next dev`, unless `HUB_REVISION` in `hub.ts` is bumped, which makes the running server shut the old hub down and start a new one.
- **Rendering cost.** The hub sends each browser at most 4 updates a second per instrument (it flushes every 250 ms). Quotes live outside React, and each component subscribes to one instrument, so a NIFTY tick only re-renders components showing NIFTY.
- **Access control.** The stream route checks the app session before subscribing anything. The Dhan token never leaves the server; it travels in the feed URL, which is never logged.
- **Hosting.** The hub needs a long-running Node server (`next dev` or `next start`). It won't work on serverless hosting.

### Where live data shows

| Place | What it shows |
|---|---|
| Header tickers | Live NIFTY 50 and BANK NIFTY with day change. The status reads "Live" while ticks arrive, "Feed connected · last update HH:MM:SS" when they pause, or the snapshot age with "feed offline / reconnecting / stopped" |
| Overview market panel | Live price and day change |
| Market Watch | Live price and day change on all six index cards, and 5-minute candles for the selected index |
| Positions, on Overview and the Positions page | New LTP column for open positions, "—" without the feed |

The REST snapshot stays as the fallback everywhere. Holdings and the option chain are still REST snapshots.

### Charts

`GET /api/market/candles?index=NIFTY` calls Dhan's `POST /charts/intraday` (`getIntradayCandles` in `src/lib/dhan/api.ts`) for the last 7 days of 5-minute candles. It goes through the existing limiter's `data` bucket with a 60-second cache, and returns only the latest session. Times shift by +5:30 so Lightweight Charts, which labels axes in UTC, reads in IST.

- **Library loading.** `src/components/live/index-chart.tsx` loads `lightweight-charts` 5.2.1 with a dynamic import, so other pages don't download it. It calls `setData` once and `update` for each tick.
- **Live candles.** Ticks extend the chart only during 09:15–15:30 IST on weekdays, so the snapshot Dhan sends on subscribing on a weekend can't start a fake candle. A tick's candle comes from its arrival time, not Dhan's `ltt` (see open questions).
- **One chart at a time.** Market Watch controls its index tabs, so only the selected index mounts a chart and fetches candles.

## Safety rules in the connection manager

All of these are covered by `src/lib/live/feed/dhan-feed.test.ts` (per socket) and `feed-hub.test.ts` (connections):

- At most 5 connections, one instrument on one connection only.
- One socket per connection at most. Subscribing while a socket is opening or open never opens another.
- Reconnects back off from 1 second to 30 seconds with jitter, then resubscribe everything in batches of 100.
- After Dhan disconnect code 805, wait at least 60 seconds.
- After 5 failed handshakes in a row, wait 5 minutes between attempts. A bad token surfaces this way when Dhan rejects the upgrade itself.
- Disconnect codes 807 to 810 (token or auth) stop the feed until the token changes, rather than retrying with a dead token.
- No subscribers for 5 minutes closes the socket. Browser tabs leaving release instruments after a 30-second grace period, so moving between sections doesn't churn subscriptions.

## Dhan Live Market Feed v2 facts

Sources: dhanhq.co/docs/v2/live-market-feed and the Annexure, read on 2026-11-15.

**Connection:** `wss://api-feed.dhan.co?version=2&token=<access token>&clientId=<client id>&authType=2`.

**Limits:**
- 5 connections per user. A sixth disconnects the first with 805.
- 5,000 instruments per connection.
- 100 instruments per subscribe message.

**Request codes:**

| Code | Meaning |
|---|---|
| 15 / 16 | Ticker subscribe / unsubscribe (the only mode the hub uses) |
| 17 / 18 | Quote subscribe / unsubscribe |
| 21 / 22 | Full subscribe / unsubscribe |
| 23 / 24 | Full market depth subscribe / unsubscribe |
| 12 | Disconnect |

**Response header:** 8 bytes. Offsets below are 0-based.

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
| 2 | Ticker | 8 LTP float32, 12 last trade time int32. Confirmed live |
| 4 | Quote | 8 LTP f32, 12 LTQ i16, 14 LTT i32, 18 avg price f32, 22 volume i32, 26 total sell qty i32, 30 total buy qty i32, 34 open f32, 38 close f32, 42 high f32, 46 low f32 |
| 5 | OI | 8 open interest int32 |
| 6 | Previous close | 8 previous close float32, 12 previous OI int32. Sent on subscribe in every mode; this is where day change comes from. Confirmed live |
| 7 | Market status | Listed in the Annexure without a layout. The hub logs it as unparsed |
| 8 | Full | Quote fields with OI at 34 and OHLC at 46 to 61, then 5 depth levels of 20 bytes |
| 50 | Disconnect | 8 reason code int16 |
| 1 | Index | Listed without a layout; parsed as a ticker until a capture says otherwise |

**Keepalive:** the server pings every 10 seconds and closes the socket after 40 seconds without a pong. Node's built-in WebSocket answers pings automatically.

## Open questions

- **What `ltt` measures.** On 2026-11-15 NIFTY's `ltt` was 1794598820. Read as Unix seconds, that is Fri 13 Nov 19:40:20 UTC, 9 h 40 m after the 15:30 IST close. No other reading lines up with the close either. Compare it with the wall clock during a session (with `FEED_CAPTURE=1`) before using it anywhere.
- **Whether Dhan stamps candles at the start of the interval.** The live candle logic assumes it does. If live ticks land one candle late during a session, Dhan stamps the end instead.
- **Packet 7 (market status).** Capture one during a session to learn its layout. Once it decodes, the header can show open/closed status from the exchange instead of a clock guess.
- **Not built yet:**
  - Overview sparklines.
  - Live prices in the option chain.
  - Live holdings P&L. It would change how holdings P&L is calculated, which is still from REST.
