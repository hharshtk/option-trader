# Engine

The engine is a long-running Node process that will own everything that talks to Dhan: market data, the journal, analytics, strategies and orders. The web app is its operator console. Everything the engine does is reported to the web.

This document describes what is built. For what comes next, see [engine-plan.md](engine-plan.md). Last updated 2026-11-16.

## Contents

1. [Status](#status)
2. [Running it](#running-it)
3. [Configuration](#configuration)
4. [Reaching it from Vercel](#reaching-it-from-vercel)
5. [What you see on the web](#what-you-see-on-the-web)
6. [How it fits together](#how-it-fits-together)
7. [Health checks](#health-checks)
8. [Control API](#control-api)
9. [Telemetry stream](#telemetry-stream)
10. [Logs and metrics](#logs-and-metrics)
11. [Journal](#journal)
12. [Replay](#replay)
13. [Always-on universe](#always-on-universe)
14. [Research recording](#research-recording)
15. [Session calendar](#session-calendar)
16. [Code layout and rules](#code-layout-and-rules)
17. [Testing](#testing)
18. [Extending it](#extending-it)
19. [Troubleshooting](#troubleshooting)

## Status

| Step | State | What it gives |
|---|---|---|
| E0 Groundwork | Built | Shared modules run under plain Node; clock, event types, logger, metrics, session calendar |
| E1 Skeleton and monitoring | Built | `npm run engine`, control API, health checks, Engine page, header status dot |
| E2 Engine owns Dhan | In progress | Done: the feed runs in the engine and the web forwards to it; always-on journal; always-on universe (NIFTY's and BANKNIFTY's constituents in Full mode, India VIX, BANKNIFTY, FINNIFTY); per-instrument Ticker/Quote/Full modes; the [research recorder](#research-recording) (NIFTY and BANKNIFTY futures, wide option windows, 20-level depth, option chain snapshots). Next: journal compression and upload to S3, one REST limiter |
| E6–E7 Signals and paper trading | First version built | The engine follows a Pulse signal with NIFTY options on paper: decision API gate, limits, Dhan's charges, Parquet tables, Strategies and Activity pages. See [trading.md](trading.md) |
| E3–E5, E8 | Planned | See [engine-plan.md](engine-plan.md#build-steps). Live orders (E8) wait for the go-live gate in [engine-plan.md](engine-plan.md#go-live-gate) |

Today the engine monitors itself and the Dhan account, **owns the live Dhan feed**, keeps the NIFTY universe subscribed at all times, and **journals every raw frame** to disk. With `ENGINE_URL` set, the web never opens Dhan sockets: its quote stream, Live Feed stream and Live Feed actions forward to the engine. Without `ENGINE_URL`, the web runs its own feed as it did before the engine. The engine also **trades on paper** ([trading.md](trading.md)). It doesn't place orders with Dhan.

**Host:** the OCI VM `option-trading-e5` (Ubuntu 24.04, Node 26.13). See [oci-setup.md](oci-setup.md).

## Running it

| Command | What it does |
|---|---|
| `npm run engine` | Starts the engine with `.env.local`. Use this on days you record |
| `npm run engine:dev` | The same under `node --watch`: restarts on every edit |
| `npm run engine:replay` | Starts on a recorded day instead of the live feed. Options after `--`: `--date YYYY-MM-DD` (default: newest recorded day), `--from HH:MM` IST (default: 09:00 on a trading day), `--speed N` (default 1). See [Replay](#replay) |
| `npm run test:engine` | Engine tests |
| Ctrl-C | Clean stop: closes connections, releases the lock, flushes the log |

Only one engine runs at a time. A second one exits with `The engine is already running (pid N)`. The lock file is `data/engine/engine.lock`; a lock left by a crashed engine is replaced automatically.

### As a service

[deploy/option-trader-engine.service](../deploy/option-trader-engine.service) runs the engine under systemd: it starts on boot, restarts 5 seconds after a crash, and gives up after 5 failed starts in a minute.

```bash
sudo cp deploy/option-trader-engine.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now option-trader-engine
journalctl -u option-trader-engine -f     # follow the logs
sudo systemctl restart option-trader-engine   # after pulling new code
```

Stop any engine started by hand first, or the service fails on the lock.

## Configuration

All settings come from `.env.local`, which both the engine and the web read.

| Variable | Default | Purpose |
|---|---|---|
| `ENGINE_TOKEN` | none, required | Secret for the control API, at least 32 characters. Generate with `openssl rand -hex 32` |
| `ENGINE_URL` | none | Where the web reaches the engine: `http://127.0.0.1:3100`. Without it the header dot is grey and the Engine page says "Not configured" |
| `ENGINE_PORT` | `3100` | Control API port |
| `ENGINE_HOST` | `127.0.0.1` | Control API address. Keep it on localhost; the web proxies to it |
| `ENGINE_DATA_DIR` | `data/engine` | Lock file, logs and journal. Git-ignored |
| `ENGINE_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `DHAN_CLIENT_ID` | none | Dhan account |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | none | Where the access token saved on the Settings page lives |
| `DHAN_ACCESS_TOKEN` | none | Fallback token when Redis has none |
| `OPENROUTER_API_KEY` | none | The decision API for paper trading. Without it the decision gate can't answer |
| `S3_BUCKET` and the other `S3_*` | none | Where trading's Parquet tables and the instrument file live. Without them, under `DATA_DIR` |

The web reads `.env.local` changes on its own. The engine reads it at start, so restart the engine after changing it. The access token is the exception: the engine re-reads it from Redis every 30 seconds, so a token saved on the Settings page needs no restart.

## Reaching it from Vercel

The frontend runs on Vercel; only the engine runs on the server. Vercel reaches the engine over HTTPS on the server's public IP:

```
Vercel (bom1) ──HTTPS──► 140.245.240.9:443 ──► Caddy ──► 127.0.0.1:3100 engine
```

| Piece | Setting |
|---|---|
| Vercel environment | `ENGINE_URL=https://140.245.240.9` and the same `ENGINE_TOKEN` as the server |
| Vercel region | `bom1` (Mumbai), set in [vercel.json](../vercel.json): the closest region to the server and to Dhan |
| Caddy | [deploy/Caddyfile](../deploy/Caddyfile): HTTPS with a Let's Encrypt IP certificate, forwards only `/v1/*`, 404 for anything else |
| Firewalls | Port 443 open in the OCI security list and in the VM's iptables (`/etc/iptables/rules.v4`). Port 3100 stays closed; the engine listens on 127.0.0.1 only |
| Bad tokens | After 10 in 10 minutes from one address, that address gets 429 until the window passes. The engine reads the address from Caddy's `X-Forwarded-For`, trusted only from localhost |

**Certificate.** Let's Encrypt IP certificates last about 6 days; Caddy renews them on its own through the `tls-alpn-01` challenge on port 443. Port 80 isn't needed. Clients send no SNI to a bare IP, so the Caddyfile sets `default_sni`; without it the handshake fails with "internal error".

```bash
# Caddy
sed 's/ENGINE_PUBLIC_IP/140.245.240.9/g' deploy/Caddyfile | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
journalctl -u caddy -f                       # certificate renewals and errors
sudo tail -f /var/log/caddy/engine-access.log

# From anywhere: 401 means HTTPS and Caddy work and the token check is on
curl -s -o /dev/null -w '%{http_code}\n' https://140.245.240.9/v1/status
```

**The IP is ephemeral.** It survives reboots and stop/start, but not terminating the instance. Moving to a reserved IP gives a new address, so it means updating the Caddyfile, Vercel's `ENGINE_URL`, your SSH config and, once set, Dhan's order whitelist (changeable only once every 7 days). Do it from the OCI Console, not over an SSH session to the old address.

**Live quotes on Vercel come from the engine.** Vercel's functions can't hold a Dhan socket, so with `ENGINE_URL` set the web forwards quote and Live Feed streams to the engine, which owns the socket. Telemetry streams also reconnect when Vercel ends a function at its maximum duration; they resume from the last message, so nothing is lost.

## What you see on the web

**Header, every page:** an Engine dot next to Dhan. Hover for the reason, click for the Engine page.

| Dot | Meaning |
|---|---|
| Green | Running, every component ok |
| Amber | Degraded: running, but something needs attention |
| Red | Failing, or offline (no status for over 5 seconds) |
| Grey | Connecting, or `ENGINE_URL` isn't set |

**Engine page (`/engine`), Overview:**

| Panel | Shows |
|---|---|
| Health | Each component, its state, the reason and when it changed |
| Journal | Today's file, its size, frames, events and gaps written by this run, last write, write latency p99, any disk backlog, and the recorded days |
| Dhan feed | The always-on universe and its size; sockets used of 5, each socket's state (with the reason when stopped or reconnecting), instruments, frames and last tick; open tabs, pinned instruments, and whether raw frames are being recorded |
| Dhan account | Token source (Redis or `.env.local`) and expiry, Data API plan and its end date, active segments, last profile check, clock offset from Dhan |
| Market sessions | Each segment: open, pre-open or closed, today's holiday, the next session in IST |
| Process | Git version, host, pid, Node version, start time, memory, CPU, event-loop delay p99 |
| Metrics | Every counter, gauge and latency histogram the engine records |

**Engine page, Session:** a trading day read back from its journal file, picked from the recorded days; today's view refreshes every 5 seconds. Everything on it is decoded by the engine from the raw frames on disk with the live feed's own parser:

| Panel | Shows |
|---|---|
| Headline | NIFTY and its change, breadth (stocks up / down), turnover (VWAP × volume summed), packets decoded, feed rate in the session and its peak minute, gaps |
| Chart | NIFTY 1-minute bars built from journaled ticks; below it breadth (stocks up minus down) and packets per minute |
| Movers | Top 5 gainers, top 5 losers, most traded by value |
| Instruments | Every recorded instrument, sortable: a sparkline of the day, LTP, change from the previous close, from the open and against VWAP, where the price sits in the day's range, volume, turnover, pending buy and sell quantity, packets, last tick |
| Journal | Records, packets and events by kind, first and last frame, session minutes with data, engine runs, gaps and socket state changes |

**Reference price.** Changes are measured from the last price recorded before 09:00 IST, which is the previous session's close (the universe is subscribed from engine start, so Dhan's subscribe snapshot provides it). Dhan's previous-close packet is used only when received after 09:00: before the open it still holds the close before that (checked 16 November 2026: Thursday's close on Monday morning). An engine started after 09:00 in Quote mode has no reference, so those stocks show no change.

**Cost.** The first request for a day reads the whole file in 1 MB chunks with a yield between them (a 135 MB, 2-million-frame day reads in under a second, stalling the event loop at most about 20 ms at a time). Later requests read only the bytes appended since. The last 4 days read are kept in memory.

**Strategies and Activity pages:** the engine's paper trading. See [trading.md](trading.md#using-it).

**Engine page, Logs:** a live tail that starts with the last 500 lines. Filter by minimum level, component (a component includes its children: `dhan` includes `dhan.feed`) and text. Follow keeps the newest line in view; scrolling up turns it off. The tab keeps the last 2,000 lines; the full history is in `data/engine/logs/`.

When the engine stops, the page says so and how to start it. It reconnects within about 2 seconds of the engine coming back, and clears old log lines when the engine restarted.

## How it fits together

```
Browser ──► Next.js (session cookie) ──► /api/engine/v1/* ──► engine on 127.0.0.1:3100
             header dot, /engine page      adds ENGINE_TOKEN      control API (node:http)
                                           streams the reply          │
                                                                      ├─ status every 1 s
                                                                      ├─ metrics every 5 s
                                                                      ├─ log lines as they happen
                                                                      └─ Dhan profile every 15 min
```

- **The browser never talks to the engine.** The route [src/app/api/engine/[...path]/route.ts](../src/app/api/engine/[...path]/route.ts) checks the session cookie, adds the token and streams the response through. It allows only `v1/status`, `v1/logs`, `v1/telemetry`, `v1/journal/session`, `v1/trading` and `v1/trading/history`. Closing the tab aborts the upstream request.
- **Market data goes through the engine too.** `/api/market/stream` (quotes for a tab), `/api/market/feed` (Live Feed page) and the Live Feed Server Actions forward to the engine's `/v1/quotes`, `/v1/feed` and `/v1/feed/*` when `ENGINE_URL` is set ([web.ts](../src/lib/engine/web.ts)). Browser code is unchanged. Closing a tab releases its instruments in the engine.
- **The engine never waits for the web.** A browser that falls behind loses its oldest messages and gets a `gap` notice; the engine carries on.
- **Each side works without the other.** The engine runs with no browser attached. The web works without the engine, minus the engine panels.

| Proxy reply | Meaning |
|---|---|
| 401 | Not signed in |
| 404 | Path not on the allowlist |
| 501 | `ENGINE_URL` or `ENGINE_TOKEN` not set |
| 503 | Engine not running |

## Health checks

Each component reports `ok`, `degraded` or `failing`. The overall state is the worst of them. Every change is logged: `info` back to ok, `warn` for degraded, `error` for failing.

| Component | Degraded | Failing | Checked |
|---|---|---|---|
| `engine` | — | — | Always ok while running |
| `journal` | The disk is more than 8 MB behind | A write failed (for example disk full) | Every second |
| `feed` | A socket is reconnecting | A socket stopped (for example a rejected token); it reconnects on its own once a new token is saved | Every second |
| `api` | — | — | Ok once the control API listens |
| `token` | Less than 2 hours left, or expiry unreadable | Missing or expired | Every second |
| `dhan` | Network error reaching Dhan | Dhan rejected the profile call (for example a bad token) | At start, then every 15 minutes |
| `data-plan` | Less than 7 days left | Not active | With the profile check |
| `clock` | Offset from Dhan above 1 s | Offset above 5 s | After every Dhan REST call |
| `calendar` | No holiday list for the current year | — | At start |
| `trading` | The day is stopped (loss limit, losses in a row, or by you); option contracts are missing with entries on; the tables can't be saved; the decision API has no key | — | Every second |

**Clock offset.** Every Dhan REST response carries a `Date` header with 1-second resolution. [client.ts](../src/lib/dhan/client.ts) turns it into an offset estimate with an uncertainty (about ±500 ms plus half the round trip) and keeps the tighter of recent samples. The clock check only flags what lies beyond that uncertainty, so a ±540 ms reading never raises a false alarm. The VM's clock is NTP-synchronised; typical offsets are under 100 ms.

## Control API

Plain HTTP on `127.0.0.1:3100`. Every request needs `Authorization: Bearer <ENGINE_TOKEN>`; anything else gets 401. Only `GET`.

| Endpoint | Returns |
|---|---|
| `GET /v1/status` | One `EngineStatus` snapshot (below) |
| `GET /v1/logs?level=&component=&limit=` | `{ entries: LogEntry[] }`, newest last. `limit` defaults to 500, at most 2,000 |
| `GET /v1/telemetry?topics=status,log,metrics,feed&since=` | Server-sent events (below) |
| `GET /v1/quotes?i=IDX_I:13,NSE_EQ:1333` | Server-sent quotes for up to 200 instruments, the same events the web's `/api/market/stream` always sent. Subscribes them on Dhan; disconnecting releases them after a 30-second grace period |
| `GET /v1/journal/session?date=YYYY-MM-DD` | `JournalSession`: the day read back from its journal (see the Session view above). `date` defaults to today in IST; 404 when there is no file for that day |
| `GET /v1/feed` | Server-sent Live Feed monitor: a `snapshot`, then `health` every second and `events` |
| `POST /v1/feed/pin` | `{ key, connection: number \| "new", name?, connectionName? }`: keep an instrument subscribed |
| `POST /v1/feed/unpin` | `{ key }` |
| `POST /v1/feed/connections/:id/close` | Close a socket other than Main |
| `GET /v1/trading`, `POST /v1/trading`, `GET /v1/trading/history?run=` | Paper trading: its status, its commands and its stored runs. See [trading.md](trading.md#control-api) |
| `GET /v1/research`, `POST /v1/research`, `GET /v1/research/studies`, `GET /v1/research/study?id=` | Research studies: the job queue, its commands, the stored studies and one study. Each job runs in a child process. See [research-center.md](research-center.md#how-it-fits-together) |
| `POST /v1/replay` | Switch the feed to a recorded day and back, and steer it: `{ action: "start", date?, from?, speed? }`, `"stop"` (back to live), `"play"`, `"pause"`, `{ action: "speed", speed }`, `{ action: "seek", to: "HH:MM[:SS]" }`. Answers `{ ok, message }`. See [Replay](#replay) |

Feed routes answer 503 for the second or so after start-up, before the feed exists.

From the server itself:

```bash
T=$(grep '^ENGINE_TOKEN=' .env.local | cut -d= -f2)
curl -s -H "Authorization: Bearer $T" http://127.0.0.1:3100/v1/status | jq .overall
curl -sN -H "Authorization: Bearer $T" "http://127.0.0.1:3100/v1/telemetry?topics=log"
```

`EngineStatus`, from [protocol.ts](../src/lib/engine/protocol.ts):

| Field | Contents |
|---|---|
| `version`, `pid`, `host`, `node`, `startedAt`, `now` | Identity and timing. `version` is `git describe --always --dirty` |
| `overall`, `components` | Health, as above |
| `token` | `source` (`redis`, `env`, `none`) and `expiresAt` |
| `dhan` | Last profile check: client id, data plan and validity, token validity, active segments. `null` before the first check |
| `clock` | `offsetMs` (Dhan minus ours), `uncertaintyMs`, `measuredAt`. `null` before the first Dhan call |
| `sessions` | Per segment: `phase`, `next` session, today's `holiday` |
| `journal`, `journalDays` | Today's file and counts (see [Journal](#journal)); recorded days with sizes, newest first |
| `universe` | Name, instrument count and any entries that couldn't be resolved |
| `process` | `rssBytes`, `heapUsedBytes`, `cpuPercent`, `eventLoopDelayP99Ms` |
| `replay` | `null` when live. During a replay: `date`, `state` (`playing`, `paused`, `ended`), `speed`, `at` (recorded time reached), `startAt`/`endAt`, `frames`/`totalFrames`, `sockets`, `jumps` (increases on each start and seek), `since`, `liveAt` (when it goes back to live on its own) |
| `replayBlocked` | Why a replay can't start now (a session is open or opens within 30 minutes), or `null` |

## Telemetry stream

`GET /v1/telemetry` is a server-sent-events stream of what a run is doing. Today there is one run, `live`.

Each event:

```
id: 42
event: log
data: {"run":"live","seq":42,"topic":"log","at":1794758217612,"wall":1794758217612,"data":{...}}
```

- `seq` increases by one per message. `at` is the run's clock (virtual in future replays); `wall` is the engine's wall clock.
- The first event on every connection is `hello` (`{ protocol, run, seq }`), with no id.
- A `gap` event (`{ dropped }`) means this client fell behind and lost that many messages.
- A `: ping` comment every 15 seconds keeps proxies from closing an idle stream.

**Resuming.** Reconnect with `Last-Event-ID: <seq>` (EventSource does this itself) or `?since=<seq>` to get what you missed, as far as the buffers reach. A `since` above the engine's current seq means the engine restarted, so the stream starts from the beginning.

| Topic | Contents | Rate | Kept for new clients |
|---|---|---|---|
| `status` | `EngineStatus` | 1 a second | The latest |
| `metrics` | `MetricsSnapshot` | Every 5 seconds | The last 12 (one minute) |
| `log` | `LogEntry` | As they happen | The last 500 |
| `feed` | `FeedHealth`: sockets, instruments, tabs, capture | 1 a second | The latest |
| `trading` | `TradingUpdate`: the trading status; its lists only when they changed | About 1 a second while anything changes, else every 5 | The latest |
| `bars`, `gaps` | Reserved for E3 | — | — |

A client that can't keep up gets up to 1,000 queued messages, then loses the oldest.

## Logs and metrics

**Logs** ([logger.ts](../src/engine/telemetry/logger.ts)) go to three places at once: the terminal (or journald under systemd), `data/engine/logs/<IST date>.jsonl` (one JSON object per line, a new file each IST day), and the telemetry stream.

```ts
const log = logs.logger("dhan");          // component name
log.info("Dhan profile checked", { dataPlan: "Active" });
log.child("feed").warn("reconnecting");   // component "dhan.feed"
```

Each component may log at most 50 lines a second. Extra `debug`, `info` and `warn` lines are counted and summarised (`dropped N log lines over the 50/s limit`); `error` lines are never dropped.

**Metrics** ([metrics.ts](../src/engine/telemetry/metrics.ts)):

| Kind | Call | Snapshot |
|---|---|---|
| Counter | `metrics.increment("frames")` | Cumulative since start |
| Gauge | `metrics.gauge("sockets", 2)` | Latest value |
| Latency histogram | `metrics.observe("kernel.lag", ms)` | p50, p90, p99, max and count over the last 5-second window |

Histogram buckets run from 0.05 ms to 30 s; percentiles report the bucket's upper bound, capped at the largest value seen. Current metrics: `log.debug`, `log.info`, `log.warn`, `log.error`, `api.clients`, and for the feed `feed.connections`, `feed.live_connections`, `feed.instruments`, `feed.quote_streams` and the `feed.frames` counter.

## Journal

Full explanation: [journal.md](journal.md). In short: every raw WebSocket frame, exactly as Dhan sent it, is appended to `data/engine/journal/<IST date>.bin` before anything parses it. This is the source of truth: if the parser changes, a day can be decoded again, and replays (E4) feed these files through the same code as the live run.

- **One order.** Records are numbered as they arrive, across every socket, so a day has a single sequence. The number restarts at each engine start (marked by an `engine-start` record) and at each new day.
- **What else is recorded.** Control records, as JSON: `file-open` (engine version and the subscriptions in force, so a day replays on its own), `engine-start`, `engine-stop`, `subscribe` and `unsubscribe` (instrument keys), `state` (connecting, live, reconnecting, stopped), and `gap`.
- **Gaps.** A socket that drops and reconnects gets a `gap` record from the moment it went down to the moment it was live again. A status tick more than 5 seconds late (process suspended or starved) gets a `gap` with reason `suspend`. Both are logged as warnings.
- **Restarts.** A restart on the same day appends to that day's file.
- **Closed market.** While a segment is closed, frames that only repeat the last value journaled for each instrument (Dhan's after-hours index heartbeat) are skipped and counted in `journal.frames_skipped`. Anything new is still written. See [journal.md](journal.md#how-it-behaves).
- **Crashes.** At most the last unflushed write is lost; a cut-off last record is detected and skipped when reading.
- **Format.** [format.ts](../src/engine/journal/format.ts): an 8-byte magic `OTJRNL01`, then records of `length u32 | type u8 | reserved u8 | connection u16 | seq f64 | recvTs f64 | payload`, little-endian. `decodeJournal()` reads a file back.
- **Size.** About 50 bytes per frame record header plus the frame. Measure a full session before deciding retention; compression and R2 upload come later in E2. The disk has about 90 GB free.

`FEED_CAPTURE` no longer applies to the engine: the journal replaces it.

## Replay

For working on the app while the market is closed: the engine plays a recorded day back through a stand-in for Dhan's WebSocket, so every page shows that day's prices at their recorded pace. The feed opens the stand-in exactly as it opens Dhan, sends it the same subscribe requests and receives the same binary frames, so the hub, quote streams, Live Feed page and everything built on them run unchanged.

**Switching.** On the Engine page, Overview → Feed source: pick a day, a start time and a speed, then Start replay. While replaying, the same panel has play/pause, speeds ×1 to ×300, a scrubber, Jump to a time, and Back to live. The header shows a **Replay** tag next to the Engine dot on every page, and the Engine page a banner. Or start the engine straight into a replay:

```bash
npm run engine:replay                                   # newest day, from 09:00, ×1
npm run engine:replay -- --date 2026-11-16 --from 13:30 --speed 10
```

**What it mimics.**

| Dhan does | The replay does |
|---|---|
| Sends frames as the market moves | Sends each journaled frame at its recorded receive time, scaled by the speed |
| Sends only what a socket subscribed, in its mode | The same. A packet recorded in a richer mode is cut down (Quote or Full to Ticker, Full to Quote); one recorded in a poorer mode is sent as recorded |
| Answers a subscribe with the instrument's latest state | Sends its latest recorded price packet, and in Ticker mode its previous close, at once |
| Previous close in Ticker mode only; OI in Quote and Full | The same |
| Disconnect request (code 12) closes the socket | The same |
| Silence for an instrument that doesn't trade | Silence for an instrument with nothing recorded (a line in the `replay` log says how many) |

**Time.** During a replay the web sees recorded time: a quote's time is when that frame originally arrived (to the millisecond), and so are last-tick times, socket times and Live Feed event times. The live feed code is unchanged and stamps frames with the wall clock as always; the player remembers which recorded frame it delivered in each wall-clock millisecond, and the engine rewrites the times in what it sends out (`/v1/quotes`, `/v1/feed`, `feed` telemetry) in [retime.ts](../src/engine/replay/retime.ts). Those streams also carry the replay's `clock` (recorded time now, speed, day), so ages such as "tick 2 s ago" on the Live Feed and Engine pages are measured from recorded time, and the Live Feed page shows "Replay 10:42:13". The header's market status still follows the wall clock. A seek resends every subscribed instrument's state at the new time, so prices jump there; going back in time is allowed. The replay stays on the last prices when it reaches the end of the file. The engine's logs stay on the wall clock.

**Session view and Pulse.** During a replay, `GET /v1/journal/session` answers for the replayed day (and by default) with that day as far as the replay has reached, read from the same file with the same aggregator as a live day. So the Session view and Pulse build up minute by minute as they do live, and a seek back shrinks them again. Pulse follows the replay's day on its own and says "Replay of …" instead of "Live". The first read after a start or a seek back catches up in chunks (about 0.2 s for an hour of the day); later reads take milliseconds. Code: [replay-session.ts](../src/engine/replay/replay-session.ts).

**Charts and option prices from Dhan.** Two places draw on Dhan's history API rather than the journal, and both are cut at the replay's position so nothing from later in the day shows. The index chart on the index pages loads the replayed day's 1-minute candles, keeps the minutes that had closed by the replay's position, groups them into 5-minute candles, and lets replayed ticks extend it; it reloads when the replay starts, seeks or ends (`jumps` in the replay status). Pulse's "Trade it with options" hides option candles for minutes that hadn't closed yet, so a trade whose exit minute is still ahead waits for it, as live. Code: [replay-candles.ts](../src/lib/replay-candles.ts), `candlesAsOf` in [option-trades.ts](../src/lib/insight/option-trades.ts).

**What it doesn't do.** It isn't the E4 replay: nothing runs on a virtual clock, and runs aren't reproducible to the millisecond. It doesn't recreate the recorded subscriptions: the always-on universe and open pages subscribe as they do live. Recorded gaps play as silence.

**Guard rails.** A session not recorded on the day is lost for good, so:

- Replay is refused from 30 minutes before any segment's session (pre-open included) until it closes. A running replay switches back to live on its own at that point; the Feed source panel says when.
- Nothing is journaled while replaying. The live journal gets a `replay-start` record, then on the way back a `replay-stop` and a `gap` with reason `replay` covering the time the live feed was off.
- Switching closes every quote stream and Live Feed page stream; browsers reconnect within 3 seconds and resubscribe.

**Cost.** Starting reads the whole file: about 0.25 s and 90 MB of memory for a full day (982,000 frames). A seek across the whole day blocks the engine for about 0.4 s; short seeks are instant.

Code: [player.ts](../src/engine/replay/player.ts) (the stand-in socket and the timing), [retime.ts](../src/engine/replay/retime.ts) (recorded times on the web), [recording.ts](../src/engine/replay/recording.ts) (the file index), [feed-switch.ts](../src/engine/feed-switch.ts) (switching and the guard), tests in [replay.test.ts](../src/engine/replay/replay.test.ts), which run the real feed client against the stand-in.

## Always-on universe

[config/engine/universe.json](../config/engine/universe.json) lists instruments the engine subscribes at start and never releases, so sessions are journaled even with no page open. Pages still add what they show on top. Today: the NIFTY index, India VIX, BANKNIFTY and FINNIFTY in Ticker mode, and the constituents of NIFTY (50) and BANKNIFTY (14, five of them also in NIFTY) in Full mode: 63 instruments, one socket. Full gives the constituents five levels of depth with order counts, for order-book features across the basket.

NIFTY futures and options aren't in this file, because which ones exist changes with each expiry and which strikes matter moves with the index. The [research recorder](#research-recording) picks them each trading day. Trading also subscribes its own window ([trading.md](trading.md#option-contracts-and-recording)); the hub counts holders, so the two never clash.

Entries are `{ "kind": "index", "index": "NIFTY" }`, `{ "kind": "constituents", "index": "NIFTY" }`, `{ "kind": "instrument", "key": "NSE_EQ:1333" }`, or plain keys in `instruments` (always Ticker). Each entry takes an optional `"mode"`:

| Mode | Dhan request codes | What Dhan streams | Packet |
|---|---|---|---|
| `ticker` (default) | 15 / 16 | Last price and time | 16 bytes |
| `quote` | 17 / 18 | Adds last traded quantity, average traded price (the exchange's VWAP), volume, total buy and sell quantity, day open, high, low and (after the close) close | 50 bytes |
| `full` | 21 / 22 | Adds open interest and five levels of market depth | 162 bytes |

Indices carry no volume, so Ticker is enough for them. An instrument listed twice gets the richer mode. In the hub an instrument keeps the richest mode anyone asked for: a page asking for Ticker never downgrades a universe instrument in Quote. Switching a mode unsubscribes the old one first, since Dhan doesn't document what a second subscription in a different mode does.

**Known effect:** in Quote mode (and so presumably Full) Dhan doesn't send the previous-close packet (checked 15 November 2026), so the Live Feed page shows no change % for the 50 constituents. The header, Overview and Market Watch show change % for indices only, which stay in Ticker mode and are unaffected. Anything that can't be resolved is logged and shown on the Engine page. Restart the engine after editing it.

## Research recording

[recorder.ts](../src/engine/recording/recorder.ts) records, on every trading day, the data any strategy might later need, whether or not the trader uses it. NIFTY is the index strategies are built on; BANKNIFTY is recorded alongside so it can be tested later. `RECORDED` in recorder.ts lists the indices and how much of each to keep. It runs from 30 minutes before the F&O open to 10 minutes after the close (08:45–15:40 IST on a normal day), on the live feed only: during a replay it holds nothing. The Engine page's **Research recording** panel shows what it holds, the depth connection and the chain snapshots; problems turn the `recorder` health component amber.

| What | Where it goes | Detail |
|---|---|---|
| Every unexpired NIFTY and BANKNIFTY future (three months each) | Main journal, Full mode | Last trade, volume, OI, 5-level depth |
| NIFTY options, three nearest (weekly) expiries | Main journal, Full mode | ±15, ±10 and ±5 strikes around the money (126 contracts). The window follows the index and only grows during the day, so no series is cut |
| BANKNIFTY options, two nearest (monthly) expiries | Main journal, Full mode | ±15 and ±10 strikes (104 contracts) |
| 20-level depth: NIFTY's two nearest futures and its nearest expiry's ±5 strikes, then BANKNIFTY's two nearest futures | `<date>.depth.bin` | Dhan's depth connection (`wss://depth-api-feed.dhan.co/twentydepth`), up to 50 instruments; price, quantity and order count per level. Starts with 26 and grows with NIFTY's window until 50 |
| Option chain: NIFTY's three nearest expiries, BANKNIFTY's two | `<date>.chain.bin` | Once a minute while the market is open (5 seconds into the minute) and once at the close: IV, delta, gamma, theta, vega, OI and previous OI, volume, best bid and ask for strikes within 10% of the index. 75–90 KB per expiry per snapshot, so about 150 MB a day |
| What each recorded ID is | Main journal, `instruments` control records | Key, future or option, expiry, strike, CE/PE, lot size, name. A day stays readable after its contracts expire and leave Dhan's instrument file |

**Side files.** `<date>.depth.bin` and `<date>.chain.bin` sit next to the day's journal in the same [format](../src/engine/journal/format.ts). The depth file holds the depth connection's raw frames (connection 1) plus its `state` and `subscribe` events; decode frames with `parseDepthFrame()` in [depth-packets.ts](../src/lib/live/feed/depth-packets.ts). The chain file holds `option-chain` control records: `{ underlying, expiry, minute, lastPrice, oc }` (underlying is `NIFTY` or `BANKNIFTY`), where `oc` is Dhan's per-strike object. Replays and the Pulse page read only the main journal; the side files are research data and nothing replays them yet.

**Contracts.** Options come from the same instrument file and contract loader as trading's, per index; each live day's contracts are saved as `reference/<index>-options/<date>.parquet`.

**Futures.** Each download of Dhan's instrument file (Settings, or the engine's own download before a session) also writes the unexpired NSE and BSE index futures to `instruments/index-futures.parquet`. If that table is missing or older than the day, the recorder downloads the file again, at most every 10 minutes.

**Sockets.** The depth connection is a second socket per engine. Dhan allows five per account: prod and a dev engine both running use four. A third engine against the live feed would go over and Dhan would cut the oldest socket, so test engines should replay rather than connect.

**Size.** Full mode on the constituents and options, plus depth, makes the main journal several times larger than in Quote mode, and the depth file may well be bigger still. Measure the first full day on the Engine page; compression and upload to S3 are the next step, and the disk has about 85 GB free.

## Session calendar

[config/engine/calendar.json](../config/engine/calendar.json) holds trading hours per segment and exchange holidays; [session-calendar.ts](../src/engine/market/session-calendar.ts) answers questions about it.

- **Segments:** `IDX_I`, `NSE_EQ` (with pre-open 09:00–09:08) and `NSE_FNO`, all 09:15–15:30 IST.
- **Holidays:** NSE's 16 trading holidays for 2026, including the 15 January closure added later.
- **Time zone:** all times are IST from a fixed +05:30 offset, so nothing depends on the server's time zone (the VM runs in UTC). Journal and log files are named by IST date.
- **Special sessions:** Muhurat trading (8 November 2026) is listed without times, so it counts as closed. Fill in `open` and `close` from NSE's circular to trade it.

**Each year:** add the next year's holidays from NSE's circular (usually published in December) and add the year to `coveredYears`. Until then the `calendar` component reports degraded.

## Code layout and rules

```
src/engine/
  main.ts                 entry point: config, lock, timers, shutdown
  dhan-watch.ts           profile, token and clock checks
  lock.ts                 one engine at a time
  api/server.ts           control API
  api/sse.ts              one SSE client with a bounded queue
  kernel/clock.ts         live and virtual Clock
  kernel/events.ts        MarketEvent types
  market/session-calendar.ts
  feed.ts                 the Dhan feed hub inside the engine, wired to the journal and universe
  feed-switch.ts          live or replay: swaps the feed's source, guards the market hours
  replay/                 a journal file loaded for replay, the player that stands in for Dhan's socket, and recorded times for the web
  journal/                journal format (encode/decode), writer, and the session reader behind the Session view
  market/universe.ts      always-on universe from config/engine/universe.json
  trading/                paper trading: trader, strategy, decision gate, paper fills, contracts, run log, Parquet tables
  recording/              research recorder: NIFTY and BANKNIFTY futures and option windows on the main feed, 20-level depth socket, option chain snapshots
  api/feed-routes.ts      quote stream, Live Feed stream and actions
  telemetry/              logger, log file, metrics, health, telemetry hub, process stats, ring buffer
src/lib/engine/protocol.ts    types shared by engine and web (the web imports only this and trading.ts)
src/lib/live/feed/depth-packets.ts  Dhan's 20-level depth feed: URL, subscribe messages, frame parser
src/lib/engine/trading.ts     trading types and settings shared by engine and web
src/lib/trading/charges.ts    Dhan's charges
src/lib/db/parquet-store.ts   Parquet tables in the file store, read and written with DuckDB
src/lib/engine/web.ts         web side: reads ENGINE_URL and ENGINE_TOKEN
src/app/api/engine/[...path]/ web-to-engine proxy
src/app/(cockpit)/engine/     Engine page
src/components/engine/        header dot, Engine page, telemetry hook
config/engine/                checked-in configuration
deploy/                       systemd unit
data/engine/                  runtime files, git-ignored: lock, logs, journal, trading (settings, run logs)
```

The engine runs TypeScript directly with Node's type stripping: no build step. That brings rules, enforced by `tsconfig.json` and ESLint:

| Rule | Why | Enforced by |
|---|---|---|
| Relative imports with the `.ts` extension | Node doesn't know the `@/` alias | ESLint, in engine and shared code |
| No `next`, `next/*` or `server-only` imports | The engine runs without Next.js | ESLint, same files |
| `import type` for type-only imports | Node strips only what is marked as a type | `verbatimModuleSyntax` |
| No enums, namespaces or constructor parameter properties | Node can only strip syntax that has no runtime effect | `erasableSyntaxOnly` |
| No `Date.now`, `performance.now` or timers in `kernel/` and `market/` | Kernel code gets time from the injected `Clock`, so a replay matches the live run exactly | ESLint |

**Shared modules.** The engine reuses the web's Dhan client, config, API, errors, rate limiter, token store, instrument download, storage, DuckDB, feed and Pulse modules. They no longer import `server-only`; the web's entry point `@/lib/dhan` still does. [shared-modules.test.ts](../src/engine/shared-modules.test.ts) loads each one under plain Node, so a stray Next-only import fails the tests.

## Testing

| Command | Covers |
|---|---|
| `npm test` | Everything |
| `npm run test:engine` | `src/engine/**/*.test.ts` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, including the engine rules |
| `npm run build` | The web still builds |

Tests use `node --test`, inject clocks and sockets, and never call Dhan. The control API tests start a real server on a random local port.

## Extending it

**A health check:** call `health.set("name", state, reason)` whenever the state may change. It appears on the Engine page and in the header tooltip with no web changes.

**A metric:** call `metrics.increment`, `gauge` or `observe` with a dotted name (`feed.frames`). It appears in the Metrics panel with no web changes.

**A status field:** add it to `EngineStatus` in [protocol.ts](../src/lib/engine/protocol.ts), fill it in `status()` in [main.ts](../src/engine/main.ts), and show it in [engine-console.tsx](../src/components/engine/engine-console.tsx).

**A telemetry topic:** add it to `TelemetryTopic` and `TelemetryData` in protocol.ts and to `BACKLOG` in [hub.ts](../src/engine/telemetry/hub.ts), publish with `telemetry.publish(topic, data)`, and subscribe in the browser with `useEngineTelemetry([...topics])`.

**An API endpoint:** add a case to [server.ts](../src/engine/api/server.ts) and, if the browser needs it, to `ALLOWED` in the proxy route.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Missing script: "engine"` | Old checkout. Pull, then `npm run engine` |
| `ENGINE_TOKEN must be set` | Add `ENGINE_TOKEN=$(openssl rand -hex 32)` to `.env.local` |
| `The engine is already running (pid N)` | One is running already (by hand or the service). `ps -p N -o cmd` to see it; stop it with Ctrl-C, `kill N` or `systemctl stop` |
| `Port 3100 is in use` | Another process holds the port: `ss -ltnp \| grep 3100` |
| Header dot grey, "Not configured" | `ENGINE_URL` or `ENGINE_TOKEN` missing from `.env.local` |
| Header dot red, "Engine offline" | The engine isn't running, or crashed. Check the terminal, `journalctl -u option-trader-engine` or the last lines of `data/engine/logs/` |
| Vercel can't reach the engine | From any machine, `curl -s -o /dev/null -w '%{http_code}' https://140.245.240.9/v1/status` should print 401. Nothing: port 443 blocked or Caddy down (`systemctl status caddy`). 502: Caddy is up but the engine isn't. 429: that address sent 10 bad tokens; wait 10 minutes and check `ENGINE_TOKEN` in Vercel |
| TLS "internal error" from the IP | `default_sni` missing from `/etc/caddy/Caddyfile` |
| `token` failing | No token in Redis or `.env.local`, or it expired. Save a new one on the Settings page; the engine picks it up within 30 seconds |
| `dhan` failing | Dhan rejected the call; the reason is on the Engine page. Usually the token |
| `journal` failing | A write failed; the reason is on the Engine page. Usually a full disk: `df -h /` |
| Nothing journaled while the market is open | Check the Dhan feed panel: the Main socket should be live with the universe's instruments. A stopped socket usually means an expired token |
| `feed` failing | A socket stopped, usually a rejected token. Save a new token on the Settings page: it reconnects within 30 seconds |
| Local `next dev` still logs `[feed ...] Main: live` | It started before `ENGINE_URL` was set, or kept a hub from before this change. Restart `next dev`; with `ENGINE_URL` set it never opens Dhan sockets |
| `data-plan` degraded or failing | Renew the Data API plan on web.dhan.co. It ends 2026-12-16 |
| `calendar` degraded | The year's holidays are missing from `config/engine/calendar.json` |
| `trading` degraded | The reason is on the Engine page and the Strategies page: a stopped day (press Resume), missing option contracts (Settings → Download option instruments), unsaved tables (check the `S3_*` settings), or no `OPENROUTER_API_KEY` |
| Strategies page says the engine doesn't report trading | The engine runs code from before trading. Restart it |
| Node warns about module type | Old checkout without `"type": "module"` in package.json |
