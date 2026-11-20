# Roadmap

What has been built, what is being built and what comes next, in the order of the [constitution's](constitution.md#2-what-it-is) loop: record, predict, grade, trade on paper, go live. Every change that ships updates this file in the same change: move the item, add the date, link the document that explains it.

## Contents

1. [Now: Predict and Grade](#now-predict-and-grade)
2. [Waiting on the owner](#waiting-on-the-owner)
3. [Done](#done)
4. [Not doing](#not-doing)
5. [Known gaps in the data](#known-gaps-in-the-data)

## Now: Predict and Grade

Make every recorded minute count as a graded prediction, add the recorded data that isn't read yet, then let the decision API predict on a timer. Trading follows only what proves itself.

| Step | What | State |
|---|---|---|
| 1 | **Grade every minute.** Every signal, rule and baseline graded on every minute of every recorded day, 15 minutes later, in rupees from the recorded option prices after charges, against a coin flip at the same minutes. On the Pulse page | Built 19 Nov 2026. [predictions.md](predictions.md) |
| 2 | **Read the ignored data.** New readings in each minute's record, each fixed on the day it's written and graded from the next day: option buyers against sellers near the money (every option trade is recorded; only open interest is read), changes in the order book within the minute (big orders appearing or pulled; today one snapshot a minute is read), whether BANKNIFTY moves first (recorded, unread), and per-strike shifts in open interest and volatility from the chain | Next |
| 3 | **The decision API every 5 minutes.** Asked which way NIFTY goes in the next 15 minutes, by how much and how sure it is, with the richer context; its answers graded on the same scoreboard. Liquid, about 75 answers a day | Next, alongside step 2 |
| 4 | **Trade only on what's proven.** After 20 sessions, the trader follows the predictor that beat the baselines after costs, at the confidence where it's reliable | After 20 sessions |

Decided: the prediction window is 15 minutes (19 Nov 2026; 30 can be added later). To decide with step 3: Liquid for the timed predictions (proposed, since OpenRouter's free model allows 50 answers a day).

## Waiting on the owner

| What | Why it matters |
|---|---|
| Back up the journal to S3 | The disk holds about 11 more trading days at about 5 GB a day (58 GB free on 19 Nov 2026). Order books and chains can't be downloaded again. The owner is doing this as a separate exercise |
| Restart the dev engine | It runs the code below only after a restart |
| Push to prod when ready | Prod runs older code: no decision lab, no prediction scoreboard, no one-position Sell |

## Done

Newest first.

| Date | What | Where |
|---|---|---|
| 19 Nov 2026 | Prediction scoreboard: outcomes and calls stored per day, `GET /v1/predictions`, Pulse page panel, `npm run decide` prints it | [predictions.md](predictions.md) |
| 19 Nov 2026 | Constitution, linked from AGENTS.md | [constitution.md](constitution.md) |
| 19 Nov 2026 | Decision lab compares each rule with random trades on the same side, shows days ahead and day by day, and counts candidates only from their tested date | [trading.md](trading.md#decision-lab) |
| 19 Nov 2026 | Trailing stop with no target, in the lab (a third exit style) and the trader (a setting) | [trading.md](trading.md#trailing-stop) |
| 19 Nov 2026 | Three candidates, tested from 20 Nov: Trend day held, Breadth and OI build-up agree, Fade futures order flow | [trading.md](trading.md#decision-lab) |
| 19 Nov 2026 | Sell one open position by hand: its own `sell` command, so an older engine refuses it instead of selling everything | [trading.md](trading.md#using-it) |
| 19 Nov 2026 | Data check of 18 and 19 Nov: both complete (see the gaps below) | [research.md](research.md) |
| Before 19 Nov 2026 | The engine, journal, replay, research recorder (futures, options, 20-level depth, chain), paper trading with the decision API gate and shadow book, the decision lab, the scalp lab, volatility exits | [engine.md](engine.md), [trading.md](trading.md) |

## Not doing

Decided against; each needs an [amendment](constitution.md#8-amendments) to come back.

| What | Decided | Why |
|---|---|---|
| Date-range backtester (pick dates and settings, compare setups) | 19 Nov 2026 | Tools like that exist; the app's edge is live data and the decision API |
| Research center and strategy store | 18 Nov 2026 | Too complicated, and strategy builders exist. Parked on branch `research-and-strategy-store` |
| A machine-learning model trained now | 19 Nov 2026 | On two days of order books it would memorise them; on a year of candles it only sees price and breadth, which were coin flips |
| Option selling, spreads, futures trading | 19 Nov 2026 | Long options only, by the constitution |

## Known gaps in the data

- **18 Nov 2026:** option chain snapshots missing 09:15–09:53 and 09:57–10:04 (prod and dev both asked Dhan for chains; dev's chain recording is off since).
- **16 and 17 Nov 2026:** no option prices or futures, so they're graded on direction only.
- **The decision API** has 17 recorded answers in all (14 on 18 Nov, 3 on 19 Nov): far too few to judge it until step 3.
