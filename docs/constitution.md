# Constitution

What this application is for, what it will and won't become, and how to decide what to build next. It outranks every other document in `docs/`. When a plan, a request or an idea conflicts with it, name the conflict and let the owner decide. It changes only by [amendment](#8-amendments).

## Contents

1. [Purpose](#1-purpose)
2. [What it is](#2-what-it-is)
3. [What it is not](#3-what-it-is-not)
4. [Principles](#4-principles)
5. [Deciding what to build](#5-deciding-what-to-build)
6. [Going live](#6-going-live)
7. [House rules](#7-house-rules)
8. [Amendments](#8-amendments)

## 1. Purpose

Predict where NIFTY goes in the next minutes from the live market (the index, its stocks, futures, the 20-level order book and the option chain), with Decision APIs reading that data, and trade NIFTY options only on predictions that have proven themselves: a few trades a day, positive after costs, with code and AI in the loop.

## 2. What it is

One loop, run every trading day:

1. **Record.** Every frame of the live feed, the order book and the option chain, as the session happens.
2. **Predict.** The Decision API reads the live context and says which way NIFTY goes next, how far, and how sure it is.
3. **Grade.** Every prediction is checked automatically against what NIFTY then did.
4. **Trade on paper.** The trader acts only on predictions that have earned it. The paper book shows the result after costs.
5. **Go live.** Only after the [go-live gate](#6-going-live).

Replay plays a recorded day through the same loop, to check and debug it. The decision lab scores rules over recorded days in the background. Both serve the loop; neither is a product of its own.

## 3. What it is not

- **Not a backtester or strategy builder.** It has no date-range runs with settings to tweak, no indicator catalogs, no strategy stores and no form-driven rule editors. Tradetron, AlgoTest and Streak do that already. This app's edge is live data they don't have, and AI reading it. Earlier work of that kind is parked on the branch `research-and-strategy-store`.
- **Not a collection of knobs.** A setting is added only when the loop can't run without it, never just to explore.
- **Not a tuning machine.** Nothing is fitted to past days to make a result look good.
- **Long options only.** It buys calls and puts. Option selling, spreads and futures trading stay out until an amendment adds them.
- **Not live trading, yet.** See [Going live](#6-going-live).

## 4. Principles

1. **Live data is the source of truth.** What happened in a live session decides. Replays and the lab must agree with it; they never replace it.
2. **Record first, never lose a session.** Order books and option chains can't be downloaded later. The recorder runs every trading day, whether or not anything trades, and nothing may break or pause it during market hours.
3. **Every prediction is graded.** A prediction with no automatic check against the outcome doesn't count. The Decision API is judged on its graded record, not on a handful of trades.
4. **Beat the simple bars, after costs, on days it wasn't built on.** The bars are a trade at a random moment on the same side, and "NIFTY keeps going the way it has since the open". Anything written with a day already seen is tested only from the next day, and is never tuned on the days that test it.
5. **Direction isn't enough.** An option buyer wins only when NIFTY moves further than options already price in, plus charges, spread and slippage. Predictions and trades are judged against that move, and results are always in rupees after Dhan's charges.
6. **Proof takes weeks.** One or two days prove nothing. Nothing counts as working before 20 live sessions.
7. **Safety over results.** Trading stays on paper until the gate. Risk limits (daily loss, positions at once, losses in a row) are never loosened to make a result look better. A setup that keeps hitting them gets changed instead.
8. **One set of trading rules.** The trader, replays and the lab share the code for entries, exits, fills and charges, so a change to one is a change to all.
9. **Small and plain.** Each feature does one thing, built on the existing pieces: feed, journal, replay, trader and Decision API. Removing is preferred to adding.
10. **Written for the owner.** Use rupees, not points; put the bottom line first; avoid statistics jargon. The owner is a software engineer, not a trader.

## 5. Deciding what to build

Before proposing or starting work, answer these:

1. Does it improve live prediction, measure live prediction, protect recorded data or money, or keep the loop running? If none of these, don't build it.
2. Does the market already offer it? If so, and it doesn't use our live data or the Decision API, don't build it.
3. Does it add a setting? Then say why the loop can't run without it.
4. Can its effect be seen on live data within a few weeks? If not, it waits.
5. Is this the smallest version that answers the question?

When a request fails a check, say which check and ask. The owner may still decide to go ahead.

## 6. Going live

No code places an order with Dhan until every check of the go-live gate holds and the owner signs off: see [engine-plan.md](engine-plan.md#go-live-gate) and [trading.md](trading.md#before-live-orders). Live is never the default.

## 7. House rules

- **Storage.** Anything that needs a database is a Parquet file in the file store (S3), read and written with DuckDB through [parquet-store.ts](../src/lib/db/parquet-store.ts). No SQLite, and no DuckDB database file.
- **Dev and prod.** Work happens on dev (this checkout, port 3101). Prod runs only what the owner has pushed. Finished live sessions are copied from prod into dev's journal for analysis.
- **Where things run.** The frontend deploys to Vercel and the engine runs on the VM; see [AGENTS.md](../AGENTS.md).

## 8. Amendments

Only the owner changes this document. Each amendment records what changed, when and why in the log below. An agent that finds a principle in its way says so and proposes an amendment; it doesn't work around the principle.

| Date | Change | Why |
|---|---|---|
| 19 Nov 2026 | Written | A date-range backtester was proposed and rejected as drift from live prediction, the second such proposal after the research center and strategy store were parked on 18 Nov 2026 |
