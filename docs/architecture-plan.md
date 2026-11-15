# Architecture plan: event-driven derivatives trading platform

Status: proposed on 2026-11-15. Nothing in this document is built yet. It describes how the app should grow from today's cockpit into an event-driven quantitative trading platform for Indian derivatives: futures and options on indices, stocks, commodities and currencies, across every segment Dhan offers. It also sets the order to build it in. Everything that works today stays, and each phase ships without changing what already works.

The platform is generic over underlyings from the start: no component is written for one index. Coverage is rolled out in tiers, though. NIFTY 50 options come first as the reference underlying, then other indices, stock F&O, commodities and currency (see [Coverage tiers](#coverage-tiers)).

## Contents

1. [What exists today](#what-exists-today)
2. [Gaps and risks](#gaps-and-risks)
3. [Target architecture](#target-architecture)
4. [Instrument and underlying model](#instrument-and-underlying-model)
5. [Components](#components)
6. [Event contracts](#event-contracts)
7. [Technology choices](#technology-choices)
8. [Phases](#phases)
9. [Coverage tiers](#coverage-tiers)
10. [Engineering decisions](#engineering-decisions)
11. [Open decisions](#open-decisions)

## What exists today

| Area | Current state | Role in the target architecture |
|---|---|---|
| Dhan REST | Read-only client: profile, funds, positions, holdings, orders, LTP, option chain and expiries, intraday candles. One sliding-window limiter per Dhan rate-limit category, a response cache, and a common error shape. See [client.ts](../src/lib/dhan/client.ts), [rate-limit.ts](../src/lib/dhan/rate-limit.ts), [api.ts](../src/lib/dhan/api.ts) | Becomes the engine's broker gateway, unchanged |
| Live feed | Binary parser with tests that already knows every Dhan segment: NSE and BSE equity and F&O, MCX, and currency ([packets.ts](../src/lib/live/feed/packets.ts)). Socket handling with backoff, the 805 pause, stop on a rejected token, and an injectable socket ([dhan-feed.ts](../src/lib/live/feed/dhan-feed.ts)). Hub for up to 5 connections with SSE out to browsers ([feed-hub.ts](../src/lib/live/feed/feed-hub.ts)). Details in [realtime-market-data.md](realtime-market-data.md) | Becomes the engine's market-data ingest. Moved, not rewritten |
| Raw capture | `FEED_CAPTURE=1` appends each frame as hex with its receive time to `captures/feed/<date>.jsonl` | The start of the immutable event archive |
| Instruments | Settings downloads Dhan's detailed scrip master daily, keeps unexpired NSE and BSE index and stock options (`OPTIDX`, `OPTSTK`), and stores Parquet on R2 or local disk. DuckDB answers lookups ([option-scrips.ts](../src/lib/dhan/option-scrips.ts), [option-contracts.ts](../src/lib/dhan/option-contracts.ts), [option-lookup.ts](../src/lib/dhan/option-lookup.ts)) | Grows into the instrument master for every derivative class |
| Indices | Six indices hard-coded: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, BANKEX ([instruments.ts](../src/lib/dhan/instruments.ts), [cockpit.ts](../src/lib/cockpit.ts)) | Seed entries for the underlying registry |
| Constituents | Static constituent snapshots for all six indices, with Dhan security IDs and Dhan's market-cap share ([index-constituents.ts](../src/lib/index-constituents.ts)) | Basket data for index underlyings, but the weights must be replaced (see gaps) |
| Storage | File store on S3-compatible storage (R2) or `DATA_DIR` ([storage.ts](../src/lib/storage.ts)). In-memory DuckDB per process ([duckdb.ts](../src/lib/db/duckdb.ts)) | Archive and research storage |
| UI and auth | Next.js 16 cockpit. Single-user HMAC session cookie checked in [proxy.ts](../src/proxy.ts). Strategies and Activity pages are placeholders | Stays the operator console |

The feed modules already avoid Next.js APIs: they take their dependencies as arguments, import each other with relative `.ts` paths, and run under `node --test`. Only [hub.ts](../src/lib/live/feed/hub.ts) ties them to Next. That makes a separate engine process a move, not a rewrite.

## Gaps and risks

Ordered by how much they block the target architecture.

1. **Where the code runs.** The feed runs inside the Next server. Dev hot reload needs the `HUB_REVISION` workaround to avoid duplicate sockets, and the production host is serverless, where the feed can't run at all. Strategies and order management can't live there either.
2. **No order path and no static IP.** Order placement isn't built. SEBI requires order APIs to come from a whitelisted static IP, which isn't set up.
3. **Index-shaped code.** "Underlying" means one of six hard-coded indices (`IndexKey`, `INDEX`). The scrip download keeps NSE and BSE options only, with no futures, no MCX and no currency. Live candles assume NSE equity hours (09:15–15:30 IST). There is no general model of an underlying, its derivatives, or its trading session.
4. **Ticker mode only.** The feed subscribes with request code 15, which delivers LTP and previous close. There is no volume, average traded price (VWAP), OI or bid/ask. Relative volume, VWAP deviation, liquidity scoring and paper fills all need Quote mode (17) or Full mode (21). The parser already decodes those packets (codes 4, 5 and 8).
5. **Subscriptions follow browser tabs.** An instrument is subscribed because an open page shows it. An engine needs a universe that streams whether anyone is watching or not. Across many underlyings, it also needs a budget: Dhan allows 5 sockets of 5,000 instruments each per account.
6. **No normalized events, sequence numbers or clock abstraction.** Packets update a quote map directly, and timing uses `Date.now()` and `setInterval` throughout. A replayed day can't produce the same results as the live day.
7. **Unconfirmed timing facts.** What `ltt` measures, the layout of packet 7 (market status), and whether Dhan stamps candles at interval start are all still open (see [realtime-market-data.md](realtime-market-data.md#open-questions)). They need checking per segment, because MCX and currency may behave differently from NSE. Bar building and latency measurement depend on them.
8. **Wrong constituent weights for this use.** Dhan's market-cap share isn't the exchange's free-float weight, so weighted contribution would be biased for every index. Constituent lists also change at each index rebalance, and the snapshots are static.
9. **REST option chain doesn't scale across underlyings.** Dhan's option chain is limited to one call per 3 seconds for the whole account. Spread across dozens of underlyings, each chain would refresh only every few minutes. Live options analytics can't rely on it.
10. **No durable trading state.** Nothing persists orders, fills, positions, strategy state or signals. A crash mid-session loses all of it, and there is nothing to rebuild from.
11. **Shared account limits.** The 5-socket limit is shared by everything using the account: dev server, production and a future engine. Two processes with separate REST limiters could together breach the REST limits, and the account has already had one 805 warning. Only one process should talk to Dhan.
12. **Segment-specific contract rules.** Settlement differs by class and is easy to get wrong:
    - Stock F&O settles by physical delivery, so an in-the-money stock option held to expiry turns into a delivery obligation.
    - MCX options on futures turn into futures positions at expiry (confirm per contract).
    - Lot sizes, freeze quantities and expiry calendars differ per contract and are revised by the exchanges.
13. **Dated dependencies and account setup.**
    - The access token is self-generated, valid 24 hours and renewed by hand, which doesn't work for an unattended process.
    - The Data API plan, which the streaming modes depend on, expires 2026-12-16.
    - Trading commodities or currency needs those segments activated on the Dhan account, and it hasn't been checked whether the data plan covers their feeds.

## Target architecture

Two processes on one host, not microservices.

- **`engine`**: a long-running Node.js/TypeScript process. It holds all market data processing, analytics, strategies, risk and order management, and it is the only process that talks to Dhan, over both WebSocket and REST.
- **`web`**: the existing Next.js app, reduced to the operator console. It reads from the engine through a local HTTP/SSE API. The current `/api/market/stream` route becomes a thin proxy to the engine, so existing UI components keep working.

Both run on a VPS in Mumbai with a static IP, managed by systemd. The static IP satisfies the order-API rule, the long-running process can hold sockets, and Mumbai keeps latency to Dhan low.

For now, both run on the development laptop (decided 2026-11-15). That covers everything up to paper trading; live orders still need the static IP. [engine-plan.md](engine-plan.md) has the build steps for the engine on the laptop, including web monitoring and running on historical data.

### Data flow

```
Instrument master (daily) ──► Underlying registry ──► Universe manager (subscription budget)
                                                          │ subscribe / unsubscribe
Dhan WebSocket (Quote / Full, all segments)               ▼
   │                                          Dhan REST (one limiter, one owner)
   ▼                                                      ▲
[Ingest] ── raw frame + recvTs + seq ──► [Journal: append-only, one file per day] ──► Parquet on R2
   │  parse + normalize
   ▼
MarketEvent bus
(in-process, typed, synchronous, single writer, injectable Clock, session calendar)
   │
   ├─► MarketState: latest quote per instrument, bars and VWAP per segment session
   │      ├─► Underlying intelligence, per underlying ──► UnderlyingSnapshot
   │      │     (basket analytics for indices; peers and sector for stocks;
   │      │      term structure and OI for futures, commodities, currency)
   │      ├─► Derivatives intelligence, per underlying ──► DerivativesSnapshot
   │      │     (futures basis, IV surface, Greeks, liquidity, contract selection)
   │      └─► Feature Engine: incremental, multi-timeframe, keyed by underlying ──► FeatureVector
   │               └─► Signal generators ──► composite score + regime
   ▼
Strategy Runtime (strategy version × underlyings × params) ──► TradeIntent
   ▼
Risk Engine: sizing, portfolio Greeks, per-segment limits, settlement guard ──► OrderRequest
   ▼
OMS: order state machine, written to SQLite before sending ──► Execution adapter: Paper | Dhan
   ▲                                                                  │
   └──────────────── order updates / fills ◄──────────────────────────┘

Reconciler: compares OMS state with Dhan /orders and /positions
Metrics and health ──► web console, alerts
```

Market data processing never depends on strategy execution. A slow or failing strategy can't delay ingest or state updates, and strategies only see events after state has been updated.

## Instrument and underlying model

This model is what makes the platform generic. Everything downstream is keyed by underlying and instrument, never by a hard-coded index.

### Instrument master

The daily scrip download grows from options-only to every derivative row on the target segments. Each class is only enabled once its coverage tier starts:

| Class | Dhan `INSTRUMENT` values | Exchanges |
|---|---|---|
| Index futures and options | `FUTIDX`, `OPTIDX` | NSE, BSE |
| Stock futures and options | `FUTSTK`, `OPTSTK` | NSE, BSE |
| Commodity futures and options | `FUTCOM`, `OPTFUT` | MCX (and NSE commodity, if used) |
| Currency futures and options | `FUTCUR`, `OPTCUR` | NSE, BSE |

Check the exact `INSTRUMENT` values against the master before relying on them.

For each contract, the master stores:
- security id and segment, which together form the instrument id `SEGMENT:SECURITY_ID`, the same as today's `instrumentKey`
- underlying
- expiry
- strike and option type
- lot size, tick size and freeze quantity
- price bands
- settlement type

It stays Parquet on R2 with DuckDB lookups, as today.

### Underlying registry

Each tradable underlying has one entry:

| Field | Examples |
|---|---|
| Kind | index, stock, commodity, currency pair |
| Reference price source | `IDX_I` index feed. `NSE_EQ` cash price. For MCX, the near-month future, since there is no spot feed |
| Forward source | Futures curve. Options derive a synthetic forward from put-call parity when futures are thin |
| Derivatives | Futures expiries, option expiries and strikes, all from the instrument master |
| Basket | Constituents and free-float weights, for indices only |
| Session | Segment calendar: trading hours, holidays, special sessions |
| Contract rules | Settlement (cash, physical delivery, or devolving into futures), expiry-day rules |
| Analytics profile | Which intelligence modules apply. Basket analytics only makes sense for indices |

The registry is built from the instrument master plus a small, versioned configuration file. That file holds what the master lacks: index constituents and weights, session calendars, and which underlyings are enabled. The six indices in [instruments.ts](../src/lib/dhan/instruments.ts) become its first entries.

Note: when matching option rows to indices, use `UNDERLYING_SYMBOL`, not `UNDERLYING_SECURITY_ID`. Index option rows carry their own underlying ids; NIFTY options, for example, carry 26000, not the index feed id 13.

### Session calendar

Segments trade different hours. NSE and BSE equity derivatives keep equity hours. Currency derivatives have their own hours. MCX trades into the evening, with closing times that vary by commodity and season. Holidays differ by exchange, and special sessions happen.

A session calendar, loaded from exchange data per segment, drives:
- bar boundaries and the daily VWAP reset
- market-hours checks in the risk engine
- gap detection
- each segment's end-of-day archive cut

Nothing hard-codes 09:15–15:30.

## Components

### Market data infrastructure

- **Universe manager.** Decides what is subscribed, within Dhan's limits of 5 sockets × 5,000 instruments.
  - Each enabled underlying asks for a set of instruments with a priority:
    - its reference price
    - near and next futures
    - basket constituents (indices only)
    - an option window of ATM ± N strikes for chosen expiries
  - The manager packs these onto sockets by priority. When the budget runs out, it drops the lowest-priority option strikes first and reports what it dropped.
  - Option windows re-centre as the underlying moves, with hysteresis so small moves don't churn subscriptions.
  - Browser tabs become consumers only; they no longer decide what is subscribed.
- **Sizing example.** Six indices with ATM ± 15 strikes on two expiries come to about 720 option contracts. Roughly 200 stock F&O underlyings with ATM ± 5 strikes on one expiry come to about 4,000, plus about 400 for cash prices and futures. Both fit in two sockets, which leaves headroom for commodities and currency. Measure real tick rates in tier 1 before committing to a budget.
- **Modes.** Reference prices and constituents use Quote mode. Futures and option contracts use Full mode, for bid/ask and OI.
- **Journal.** Every frame is appended before parsing, with receive time, connection id and a sequence number. Journaling is always on in the engine, not opt-in.
- **Normalization.** The parser's packets become `MarketEvent`s with the instrument id, underlying id, `recvTs`, and `eventTs` once `ltt` is understood for that segment.
- **MarketState.** Latest quote per instrument, bars at 1 second, 1 minute and 5 minutes, and VWAP reset per segment session.
- **Gap detection.** An instrument that goes quiet for longer than a threshold during its own segment's session is marked stale, and stale data is visible to every consumer.

### Underlying intelligence

Which modules run depends on the underlying's analytics profile.

**Basket analytics**, for every index with constituent data: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, BANKEX, and later others.

Per constituent:
- return since previous close
- VWAP deviation, from Dhan's average traded price
- momentum over 1, 5 and 15 minutes
- realized volatility from 1-minute bars
- relative volume against a time-of-day volume profile, backfilled once a day from `/charts/intraday` within the `data` rate-limit bucket

Across the basket:
- weighted contribution: free-float weight × return, expressed in index points
- advance/decline, both equal-weighted and weighted
- share of constituents above VWAP
- dispersion, and synchronization: the share of constituents moving with the index, and rolling correlation with it

Constituents shared between indices (HDFCBANK is in NIFTY, BANKNIFTY and FINNIFTY) are subscribed and computed once, then reused by every basket that contains them.

**Stock context**, for stock F&O underlyings: the stock's own momentum, VWAP deviation, relative volume and volatility, plus relative strength against its sector and against the indices it belongs to. Index membership comes from the basket data.

**Futures context**, for every underlying with futures: basis and annualized carry against the reference price, calendar spreads between expiries, OI change, and the price-OI combination (long build-up, short covering and so on). For commodities and currency, this is the main context, because they have no basket.

Each underlying gets one `UnderlyingSnapshot` per bar close.

### Derivatives intelligence

All per underlying, independent of directional signals.

- **Local IV and Greeks.** Computed with Black-76 from streamed bid/ask, using the forward from the futures curve, or a synthetic forward from put-call parity when futures are thin. The same model covers index, stock, commodity and currency options, and it needs no assumed dividend yield or risk-free rate.
- **REST chain as a scheduled cross-check.** A scheduler rotates the account's one-call-per-3-seconds option chain budget across enabled underlyings, weighted by priority. The chain calibrates and checks local IV; it isn't the live source.
- **Volatility surface.** IV by strike and expiry: ATM IV, skew, term structure, and IV rank against history from the archive.
- **Liquidity score.** Built from spread as a percentage of mid, top-of-book quantity, OI and volume. Stock and commodity options are often far less liquid than index options, so this score gates contract selection.
- **Contract selector.** Takes underlying, direction, instrument preference (future or option), target delta, days to expiry and maximum spread, and returns contracts.
- **Contract facts.** Lot size, freeze quantity, price bands, settlement type and the expiry calendar come from the instrument master. Expiry calendars differ by underlying and change by regulation, so they are always read from the master, never assumed.

### Feature and signal engine

- **Features update incrementally.** Each event updates the affected features; nothing is recomputed from scratch. Features are keyed by underlying and timeframe and driven by bar-close events from the session calendar.
- **Indicators.** The npm `trading-signals` library fits here: it has streaming `add()` and `replace()`. Its VWAP has no session reset, so each session needs a new instance.
- **Volume for indices.** Index feeds carry no volume, so volume features for index underlyings come from their futures.
- **Signal generators.** Each one is a pure function of features. It emits a score and a confidence, and generators don't depend on each other. A generator declares which underlying kinds it applies to. A basket-breadth signal, for example, only applies to indices.
- **Composite and regime.** A composite scorer and a regime classifier (for example trend or range, crossed with high or low volatility) run per underlying.
- **Signal journal.** Every signal is recorded for later evaluation.

### Strategy runtime

- **Interface.** A strategy is `{ id, version, paramsSchema, supports, init(ctx), onEvent(event) → TradeIntent[] }`. `supports` declares the underlying kinds and instrument classes it can trade.
- **Instances.** A running instance is a strategy version × a set of underlyings × parameters. The same strategy can run on NIFTY and BANKNIFTY with different parameters, and each instance keeps its own state.
- **Isolation.** State is snapshotted to SQLite so it survives a restart. One instance's error can't affect another's.
- **Versioning.** The code version plus a hash of the parameters identifies a configuration. Every intent and order records it, which is what attribution relies on.
- **Modes.**
  - **Shadow** records intents only.
  - **Paper** sends them through risk and the OMS to the paper adapter.
  - **Live** sends them to Dhan.
- **Controls.** Each instance has its own capital allocation and kill switch, and each underlying and segment has a kill switch too.

### Risk and execution

Strategies decide what they want; they never place orders.

- **Risk engine.** Owns position sizing and runs pre-trade checks:
  - daily loss limits per account, strategy instance, underlying and segment
  - maximum lots and notional exposure per underlying
  - portfolio Greeks: delta in underlying-equivalent terms, plus gamma, vega and theta, with limits per underlying and in total
  - order slicing at each contract's freeze quantity
  - price bands and tick size
  - margin, including across segments
  - the segment's own market hours
  - duplicate intents
  - stale data: no new orders on an underlying while its data is stale or its socket isn't live
- **Settlement guard.** Closes or blocks positions that would settle in a way the account isn't set up for: physical delivery on stock F&O, futures devolvement on MCX options. Each contract's rule comes from the registry and acts before expiry day.
- **Post-trade risk.** Mark-to-market stops, and squaring off before the broker's auto square-off time for each segment.
- **OMS.** An order state machine: pending, sent, open, partly filled, then filled, cancelled or rejected. Each order is written to SQLite with a correlation id before it is sent, so a restart can rebuild state from Dhan's records.
- **Execution adapters.** Paper and live share risk and the OMS; only the adapter differs.
  - The paper adapter fills against live bid/ask with a slippage and latency model. Less liquid contracts get wider slippage.
  - The Dhan adapter places, modifies and cancels orders through the existing client and its `order` rate-limit bucket.
- **Order updates.** They come from Dhan's order-update WebSocket, with low-rate REST polling as a fallback.
- **Reconciler.** Compares OMS state with Dhan's orders and positions on start-up and periodically, across all segments, and flags any difference.
- **Last line of defence.** Dhan's broker-side kill switch.

### Data and research

Storage is layered:

| Layer | Contents | Storage |
|---|---|---|
| Raw | Frames exactly as received, with receive time and sequence number | Local journal during the day, Parquet on R2 after each segment's close |
| Reference | Instrument master and registry configuration, versioned by date | Parquet and JSON on R2 |
| Decoded | Normalized market events and bars, partitioned by date and segment | Parquet on R2 |
| Derived | Features, signals, intents, partitioned by date and underlying | Parquet on R2 |
| Operational | Orders, fills, positions, strategy state, configuration versions | SQLite |

- **The raw journal is the source of truth.** If the parser changes, a day can be decoded again from raw frames.
- **Point-in-time reference data.** Replay uses the instrument master and registry as they were on that day. Lot sizes, constituents and expiries all change over time.
- **Replay.** A CLI reads one day's journal, for all segments or only some, and runs it through the same engine with a virtual clock and the paper adapter. Golden-file tests compare its output across code changes.
- **Research.** DuckDB queries the Parquet archive:
  - forward-return information coefficient (IC) and hit rate per signal, split by underlying kind and regime
  - slippage, as decision price versus fill price, per instrument class
  - P&L attributed by strategy instance, configuration version, underlying, signal and regime

### Observability

This extends the existing feed monitor ([monitor.ts](../src/lib/live/feed/monitor.ts)) and the Live Feed page.

- **Feed health:** per connection and per segment, including tick rate, stale instruments and parse errors.
- **Subscription budget:** use per socket, and what the universe manager dropped.
- **Latency histograms per hop:** receive → state → signal → intent → order sent → acknowledged.
- **Strategy health per instance:** last event processed, errors, current mode.
- **Positions:** orders, portfolio Greeks and live P&L, broken down by underlying and segment.

These go on the placeholder Activity and Strategies pages. Critical states (feed stopped, reconciliation mismatch, loss limit hit, a settlement guard about to act) also send push alerts.

## Event contracts

Subsystems talk only through typed events. Each layer sees events from the layer above it and nothing else.

| Event | Producer | Consumers |
|---|---|---|
| `MarketEvent` (tick, quote, OI, previous close, depth) | Ingest | MarketState, journal |
| `SessionEvent` (open, close, special session) | Session calendar | Every stateful component |
| `Bar` | MarketState | Underlying and derivatives intelligence, features |
| `UnderlyingSnapshot` | Underlying intelligence | Features, strategies, UI |
| `DerivativesSnapshot` | Derivatives intelligence | Strategies, contract selector, UI |
| `FeatureVector` | Feature engine | Signal generators |
| `Signal` | Signal generators, composite scorer | Strategies, signal journal |
| `TradeIntent` | Strategy instances | Risk engine |
| `OrderRequest` | Risk engine | OMS |
| `OrderUpdate`, `Fill` | Execution adapter | OMS, positions |
| `PositionSnapshot` (with Greeks) | OMS, reconciler | Risk engine, strategies, UI |

Every event carries `seq`, `recvTs`, `eventTs`, its source and, where it applies, the instrument id and underlying id. Intents, orders and fills also carry the strategy instance, version and configuration hash.

## Technology choices

| Choice | Why | Not chosen for now |
|---|---|---|
| Node.js 26 and TypeScript, run directly with native type stripping | The tests already run this way. The engine needs no build step, and the existing feed code moves as it is | Rust or Go: no latency requirement yet that Node can't meet at this scale |
| In-process synchronous event bus with a single-writer core | Events are processed in a fixed order, which makes replay deterministic, and it's simple | Kafka, Redis, NATS: built for many hosts and many writers. Here there is one host and one writer, so they add operations work and no benefit |
| `worker_threads` for derivatives analytics, sharded by underlying, only if profiling shows the need | Thousands of option contracts in stock F&O can make IV and Greeks the CPU hot spot. Sharding by underlying keeps each shard deterministic. Throttling recomputes to bar or quote-change cadence comes first | Separate services per underlying |
| SQLite in WAL mode for operational state | Embedded, transactional and crash-safe, with no server to run. Use `node:sqlite` if it is stable on Node 26, otherwise `better-sqlite3` | Postgres: a server to operate for a single writer |
| DuckDB, Parquet and R2 for the archive, reference data and research | All three are already in use. Columnar files, partitioned by date and segment, suit replay and research queries | A time-series database: not needed at this volume |
| Mumbai VPS with a static IP, managed by systemd | The static IP is required for order APIs, the process must run continuously (including MCX evening hours), and the host is close to Dhan | Vercel for the engine: serverless functions can't hold sockets |
| Small in-house options-math module (Black-76, IV solver) | One model covers index, stock, commodity and currency options on forwards. It is small and easy to test | — |
| `trading-signals` for indicators | Streaming API, no runtime dependencies, evaluated on 2026-11-15 | Hand-written indicators, except where the library doesn't fit |

## Phases

Phases build the pipeline. Each one ships on its own, leaves existing behaviour intact, and is built generically but validated first on NIFTY, the tier 1 reference underlying. Coverage tiers (next section) then widen it. Observability is built up in every phase rather than at the end.

| # | Phase | Scope | Done when |
|---|---|---|---|
| 0 | Foundations | Event contracts and the Clock interface. Instrument master extended to futures. Underlying registry and session calendar, seeded with the six indices. Make modules the engine will use free of Next.js (`server-only`, `@/` imports). One live session with capture on to settle `ltt`, packet 7 and candle stamping. Decide hosting and token renewal | Contracts reviewed. Open feed questions answered for NSE |
| 1 | Engine and market data | Engine process hosting the existing hub. Universe manager with budget and priorities. Quote and Full mode. Always-on journal with sequence numbers. MarketState, bars, session VWAP. The web app proxies to the engine and no longer opens Dhan sockets | A full session journaled, and the UI works as before |
| 2 | Replay and archive | End-of-day Parquet export per segment to R2, with point-in-time reference data. Replay CLI with a virtual clock. Golden-file regression tests | Replaying a recorded day reproduces its bars exactly |
| 3 | Underlying intelligence | Free-float weights, volume-profile backfill, basket analytics, futures context, UI panels | Summed contributions match the index move within tolerance |
| 4 | Derivatives intelligence | Option windows, local IV and Greeks, REST chain scheduler and cross-check, volatility surface, liquidity score, contract selector, live option chain in the UI | Local IV within tolerance of Dhan's |
| 5 | Features, signals, regime | Incremental features, signal generators, composite score, regime classifier, signal journal, evaluation reports. Strategies run in **shadow** mode | IC and hit-rate reports exist for every signal |
| 6 | Strategy runtime, risk and OMS on **paper** | Strategy instances, risk engine with portfolio Greeks and settlement guard, OMS, paper adapter, attribution | Several weeks of paper trading with clean reconciliation |
| 7 | Live execution | Static IP whitelisted, Dhan order adapter, order-update WebSocket, reconciler, kill switches, unattended token renewal. Start with one lot, one strategy and one underlying | Live and paper results agree on the same signals |

Replay (phase 2) comes before any analytics on purpose: every later phase is validated by replaying recorded sessions.

## Coverage tiers

A tier adds underlyings to an existing pipeline. It is mostly configuration, reference data and validation, not new architecture. A tier can start once phase 3 is done for the previous tier. Each tier goes through shadow and paper trading before live.

| Tier | Underlyings | What it adds | Prerequisites |
|---|---|---|---|
| 1 | NIFTY 50 index futures and options | The reference implementation of every phase | — |
| 2 | BANKNIFTY, FINNIFTY, MIDCPNIFTY (NSE), SENSEX, BANKEX (BSE) | More baskets with shared constituents. BSE F&O segment. Different expiry calendars | Free-float weights for each index |
| 3 | Stock F&O on NSE (roughly 200 underlyings) | Stock context, the physical-delivery settlement guard, liquidity gating, a much larger subscription budget, a likely need for analytics worker shards | Throughput profiling from tiers 1–2 |
| 4 | MCX commodity futures and options | Evening session calendar, futures as reference price, the futures-devolvement settlement guard, commodity-specific contract rules | Commodity segment activated on the Dhan account. Data plan coverage of MCX confirmed. `ltt` and candle behaviour checked on MCX |
| 5 | Currency futures and options (NSE and BSE) | Currency session calendar and contract rules | Currency segment activated. Feed behaviour checked |

The tier order is a recommendation; see the open decisions.

## Engineering decisions

| Decision | Recommendation | Reason |
|---|---|---|
| Engine inside Next.js or separate | Separate process | Deploying or restarting the web app mustn't interrupt trading. Hot reload already causes duplicate-socket problems. Serverless can't host it |
| Who talks to Dhan | The engine only | One owner keeps within the 5-socket limit and one REST rate budget |
| How to support many derivatives | One generic pipeline keyed by underlying and instrument, plus an underlying registry and session calendar; coverage widened in tiers | New underlyings become configuration and validation, not new code paths |
| Subscription limits | A universe manager with priorities and a visible budget | 25,000 instruments per account is generous for indices but finite once stock F&O and commodities are added |
| Concurrency model | Single-writer core with synchronous event dispatch. Derivatives analytics sharded by underlying onto workers only when profiling demands | Deterministic ordering makes replay exact. Sharding by underlying keeps it deterministic |
| Time | An injectable Clock everywhere. Timers driven by bar-close and session events from the session calendar, not `setInterval` | Replay with a virtual clock behaves exactly like live, across segments with different hours |
| Event time | Receive time is authoritative until `ltt` is understood per segment. Record both | `ltt`'s meaning is unconfirmed |
| Archive source of truth | Raw frames, plus point-in-time reference data | Parser changes can be re-applied to old days, and replays see contract specs as they were |
| IV and Greeks | Computed locally with Black-76 on forwards. Dhan's chain is a scheduled cross-check | The REST chain's single 3-second budget can't keep many underlyings live |
| Subscriptions | Universe owned by the engine; tabs are consumers | Strategies need data regardless of what pages are open |
| Paper versus live | Same risk engine and OMS; only the adapter differs | Paper results then predict live behaviour |
| Settlement risk | Settlement guard in the risk engine, driven by per-contract rules | Physical delivery and futures devolvement are costly mistakes that differ by segment |
| Resilience | Recoverability instead of high availability: journal, write-ahead orders, reconciliation, broker-side kill switch | One host is simpler, and recovery covers the failures that matter |

## Open decisions

These need a choice from the owner before the phase or tier that depends on them.

1. **Coverage order** (before tier 2): confirm the tier order above, or reprioritize, for example commodities before stock F&O.
2. **Hosting** (before phase 7): which Mumbai VPS provider, and whether the web app moves to the same host (recommended) or stays on Vercel behind an authenticated tunnel to the engine. Until then, web and engine run on the development laptop (decided 2026-11-15; see [engine-plan.md](engine-plan.md)).
3. **Token renewal** (needed before phase 7, useful from phase 1): Dhan's RenewToken endpoint, TOTP login, or the API-key OAuth flow.
4. **Free-float weight source** (phase 3, and again for each index in tier 2): exchange index factsheets loaded as versioned files, or weights estimated from returns.
5. **Account segments** (before tiers 4 and 5): activate commodity and currency trading on the Dhan account, and confirm the data plan covers their feeds.
6. **Settlement policy** (phase 6): whether any strategy may ever hold stock options or MCX options into expiry, or the settlement guard always exits first.
7. **Alert channel** (phase 1 onward): for example Telegram or email.
8. **Compliance** (phase 7): confirm Dhan's current requirements for API orders under SEBI's retail algo rules, including the static IP and any algo registration.
9. **Data plan** (before 2026-12-16): renew Dhan's Data API plan, which Quote and Full streaming depend on.
