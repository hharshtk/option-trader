# The Pulse page

What the Pulse page (`/pulse`) shows, how each number is computed, and what it can and can't tell you. Written 2026-11-16. For where its data comes from see [engine.md](engine.md) and [journal.md](journal.md); for where signals and paper trading go next see [engine-plan.md](engine-plan.md#trading).

## Contents

1. [In one paragraph](#in-one-paragraph)
2. [Where the data comes from](#where-the-data-comes-from)
3. [Verdict](#verdict)
4. [Chart](#chart)
5. [Who moved NIFTY](#who-moved-nifty)
6. [Learned weights](#learned-weights)
7. [Futures and options](#futures-and-options)
8. [Signal lab](#signal-lab)
9. [Trade it with options](#trade-it-with-options)
10. [What it doesn't do](#what-it-doesnt-do)
11. [Code layout](#code-layout)
12. [Changing it](#changing-it)

## In one paragraph

Pulse turns the engine's live recording of NIFTY and its 50 stocks into a read of the market. It says what NIFTY is doing and gives a shadow decision (what the system would do, without trading). It shows which stocks and sectors moved the index and what NIFTY's futures and options are doing, and scores six candidate signals (three from prices, three from futures and options) on what NIFTY did after each one fired. It also replays a signal's firings with real NIFTY option prices to show the money made or lost after charges. Every number is recomputed from the day's journal every 5 seconds, with fixed and visible rules, so a replayed day gives the same answers. That is what makes the rules testable.

## Where the data comes from

| Data | Source | Refresh |
|---|---|---|
| NIFTY 1-minute bars, per-stock minute closes, breadth, VWAP, pending buy and sell quantity | The engine decodes today's journal: `GET /v1/journal/session` through the web proxy (see [engine.md](engine.md#what-you-see-on-the-web)) | Every 5 seconds while the tab is visible |
| NIFTY's near-month future (price, open interest, VWAP, who traded, the best five bids and asks) and its nearest option expiry (open interest and prices per strike) | The same session: `derivatives`, built from the research recorder's Full-mode packets in the main journal ([engine.md](engine.md#research-recording)). From 18 November 2026 | Same |
| Index weight prior, sector of each stock | [index-constituents.ts](../src/lib/index-constituents.ts): Dhan's market-cap shares, snapshot of 2026-11-15 | Static |
| NIFTY option contracts: expiries, strikes, CE/PE security ids, lot size | The scrip file the app downloads daily (Settings → Download option instruments), through `/api/insight/options` | When the expiry or the day's range changes |
| Option prices | Dhan's intraday charts API, 1-minute candles, through `/api/insight/option-candles`. Needs the Data API plan | Every minute |

The engine records NIFTY in Ticker mode (about one price a second) and its 50 stocks in Quote mode (price, VWAP, volume, day range, pending quantity). Pulse itself samples nothing; it reads what the journal holds.

The page shows today only. It needs the engine to have run today, and shows nothing until NIFTY's first session minute. While the engine replays a recorded day ([engine.md](engine.md#replay)), the page follows the replay instead: that day as far as the replay has reached, built up minute by minute, with "last tick" timed on the replay's clock. Option prices still come from Dhan's intraday API, but only minutes that had closed by the replay's position are used, so a trade whose exit is still ahead waits for it as it would live.

## Verdict

The top panel gives NIFTY's price and change, a headline, a shadow action, a bar of the day's range (previous close, open, now, low and high with their times), and the evidence behind the call.

Each line of evidence votes +1 (bullish), 0 or −1 (bearish):

| Evidence | +1 when | −1 when |
|---|---|---|
| Since the open | NIFTY 15 pts or more above its open | 15 pts or more below |
| Place in the day's range | Above 66% of the low–high range | Below 33% |
| Weight above its own VWAP | More than 60% of NIFTY's weight trades above each stock's day VWAP | Less than 40% |
| Breadth | 10 or more stocks up than down | 10 or more down than up |
| Pending orders | Weighted (buy − sell) / (buy + sell) pending quantity above +0.15 | Below −0.15 |
| Last 15 minutes | NIFTY up 10 pts or more | Down 10 pts or more |
| How broad the move is | — | The top 3 contributors give more than NIFTY's whole move (the rest pull the other way): a fragile move, so it votes against the move's direction |

**Breadth** counts NIFTY's 50 stocks only. Until 18 November 2026 it counted every stock in the journal, and from that day the journal also holds BANKNIFTY's banks, so breadth read 59 stocks and the Breadth thrust signal (tuned on 50) fired more easily.

The six single signals from the [Signal lab](#signal-lab) vote the same way. The sum is the **score**:

| Score | Stance | Shadow action |
|---|---|---|
| +3 or more | Bullish ("Buyers in control", or "Recovering" on a red day) | Favour longs on dips towards VWAP |
| −3 or less | Bearish ("Sellers in control", or "Fading rally" when NIFTY is green but in the lower part of its range) | Favour shorts on bounces |
| Between | Mixed ("No edge") | Stand aside |

The thresholds are judgement calls, not fitted. They are written down so they can be tested on replayed days.

## Chart

**Controls:** Candles or Line; 1m, 3m, 5m or 15m bars (built from 1-minute bars, aligned to 09:15); the basket overlay on or off. The choice is kept in the browser (`localStorage` key `pulse.chart`).

| Pane | Shows |
|---|---|
| Top | NIFTY. The basket (dashed): the 50 stocks with the [learned weights](#learned-weights), what NIFTY "should" be. Dashed levels for the previous close and today's open |
| Middle | Breadth: stocks up minus stocks down from the previous close, shaded green above zero, red below |
| Bottom | Signal votes: long minus short among the six single signals, −6 to +6. Faint bars are one vote, solid bars two or more agreeing |

**Hover legend** (above the chart): for the bar under the pointer, or the latest one, it shows open, high, low and close; change from the previous close; the basket against NIFTY; breadth; each signal's reading and vote; and the net vote.

**Firing arrows:** "Show on chart" on a Signal lab card draws that signal's firings. ▲ marks long and ▼ short; blue means NIFTY then moved that way over the chosen hold, grey means it didn't. Hovering an arrow shows a card next to it with the reading that triggered it, NIFTY then and after the hold, the result in points, and the result after the Signal lab's cost. Hovering a bar also lists its firings in the legend. A firing is decided when its minute closes, so an arrow on the 14:05 bar reads 14:06.

## Who moved NIFTY

Index points each stock added: `weight × stock's return × NIFTY's previous close`, using the learned weights.

- **Today**: from the previous close. **15 min**: over the last 15 minutes.
- The top 7 contributors up and the top 7 down are shown as bars. **By sector** sums the same points per sector.
- The sentence above the bars names the three biggest contributors and what the other 47 add together. On 16 November, for example, HDFC Bank, Bharti Airtel and ITC gave +77 of NIFTY's +67 points while the other 47 gave −11: a narrow rally.

## Learned weights

Dhan's constituent shares are full market cap, but NIFTY weights stocks by free float. With Dhan's shares, the basket explained only 31 of NIFTY's 56 points on 16 November. So Pulse learns the weights from the day's own prices:

- NIFTY's return from the previous close is modelled as a weighted sum of its stocks' returns, minute by minute.
- A ridge regression pulled towards Dhan's shares (λ = 1e-5) fits the weights; negative weights are clipped to zero.
- It needs 75 session minutes (45 to fit, 30 to test). Until then Dhan's shares are used.
- **Honesty check:** the weights are fitted without the last 30 minutes, then tested on them. The "How this is computed" panel shows that out-of-sample error next to the error with Dhan's shares. On 16 November: 1.3 pts against 25 pts.
- The weights used on screen are then refitted on all minutes so far.

The learned order matched NIFTY's real one (HDFC Bank about 10%, then ICICI Bank and Reliance).

## Futures and options

A panel under the verdict, shown when the day's journal has NIFTY's futures and options (from 18 November 2026). Computed in [derivatives.ts](../src/lib/insight/derivatives.ts) from the session's `derivatives`; the decision API gets the same numbers ([trading.md](trading.md#decision-api)).

| Line | What it says |
|---|---|
| The near-month future | Its price, its premium over NIFTY and how that changed in 15 minutes, and its distance from its own VWAP |
| Open interest | The future's open interest change in 15 minutes and since yesterday's close, and what price against open interest means: long build-up (price up, positions added), short build-up (down, added), short covering (up, closed), long unwinding (down, closed) |
| Who is trading | The share of the future's traded quantity taken by buyers lifting the ask against sellers hitting the bid, over 5 and 15 minutes, and the net in lots. Each trade is classed by its price against the book just before it, or by its tick when it traded between bid and ask |
| Options, expiry | Put open interest over call open interest within 10 strikes of the money (above 1: more puts written), now, at the open and 15 minutes ago |
| Lots written near the money | Lots of calls and puts added within 10 strikes of the money, today and in the last 15 minutes. Writers sell options where they expect the market not to go |
| Biggest strikes | The strike with the most call open interest above NIFTY and the most put open interest below it, among the recorded strikes (15 each side of the money), and max pain: the settlement at which option holders would collect least |
| Typical 15-min move | What the at-the-money straddle (call plus put) prices for 15 minutes, against how far NIFTY has actually been moving (its average 1-minute move over the last 30 minutes, scaled to 15). Plus India VIX and the change in option volatility since the open |

The straddle prices the move to expiry; a move over 15 minutes is that times √(15 / trading minutes left), counting weekdays but not exchange holidays. It counts no move overnight, so it reads a little high.

## Signal lab

Six candidate signals, each a fixed rule read at the end of every minute from data up to that minute (no look-ahead), and two that combine them:

| Signal | Reads | Fires long / short when |
|---|---|---|
| Breadth thrust | NIFTY's 50 stocks | Stocks up minus down rose / fell by 6 or more over 5 minutes |
| Basket leads index | NIFTY's 50 stocks | The average stock (equal weight) beat / lagged NIFTY by 4 bps or more over 5 minutes |
| 15-minute momentum | NIFTY | NIFTY rose / fell 0.12% or more over 15 minutes |
| Futures order flow | The future | Buyers lifting the ask took 70% or more of what the future traded over 5 minutes / sellers hitting the bid did. Not when volume was thin: under 30% of the day's average so far |
| Futures OI build-up | The future | The future rose / fell 0.12% or more over 15 minutes while its open interest rose 0.2% or more: new positions behind the move. Momentum with a check that someone is committing money |
| Option writers | Options near the money | Over 15 minutes, put open interest grew faster than call open interest by 3% or more of the total (writers expect a floor) / calls faster (writers expect a ceiling) |
| Two or more agree (combined) | | At least two of the three price signals point the same way, net |
| Confirmed by futures and options (combined) | | The price signals that fired all point one way, at least one of the three futures and options signals agrees, and none disagrees |

**What the record says.** Over 257 days to 17 November 2026 the three price signals and Two or more agree were right 49–51% of the time and averaged under a point a trade before costs, against about 3.9 points of costs for an option trade (the parked research study, branch `research-and-strategy-store`). The futures and options signals read data recorded only from 18 November 2026; their thresholds were set that morning so each fires on about a quarter of minutes, and they are untested. Judge them on the days that follow.

**No signal reads the closing auction.** From 15:15 stock prices stop and NIFTY holds still until the auction price lands near 15:28 ([research.md](research.md#things-the-data-taught-us)). Signals read nothing from 15:15, and an outcome must end by 15:14.

**Scoring.** A firing "follows NIFTY" for the hold time: the outcome is NIFTY's points from the firing minute's close to the close the hold later. Only firings whose outcome is complete count. After each firing the next hold is skipped, so samples never overlap.

**Controls.** Hold: 1, 3, 5, 10 or 15 minutes. Cost per trade: 0, 4, 8, 12, 16 (default) or 20 NIFTY points. 16 is one futures lot, round trip, at Dhan's charges: about ₹975 (15 points) since futures STT rose to 0.05% on 1 April 2026, plus about a point of spread. It was 8 until 16 November 2026, from the old 0.02% STT.

**What's on the page:**

| Part | Shows |
|---|---|
| What today says | Lessons computed from the numbers: cost against NIFTY's typical move, which signal (if any) is ahead after costs, where holding longer or shorter changes the answer, and whether any signal beats a coin flip |
| Baseline | Share of hold-length windows NIFTY rose, its median move, and cost as a share of that move |
| Signal cards | Verdict; hit rate with its 95% range (Wilson interval) drawn against the 50% coin-flip line; long and short scored separately; points after costs as a curve through the day (before costs dashed); points at each hold time (click one to switch the lab); the last firings |

**Verdicts:**

| Verdict | Meaning |
|---|---|
| Too few firings | Fewer than 8 firings |
| Edge so far | The 95% range is above 50%, and it is ahead after costs |
| Right often, costs eat it | The range is above 50%, but the wins don't pay for the trades |
| Ahead, could be luck | The range includes 50%, but it is ahead after costs |
| No edge after costs | The range includes 50% (not proven right or wrong), and it lost money after costs |
| Reliably wrong | The whole range is below 50%: the opposite may be the signal |

Each card states its verdict's numbers, for example: "Right 12 of 18 (67%), 95% range 44–84%. … +41.6 pts before costs, 18 × 8 pts of costs, −102.4 after."

**Reading it.** One day gives 10 to 40 firings per signal, too few to separate skill from luck. Picking the best hold after seeing the results is itself overfitting. A signal earns a place in a strategy only after it holds up across weeks of replayed days (step E6 in the [engine plan](engine-plan.md#build-steps)).

## Trade it with options

Replays one signal's firings at the Signal lab's hold time, with real NIFTY option prices. The signal is picked in the panel's own dropdown, which shares its choice with the Signal lab's "Show on chart": picking in either place selects it in both, and its arrows appear on the chart.

**Controls:**

| Control | Choices |
|---|---|
| Signal | Any of the four Signal lab signals, with how many times each fired at the current hold |
| Expiry | The next 6 NIFTY expiries in the scrip file |
| Strike | ATM at each firing (follows NIFTY), 1 or 2 strikes OTM or ITM, or one fixed strike all day |
| Trade | Both (buy CE on ▲, PE on ▼), calls only, or puts only |
| Lots | 1 to 100; quantity = lots × lot size from the scrip file |
| Slippage | ₹0, 0.5 (default), 1 or 2 per unit, paid on entry and on exit |

**Each trade** buys at the option's 1-minute close for the firing minute and sells at the close the hold later. A minute with no trade in that option uses the last close within 3 minutes. If Dhan hasn't published the exit minute's candle yet, the trade shows "Waiting" rather than using an old price.

**Charges** are Dhan's, from [charges.ts](../src/lib/trading/charges.ts), the same module the engine's paper trading uses. They reproduce a result from Dhan's brokerage calculator to the paisa ([trading.md](trading.md#charges)):

| | Options | Futures (comparison only) |
|---|---|---|
| Brokerage | ₹20 an order, 2 orders | Same |
| STT | 0.15% of sell premium | 0.05% of sell value |
| Exchange fees | 0.03503% of turnover | 0.00173% of turnover |
| IPFT | 0.0005% of turnover | 0.0001% of turnover |
| SEBI fees | 0.0001% of turnover | Same |
| Stamp duty | 0.003% of buy value | 0.002% of buy value |
| GST | 18% on brokerage, exchange, IPFT and SEBI fees | Same |

**What's on the page:** net P&L, trades priced, winners after costs, result before costs, charges plus slippage, and the most premium at risk at once. Below that:
- the running P&L after costs;
- the same firings traded with NIFTY futures (0.5-pt slippage each way);
- the best and worst trade;
- a trade table: contract, NIFTY's move, buy and sell, the option's move, the move per NIFTY point (roughly delta; shown only when NIFTY moved 5 pts or more), gross, charges and net.

**Example, 16 November** (Breadth thrust, 5-minute hold, ATM, 1 lot of 65), computed with the rates in use before 16 November's correction (STT at 0.1% and 0.02%), so today's page shows slightly higher charges:

| | Before costs | Costs | Net |
|---|---|---|---|
| Options | −₹81 | ₹1,061 | −₹1,142 |
| Futures | +₹1,534 | about ₹8,600 (₹476 a trade) | −₹7,094 |

Futures caught the move, but their charges took it all. Options cost about ₹59 a trade but moved only 0.3 to 0.8 per NIFTY point and lost time value while held.

**Dhan calls:** one intraday-charts call per contract in play per minute, through the app's rate limiter (5 a second) and cached for a minute. ATM-following strikes usually need 5 to 10 contracts.

**Stale contracts:** if the scrip file wasn't downloaded today, the panel still answers from the latest download and shows a warning. New strikes or a lot-size change would be missing.

## What it doesn't do

- **No orders.** The verdict is a shadow call and the option replay is a calculation. The engine trades these signals on paper as they fire: see [trading.md](trading.md).
- **Today only.** Past days and replays of journal files come with E4 in the engine plan.
- **One day of evidence.** No signal here is validated. The page shows how a signal would be judged, not that any signal works.
- **A round cost in the Signal lab.** Its cost in NIFTY points per trade is one figure for every trade. The option replay's charges are computed per trade at Dhan's rates.
- **Buying options only.** No option selling, spreads, stop losses or targets.
- **Minute closes.** Entries and exits are at 1-minute closes; real fills would differ by the spread and latency, which slippage only approximates.

## Code layout

```
src/lib/insight/pulse.ts                 computePulse(): weights, attribution, evidence, verdict, signals, scoring, chart series
src/lib/insight/derivatives.ts           futures and options readings, Black-76 option maths, expected moves
src/lib/insight/option-trades.ts         planTrades(), simulateTrades(), charges, futures comparison
src/lib/insight/*.test.ts                node --test
src/components/insight/pulse-view.tsx    the page: verdict, chart, attribution, Signal lab, method panel
src/components/insight/option-replay.tsx "Trade it with options"
src/app/(cockpit)/pulse/page.tsx         route, behind the session check
src/app/api/insight/options/route.ts     NIFTY expiries and strikes from the scrip file
src/app/api/insight/option-candles/route.ts  1-minute option candles from Dhan, up to 20 contracts a call
```

`pulse.ts` and `option-trades.ts` are pure and deterministic: data in, results out, no clock or network. They run in the browser, and `pulse.ts` also runs in the engine, where trading reads its signals at each minute close. They import with relative `.ts` paths so plain Node can load them. The page reuses `useJournalSession` from the Engine page's [session-view.tsx](../src/components/engine/session-view.tsx).

## Changing it

| To | Change |
|---|---|
| Add a signal | Add an entry to `definitions` in `computePulse()` (id, name, group, rule, `read(t)` using only data up to minute `t`, threshold, format). It is scored at every hold, appears in the lab, the chart and the verdict with no UI changes. To trade it, add it to `SIGNALS` in [trading.ts](../src/lib/engine/trading.ts) and explain it in `GUIDE` in [signal-guide.tsx](../src/components/trading/signal-guide.tsx). Changing a rule means changing its text there too |
| Change a verdict threshold | The `evidence.push` calls and `decide()` in `pulse.ts` |
| Change the Signal lab's costs or holds | `COSTS`, `DEFAULT_COST` in `pulse-view.tsx`; `HORIZONS` in `pulse.ts` |
| Change charge rates | `OPTION_RATES`, `FUTURES_RATES` in [charges.ts](../src/lib/trading/charges.ts) |
| Test | `node --test src/lib/insight/*.test.ts`, or `npm test` |
