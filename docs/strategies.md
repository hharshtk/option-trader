# Strategy store

Where strategies are made, changed, tested and put to paper trading: the **Strategies** page. Built 2026-11-17. For how the engine trades a strategy see [trading.md](trading.md); for how a test works see [research-center.md](research-center.md); for what the signals measure see [pulse.md](pulse.md).

## Contents

1. [In one paragraph](#in-one-paragraph)
2. [Using it](#using-it)
3. [What a strategy is](#what-a-strategy-is)
4. [One source for every page](#one-source-for-every-page)
5. [Storage on S3](#storage-on-s3)
6. [Control API](#control-api)
7. [Code layout](#code-layout)
8. [Adding a new kind of strategy](#adding-a-new-kind-of-strategy)
9. [Preloaded strategies](#preloaded-strategies)
10. [Phase 2](#phase-2)

## In one paragraph

A strategy is a named set of settings for logic that lives in code: which signal starts a trade and with what numbers, how it trades (calls or puts, which strike, how long, stop-loss, target), and its AI check (the Decision API). Every save is a new **version**; versions are never changed or deleted. From the same card you **test** a version on a year of past data and **paper trade** it; each test's result is recorded against the version it tested. The engine keeps everything as Parquet files on S3 and paper-trades one version at a time. Pulse, the trader and research all read the signals from one module, so what the page shows, what is tested and what trades are the same rules.

## Using it

**Strategies** has two tabs: **Strategies** (the store) and **Paper trading** (the engine trading the chosen version: positions, trades, the account's limits).

| To | Do |
|---|---|
| See how a strategy did | Pick it in the list. "Latest test" says, in rupees for one lot, what it would have made or lost, with a link to the full result |
| Test it | **Test version N on past data**: about 30 seconds; the result lands on the card and on the Research page |
| Change it | Edit **Settings** and **Save as version N+1**, with an optional note. The old version stays |
| Paper trade it | **Paper trade version N**: the engine follows that version from the next signal and takes entries. Whatever it traded before stops |
| Stop | **Stop paper trading**: no new entries; an open position keeps its exits |
| Start from another | **Make a copy**, or **+ New strategy** for a blank one |
| Put one away | **Retire**: it leaves the list (and paper trading); **Show retired** brings it back to view, **Restore** to use |
| Look back | **History**: every version with what changed and how it tested, and everything that happened |

Saving a new version of the strategy being paper traded doesn't change what trades: the card says paper trading still follows the older version until you switch. Test first, then paper trade.

The **Paper trading** tab keeps the account's own settings (entry window, limits, fills, recording). What is traded and its AI check can only be changed in the store; the engine refuses a settings change that tries to.

**First start.** When the store is empty, the engine carries over what it was trading as the first strategy, marked as paper trading, so nothing changes for a running engine.

## What a strategy is

| Part | Holds | Checked by |
|---|---|---|
| Name and idea | A name, and in a sentence why it should make money | Length |
| Kind | Which code it runs. Phase 1 has one: **Follow a signal with options** | The list of kinds |
| When it trades | The signal (Breadth thrust, Basket leads index, Momentum, Two or more agree) and its numbers: how many stocks over how many minutes, how many hundredths of a percent, what percent move, how many must agree | The engine's own rules (`mergeTradingConfig`), with the ranges in `SIGNAL_PARAM_LIMITS` |
| How it trades | Calls and puts or one side, which strike, lots, sell after N minutes, stop-loss, target, sell when the signal turns, skip near expiries | The engine's own rules |
| AI check | Off, record only, or allowed to turn trades down; provider (OpenRouter or Liquid), model, threshold, trend veto, time limit, what to do with no answer | The engine's own rules |

Because a strategy is checked by the same rules as the engine's settings, any version the store accepts is one the engine can trade.

**Statuses**, worked out from the history: *Not tested yet*, *Tested*, *Paper trading* (with its version), *Retired*.

## One source for every page

| Page | Reads |
|---|---|
| Pulse | The signals from `src/lib/strategies/signals.ts` with their default numbers. Its output is byte-for-byte what it was before the move (checked on 16 and 17 November 2026) |
| Paper trading (the trader) | The chosen version's signal, numbers, trade rules and AI check, set by the store through `trader.useStrategy()` |
| Research | A test is a study of one version: its signal with its numbers, its holding time, the engine's entry window. The study records the version, and the store records the result |

The signals' numbers used to be fixed inside the Pulse code; they are now settings of each strategy, with the old values as defaults.

## Storage on S3

```
option-trader/strategies/<namespace>/
  versions/<id>/<version>.parquet    one row: id, version, saved_at, note, definition (the settings as JSON)
  events/<id>/<time>.parquet         one row: strategy, at, kind, version, note, and for a test: study, verdict, net, trades, days
```

- **Written once.** A save writes a new version file; everything else is an event. Nothing is overwritten, so a strategy's whole history stays readable. Its status comes from its events.
- **Namespace** as trading's: `main` for the engine on port 3100, `dev-<port>` otherwise.
- **Ids** are the name in lowercase plus four random characters: `momentum-held-20-min-s2n6`.
- **One writer**: the engine. It reads everything at start (two glob queries) and keeps it in memory.

```sql
-- Every version of every strategy
SELECT id, version, note, to_timestamp(saved_at / 1000) AS saved, json_extract_string(definition, '$.name') AS name
FROM read_parquet('s3://<bucket>/option-trader/strategies/main/versions/*/*.parquet') ORDER BY id, version;

-- Every test result
SELECT strategy, version, verdict, net, trades FROM read_parquet('s3://<bucket>/option-trader/strategies/main/events/*/*.parquet')
WHERE kind = 'tested' ORDER BY "at" DESC;
```

## Control API

| Endpoint | Does |
|---|---|
| `GET /v1/strategies` | `StrategiesStatus`: every strategy's summary (latest version, status, paper version, latest test) and what paper trading follows |
| `GET /v1/strategies/one?id=` | One strategy: every version and event |
| `POST /v1/strategies` | `{ action: "create", definition?, from? }`, `{ action: "save", id, definition, note? }`, `{ action: "paper", id, version? }`, `{ action: "stop-paper", id }`, `{ action: "test", id, version?, from?, to? }`, `{ action: "retire" \| "restore", id }` |
| Telemetry topic `strategies` | The status on every change |

Types are in [src/lib/strategies/types.ts](../src/lib/strategies/types.ts).

## Code layout

```
src/lib/strategies/
  signals.ts         the signals: definitions, numbers and limits, readings and votes (Pulse, trader, research)
  types.ts           a strategy, its versions, events, statuses, commands; checkDefinition()
  store.ts           versions and events on S3; assemble() into summaries
src/engine/strategies/
  service.ts         the store in the engine: commands, carry-over, the trader's strategy, recording tests
src/components/strategies/
  strategy-store.tsx  the page: list, card, latest test, actions, history
  strategy-editor.tsx the settings, in plain words
src/app/(cockpit)/(strategies)/  the Strategies and Paper trading tabs
```

Tests: `src/lib/strategies/store.test.ts` and `src/engine/strategies/service.test.ts` (carry-over, versions, test results, paper switching, retire, copy, restart).

## Adding a new kind of strategy

Phase 1 has one kind. A new one (opening range breakout, intraday momentum, option selling) is code:

1. Add its id and plain description to `STRATEGY_KINDS` in types.ts, and its settings to `StrategyDefinition` if it needs new ones (checked in `checkDefinition`).
2. Write its logic as a pure function next to the signals, with tests.
3. Teach the trader (trader.ts) and research (study.ts) to run it, and the editor to show its settings.

## Preloaded strategies

The store starts with six well-known intraday strategies ([catalog.ts](../src/lib/strategies/catalog.ts)), each with the settings most often published for it. The engine adds any that are missing when it starts (a retired one stays retired) and tests each once. Their AI check is set to record its opinion without blocking. Their entry rules are in `PATTERN_SIGNALS` in [signals.ts](../src/lib/strategies/signals.ts); they read NIFTY's own minute bars and never touch the Pulse page, whose output is unchanged.

| Strategy | The rule (default settings) | Where it comes from |
|---|---|---|
| Intraday momentum | At 14:44, follow NIFTY's move from the previous close to 09:45 when it is at least 0.05%; sell at the 15:10 square-off | Gao, Han, Li and Zhou, "Market intraday momentum", Journal of Financial Economics 2018: the first half-hour predicts the last in the S&P 500 over 20 years; later found in 12 of 16 developed markets. Moved earlier because NSE closes with an auction at 15:15 |
| Opening range breakout | Follow the first close at least 0.05% beyond the first 15 minutes' high or low; hold 60 min, stop 25%, target 50% | TradingView NIFTY scripts, QuantInsti EPAT projects. No trustworthy published NIFTY test |
| Moving-average crossover (9/21) | Follow the 9-bar average of 5-minute closes crossing the 21-bar one; sell when it crosses back | AlgoTest and m.Stock guides |
| Supertrend (10, 3) | Follow Supertrend (10 bars, 3 × ATR, 5-minute bars) turning; sell when it turns back | Common Indian default; the few published tests on 5-minute bars (not NIFTY) found it unprofitable for day trading |
| RSI reversal (14, 30/70) | Bet up when RSI (14, 5-minute bars) climbs back above 30, down when it falls back below 70; hold 15 min, stop 20%, target 30% | The classic "oversold bounce" |
| Gap fade | At 09:25, bet against an opening gap of 0.3% to 1%; hold 60 min, stop 30% | Blog claims of 55–62% same-day fills for small gaps, none with data |

**First results** (test engine, 17 November 2026; 257 days from 3 November 2025; one lot, after ₹128 of costs a trade):

| Strategy | Trades | Won | A trade, after costs | Total | Verdict |
|---|---|---|---|---|---|
| Intraday momentum | 231 | 50.6% | +₹47 | +₹10,900 | Made a little, could be luck |
| Moving-average crossover | 283 | 51.2% | −₹11 | −₹3,100 | Loses money |
| Supertrend | 219 | 51.6% | −₹69 | −₹15,100 | Loses money |
| Gap fade | 88 | 52.3% | −₹235 | −₹20,700 | Loses money |
| RSI reversal | 392 | 41.8% | −₹218 | −₹85,500 | Loses money: reliably wrong, so the market keeps going rather than bouncing |
| Opening range breakout | 242 | 50.8% | −₹305 | −₹73,900 | Loses money |

Only intraday momentum, the one with real academic evidence, comes out ahead, and not by enough to be sure (its range before costs runs from −0.3 to +11.7 points against a 3.9-point cost). A test measures NIFTY's move over the holding time: stops, targets and "sell when the signal turns" aren't part of it yet, so the crossover and Supertrend results are for a fixed 60-minute hold.

## Phase 2

- **AI in the strategy itself**: beyond the AI check on each trade, for example a regime filter or AI-suggested settings.
- **Try variations**: run a set of settings automatically, judged on months held back from tweaking, so tuning to the past is caught.
- **Several strategies at once** in paper trading (the trader runs one today).
