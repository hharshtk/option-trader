# Engine plan

Status: proposed on 2026-11-15. Steps E0 and E1 are built; see [engine.md](engine.md) for how the engine runs today. The engine now runs on the OCI VM described in [oci-setup.md](oci-setup.md), not the laptop this plan assumes. This plan turns the `engine` process from [architecture-plan.md](architecture-plan.md) into build steps, for running it on the development laptop next to the web app. It covers three things the architecture plan leaves open:

- running on a laptop instead of a VPS
- seeing everything the engine does on the web
- running the same engine on live data and on historical data

The architecture plan's direction stays:
- a separate engine process that is the only thing talking to Dhan
- a typed in-process event bus with a single writer and an injectable clock
- the raw journal as the source of truth

## Contents

1. [Assumptions](#assumptions)
2. [Running on the laptop](#running-on-the-laptop)
3. [Engine structure](#engine-structure)
4. [Monitoring on the web](#monitoring-on-the-web)
5. [Live and historical data](#live-and-historical-data)
6. [Build steps](#build-steps)
7. [Redis](#redis)
8. [Testing](#testing)
9. [Open decisions](#open-decisions)

## Assumptions

| Topic | Assumption |
|---|---|
| Where it runs | This laptop: WSL2 Ubuntu 24.04, 16 threads, 7.6 GB RAM visible to WSL, systemd enabled, Node 26.13. Web on port 3000, engine on 127.0.0.1:3100 |
| What it can do | Live data, recording, replay, backtests, shadow strategies and paper trading. Not live orders: Dhan only accepts orders from a whitelisted static IP, which a home connection usually doesn't have. Live orders wait for the hosting decision (architecture plan, open decision 2) |
| Redis | The Upstash database configured in `.env.local` is not on the engine's data path. See [Redis](#redis) |
| Without the engine | The web app works exactly as today, with its own in-process feed, whenever `ENGINE_URL` isn't set |

## Running on the laptop

```
Windows laptop
└─ WSL2 Ubuntu
   ├─ npm run dev      next dev on :3000, the operator console
   │     │  /api/engine/*, /api/market/stream, /api/market/feed:
   │     │  check the session cookie, then forward with ENGINE_TOKEN
   │     ▼
   └─ npm run engine   engine on 127.0.0.1:3100
         ├─ live run: Dhan WebSocket (at most 5 sockets) and Dhan REST (one limiter)
         ├─ replays and backtests: one child process each
         └─ data/engine/: journal, research.duckdb, logs (state.sqlite from step E7)
```

| Command | What it does |
|---|---|
| `npm run engine` | Starts the engine with `.env.local`. Use this on days you record, so edits don't restart it mid-session |
| `npm run engine:dev` | The same under `node --watch`, which restarts on every edit. Each restart reconnects to Dhan and leaves a gap in the journal |
| `npm run test:engine` | Engine unit and replay tests |

### Laptop facts that shape the design

- **Sleep and network changes.** Sleep, closing the lid or switching Wi-Fi drops the Dhan sockets. The feed code already reconnects with backoff. On top of that, the engine:
  - notices a suspend from its 1-second heartbeat timer firing late
  - writes a gap record into the journal
  - marks every quote stale and flags bars that span the gap as incomplete
  - shows each gap on the web

  On days you record, keep the laptop plugged in with sleep turned off during market hours.
- **Clock.** Receive timestamps come from the laptop's clock, and WSL2's clock can drift after the host sleeps. The engine compares its clock with the `Date` header on Dhan REST responses. That is a coarse check, because the header has 1-second resolution. It shows the offset on the web and warns above 1 second. `timedatectl` reports the clock as synchronised today.
- **One engine at a time.** The engine takes a lock file at start. A second engine would open more Dhan sockets (5 per account, shared with everything using it) and double the REST rate. With `ENGINE_URL` set, the web never opens Dhan sockets itself.
- **Token.** The access token is renewed by hand every 24 hours. The engine re-reads `DHAN_ACCESS_TOKEN` from `.env.local` with `util.parseEnv` when the file changes, so pasting a new token needs no restart. The web shows the time left on the token. Unattended renewal remains open decision 3 in the architecture plan.
- **Memory.** `next dev` shares the 7.6 GB. Backtests run one at a time by default, in a child process with a DuckDB memory cap, so a large backtest can't starve the live run.
- **Supervision.** Two terminals for now. WSL has systemd enabled, so the engine can become a service later, though that only helps while WSL itself is running.

## Engine structure

### Runs

The engine's unit of work is a **run**: one kernel (event bus, clock, market state, analytics, strategies) fed by one source.

| Run | Source | Clock | Resolution | Where it runs |
|---|---|---|---|---|
| `live` | Dhan WebSocket, journaled as frames arrive | Wall clock | Ticks, quotes, OI | Engine main process, started at boot |
| Replay | A journaled day of raw frames | Virtual, from recorded receive times | Exactly what was recorded | Child process |
| Backtest | Dhan historical candles, downloaded and cached | Virtual, from bar times | 1-minute bars | Child process |

- **One kernel.** The same kernel code runs all three; only the source and the clock differ.
- **Isolation.** A run in a child process can't slow down or crash the live run.
- **Run ids.** Everything a run emits carries its id (`live` for the live run), so the web shows a replay in the same panels as live.
- **Speed.** Replays and backtests run either as fast as possible or paced at ×1, ×10 or ×60, so a recorded session can be watched on the web as if it were live. UI work and testing can then happen in the evenings and at weekends.

### Kernel

```
Source ──► normalize ──► Kernel.dispatch(event)    synchronous, one event at a time, in seq order
                            ├─ MarketState         latest quotes, bars, session VWAP, staleness
                            ├─ analytics           architecture phases 3–4
                            ├─ strategies          shadow, then paper (phases 5–6)
                            └─ paper broker        phase 6
                         telemetry tap ──► ring buffers ──► control API ──► web
```

- **Time.** Kernel components get time only from the `Clock`. A lint rule bans `Date.now`, `setTimeout` and `setInterval` in kernel folders.
- **Order.** Dispatch is synchronous and the bus has one writer, so the input alone fixes the order of events and therefore every result.
- **The web never slows the kernel.** The telemetry tap never blocks dispatch. Each web client has a bounded queue; a client that falls behind loses its oldest messages and gets a `gap` notice. The engine never waits for the web.
- **Presentation timers stay outside.** Timers that only serve the UI, such as the 250 ms quote flush to browsers, live outside the kernel.

Key interfaces, as a sketch:

```ts
interface Clock {
  now(): number; // ms since epoch; virtual in replays and backtests
  at(time: number, fire: () => void): () => void; // returns a cancel function
}

type MarketEvent = { seq: number; recvTs: number; eventTs?: number } & (
  | { kind: "tick"; instrument: string; ltp: number; ltq?: number; volume?: number; atp?: number }
  | { kind: "quote"; instrument: string; bid: number; ask: number; bidQty: number; askQty: number }
  | { kind: "oi"; instrument: string; oi: number }
  | { kind: "prevClose"; instrument: string; prevClose: number; prevOi: number }
  | { kind: "bar"; instrument: string; interval: "1m"; start: number; open: number; high: number;
      low: number; close: number; volume?: number; oi?: number; iv?: number }
  | { kind: "gap"; reason: "reconnect" | "suspend" | "resubscribe"; from: number; to: number; connection?: number }
  | { kind: "session"; segment: string; phase: "open" | "close" }
);

interface Source {
  resolution: "tick" | "bar";
  run(emit: (event: MarketEvent) => void, clock: Clock, signal: AbortSignal): Promise<void>;
}
```

In tick runs, MarketState builds bars from ticks. In bar runs, bars come straight from the source. Each component declares the resolution it needs. A backtest that includes a component needing quotes fails at the start, with a clear message on the web, instead of producing misleading results.

### Folder layout

```
src/engine/                  engine-only code, run directly by Node: relative .ts imports, no Next.js
  main.ts                    config, lock file, live run, control API, shutdown
  kernel/                    clock, bus, events, run
  sources/                   live, journal replay, candles
  journal/                   binary writer and reader, control and gap records
  market/                    normalize, market state, bars, session calendar
  history/                   candle downloader and store
  runs/                      run manager (forks children), child entry point
  api/                       node:http server, SSE, routes, token check
  telemetry/                 logger, metrics, health
src/lib/engine/protocol.ts   types shared by engine and web: status, telemetry, commands
src/app/api/engine/[...path]/route.ts   web-to-engine proxy
src/app/(cockpit)/engine/    Engine page
config/engine/               checked in: universe, session calendar, holidays
data/engine/                 git-ignored (already under /data/): journal, research.duckdb, logs
```

The web imports only `src/lib/engine/protocol.ts`, never engine internals. The engine reuses modules from `src/lib` once step E0 frees them from Next.js.

## Monitoring on the web

Design rule: everything the engine does is reported, and the web is a viewer and a remote control. The engine runs fine with no web attached, and the web keeps working, minus the engine panels, when the engine is down.

### Control API

The control API is plain `node:http` on 127.0.0.1:3100.
- **Token.** Every request needs `Authorization: Bearer <ENGINE_TOKEN>`. The token is a random secret in `.env.local` that both processes read.
- **No direct browser access.** The browser never talks to the engine. A Next route handler checks the session cookie, adds the token, and streams the engine's response through.
- **Closing a tab releases its instruments.** The route handler passes `request.signal` to its upstream `fetch`, so when a tab closes, the engine releases that tab's instruments, as the hub does today.

| Endpoint | Purpose |
|---|---|
| `GET /v1/status` | One snapshot: version (git commit), uptime, health per component, token expiry, sockets, REST budget, clock offset, journal, active runs |
| `GET /v1/telemetry?run=live&topics=…` (SSE) | The stream of what a run is doing, by topic (below). Resumes from `Last-Event-ID` out of a ring buffer |
| `GET /v1/quotes?i=…` (SSE) | Today's `/api/market/stream` payload (`status` and `quotes` events), so [store.ts](../src/lib/live/store.ts) doesn't change |
| `GET /v1/feed` (SSE) | Today's `/api/market/feed` payload, for the Live Feed page |
| `POST /v1/feed/pin`, `/v1/feed/unpin`, `/v1/feed/connections/:id/close` | Today's Live Feed actions |
| `POST /v1/dhan/request` | The web's Dhan REST calls, sent through the engine's limiter. Read-only allowlist; never orders |
| `GET /v1/runs`, `POST /v1/runs`, `GET /v1/runs/:id`, `DELETE /v1/runs/:id` | List, start, inspect and stop replays and backtests |
| `GET /v1/journal` | Recorded days, with size and gaps |
| `GET /v1/history`, `POST /v1/history/jobs` | Downloaded candle coverage; start a download |

Telemetry topics:

| Topic | Contents | Rate |
|---|---|---|
| `status` | Health per component, counts, run progress | 1 a second |
| `log` | Structured log lines: level, component, message, fields | As they happen, rate-limited per component |
| `metrics` | Counters, gauges, latency histograms | Every 5 seconds |
| `feed` | Connections, instruments and packet counts (today's `FeedHealth`) | 1 a second |
| `bars` | Bar closes, for the instruments a page asks for | Per bar |
| `gaps` | Reconnects, suspends, stale instruments | As they happen |
| `signals`, `intents`, `orders`, `fills`, `positions` | Added with the steps that produce them | As they happen |

Every message has the shape `{ run, seq, topic, at, wall, data }`. `at` is the run's clock time, which is virtual in replays. `wall` is the engine's wall-clock time.

### Health checks

Each component reports `ok`, `degraded` or `failing`, with a reason. The header dot shows the worst state of any component.

| Component | Degraded | Failing |
|---|---|---|
| Feed | Reconnecting, or no ticks for 30 s while its segment is open | Stopped (for example by a rejected token) |
| Journal | Write latency above 1 s | Write error or disk full |
| Clock | Offset from Dhan above 1 s | Offset above 5 s |
| Token | Less than 2 hours left | Expired |
| Data plan | Less than 7 days left (currently ends 2026-12-16) | Inactive |
| REST limiter | Paused after a rate-limit warning | Repeated pauses |
| Kernel | Receive-to-processed lag p99 above 100 ms | A component throwing on every event |

The thresholds are starting points, to be tuned once real sessions are measured.

### What the web shows

| Where | What |
|---|---|
| Market header, on every page | Engine status dot: live, degraded with the reason, or offline. Offline explains how to start the engine |
| New **Engine** page: Overview | Health per component. Token time left. Sockets used of 5. REST budget per rate-limit bucket. Clock offset and detected suspends. Events per second by segment. Kernel lag (p50, p99) and Node event-loop delay. Today's journal file, size and gaps. Memory and CPU |
| Engine page: Logs | Live log tail, filtered by level, component and run |
| Engine page: Runs | Start a replay (choose a recorded day and a speed) or a backtest (date range, instruments). Progress and results. "Watch" opens the run in the same panels as live |
| Engine page: History | Downloaded candle coverage by instrument and month, plus download jobs and their progress |
| Live Feed page | Unchanged, now fed by the engine |
| Strategies, Activity | Strategy instances, signals, orders and fills, once steps E6 and E7 exist |

Metric sources:
- per-hop latency, measured from each event's `recvTs`
- `perf_hooks.monitorEventLoopDelay`
- `process.memoryUsage()` and `process.cpuUsage()`
- the rate limiter's queue and pause state, which needs a small read accessor in [rate-limit.ts](../src/lib/dhan/rate-limit.ts)

Engine logs also go to the terminal and to `data/engine/logs/<date>.jsonl`, so nothing depends on a browser being open.

### Changes on the web side

- **Settings.** `ENGINE_URL` (`http://127.0.0.1:3100`) and `ENGINE_TOKEN` go in `.env.local`. The leftover `FEED_PORT` there can go.
- **Feed routes.** With `ENGINE_URL` set, `/api/market/stream`, `/api/market/feed` and the Live Feed Server Actions forward to the engine, and `getFeedHub()` is never called, so the web opens no Dhan sockets. Without `ENGINE_URL`, they use today's in-process hub.
- **Dhan REST.** Until step E2, the web keeps calling Dhan directly, and the engine keeps its own REST use low: history downloads are capped at 2 requests a second in the `data` bucket, whose limit is 5. From E2 on, `dhanRequest` forwards to the engine's limiter whenever the engine is running, so one limiter covers the whole account. It calls Dhan directly only while the engine is down.

## Live and historical data

The engine works on both. There are two kinds of historical data, and they answer different questions.

| | Live | Journal replay | Candle backtest |
|---|---|---|---|
| Data | Every frame Dhan sends | Frames the engine recorded, or that today's app recorded with `FEED_CAPTURE=1` | Dhan `/charts/*` candles |
| Resolution | Ticks, quotes, OI, depth, by subscription mode | Whatever was recorded | 1-minute bars: OHLC, volume, OI, and IV for expired options |
| How far back | Now | The first recorded day | Years |
| Exactness | — | Identical input, so results must match the live run exactly | Approximate: no bid/ask and no trade order within a minute |
| Good for | Trading and recording | Debugging, regression tests, off-hours UI work, tick-level strategy tests | Strategy research across months, regimes and expiries |

Recorded sessions are the history that can't be bought back later, so recording should start as early as possible: with `FEED_CAPTURE=1` in today's app, then always-on in the engine from step E2.

### Journal

- **Files.** One file per IST trading day: `data/engine/journal/YYYY-MM-DD.bin`.
- **Format.** Binary, length-prefixed records. Each record holds a type, connection id, sequence number and receive time, then either the raw frame or a small JSON control record. Today's capture writes hex inside JSON, which doubles every byte.
- **Control records.** Connect, disconnect, subscribe and unsubscribe (with mode), suspend detected, clock offset, engine start and stop. A replay needs these to know what was subscribed at each moment, and where data is missing.
- **Ordering.** The main process assigns sequence numbers as frames arrive, across all connections, so each day has a single order.
- **Durability.** The file is flushed every second, so a crash loses at most a second.
- **End of day.** After each segment closes, the day's file is:
  - compressed with zstd (built into Node 26's `zlib`)
  - uploaded to R2 under `journal/`, if enabled
  - decoded into Parquet later (architecture phase 2)
- **Old captures.** An importer converts the existing `captures/feed/*.jsonl` files, so sessions recorded before the engine exists can be replayed too.
- **Size.** Measure a real day in step E2 before deciding how long to keep files locally. The disk has about 950 GB free.

### Candle history from Dhan

From Dhan's OpenAPI spec, read on 2026-11-15:

| Endpoint | What it returns | Notes |
|---|---|---|
| `POST /charts/intraday` | 1, 5, 15, 25 or 60-minute OHLC and volume, plus open interest with `oi: true`. Covers index, equity, futures and options | The spec says "current day", but the app already gets 7 days per call. Check how far back it goes and how many days one call may span |
| `POST /charts/historical` | Daily OHLC and volume since inception, optional OI. `expiryCode` selects the futures contract | |
| `POST /charts/rollingoption` | Minute bars for **expired** options, by strike relative to ATM: OHLC, IV, volume, OI, spot and the actual strike | ATM ± 10 strikes for index options near expiry, ± 3 otherwise. Weekly or monthly; expiry code 1–3; calls and puts requested separately. Each series is "ATM+k" at each minute, so it switches contracts as ATM moves |

All three count against the `data` rate-limit bucket: 5 a second and 100,000 a day. The downloader:
- runs as an engine job, visible on the Engine page, and resumes where it stopped
- caps itself at 2 requests a second, leaving room for the web's chart calls
- never downloads a range it already has
- stores candles in `data/engine/research.duckdb`, with the engine as the only writer, and exports Parquet to R2 for backup
- for expired options, stores each row under its actual expiry, strike and option type, read from the returned `strike` field. A held contract can then be followed minute by minute while it stays inside the window

Scale for tier 1: several years of 1-minute data for the NIFTY index, its 50 constituents and its futures, plus expired NIFTY weekly options at ATM ± 10. That is likely a few thousand calls, depending on how many days one call may span. That is well under the daily limit, and at most an evening or two at 2 a second.

**Point-in-time reference data.** The scrip master lists only unexpired contracts, while lot sizes, constituents and expiry calendars change over time.
- From step E2, the engine keeps each day's master under its date.
- Older periods have no master snapshot. Backtests over them use the rolling option series plus a small versioned table of lot sizes by date.

### Fills on historical data

- **Replays** fill paper orders against recorded bid and ask, exactly as live paper trading does.
- **Candle backtests** have no bid or ask. They fill at the next bar's open plus a configurable slippage, which widens for less liquid contracts, and every result is labelled as a bar-level estimate.
- **Measuring the estimate.** Running a candle backtest of a day that was also recorded, and comparing it with that day's replay, shows how far off the estimate is.

## Build steps

Each step ships on its own and leaves the app working.

| Step | Scope | Done when | Architecture phase |
|---|---|---|---|
| Now | Record sessions with today's app | A trading day captured | 0 |
| E0 | Groundwork | Shared modules run under plain Node; the web builds and behaves as before | 0 |
| E1 | Engine skeleton and monitoring | Starting or stopping the engine shows on the web within 2 seconds | 1 |
| E2 | Engine owns Dhan | A full session journaled by the engine, with the UI working as before | 1 |
| E3 | Event core and MarketState | Engine 1-minute bars match Dhan's 1-minute candles within tolerance | 1 |
| E4 | Journal replay | Replaying a recorded day reproduces its live bars exactly | 2 |
| E5 | Candle history and backtests | A backtest over downloaded NIFTY history runs and is watchable on the web | 2 |
| E6 | Analytics and shadow strategies | The same strategy runs on live, replay and backtest | 3–5 |
| E7 | Paper trading | Paper results on live and replay with clean reconciliation | 6 |

### Now: record with today's app (no code)

- Set `FEED_CAPTURE=1` in `.env.local` and restart `next dev`.
- During a session, keep the app open with NIFTY and a few constituents on the Live Feed page.
- This uses the existing ticker-mode feed and makes no extra REST calls. It settles the open feed questions (what `ltt` measures, packet 7, candle stamping), and the importer will make the day replayable later.

### E0: groundwork

- **Shared modules.** Make the modules the engine needs run under plain Node: relative `.ts` imports and no `server-only` in the shared code, with thin `server-only` wrappers kept for the web. The modules are:
  - `src/lib/dhan/` client, config, errors, rate-limit, types, api and instruments
  - [storage.ts](../src/lib/storage.ts) and [duckdb.ts](../src/lib/db/duckdb.ts)
  - [option-contracts.ts](../src/lib/dhan/option-contracts.ts) and [index-constituents.ts](../src/lib/index-constituents.ts)
- **Protocol.** `src/lib/engine/protocol.ts`, with the status, telemetry and command types.
- **Kernel basics.** Live and virtual `Clock` with tests, the `MarketEvent` types, and a logger and metrics registry.
- **Session calendar v1** in `config/engine/`: NSE F&O and index hours, and NSE's 2026 trading holidays.
- **Checks.** Typecheck, lint and `next build` still pass.

### E1: engine skeleton and monitoring

- **Process.** `src/engine/main.ts`, the `npm run engine` and `engine:dev` scripts, the lock file, and a clean shutdown on Ctrl-C that closes sockets.
- **Control API.** The token check, `/v1/status`, and `/v1/telemetry` with the `status`, `log` and `metrics` topics.
- **Dhan checks.** The engine reads `/profile` at start and every 15 minutes. That gives the data plan validity and a `Date` header for the clock offset.
- **Token watch.** The engine watches `.env.local` for a new token.
- **Web.** The `/api/engine/[...path]` proxy, the header status dot, and the Engine page's Overview and Logs tabs.
- **Without the engine,** the web behaves exactly as before.

### E2: engine owns Dhan

- **Feed hub.** The engine hosts `createFeedHub`, moved rather than rewritten. With `ENGINE_URL` set, the web's stream, feed and Live Feed actions forward to it.
- **Universe.** `config/engine/universe.json` is subscribed at start, whether or not any page is open: the NIFTY index, its 50 constituents, and the near and next NIFTY futures. Pages still add what they show, such as positions and other indices, as they do today.
- **Subscription modes.** Quote mode (17) for constituents, Full mode (21) for futures and options, and ticker mode for the index, which carries no volume. This extends [dhan-feed.ts](../src/lib/live/feed/dhan-feed.ts) and the hub to track a mode per instrument. The parser already decodes the packets.
- **Journal.** Always on, with control and gap records and suspend detection.
- **REST gateway.** `/v1/dhan/request` carries the web's read-only calls, so one limiter covers the account.
- **Reference data.** A daily scrip master snapshot, kept by date.
- **Web.** The Engine page shows journal size, frames and gaps.

### E3: event core and MarketState

- **Normalizer.** Turns packets into `MarketEvent`s with sequence numbers, and the kernel dispatches them.
- **MarketState.**
  - latest quotes
  - 1-second, 1-minute and 5-minute bars, cut at session boundaries
  - session VWAP, from the average traded price
  - staleness per instrument
- **Telemetry.** The `bars` and `gaps` topics. The Market Watch chart can draw engine bars.
- **End-of-day check.** The engine fetches Dhan's 1-minute candles for NIFTY and a few constituents and compares them with its own bars. Results go on the Engine page. This also settles whether Dhan stamps candles at the start of the interval.

### E4: journal replay

- **Replay.** The journal reader, the replay source and the virtual clock, with a run manager that forks one child per run, at the chosen speed.
- **Run storage.** The run registry and results live in `research.duckdb`.
- **Web.** The Runs tab. Watching a run uses the live panels.
- **Golden-file test.** Replaying a recorded day reproduces exactly the bars the live run built that day.

### E5: candle history and backtests

- **Dhan client.** Functions for `/charts/historical` and `/charts/rollingoption`, and OI support in `getIntradayCandles`.
- **Downloader.** The download job, with coverage tracking.
- **Backtests.** The candle source, bar-resolution runs, and the resolution check per component.
- **Web.** The History tab and backtest runs.
- **Done when** NIFTY's 1-minute history for the chosen period is downloaded, a backtest over it completes and is watchable on the web, and a candle backtest of a recorded day lines up with that day's replay.

### E6: analytics and shadow strategies

Architecture phases 3–5, for NIFTY only.
- **Analytics.** Basket analytics, futures context, local IV and Greeks, features (`trading-signals`), signals and regime.
- **Strategies** run in shadow mode, identically on live, replay and backtest.
- **Web.** Signals and features per run, and strategy instances on the Strategies page.

### E7: paper trading

Architecture phase 6.
- **Risk and OMS.** The risk engine, the OMS (each order written to SQLite before it is sent) and the paper adapter. `node:sqlite` loads without an experimental warning on this machine's Node 26.13.
- **Backtests become paper trading** on historical sources, using the fill models above.
- **Web.** Positions, orders, P&L and kill switches on the Activity and Strategies pages.

Live orders (architecture phase 7) need a static IP and the remaining live-trading decisions, so they're outside this plan.

## Redis

The Redis in `.env.local` is Upstash, used through its HTTPS REST API (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`). It isn't part of the engine's data path:

- **No benefit locally.** Web and engine run on the same machine, so a local HTTP and SSE connection is faster and has nothing extra that can go down.
- **Cost and latency.** Every Upstash command is an HTTPS round trip to Upstash's region and is billed per command. A tick stream is hundreds of thousands to millions of messages a day.
- **Determinism.** It comes from one in-process writer, and an external bus adds nothing to that. The architecture plan already rejects Kafka, Redis and NATS for the bus.

It does fit later, if the web is ever deployed somewhere other than the laptop, such as Vercel:

- **Status beacon.** The engine writes a small status record (health, last tick, positions summary) with an expiry every 10 seconds during market hours. That is about 2,250 commands per trading day. The remote web reads it, and an expired key means the engine is offline.
- **Remote kill switch.** The remote web sets a flag that the engine polls. It is the only command worth accepting from outside the laptop, and only once paper or live trading exists.

Neither is needed while web and engine run side by side.

## Testing

- **Unit tests** run with `node --test`, as the feed tests do today: injectable sockets, a virtual clock, no network.
- **Replay golden files.** A recorded day, or a trimmed fixture of one, replayed through the kernel must produce identical bars after every change.
- **No test calls Dhan.** Live checks use at most one call, through the limiter.

## Open decisions

1. **Engine port and token:** 3100 and a random `ENGINE_TOKEN` (recommended).
2. **Tier 1 universe at start:** NIFTY index, 50 constituents, near and next futures, with the option window added in E6. Confirm or change.
3. **Journal backup:** compressed days uploaded to R2 (recommended: cheap, and off the laptop), or local only.
4. **NIFTY history range:** how many years to download first.
5. **Live-orders host:** unchanged from the architecture plan (open decision 2 there). The laptop covers everything up to paper trading.
