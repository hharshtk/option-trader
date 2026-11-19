# Trading

How the engine trades: what is built, how to run it, and how each number is computed. Written 2026-11-16. For the engine itself see [engine.md](engine.md); for the signals it follows see [pulse.md](pulse.md); for the plan this came from see [engine-plan.md](engine-plan.md#trading).

## Contents

1. [In one paragraph](#in-one-paragraph)
2. [What is built](#what-is-built)
3. [Using it](#using-it)
4. [How a trade happens](#how-a-trade-happens)
5. [Settings](#settings) ([Scalping](#scalping))
6. [Scalp lab](#scalp-lab)
7. [Decision lab](#decision-lab)
8. [Decision API](#decision-api)
9. [Paper fills](#paper-fills)
10. [Charges](#charges)
11. [Limits](#limits)
12. [Option contracts and recording](#option-contracts-and-recording)
13. [Runs and storage](#runs-and-storage)
14. [Replays](#replays)
15. [Control API](#control-api)
16. [Before live orders](#before-live-orders)
17. [Code layout](#code-layout)
18. [Testing and changing it](#testing-and-changing-it)

## In one paragraph

The engine paper-trades NIFTY options. At the close of every minute it reads the same signals the Pulse page shows; when the one it follows fires, it proposes buying a call (long) or a put (short), asks the decision API whether the market context supports the trade, checks its limits, and fills a paper order against the option's quote. Positions are sold on a stop, a target, a hold time, an opposite signal or the square-off time. Every fill carries Dhan's charges, so results are after costs. It runs the same way on the live feed and on a replayed day, shows everything on the Strategies and Activity pages, and stores each run as Parquet files queried with DuckDB.

## What is built

| Piece | State |
|---|---|
| Strategy: follow one Pulse signal with long options | Built |
| Decision API as a gate on entries, with a shadow book for what it turns down | Built |
| Limits: entry window, trades a day, daily loss, losses in a row, premium, spread, stale quotes, square-off | Built |
| Paper fills against the order book, a last price or 1-minute candles | Built |
| Dhan's charges on every fill | Built, checked against Dhan's calculator |
| Option contracts loaded by the engine; today's file downloaded when missing | Built |
| NIFTY options around the money subscribed in Full mode and journaled | Built |
| Runs stored as Parquet (S3 when configured), read back with DuckDB | Built |
| Strategies and Activity pages | Built |
| Live orders through Dhan | Not built. See [Before live orders](#before-live-orders) |
| Several positions at once (**Positions at once**, default 1) | Built |
| Futures, option selling, spreads | Not built |
| Scalp lab: second-by-second triggers on NIFTY's future, scored after charges, never traded | Built. See [Scalp lab](#scalp-lab) |
| Decision lab: every decision rule scored over every recorded day, after costs, never traded | Built. See [Decision lab](#decision-lab) |

Nothing here can reach Dhan's order API: there is no code that places an order.

## Using it

**At the top of Strategies:** hover over the settings icon (or tab to it) for every setting in force as short label and value pairs, grouped as entries, exits, limits, AI check and fills. While trading is stopped for the day (the daily loss limit, losses in a row, or Stop for the day), a red bar across the top of every page says so, when and why, until you resume or the next session starts.

1. Restart the engine so it runs this code (`npm run engine`, or the systemd service).
2. Open **Strategies**. Beside the buttons a small indicator says what trading is doing ("Looking for a signal" with a live dot while it waits for the followed one). The **Signals** table shows each signal's reading at the last minute close, the line it must cross and how close it is, how it has done today at your hold time, and when it last fired and what NIFTY did next. The ⓘ beside a signal opens a guide with a tab per signal: what it watches, when it votes, why it stays silent, a right and a wrong example from 18 November 2026, its live record today and its past year. **Open positions** appear above **Trades**, in the same columns, only while something is open.
3. Press **Start paper trading**. Entries are off until you do; the choice is kept across restarts.
4. Watch **Strategies** for positions and P&L, and **Activity** for the log, the proposals and the orders.

To try it with the market closed, start a replay on the Engine page (or `npm run engine:replay -- --date 2026-11-16 --speed 60`). Trading starts a new run on the replayed day and trades it as it plays.

| Button | Does |
|---|---|
| Start paper trading / Turn entries off | Arms or disarms entries. Open positions keep their exits either way |
| Sell open position(s) | Sells everything that is open now |
| Stop for the day | Sells what is open and takes no more entries until you press Resume or the next day starts |

**What starts on its own.** With entries off the engine still reads the signals and, when "Record these options every session" is on (the default), keeps the option window subscribed so the journal records it. It never opens a position with entries off.

## How a trade happens

```
feed frame ──► quotes ──► fill due orders ──► stops, targets, hold time, square-off
minute close (+1.5 s) ──► Pulse signals ──► sell on an opposite signal
                                        └─► followed signal fired?
                                              quiet checks (entries on, window, limits, room for a position)
                                              contract: nearest expiry, strike by the offset
                                              fresh quote; premium and spread limits
                                              decision API ──► approved ──► buy on the paper book
                                                           └─► turned down ──► buy on the shadow book
```

- **Signals** come from `computePulse()` on the day's journal, the same call the Pulse page makes, read 1.5 seconds after each minute closes. The strategy follows one of: Breadth thrust, Basket leads index, 15-minute momentum, Futures order flow, Futures OI build-up, Option writers, Order book lean, Two or more agree, Confirmed by futures and options ([pulse.md](pulse.md#signal-lab)). None has shown an edge after costs: the price signals were coin flips over a year, and the futures and options ones have days, not years, of data.
- **Positions at once** (default 1) caps how many positions the paper book holds together. A signal that fires while that many are open is ignored. With more than one allowed, a signal that stays on buys again once **Wait after a trade** has passed since the last buy. The cooldown counts from buys as well as sells, so the engine doesn't buy every minute. Each position keeps its own stop, target and hold time. **Most premium a trade** applies to each position, so the most premium at risk is that limit times **Positions at once**. The daily loss limit counts every open position.
- **Proposals** are recorded once they pass the quiet checks, with the reason when they aren't traded.
- **Exits** are the engine's own and never wait for the decision API. In the Standard style each trade's stop and target are, by default, worked out when it is proposed from how much NIFTY is moving (see [Volatility exits](#volatility-exits)); the decision API is told them.

## Settings

Set on the Strategies page; kept in `data/engine/trading/config.json`. They apply from the next entry; an open position keeps the stop and target it was opened with.

| Setting | Default | Meaning |
|---|---|---|
| Follow signal | Two or more agree | Which Pulse signal fires entries |
| Or lab rule | None | A candidate from the [decision lab](#decision-lab) decides entries instead of the signal |
| Cost check | Off | Every entry must pass the lab's cost check |
| Trade | Calls on long, puts on short | Or calls only, or puts only |
| Strike | At the money | Up to 2 strikes in or out of the money |
| Lots | 1 | Quantity is lots × the contract's lot size |
| Hold | 10 min | Sold this long after the buy filled |
| Stop and target | From NIFTY's moves | Or fixed percents. See [Volatility exits](#volatility-exits) |
| Stop / target, with volatility exits | 1× / 2× NIFTY's typical move over the hold | In option rupees, as a share of the premium |
| Stop loss / Target | 20% / 30% of premium | Fixed exits; with volatility exits, used only while NIFTY's movement isn't known. 0 turns either off |
| Style | Standard | Or **Scalping** (see [Scalping](#scalping)). Hold, stop, target and wait above are Standard's |
| Scalping: take profit / cut loss | ₹250 / ₹250 after charges | 0 turns either off |
| Scalping: sell anyway after / wait between trades | 3 min / 0 min | Scalping's own hold and wait |
| Sell on an opposite signal | On | |
| Skip expiries nearer than | 0 days | 0 trades the nearest expiry, on expiry day too |
| Entries from / until | 09:25 / 14:45 IST | |
| Sell everything at | 15:10 IST | |
| Trades a day | 12 | Open positions count towards it |
| Positions at once | 1 | 1 to 10. The shadow book follows the same cap |
| Stop the day at a loss of | ₹3,000 | After charges, open position included |
| Or after losses in a row | 4 | |
| Most premium a trade | ₹25,000 | Premium × quantity |
| Least premium | ₹5 | |
| Widest spread | 3% | Only checked when the order book is known |
| Wait after a trade | 2 min | Counted from the last buy or sell |
| Oldest quote to trade on | 10 s | |
| Decision role | Gate | Gate, Shadow or Off |
| Take a trade at | 0.55 | The model's probability |
| Turn down trades against the regime | On | A long in "trend down", a short in "trend up" |
| No answer in time | Skip the entry | Or take it |
| Wait at most | 4,000 ms | |
| Slippage past the bid or ask | ₹0.05 | |
| Slippage with no order book | ₹0.50 | Stands in for the spread |
| Order delay | 300 ms | |
| Option strikes kept on the feed | 6 each side | 26 contracts |

The defaults are starting points, not fitted values.

### Volatility exits

A fixed percent ignores the market: on 18 November 2026 a 20% stop on a ₹170 option was about 68 NIFTY points away while NIFTY typically moved 20 in 10 minutes, so in the decision lab 14 trades of 642 reached it at a 10-minute hold and none reached the 30% target; trades simply ran out of time. Volatility exits ([exits.ts](../src/lib/trading/exits.ts) `volatilityExits`) set each trade's own levels from the market when it is proposed:

- NIFTY's **typical move over the hold** is measured from what it actually did ([moves.ts](../src/lib/trading/moves.ts)): the average size of its move over the hold, starting within 5 minutes of the same time of day, over the last 20 trading days. Then it is scaled by how busy today is against those days at the same time (each day's average 1-minute move over the last 30 minutes), counted half (the square root of the ratio) and kept between 0.67× and 1.5×: a wild or quiet morning only partly carries on. The days come from the 1-minute candle history and from the decision lab's per-minute tables, which every engine builds from its own journal after each session, so the history keeps itself current with no download ([move-history.ts](../src/engine/trading/move-history.ts)). With fewer than 5 days stored, today's average 1-minute move times the square root of the hold stands in, and the log says so.
- Why measured and not scaled: at 09:31 on 18 November 2026 the scaled 1-minute move said NIFTY would move 111 points over 55 minutes (the opening's swings, and minute moves that partly cancel out); the last 20 days at that time said 77 (85 with that morning's busyness); NIFTY moved 40. Over the day the measured estimate missed by 27 points on average for a 55-minute hold against 32 for the scaled one, and by 12.0 against 12.9 for 10 minutes. Single hours vary a lot (16 to 70 points that day): no estimate is exact, but this one is what NIFTY really does at that time.
- Times the option's **delta** (from its price, on the forward) it is how far the premium typically moves: about ₹9.50 on an at-the-money option.
- The **stop** sits 1 of those below the entry and the **target** 2 above (**Stop / target, with volatility exits**), kept between 2% and 60% (stop) and 300% (target) of the premium. A followed decision lab rule keeps its own target-to-stop ratio (Trend day: 3).
- When NIFTY's movement isn't known yet (the first minutes, a feed gap), the fixed percents apply and the log says so. The Activity log shows each trade's levels and the move they came from (the recent days' figure and today's scale), and the settings summary says which days are in use.

What it does, from the decision lab on 18 November at a 10-minute hold, trading at random moments: 379 trades of 642 ended on their stop or target instead of 14, the worst trade lost ₹1,335 instead of ₹2,571 and the average loss was ₹648 instead of ₹723. The average result is about the same (−₹111 a trade against −₹105): exits can't make a coin-flip entry pay; they size its losses and let a rule with an edge keep its winners.

### Scalping

The Settings panel shows every setting at once, with no tabs: a **Standard / Scalping** switch in its header, then five sections (Buy, Exits, Limits, AI check, Fills and recording). The Exits section shows the style in use: Scalping's take-profit, cut-loss, hold and wait, or Standard's. Save keeps it. In config.json the style is `strategy.exitIn` (`"rupees"` is Scalping), with `strategy.targetNet`, `strategy.stopNet`, `strategy.scalpHoldMinutes` and `risk.scalpCooldownMinutes`.

With the stop and target in rupees, each entry fill works out the sell prices from [exits.ts](../src/lib/trading/exits.ts): the price at which the trade nets the amount after Dhan's charges on both orders (`sellPriceForNet` in charges.ts, solved exactly), plus the sale's slippage, rounded up to the tick. So the sale, not the trigger, nets the amount; a stop loses at most its amount unless the price jumps past it. Rupee levels trigger on the bid when the order book is known (what the position can be sold for), not on the last trade as percent levels do. The Activity log shows each position's target, stop and breakeven price.

What the charges mean for a scalp: one lot of 65 bought (filled) at ₹100 pays about ₹63 a round trip in charges, and the sale loses ₹0.05 a unit to slippage, so the option must rise about ₹1.00 just to break even. A ₹250 target sells at ₹104.90; a ₹250 stop at ₹97.20. The Strategies page shows these figures for your lots as you type. A stop smaller than the charges can't be met (selling at the entry already loses more); it is put one tick below the entry and the log warns. Entries are still decided at each minute's close; exits are checked on every quote.

## Scalp lab

Scalping mode changes how trades exit; the entries still come from the Pulse signals, read once a minute. The scalp lab is research towards a faster trigger. In [scalp-lab.ts](../src/engine/trading/scalp-lab.ts), it watches NIFTY's near-month future second by second and scores three triggers as pretend trades. **It never places a trade, paper or real.**

| Trigger | Fires when | Buys |
|---|---|---|
| Burst with buyers | The future moves 4.3+ points in 10 s and 75%+ of the volume traded on that side (at the ask going up, at the bid going down) | With the move |
| Fade a spike | The future moves 10+ points in 30 s | Against it |
| Fade the order book | Waiting buy versus sell orders (Dhan's total buy and sell quantity) lean 5%+ further to one side than their 15-minute average | The other way |
| No signal | Every 2 minutes, a call then a put | The baseline: what trading costs with no edge |

Each firing buys one lot of the at-the-money option of the trader's expiry at the ask + ₹0.05, 300 ms later, and sells at the bid − ₹0.05 after 30 s, 1, 2 and 3 minutes, paying Dhan's charges on both orders. A trigger waits a minute before firing again. Nothing fires in the first minute or in the last 5 minutes of the session. The levels were set from 18 November 2026 (the top or bottom 5–10% of each reading that day) and are fixed, so later days test them honestly.

**Where to see it.** The **Scalp lab** panel on Strategies shows each trigger's average net a trade at each hold, how many it won, and the latest firings. It runs on the live feed and on replays, and starts over with each run (an engine restart loses the day's lab; score the day again from the journal). The future comes from the index futures table the recorder uses; the recorder keeps it on the live feed.

**Scoring a recorded day:** `npm run scalp:lab -- 2026-11-18` runs the same code over the day's journal (about 12 s for a full day). Days before 18 November have no futures or order books recorded.

**18 November 2026, the first day with order books:** nothing beat the costs. A trade at a random moment lost about ₹100 a lot after charges, spread and slippage at any hold from 30 s to 3 minutes; that is the bar. Per trade, net:

| | 30 s | 1 min | 2 min | 3 min |
|---|---|---|---|---|
| Burst with buyers (152) | −₹101 | −₹100 | −₹139 | −₹152 |
| Fade a spike (129) | −₹106 | −₹83 | −₹57 | −₹94 |
| Fade the order book (63) | −₹68 | −₹55 | −₹34 | −₹89 |
| No signal (168) | −₹87 | −₹102 | −₹137 | −₹142 |

The future moves about 5 points in 30 s and 13 points in 3 minutes, while a round trip in an at-the-money option costs about ₹1.50 a unit, or 3 NIFTY points at a delta of 0.5. Momentum and trade flow shifted the next minute by about a point. An earlier version of the order-book trigger, against a fixed level, made money in the morning and lost it in the afternoon: it was following the day's drift. One day proves nothing; the lab is there to collect the days. A trigger would need to stay clearly above zero, and above No signal, over weeks before anything trades on it.

## Decision lab

The quick, honest test of a decision rule across days. Paper trading tests one setting on one day as it plays; the lab plays every rule over every recorded day in seconds. **It never places a trade.**

**What a rule sees.** At the close of each minute, one record of everything the engine knows then: NIFTY, India VIX and how far NIFTY has been moving, breadth, the near-month future (premium, VWAP, open interest, who is trading, the 5- and 20-level book, the spread), the options in the journal's window (put/call ratio, straddle, walls, max pain), the option chain (volatility from bid-ask middles, skew, the next expiry, open interest across every strike) and every Pulse signal's vote and reading. The fields and their meanings are in [state.ts](../src/lib/decide/state.ts) and under **What a rule sees** on the Strategies page. The record is built from the day as it stood at that minute (read 1.5 seconds after its close, as the trader reads its signals), never from the day's end, so nothing from later leaks in.

**A rule** is a plain function of that record (and the minutes before it): buy a call, buy a put or do nothing ([rules.ts](../src/lib/decide/rules.ts)). The bars are **No signal** (a call, then a put 15 minutes later, and so on; averaged over all 30 starting minutes and sides, since one fixed schedule can line up with a day's swings by chance) and one rule per Pulse signal, following it as the trader does. Then the **candidates**, written on 18 November 2026 with that day already seen, so only days from 19 November test them, and not to be tuned on the days that score them. Each trades rarely, with a target bigger than its stop, so it can be right less than half the time and still pay:

| Candidate | Buys when | Exits |
|---|---|---|
| Trend day | From 10:00 to 14:00: NIFTY 0.25% or more from its open, 10 more of its stocks on that side than the other, and the future's buyers (or sellers) taking most of what traded over 15 minutes. With the trend | Stop 15%, target 45%, no exit on an opposite vote; at most 2 trades a day |
| Momentum when options are cheap | 15-minute momentum fires and NIFTY has lately moved at least as much as the at-the-money straddle prices | Stop 20%, target 40%; at most 3 a day |
| Fade at the walls | NIFTY climbed 0.15% or more in 15 minutes to within 0.15% of the strike with the most call open interest (whole chain, else the journal's window): a put. The mirror at the biggest put strike: a call | Stop 15%, target 45%, no exit on an opposite vote; at most 2 a day |

**The cost check** ([cost.ts](../src/lib/decide/cost.ts)), a gate on any rule with no AI in it: Dhan's charges, the spread, slippage both ways and the time value lost over the hold, divided by the option's delta, is the NIFTY move a trade needs to break even. A trade is let through only when NIFTY's typical move over the hold (its recent 1-minute move scaled to the hold) is at least 3 times that. The scorecard shows every rule with it off and on. On 18 November a trade needed about 4 points and NIFTY typically moved 17 to 45 over 10 minutes, so it almost never stood in the way: costs, about ₹100 to ₹130 a trade, were small next to the moves, and the difficulty was the direction. It matters on quiet days and close to expiry.

**Options priced against NIFTY delivered.** Each day the lab averages, over every minute, the move over 10 minutes that the at-the-money straddle priced and the move NIFTY then made. Delivered above priced, buying options paid that day; below, it was dear. 18 November: options priced 30 points, NIFTY moved 20.4. Part of the gap is the overnight and weekend risk options also price, which an intraday move never shows, so the priced figure reads a little high.

**How a rule is played** ([simulate.ts](../src/lib/decide/simulate.ts)): the trader's own rules. A firing from 09:25 to 14:45 buys one lot of the nearest expiry's at-the-money option at the ask + ₹0.05; it is sold when the hold is up, at its stop or target (on the last price), on an opposite vote or at 15:10; one position at a time, 2 minutes between trades; Dhan's charges on both orders. Every rule is scored with fixed exits (20% stop, 30% target, or a candidate's own) and with [volatility exits](#volatility-exits) worked out at entry exactly as the trader does. Quotes are those at each minute's close, with each option's lowest and highest last price within the minute: a stop or target crossed inside a minute is sold at its level less half the spread and ₹0.05, as paper trading's tick-by-tick check would (both crossed in one minute: the stop is taken first); other exits sell at the bid − ₹0.05 at the minute's close. Each rule is scored at holds of 5, 10, 15 and 30 minutes.

**Where to see it.** The **Decision lab** panel on Strategies: per rule at the chosen hold, with exits following NIFTY's moves or fixed, the cost check off or on, trades, how many made money, the net after costs, per trade, against No signal, and the worst day; each day's priced against delivered move. The engine rebuilds it 10 minutes after each session's close, in a child process. By hand:

```bash
npm run decide                       # build days not built yet, score every rule, print the scorecard
npm run decide -- --date 2026-11-18  # build that day again, then score
npm run decide -- --score            # score only (after changing a rule)
```

**Following a rule with paper trading.** In Settings, Buy section, **Or lab rule** makes the trader take its entries from a candidate's function on the minute's record, the one the lab scores, with its window and daily cap; choosing one also sets its stop, target and opposite-vote exit. **Cost check** puts every entry through the same check. The signal still shows on the page; a turned-down entry's reason is in the proposals. The decision API is told the rule's name as the followed signal, with no past-year record.

**Tables** (Parquet in the file store, [lab.ts](../src/engine/decide/lab.ts)): `decide/minutes/<date>` (one row a minute: the record), `decide/quotes/<date>` (the nearest expiry's options at each minute's close, with the minute's price range), `decide/days/<date>` (with the day's priced and delivered move), `decide/trades/<date>` (every rule's trades at every hold, cost check off and on, fixed and volatility exits, with each trade's stop and target).

**Which days count.** A day needs NIFTY's options recorded with the `instruments` records that describe them: from 18 November 2026. 16 and 17 November are built but have no option quotes, so they aren't scored.

**18 November 2026, the first day:** a trade at a random moment lost about ₹107 a lot at a 5- or 10-minute hold (₹146 at 15 and 30 minutes). Most signals did worse than that. Basket leads index and Two or more agree did better on 5 trades or fewer, which is nothing to go on. The candidates traded 2 or 3 times each (Fade at the walls not at all: the walls stayed far from NIFTY); they were written that day, so it doesn't count for them. One day is one day: a rule must beat No signal, after costs, over weeks of days it wasn't tuned on.

## Decision API

Two providers answer the same questions in the same way; **Provider** in the Strategies page's settings picks one, and choosing it also sets that provider's default model:

| Provider | Key in `.env.local` | Default model | Price | Tried in |
|---|---|---|---|---|
| OpenRouter's Decisions API | `OPENROUTER_API_KEY` | `perplexity/pplx-decider-v1.3:free` | Free models: 50 answers a day, 1,000 once the account has bought $10 of credit; 20 a minute | [scripts/decision-demo.ts](../scripts/decision-demo.ts) |
| Liquid's decisions API | `LIQUID_API_KEY` | `d1.2-ultra` | $0.042 per million input tokens, nothing for output: about $0.00006 an answer | [scripts/liquid-decision-test.ts](../scripts/liquid-decision-test.ts) |

The clients are in [decision.ts](../src/engine/trading/decision.ts) (`createOpenRouterDecisions`, `createLiquidDecisions`); the engine builds one per key at start, so a new key needs a restart. Measured 17 November 2026 with the trader's questions and a full context: Liquid about 0.5 s and 1,330 input tokens an answer. Answers recorded for replays are keyed by model, so switching provider never reuses the other's answers.

For each proposal the engine sends the market context as JSON and three typed questions:

| Question | Type | Answer |
|---|---|---|
| `take_trade` | noul | Probability that the context supports the trade |
| `regime` | choice | trend_up, trend_down, range or chop |
| `quality` | score | How well supported the move is, from fragile to broad |

**What it is sent** (state version 3, from 18 November 2026), grouped by what a trader checks before buying an option. Each fact appears once, with its unit in its name. Nothing about the account. To see the exact JSON for an answer, open **Show** in the Decision API table on the Strategies page.

| Section | Holds | Why |
|---|---|---|
| `time` | IST time, weekday, minutes since the open and to the close | |
| `proposal` | Direction, the signal followed and the signals that agree, contract, premium, hold, stop, target | What is being judged |
| `trade_math` | Costs and spread as a share of the premium; the option's delta, implied volatility and time value lost over the hold; **the NIFTY move that pays for the trade** (costs, spread and decay over delta); the move the target needs and the move that hits the stop; the move NIFTY typically makes over the hold, as priced by the at-the-money straddle and as NIFTY has actually moved lately | The question that decides a short option hold: is the expected move comfortably bigger than the break-even move? A 30% target on an at-the-money weekly needs about 100 points in 15 minutes, which the typical move rarely reaches |
| `nifty` | Last, change, move from the open, day high and low, place in the range, last 15 minutes and the last 15 one-minute closes | |
| `volatility` | India VIX and its change, NIFTY's average 1-minute move, option volatility since the open | |
| `breadth` | NIFTY's 50 stocks: up, down, weight above VWAP, pending-order imbalance | |
| `futures` | The near-month future: premium over NIFTY and its 15-minute change, distance from VWAP, open interest change (15 minutes, today), positioning (long or short build-up, short covering, long unwinding), buyers' share of traded volume (5 and 15 minutes), net lots, book imbalance | Whether money is committing to the move. Null on days without futures |
| `options_positioning` | Near the money (10 strikes each side): put/call open interest ratio now, 15 minutes ago and at the open; lots of calls and puts written in 15 minutes and today; the biggest call strike above and put strike below; max pain | Where option writers expect NIFTY to stop. Null on days without options |
| `option_chain` | From the chain snapshots: at-the-money volatility (from bid-ask middles) and its change in 15 minutes and since the first snapshot, the put-minus-call skew 1% out, the next expiry's volatility, and across every strike the put/call open interest ratio, lots added today and the biggest call and put strikes; how old the snapshot is | Volatility rising or falling changes what an option costs over the hold, apart from NIFTY's move |
| `signals` | Every signal's reading and vote | |
| `trigger_track_record` | The followed signal today at the hold (trades, right, points) and over the past year from the research study, or that it has no history yet | The base rate: a model that knows the trigger is a coin flip judges on the context instead |
| `pulse_verdict`, `sectors_last_15_minutes`, `concentration`, `strategy_today` | As before | |

Version 1 also sent Pulse's evidence lines; they repeated numbers already in the state, so version 2 drops them. Version 3 adds the future's 20-level book (`book_imbalance_20_levels`, `orders_imbalance_20_levels`, `bid_ask_spread_points`) and an `option_chain` section from the chain snapshots: at-the-money volatility worked out from bid-ask middles and its changes, the skew, the next expiry's volatility, and put/call open interest, lots added today and the walls across every strike. Both are null on a day without side files. Measured on 18 November 2026 at 12:04: about 3,600 characters a request (Liquid charges about $0.00006).

**What it is asked:** the `take_trade` question names the break-even and expected moves and the trigger's record, and its criteria include futures and option positioning. Recorded answers are keyed by the questions' hash and by `STATE_VERSION`, so a replay never reuses an answer given to other questions or another shape of context.

**Roles:**

| Role | Effect |
|---|---|
| Gate | A trade is taken when the probability is at least the threshold and it isn't against the regime. Otherwise it goes to the shadow book |
| Shadow | Every trade is taken; the answer is recorded beside it |
| Off | Not asked |

**The shadow book** follows each trade the gate turned down with the same exits, so you can see what it would have made. The Decision API panel compares the two groups after charges: the gate earns its place when approved trades do better than turned-down ones. On the one replayed day tried so far (16 November, Breadth thrust) the turned-down trades did better, which says nothing yet either way: judge it over many stored runs.

**Rules it works under:**

- It can turn an entry down or annotate it. It never sizes a trade, never opens one, and exits never wait for it.
- No answer within the time limit means no entry, unless "No answer in time" is set to take it.
- A turned-down signal isn't asked about again while its shadow trade is running.
- Measured 16 November: 0.5 to 1.4 seconds an answer, about 440 input tokens, free on `perplexity/pplx-decider-v1.3:free`.

## Paper fills

| Quote in hand | Buy fills at | Sell fills at |
|---|---|---|
| Order book (the contract streams in Full mode) | Best ask + slippage | Best bid − slippage |
| Last price only | Last price + ₹0.50 | Last price − ₹0.50 |
| 1-minute candle (a replay of a day recorded without options) | Close of the last finished minute + ₹0.50 | Stop or target: at its level if the minute crossed it, at the minute's open if it started beyond it. Otherwise the last close. Then − ₹0.50 |

- Prices round to the contract's tick against you.
- An order fills on the first quote after the order delay. An entry with no fresh quote for 15 seconds is dropped. An exit waits up to a minute for a fresh quote, then sells against the last one.
- Stops and targets trigger on the last traded price; the position's running P&L uses the bid when the book is known.
- A candle that holds both the stop and the target counts as the stop.

**Not yet checked against the market:** the bid and ask come from the five depth levels in Dhan's Full packet, parsed from Dhan's documented layout. No Full packet had been recorded when this was written. On the first live session, compare the bid and ask on the Activity page's Orders table with Dhan's own screen.

## Charges

In [charges.ts](../src/lib/trading/charges.ts), used by the engine and by the Pulse page's option replay.

| | Options | Futures |
|---|---|---|
| Brokerage | ₹20 an executed order | Same |
| STT | 0.15% of sell premium | 0.05% of sell value |
| Exchange transaction charge | 0.03503% of turnover | 0.00173% |
| IPFT | 0.0005% of turnover | 0.0001% |
| SEBI fee | 0.0001% of turnover | Same |
| Stamp duty | 0.003% of buy value | 0.002% |
| GST | 18% of brokerage, exchange, IPFT and SEBI charges | Same |

Dhan's calculator computes on its server and publishes no formula. These rates reproduce its result of 16 November 2026 to the paisa (one NIFTY lot of 65, bought at 22.85, sold at 25.00):

| | Dhan | charges.ts |
|---|---|---|
| Brokerage | ₹40.00 | ₹40.00 |
| Exchange transaction charges (shown with IPFT) | ₹1.11 | ₹1.11 |
| GST | ₹7.40 | ₹7.40 |
| Total tax and charges | ₹50.99 | ₹50.99 |
| Net P&L | ₹88.76 | ₹88.76 |
| Breakeven | ₹23.63 | ₹23.63 |

Dhan's STT line shows ₹2.00, rounded to the rupee; its total uses the unrounded ₹2.44, as this module does. STT rose on 1 April 2026 (options 0.1% to 0.15%, futures 0.02% to 0.05%); the earlier rates in Pulse were out of date. A contract note rounds STT to the rupee per day, so a day's real total can differ by under a rupee.

## Limits

| Check | When it fails |
|---|---|
| Entries on, not stopped for the day, inside the entry window | No proposal |
| Fewer than **Positions at once** open, cooldown over, trades a day not reached | No proposal |
| NIFTY's price fresh | Proposal rejected: the feed may be down |
| Contract exists; its quote is fresh | Rejected |
| Premium within the least and most; spread within the limit | Rejected |
| Decision gate | Shadow book, or rejected when it didn't answer |
| Day's net P&L, open position included, at the loss limit | Day stopped, positions sold |
| Losses in a row | Day stopped |
| Square-off time | Everything sold |

A stopped day stays stopped across an engine restart. The `trading` health component turns degraded when the day is stopped, the contracts are missing, the tables can't be saved, or the decision API has no key.

## Option contracts and recording

- **Contracts** are read from the instrument file in the app's file store (`instruments/options-scrip-master.parquet`) with DuckDB: NIFTY's three nearest expiries.
- **Daily download.** When a live day starts and the stored file is older, the engine downloads Dhan's file itself (the same download as Settings → Download option instruments), and tries again every 10 minutes until Dhan has published the day's file. Meanwhile it trades on the older file and says so. The download parses a large CSV and can stall the engine for up to a second, once, before the open.
- **Kept per day.** Dhan lists only unexpired contracts, so each live day's NIFTY contracts are saved as `reference/nifty-options/<date>.parquet`. A replay of that day reads them back.
- **Option window.** From 20 minutes before the open the engine subscribes calls and puts within 6 strikes of the money on the trading expiry, in Full mode, and adds strikes as NIFTY moves. They are journaled like everything else, so later replays have real option ticks and depth. Expect the journal to grow by roughly 100 MB a day.
- **Research recording.** Separately from trading, the engine's recorder streams wide option windows and all futures for NIFTY and BANKNIFTY, 20-level depth and option chain snapshots every trading day ([engine.md](engine.md#research-recording)). It shares the contract source with trading, so a stale instrument file is downloaded once.

## Runs and storage

A **run** is one market day traded from one source.

| Source | Run id | Notes |
|---|---|---|
| Live | `live-2026-11-17` | Starts 20 minutes before the open, ends a minute after the close. An engine restarted in the session continues it, open position included |
| Replay | `replay-2026-11-16-20261116221351` | A new run at every replay start and seek |

**Local files**, under `data/engine/trading/`:

| File | Holds |
|---|---|
| `config.json` | The settings |
| `runs/<run>.jsonl` | Every change in the run, appended as it happens. What a restart reads back |
| `decisions/<date>.jsonl` | The decision API's answers for that market day, for replays |
| `candles/<date>/<id>.json` | Dhan's 1-minute candles fetched for a replay, once the day is over |

**Tables**, Parquet files in the app's file store: S3 (`S3_BUCKET` and the other `S3_*` settings) or `DATA_DIR` without it. This is the app's database: there is no SQLite or DuckDB file. [parquet-store.ts](../src/lib/db/parquet-store.ts) reads and writes them through DuckDB, with its `httpfs` extension for S3.

| Key | Rows |
|---|---|
| `trading/<namespace>/runs/<run>.parquet` | One: the run, its settings and totals |
| `trading/<namespace>/trades/<run>.parquet` | Closed trades with every charge line and the decision's answer |
| `trading/<namespace>/orders/<run>.parquet` | Orders with the quote each filled against |
| `trading/<namespace>/intents/<run>.parquet` | Proposals and what became of them |
| `trading/<namespace>/decisions/<run>.parquet` | Decision answers and the context sent |

- **Namespace:** `main` for the engine on port 3100, `dev-<port>` for any other, so a development engine sharing the bucket never overwrites production's runs.
- **Saving:** a run's files are rewritten 3 seconds after each closed trade, every minute while anything changed, and when the run ends. If the store can't be reached the engine carries on from the local log and tries again.
- **Times** are stored as epoch milliseconds in DOUBLE columns.

Any DuckDB can query them:

```sql
INSTALL httpfs; LOAD httpfs;
CREATE SECRET (TYPE s3, KEY_ID '…', SECRET '…', ENDPOINT '<account>.r2.cloudflarestorage.com', URL_STYLE 'path', REGION 'auto');

-- Paper results by day, live runs only
SELECT date, sum(trades) AS trades, sum(net) AS net
FROM read_parquet('s3://<bucket>/option-trader/trading/main/runs/*.parquet')
WHERE source = 'live' GROUP BY date ORDER BY date;

-- Did the gate help? Approved against turned-down trades, after charges
SELECT decision_approved, count(*) AS trades, sum(net) AS net
FROM read_parquet('s3://<bucket>/option-trader/trading/main/trades/*.parquet')
WHERE decision_approved IS NOT NULL GROUP BY 1;
```

## Replays

Trading follows the feed, so the Engine page's replay drives it:

- **Time** is the recording's. Each frame carries the time it originally arrived.
- **Fast replays wait for slow work.** At speeds above ×1 the replay pauses while trading loads contracts, reads the signals and waits for the decision API, then carries on. The time an answer took is added to the fill delay instead, so a ×300 replay trades like a ×1 one.
- **Recorded answers.** A replay reuses the decision API's answer recorded for the same minute, direction, contract, model and questions, so a day trades the same way again. A proposal with no recorded answer is asked live.
- **Days recorded without options** (16 November 2026 and earlier) take option prices from Dhan's 1-minute candles, which needs a valid token and the Data API plan. Dhan stops serving a contract's candles after it expires, so the candles are cached on disk once fetched.
- **A seek ends the run** and starts another: positions can't be carried across a jump.

## Control API

Added to the engine's control API ([engine.md](engine.md#control-api)); the web reaches them through `/api/engine/v1/…`.

| Endpoint | Returns |
|---|---|
| `GET /v1/trading` | `TradingStatus`: state, settings, run, contracts, signals, positions, trades, orders, proposals, decisions, log, totals |
| `POST /v1/trading` | A command: `{ action: "arm" }`, `"disarm"`, `"flatten"`, `"halt"`, `"resume"`, or `{ action: "config", patch }`. Answers `{ ok, message }` |
| `GET /v1/trading/decision?id=` | What was sent to the decision API for one of the current run's decisions: `{ id, model, questions, state }`. The Strategies page shows it under **Sent** in the Decision API table |
| `GET /v1/trading/history?run=` | Stored runs, newest first, read from Parquet; with `run`, that run's trades |
| Telemetry topic `trading` | The status about once a second while anything changes. The lists (trades, orders, proposals, decisions, log) are included only when they changed; a page reads `GET /v1/trading` once for the rest |

Types are in [trading.ts](../src/lib/engine/trading.ts).

## Before live orders

Live orders are a separate step (E8 in the [engine plan](engine-plan.md#e8-live-orders)), and not a switch in this code. What it needs:

1. **Paper results first.** The go-live gate in the engine plan: weeks of live-feed paper runs, positive after charges, and the same days replayed giving the same trades.
2. **A static IP whitelisted with Dhan.** Dhan refuses orders from any other address, and the whitelist can change only once every 7 days. The VM's IP is still ephemeral.
3. **A Dhan adapter** next to [paper-broker.ts](../src/engine/trading/paper-broker.ts): place and cancel with a correlation id, fills from the order-update WebSocket, reconciliation against Dhan's positions.
4. **Broker-side protection:** exits as Super Orders, `/pnlExit` set, `/killswitch` tested.
5. **Depth checked** against the market (see [Paper fills](#paper-fills)), since paper fills are only as good as the quotes.

## Code layout

```
src/lib/trading/charges.ts            Dhan's charges, shared by engine and web
src/lib/trading/exits.ts              stop and target prices, in % or in rupees after charges (scalping)
src/lib/engine/trading.ts             types and settings shared by engine and web
src/lib/db/parquet-store.ts           Parquet tables in the file store, through DuckDB
src/engine/trading/
  trader.ts                           runs, proposals, orders, exits, limits, status, commands
  strategy.ts                         reads the followed signal from Pulse
  decision.ts                         questions, context (state version 3), the gate's rules, the OpenRouter and Liquid clients
  paper-broker.ts                     fill prices
  market.ts                           latest quote per instrument
  contracts.ts                        NIFTY contracts: expiries, strikes, the day's snapshot
  sources.ts                          instrument file download and Dhan candles
  run-log.ts                          the run's local log and reading it back
  store.ts                            the Parquet tables
  scalp-lab.ts                        fast triggers on the future, scored after charges, never traded
  scalp-lab-cli.ts                    npm run scalp:lab: scores a recorded day
src/lib/decide/
  state.ts                            what a rule sees at each minute, from Pulse
  rules.ts                            the decision rules
  simulate.ts                         plays a rule over a day with the trader's prices, exits and charges
  score.ts                            the scorecard, and what options priced against what NIFTY delivered
  cost.ts                             the cost check, shared with the trader
src/engine/decide/
  day-table.ts                        a recorded day, minute by minute as it stood then
  lab.ts                              the tables, building and scoring
  job.ts                              runs the lab after each session; serves GET /v1/decide
  cli.ts                              npm run decide
src/components/trading/               Strategies and Activity pages; signal-guide.tsx explains each signal
src/app/(cockpit)/strategies/         route and the command Server Function
src/app/(cockpit)/activity/           route
```

The engine's feed passes every frame, with its market time, to `trader.onFrame()` ([feed.ts](../src/engine/feed.ts)); [main.ts](../src/engine/main.ts) ticks the trader once a second and wires its sources.

## Testing and changing it

`npm run test:engine` covers the trader end to end on fakes ([trader.test.ts](../src/engine/trading/trader.test.ts)) its parts ([parts.test.ts](../src/engine/trading/parts.test.ts)) and the decision API's context ([decision-state.test.ts](../src/engine/trading/decision-state.test.ts)); `node --test src/lib/trading/*.test.ts src/lib/db/*.test.ts` covers charges and the Parquet store. No test calls Dhan, OpenRouter or S3.

To run a whole day against the real services without touching either running engine, start a third engine on a copy of a journal:

```bash
mkdir -p /tmp/try/journal && cp data/engine/journal/2026-11-16.bin /tmp/try/journal/
ENGINE_PORT=3199 ENGINE_DATA_DIR=/tmp/try npm run engine:replay -- --date 2026-11-16 --speed 300
```

Its tables go to `trading/dev-3199/`.

| To | Change |
|---|---|
| Add a signal | Add it in `computePulse()` ([pulse.md](pulse.md#changing-it)), then to `SIGNALS` in trading.ts and its explanation to `GUIDE` in [signal-guide.tsx](../src/components/trading/signal-guide.tsx). `readSignal()` in strategy.ts reads every Pulse signal by itself |
| Change a charge rate | `OPTION_RATES`, `FUTURES_RATES` in charges.ts; keep charges.test.ts matching a fresh calculator result |
| Change what the decision API is asked | `QUESTIONS` and `buildDecisionState()` in decision.ts. Raise `STATE_VERSION` when the state changes. Recorded answers to other questions or another state version are not reused |
| Add a decision provider | A client next to `createLiquidDecisions()` in decision.ts, its entry in `DECISION_PROVIDERS` in trading.ts and in `createDecisionProviders()` |
| Change a default | `DEFAULT_TRADING_CONFIG` in trading.ts; add a field to `mergeTradingConfig()` and the Settings form |
| Add an exit rule | `onQuote()` or `advance()` in trader.ts, and `ExitReason` in trading.ts |
