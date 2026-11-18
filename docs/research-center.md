# Research Center

What the Research tab is for, how it works, and what it found first. **v1 built 2026-11-17, running on the development engine; production needs its S3 settings first** (see [Decisions](#decisions)). For the data it starts from see [research.md](research.md); for the signals it studies see [pulse.md](pulse.md); for how the engine trades them see [trading.md](trading.md).

## Contents

1. [In one paragraph](#in-one-paragraph)
2. [Using it](#using-it)
3. [What it found first](#what-it-found-first)
4. [Why signal studies first](#why-signal-studies-first)
5. [What a study computes](#what-a-study-computes)
6. [The Decision API over a study](#the-decision-api-over-a-study)
7. [The page](#the-page)
8. [How it fits together](#how-it-fits-together)
9. [Storage on S3](#storage-on-s3)
10. [What is built](#what-is-built)
11. [Testing and changing it](#testing-and-changing-it)
12. [After v1](#after-v1)
13. [Decisions](#decisions)

## In one paragraph

The Research tab answers one kind of question well before it answers many: **does this signal predict NIFTY, by enough to pay for trading it, across the whole history, and does it hold up when the history is split?** A study runs the engine's own signal code (`computePulse()`) over every day of the 1-minute history, in a child process of the engine at low priority, so it can't disturb the live feed or the trader. It stores every firing, the statistics and a manifest that pins the exact data files, code and settings, as objects on S3. The page gives the answer in plain words first and the evidence underneath. Each study has its own address and can be rerun to prove it reproduces.

## Using it

1. Restart the engine so it runs this code. The page says so if it doesn't.
2. Open **Research**. The header shows how far the history goes. **Update history** downloads the newest minute bars and official daily closes from Dhan (about 130 requests, paced at 2 a second, roughly a minute and a half).
3. The sentence at the top is the test: *Would [strategy] have made money over [period]?* The strategies are the store's ([strategies.md](strategies.md)); it starts on the one being paper traded, so **Test it** right away answers "should paper trading follow this?". A test is a study of the strategy's latest version, with its signal numbers and holding time and the engine's entry window, and its result is recorded on the strategy. Change a strategy's settings in the store, not here.
4. The study appears in the list with its progress. A year takes about 25 seconds; the page stays usable meanwhile.
5. The report opens when it finishes. Asking for a study that already exists with the same data and code opens the stored one instead.

**Method** (folded under the sentence) holds the only other settings: the entry window and the option trade's premium and slippage. Changing them makes a different study.

From a terminal, the same through the engine's control API:

```bash
T=$(grep ^ENGINE_TOKEN= .env.local | cut -d= -f2- | tr -d '\r')
curl -s -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"action":"study","spec":{"primary":{"signal":"momentum","horizon":5}}}' http://127.0.0.1:3101/v1/research
curl -s -H "Authorization: Bearer $T" http://127.0.0.1:3101/v1/research          # jobs and progress
curl -s -H "Authorization: Bearer $T" http://127.0.0.1:3101/v1/research/studies  # stored studies
```

## What it found first

The first study (development engine, 17 November 2026): every signal the engine can trade, over 257 days from 3 November 2025 to 17 November 2026, entries 09:25–14:45.

| Signal, 10-minute hold | Firings | Right | Points a firing, before costs | 95% range | Before 3 Aug 2026 | From 3 Aug 2026 |
|---|---|---|---|---|---|---|
| Two or more agree (the engine's default) | 1,433 | 49.0% | −0.1 | −1.5 to +1.2 | −0.7 | +2.0 |
| 15-minute momentum | 3,313 | 49.7% | +0.3 | −0.6 to +1.2 | −0.2 | +1.8 |
| Breadth thrust | 2,832 | 49.8% | +0.3 | −0.6 to +1.3 | +0.3 | +0.5 |
| Basket leads index | 1,755 | 50.1% | −0.4 | −2.0 to +1.1 | −0.4 | −0.1 |

- **An option trade costs about 3.9 NIFTY points** (₹63 of Dhan's charges and ₹65 of slippage on one lot at ₹100 premium, at delta 0.5, before time decay). A futures lot costs about 15.4. All 20 signal and holding-time pairs are "No edge after costs". The best average is +0.9 points (Basket leads index, 15 minutes).
- **Nobody is right more often than a coin:** 49–51% everywhere.
- **Month to month**, Two or more agree at 10 minutes ranged from −2.9 to +3.7 points a firing.
- **The one lead worth a later look:** 15-minute momentum since the closing auction, +1.8 points (range +0.4 to +3.2), still under half the cost of a trade. It is one of 20 × 6 slices looked at, so it is an idea for a new study on new days, not a finding.
- **The thresholds were picked on 16 November 2026**, so the year before is out of sample for them: a fair verdict on the rules as they stand.

### Parity: candles against the journal

The minute history reproduces the live signals. The same signals computed from the journal (what the engine traded) and from Dhan's candles, minute by minute:

| Day | Previous close taken from | Breadth | Basket leads | Momentum | Two or more agree |
|---|---|---|---|---|---|
| 16 Nov | Last minute candle | 85.9% same | 99.1% | 99.7% | 94.4% |
| 16 Nov | Official close | **100%** | 99.1% | 99.7% | **99.4%** |
| 17 Nov | Last minute candle | 88.7% | 99.6% | 99.6% | 95.7% |
| 17 Nov | Official close | **100%** | 99.6% | 99.6% | **100%** |

The official previous close is what makes it match: 46 to 47 of 50 stocks' last minute candle differs from it. Studies read it from Dhan's daily bars. The comparison is a test in the repo (`day-frames.test.ts`).

### Things a study knows

| Fact | How a study handles it |
|---|---|
| **NSE's closing auction began on 3 August 2026.** Before it stock candles run to 15:29; from it they stop at 15:14 and the index sits flat until the auction price lands | Session rules by date (`CLOSING_AUCTION_FROM`). No firing exits after 15:14 on auction days. Results are split before and after |
| **8 November 2026 was a Sunday Muhurat session** (70 index minutes) | Days under 300 NIFTY minutes are left out, with the reason in the manifest |
| **1 February 2026 was a full Sunday session** (the Budget) | Kept: the rule is session length, not the weekday |
| **Breadth counts every stock in the journal**, and the BANKNIFTY banks joined the universe on 17 November | Studies count a fixed list, the NIFTY 50, recorded in the manifest. The live engine's breadth is [still open](#decisions) |
| **Firings on the same day move together** | 95% ranges resample whole days, not firings |

## Why signal studies first

1. **It answered the most valuable open question in the system.** The engine was paper-trading a signal on thresholds chosen from one day. Now there is a year of evidence, and it says the signal doesn't pay.
2. **The data supports it today.** A year of minute data gives thousands of firings per signal. Order-book data starts on 18 November and needs weeks.
3. **Signals before strategies.** A study tests whether the signal itself predicts the market: many more samples and far fewer knobs (no strike, stop, target or lots) than a strategy backtest, so it is much harder to fool yourself. A strategy built on a signal that doesn't predict can only look good by luck.
4. **No new trading code.** It reuses `computePulse()` and `charges.ts` unchanged, so research and the engine can't drift apart.
5. **It laid the foundation the rest needs:** session rules by date, data fingerprints, manifests, the store layout, the runner, honest statistics and the report page.

## What a study computes

**A firing** is a minute close inside the entry window where the signal votes long or short. The trader reads a minute's signals 1.5 s after it closes and enters from `from` up to, not including, `until`, so 09:25–14:45 means the bars that start at 09:24 through 14:43. Its outcome is NIFTY's close H minutes later minus its close at the firing, signed by the vote. After a firing the next H minutes are skipped: one position at a time.

Each study measures **all four signals at 1, 3, 5, 10 and 15 minutes**. The pair asked about is the primary result; the other 19 are labelled exploratory.

| Number | Why |
|---|---|
| Firings, and days with firings | Whether there is enough to judge |
| Hit rate with its Wilson 95% range | The same measure Pulse shows |
| Points a firing before costs, with a 95% range from resampling whole days 2,000 times (fixed seed) | Firings on one day are related; resampling days keeps that |
| After an option trade and after a futures trade | Whether it pays to trade |
| NIFTY's drift: its average move over H from every minute in the window | Separates the signal from the market going up |

**Slices** of the primary pair: first 70% of days against the last 30%; before and after the closing auction; time of day (before 11:00, 11:00–13:30, after 13:30); India VIX at the firing (under 12, 12–16, 16 and over); long and short; month by month.

**Verdict** of each pair, in Pulse's words:

| Verdict | When |
|---|---|
| Too few firings | Fewer than 30 firings or 20 days |
| Edge after costs | The low end of the 95% range is above the option cost, and the last 30% of days is above it too |
| Ahead, could be luck | The average is above the option cost, but the range isn't |
| Predicts, costs eat it | The range is above zero, the average isn't above the cost |
| No edge after costs | The range includes zero |
| Reliably wrong | The whole range is below zero |

Slices get a verdict too but can't be "Edge after costs": an edge found by slicing is a hypothesis, not a result.

## The Decision API over a study

The trader asks OpenRouter's Decisions API about every entry and takes it only when the answer passes its rule ([trading.md](trading.md#decision-api)). A study's **Decision API** panel asks the same model the same questions about each of the study's primary firings, as the trader would have at that minute, then compares the firings it approved with the ones it turned down, by the trader's own rule (probability at least 0.55, not against the regime). The gate earns its place only if approved firings do clearly better than turned-down ones *and* pay for the trade.

**What research sends.** The trader's own context (`buildDecisionState()` in [decision.ts](../src/engine/trading/decision.ts)), with two research-only changes:

- **No look-ahead.** The context is built from the day as it stood when the firing's minute closed (`sessionUntil()` in day-frames.ts). Signals never look ahead, but the rest of a pulse does: the day's range, the learned weights, the verdict.
- **Nothing that names the day.** The model (`perplexity/pplx-decider-v1.3`, dated 12 November 2026) is newer than every day in the history and may search the web. So the contract and its expiry become "NIFTY put, at the money, nearest weekly expiry", NIFTY's level is left out, its last 15 closes become points from the latest, and levels in the evidence lines are rewritten ("−151.1 pts from the open"). A test checks no date or NIFTY level gets through.

Live trading keeps sending its full context (decided 17 November 2026), so research measures a slightly different gate; the panel says so. Two more differences: the premium is the study's assumed ₹100 rather than the real one, and evidence that needs VWAP or the order book (not in minute candles) is missing. Only the live shadow book, on days after the model was built, is fully clean evidence.

**Provider.** The panel's **Ask with** chooses OpenRouter or Liquid ([trading.md](trading.md#decision-api) has both); it starts on the trader's. Asking the other provider measures a different model, and the panel says so in amber: it tells you whether that model would make a good gate, not whether the trader's is one. Each provider's answers are kept under its own model, so a pass with one never reuses the other's.

| | OpenRouter, free model | Liquid |
|---|---|---|
| A year of the default strategy (1,433 firings) | About 7 weeks at about 30 answers a day, or about 1.5 hours with $10 of credit | About 20 minutes and $0.08 |
| Shared with live trading | Yes: the daily quota | No |
| Pace | One question every 4 s | One every 0.25 s plus the answer's 0.5 s |

**Quota (OpenRouter free models only).** Free models (`:free`) allow 20 requests a minute, and 50 a day on an account that has bought less than $10 of OpenRouter credit (1,000 a day after), per UTC day (it resets at 05:30 IST). Live trading draws on the same quota, so a pass:

- stops while 20 are left (`RESERVE` in [quota.ts](../src/engine/research/quota.ts)). OpenRouter's count lags real requests by a minute or more, so the worker also counts its own requests, retries included, and trusts the lower figure;
- asks one question every 4 seconds;
- stores answers as they arrive, and carries on where it stopped when run again. Any study's answer to the exact same context is reused, so nothing is asked twice.

On the free allowance a pass gets about 30 answers a day, so a year of firings (1,433 for the engine's default) takes about seven weeks. With $10 of credit it is about an hour and a half, still free per answer.

**First answers** (17 November 2026, test engine, 29 of 1,433 firings, early November 2025): approved 20 firings averaged −3.0 points, turned down 9 averaged −3.4. Far too few to judge; both lose after costs.

## The page

Written for someone without a finance background (changed 17 November 2026, at the user's request): the answer in rupees first, one chart, everything else folded away.

```
┌ Research ── Market data from 3 Nov 2025 to 17 Nov 2026 ──────────────────────────── [Update history] ┐
│ Would [Two or more agree ▾] have made money, holding each trade [10 min ▾] over [all the history ▾]? │
│ This is what the engine is paper trading now. Takes about 30 seconds.         Settings ▸  [Test it] │
├───────────────────────────┬────────────────────────────────────────────────────────────────────────┤
│ STUDIES                   │ Two or more agree · each trade held 10 minutes · 3 Nov 2025 – 17 Nov 2026│
│ ▣ Two or more agree,      │ Would have lost about ₹1.9 lakh                                        │
│   held 10 min             │ 1,433 trades over 257 trading days, one lot each: on average each      │
│   [Loses money]           │ trade lost ₹131 after costs.                                           │
│   −₹131 a trade · 1,433   │ [Loses money]  Don't trade this.                                       │
│                           │ A clear result: even the most hopeful reading of the data loses money. │
│                           │ Trades 1,433 │ Winning trades 49% │ Average trade −₹131                │
│                           │ [Money over time: one line, one lot, after costs]                      │
│                           │ ▸ Details: holding time · is it steady · the AI check · other          │
│                           │   strategies · every trade · how it was tested                         │
└───────────────────────────┴────────────────────────────────────────────────────────────────────────┘
```

**Money.** Every rupee figure is for one lot (65 units) of an at-the-money option, which moves about half a rupee per NIFTY point: so ₹32.50 a point (`rupeesPerPoint()` in research-format.ts, from the study's lot and delta). A trade costs ₹128 (Dhan's charges at a ₹100 option plus slippage). Time decay isn't counted, so real results would be a little worse, and the totals don't apply the engine's daily limits (12 trades, ₹3,000 loss). Both caveats are on the page.

**Words.** Studies store the precise verdicts ("No edge after costs"); the page shows `PLAIN_VERDICT` in types.ts ("Loses money", with what to do). "Firings" are trades, "95% range" is "likely between", and how sure a result is is a sentence (`certainty()`): a clear loss, a clear gain, or could have gone either way.

The selected study is in the address (`/research?study=agree-10m-…`), so it can be bookmarked or pasted into a note.

### Making it easy to use

The Research Center has to be pleasant to work in, not just correct. These rules hold for every part of it:

- **Answer first, in rupees.** The top of a study says what it would have made or lost and what to do. No finance knowledge needed; the precise numbers are under Details.
- **One click to the useful study.** Defaults come from what the engine trades now. Nothing has to be filled in.
- **No forms.** Three choices in a sentence; everything else under Settings, with its default shown.
- **Never wait blind.** Progress shows in the list, the page stays usable, and the result opens when it is ready. Reopening a study is quick, because its summary is stored.
- **Plain words.** Trades, not firings; "likely between", not "95% range"; "Loses money", not "No edge after costs".
- **Every number explains itself.** Hovering a chart or a cell shows how many trades it rests on; "How it was tested" says how each number is made.
- **Errors say what to do.** For example, an engine on older code says to restart it.
- **Permanent and linkable.** A study never changes after it is written.

The same for anyone working on the research code, person or agent: the study logic is pure functions with tests; every result is a Parquet file any DuckDB can query (the report shows the query); the control API starts a study with `curl`; this document says where everything is.

## How it fits together

```
Browser ── /research ──► Next (Vercel) ── /api/engine/v1/research/* (allowlist) ──► engine control API
   ▲                                                                                      │ POST /v1/research
   │ telemetry topic "research": jobs, progress, coverage                                  ▼
   └──────────────────────────────────────────────────────────── research runner (engine main process)
                                                                                          │ fork, nice 10, one at a time
                                                                                          ▼
                                                                  worker (child process, its own DuckDB: 2 threads, 1 GB)
                                                                    1. fingerprint the input files (key, ETag, size) → study id
                                                                    2. stop if that study exists
                                                                    3. per month: candles + official closes → day sessions
                                                                    4. per day: computePulse() → votes per minute
                                                                    5. firings, outcomes, costs, statistics
                                                                    6. write research/<namespace>/… to S3
```

**Measured** on the test engine, 17 November: a 257-day study in 24–28 s; the worker peaks at about 600 MB, most of it DuckDB reading from S3; the engine's event-loop delay p99 went from 0.3 ms to at most 1.2 ms while it ran. The VM has 4 cores and 11 GB free.

| Layer | Does | Code |
|---|---|---|
| Data access | Minute and daily downloads, coverage from Parquet footers, day sessions with session rules by date | `candle-history.ts`, `day-frames.ts` |
| Signals | `computePulse()`, unchanged | `src/lib/insight/pulse.ts` |
| Study | Votes, firings, outcomes, slices, statistics, verdicts, costs: pure | `study.ts`, `stats.ts`, `costs.ts` |
| Orchestration | One study start to finish over injected inputs; ids and hashes | `run-study.ts` |
| Persistence | The study's objects, the catalog, reruns | `study-store.ts` |
| Jobs | Queue, fork, progress, cancel, health component `research` | `src/engine/research/runner.ts`, `worker.ts` |
| Decision API pass | Contexts without look-ahead or dates, the trader's rule, the free quota | `src/engine/research/gate.ts`, `quota.ts` |
| Page | Sentence, list, report, charts | `src/components/research/`, `src/app/(cockpit)/research/` |

```
src/lib/research/
  types.ts               spec and checks, stored rows, manifest, runner status and commands (engine and web)
  candle-history.ts      minute and daily downloads, history update, coverage
  day-frames.ts          candles + official closes → one day's session; session rules by date
  study.ts               votes, firings, drift, the accumulator and its summary
  stats.ts               day-resampled ranges, Wilson interval, verdicts
  costs.ts               round trips in NIFTY points, from charges.ts
  run-study.ts           a study from start to finish; S3 inputs; ids and results hashes
  study-store.ts         the objects on S3
  fixtures/              16 and 17 Nov 2026 for the parity test
src/engine/research/
  runner.ts              the queue and the child processes
  worker.ts              one job in a child process
  gate.ts                the Decision API over a study's firings: contexts, answers, approved against turned down
  quota.ts               the free-answer quota and the reserve kept for live trading
src/components/research/ research-workspace.tsx, study-report.tsx, study-charts.tsx, research-format.ts
```

**Control API:**

| Endpoint | Does |
|---|---|
| `GET /v1/research` | `ResearchStatus`: jobs with progress, the history held, the one-click defaults, the store's location, the Decision API model and today's free answers left |
| `POST /v1/research` | `{ action: "study", spec? }` (spec fields default to the engine's signal and hold over all the history), `{ action: "rerun", id }`, `{ action: "gate", id }` (ask the Decision API about a study's firings), `{ action: "history" }`, `{ action: "cancel", job }` |
| `GET /v1/research/studies` | The catalog, newest first |
| `GET /v1/research/study?id=` | One study: manifest, summary, the primary pair's days and firings, reruns |
| Telemetry topic `research` | The status on every change, progress at most four times a second |

## Storage on S3

```
option-trader/
  history/candles-1m/YYYY-MM.parquet     minute bars, 63 instruments
  history/daily/YYYY.parquet             official daily bars (key, date, open, high, low, close, volume)
  research/<namespace>/
    events/<id>.parquet                  one row per firing, every signal and horizon
    daily/<id>.parquet                   one row per day × signal × horizon
    summary/<id>.parquet                 one row per signal × horizon × slice
    manifests/<id>.json                  the spec, the input files with their ETags, the code hashes, the results hash
    studies/<id>.parquet                 the catalog row, written last
    checks/<id>/<time>.json              each rerun and whether it matched
    decisions/<id>/<time>.parquet        Decision API answers for its firings, one file per batch, keyed by the context sent
    gates/<id>/<time>.json               each Decision API pass: approved against turned down, by probability band
```

- **One folder per table, one file per study,** like `trading/<namespace>/runs/`. One glob reads a table across every study.
- **Written once.** Nothing is edited after it is written; the catalog row goes last, so a study is listed only once all its files exist. A rerun writes a check, never over the study.
- **Namespace** as trading's: `main` for the engine on port 3100, `dev-<port>` otherwise.
- **The id** is the primary pair plus a hash of the spec, the input files' ETags and the code hashes (`agree-10m-6d6a9fa184`). The same inputs give the same id. The current month's file grows when the history is updated, so a study over it gets a new id afterwards, which is right: it has new data.
- **Determinism.** Days in date order, a fixed resampling seed, numbers rounded before hashing, no clock.

```sql
-- Every study's primary result
SELECT id, question, verdict, firings, mean, lo, hi, net_option, days
FROM read_parquet('s3://<bucket>/option-trader/research/main/studies/*.parquet') ORDER BY started_at DESC;

-- Every pair of one study, best first
SELECT signal, horizon, firings, mean, lo, hi, verdict
FROM read_parquet('s3://<bucket>/option-trader/research/main/summary/<id>.parquet')
WHERE slice_kind = 'all' ORDER BY mean DESC;
```

## What is built

| Step | Scope | State |
|---|---|---|
| R0 | Breadth's stock list in the live engine | **Open**, see [Decisions](#decisions) |
| R1 | Daily closes from `/charts/historical` into `history/daily/YYYY.parquet` | Done: 2025 and 2026 on S3; equal to the journal's previous closes on 16 and 17 Nov |
| R2 | Day sessions from candles and parity with the journal | Done: test passes, ≥ 99% of minutes on both days, and no look-ahead |
| R3 | Study and statistics | Done: tests for a planted edge, noise, verdicts, the entry window, the auction cutoff |
| R4 | Storage | Done: written, listed, read back; a changed data file changes the id |
| R5 | Runner, worker, control API, telemetry, web proxy | Done: checked end to end on a test engine (study, duplicate, rerun reproduced exactly) |
| R6 | The page | Built; typecheck, lint and a signed-in render pass. Needs a look in the browser against a restarted engine |
| R7 | Docs | This file, [research.md](research.md), AGENTS.md |
| D1 | Decision API over a study's firings | Done: checked against the real API on a test engine (29 answers, resumed with none asked again, stopped at the reserve). The first pass overshot the reserve because OpenRouter's count lags; fixed by counting requests locally, with a test |
| D2 | Liquid as a second decision provider, for the trader and for research | Done: tested with Liquid's real API (the trader's questions, a full context), a research pass of 20 answers cancelled with its answers kept |

## Testing and changing it

`node --test src/lib/research/*.test.ts src/engine/research/*.test.ts` (also part of `npm test`): parity on 16 and 17 November, no look-ahead, session rules, firing rules, verdicts, a planted edge found and noise not, costs, a whole study written and read back on local files twice with the same id and results, and the Decision API pass (no date or level in what is sent, resuming without asking again, the trader's rule, the reserve kept when OpenRouter's count lags). No test calls Dhan, OpenRouter or S3.

To try the engine side without touching either running engine, start a third on a copy of a journal ([trading.md](trading.md#testing-and-changing-it) has the steps) and use the `curl` lines above against its port. Its studies go to `research/dev-<port>/`.

| To | Change |
|---|---|
| Study a new signal | Add it to `computePulse()` ([pulse.md](pulse.md#changing-it)), to `SIGNALS` in trading.ts, `STUDY_SIGNALS` in types.ts, and `dayVotes()` in study.ts |
| Add a slice | `slicers` in `StudyAccumulator.summary()` and `SLICE_GROUPS` in study-report.tsx |
| Change a statistic or a verdict | stats.ts. Existing studies keep their numbers; new ones get a new id because the code hash changes |
| Record another market-structure change | A dated constant next to `CLOSING_AUCTION_FROM` in day-frames.ts, used by `sessionRules()` |
| Add an input file | `storeInputs()` and `studySources()` in run-study.ts, so it is fingerprinted |

## After v1

Each step starts only after the one before has been validated.

| Version | Adds | Why then |
|---|---|---|
| v2 **Real option outcomes** | Download expired NIFTY weekly options (`/charts/rollingoption`, ATM ± 10). Price each firing with the actual option at its strike, with Dhan's charges and lot sizes as of each date | Turns "points before costs" into "rupees as the engine would trade it", including time decay |
| v3 **New signals** | Move signals out of `computePulse()` into a registry of pure functions with ids and versions, shared by the engine and research. New hypotheses written in code, tested and studied | v1 says the current three don't pay, so the question now is what does |
| v4 **Order book and options microstructure** | Daily conversion of the depth and chain recordings to Parquet on S3; order-book imbalance, OI and IV studies at second resolution | Needs 4–6 weeks of recordings from 18 November |
| v5 **Strategy experiments** | The trader's own code over history (E5 in the [engine plan](engine-plan.md#e5-candle-history-and-backtests)), walk-forward, research expectations against paper results | Only worth it for a signal that passed v1 and v2 |

## Decisions

1. **Breadth in the live engine (open).** From the 18 November session, the engine's breadth counts 59 stocks, because the BANKNIFTY banks joined the universe on 17 November; Breadth thrust's threshold was set on 50. Over the year, counting 59 makes Breadth thrust fire 19–28% more often and Two or more agree 12–16% more often. Recommended: pin it to the NIFTY 50 list, which is what studies measure.
2. **Production.** Studies run in whichever engine the web reaches. Production (port 3100) has no `S3_*` settings yet, so it can't read the history; adding them (the user's step, planned) also moves its trading tables from local disk to S3.
3. **Bucket.** One bucket for now (`option-trader-dev`), research under its own namespace.
4. **What paper trading follows next.** The first study says none of the four signals pays after costs. Whether to keep paper trading one of them as a pipeline test, or pause entries until a signal passes, is a trading decision, not a research one.
5. **Decision API answers.** The OpenRouter key is on the free allowance (50 a day), and no provider offers typed probability answers for free otherwise (checked 17 November 2026). Liquid is wired in as a second provider for the trader and for research (cents a year). Which one the trader uses is a setting on the Strategies page; it stays on OpenRouter until changed.
