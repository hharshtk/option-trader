# Engine

The engine is a long-running Node process that will own everything that talks to Dhan: market data, the journal, analytics, strategies and orders. The web app is its operator console. Everything the engine does is reported to the web.

This document describes what is built. For what comes next, see [engine-plan.md](engine-plan.md). Last updated 2026-11-15.

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
11. [Session calendar](#session-calendar)
12. [Code layout and rules](#code-layout-and-rules)
13. [Testing](#testing)
14. [Extending it](#extending-it)
15. [Troubleshooting](#troubleshooting)

## Status

| Step | State | What it gives |
|---|---|---|
| E0 Groundwork | Built | Shared modules run under plain Node; clock, event types, logger, metrics, session calendar |
| E1 Skeleton and monitoring | Built | `npm run engine`, control API, health checks, Engine page, header status dot |
| E2 Engine owns Dhan | In progress | Done: the live feed runs in the engine and the web forwards to it. Next: always-on journal, universe, Quote/Full modes, one REST limiter |
| E3–E7 | Planned | See [engine-plan.md](engine-plan.md#build-steps) |

Today the engine monitors itself and the Dhan account and **owns the live Dhan feed**. With `ENGINE_URL` set, the web never opens Dhan sockets: its quote stream, Live Feed stream and Live Feed actions forward to the engine. Without `ENGINE_URL`, the web runs its own feed as it did before the engine. The engine doesn't place orders.

**Host:** the OCI VM `option-trading-e5` (Ubuntu 24.04, Node 26.13). See [oci-setup.md](oci-setup.md).

## Running it

| Command | What it does |
|---|---|
| `npm run engine` | Starts the engine with `.env.local`. Use this on days you record |
| `npm run engine:dev` | The same under `node --watch`: restarts on every edit |
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
| `ENGINE_DATA_DIR` | `data/engine` | Lock file and logs. Git-ignored |
| `ENGINE_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `DHAN_CLIENT_ID` | none | Dhan account |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | none | Where the access token saved on the Settings page lives |
| `DHAN_ACCESS_TOKEN` | none | Fallback token when Redis has none |

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
| Dhan feed | Sockets used of 5, each socket's state (with the reason when stopped or reconnecting), instruments, frames and last tick; open tabs, pinned instruments, and whether raw frames are being recorded |
| Dhan account | Token source (Redis or `.env.local`) and expiry, Data API plan and its end date, active segments, last profile check, clock offset from Dhan |
| Market sessions | Each segment: open, pre-open or closed, today's holiday, the next session in IST |
| Process | Git version, host, pid, Node version, start time, memory, CPU, event-loop delay p99 |
| Metrics | Every counter, gauge and latency histogram the engine records |

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

- **The browser never talks to the engine.** The route [src/app/api/engine/[...path]/route.ts](../src/app/api/engine/[...path]/route.ts) checks the session cookie, adds the token and streams the response through. It allows only `v1/status`, `v1/logs` and `v1/telemetry`. Closing the tab aborts the upstream request.
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
| `feed` | A socket is reconnecting | A socket stopped (for example a rejected token); it reconnects on its own once a new token is saved | Every second |
| `api` | — | — | Ok once the control API listens |
| `token` | Less than 2 hours left, or expiry unreadable | Missing or expired | Every second |
| `dhan` | Network error reaching Dhan | Dhan rejected the profile call (for example a bad token) | At start, then every 15 minutes |
| `data-plan` | Less than 7 days left | Not active | With the profile check |
| `clock` | Offset from Dhan above 1 s | Offset above 5 s | After every Dhan REST call |
| `calendar` | No holiday list for the current year | — | At start |

**Clock offset.** Every Dhan REST response carries a `Date` header with 1-second resolution. [client.ts](../src/lib/dhan/client.ts) turns it into an offset estimate with an uncertainty (about ±500 ms plus half the round trip) and keeps the tighter of recent samples. The clock check only flags what lies beyond that uncertainty, so a ±540 ms reading never raises a false alarm. The VM's clock is NTP-synchronised; typical offsets are under 100 ms.

## Control API

Plain HTTP on `127.0.0.1:3100`. Every request needs `Authorization: Bearer <ENGINE_TOKEN>`; anything else gets 401. Only `GET`.

| Endpoint | Returns |
|---|---|
| `GET /v1/status` | One `EngineStatus` snapshot (below) |
| `GET /v1/logs?level=&component=&limit=` | `{ entries: LogEntry[] }`, newest last. `limit` defaults to 500, at most 2,000 |
| `GET /v1/telemetry?topics=status,log,metrics,feed&since=` | Server-sent events (below) |
| `GET /v1/quotes?i=IDX_I:13,NSE_EQ:1333` | Server-sent quotes for up to 200 instruments, the same events the web's `/api/market/stream` always sent. Subscribes them on Dhan; disconnecting releases them after a 30-second grace period |
| `GET /v1/feed` | Server-sent Live Feed monitor: a `snapshot`, then `health` every second and `events` |
| `POST /v1/feed/pin` | `{ key, connection: number \| "new", name?, connectionName? }`: keep an instrument subscribed |
| `POST /v1/feed/unpin` | `{ key }` |
| `POST /v1/feed/connections/:id/close` | Close a socket other than Main |

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
| `process` | `rssBytes`, `heapUsedBytes`, `cpuPercent`, `eventLoopDelayP99Ms` |

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
  telemetry/              logger, log file, metrics, health, telemetry hub, process stats, ring buffer
src/lib/engine/protocol.ts    types shared by engine and web (the web imports only this)
src/lib/engine/web.ts         web side: reads ENGINE_URL and ENGINE_TOKEN
src/app/api/engine/[...path]/ web-to-engine proxy
src/app/(cockpit)/engine/     Engine page
src/components/engine/        header dot, Engine page, telemetry hook
config/engine/                checked-in configuration
deploy/                       systemd unit
data/engine/                  runtime files, git-ignored: lock, logs
```

The engine runs TypeScript directly with Node's type stripping: no build step. That brings rules, enforced by `tsconfig.json` and ESLint:

| Rule | Why | Enforced by |
|---|---|---|
| Relative imports with the `.ts` extension | Node doesn't know the `@/` alias | ESLint, in engine and shared code |
| No `next`, `next/*` or `server-only` imports | The engine runs without Next.js | ESLint, same files |
| `import type` for type-only imports | Node strips only what is marked as a type | `verbatimModuleSyntax` |
| No enums, namespaces or constructor parameter properties | Node can only strip syntax that has no runtime effect | `erasableSyntaxOnly` |
| No `Date.now`, `performance.now` or timers in `kernel/` and `market/` | Kernel code gets time from the injected `Clock`, so a replay matches the live run exactly | ESLint |

**Shared modules.** The engine reuses the web's Dhan client, config, API, errors, rate limiter, token store, storage, DuckDB and feed modules. They no longer import `server-only`; the web's entry point `@/lib/dhan` still does. [shared-modules.test.ts](../src/engine/shared-modules.test.ts) loads each one under plain Node, so a stray Next-only import fails the tests.

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
| `feed` failing | A socket stopped, usually a rejected token. Save a new token on the Settings page: it reconnects within 30 seconds |
| Local `next dev` still logs `[feed ...] Main: live` | It started before `ENGINE_URL` was set, or kept a hub from before this change. Restart `next dev`; with `ENGINE_URL` set it never opens Dhan sockets |
| `data-plan` degraded or failing | Renew the Data API plan on web.dhan.co. It ends 2026-12-16 |
| `calendar` degraded | The year's holidays are missing from `config/engine/calendar.json` |
| Node warns about module type | Old checkout without `"type": "module"` in package.json |
