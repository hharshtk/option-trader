# Five-level NIFTY futures OFI and Breadth thrust

**Exploratory result from 23 November 2026.** On 135 breadth opportunities across four already-seen sessions, the five-level order-flow imbalance (OFI) gate raised after-cost net from **₹272.66 to ₹384.09 per original opportunity**, a lift of **₹111.44** at the primary 300 ms delay. It took 70 of the 135 trades. The paired result improved on three days and at all six execution delays. Two days supplied 93% of the pooled lift.

**Next step.** Score this exact rule in shadow on at least 20 unseen live sessions, starting with the first qualifying recording on or after **25 November 2026**. The local calendar marks 24 November as an NSE holiday. This document contains the frozen rule, the replay results, and cases an implementation should reproduce. [Session calendar](../config/engine/calendar.json) · [Constitution](constitution.md#4-principles)

## Question and policies

Breadth thrust measures how the NIFTY 50 stocks are moving together. It votes up or down when the count of advancers minus decliners changes by at least six in that direction over five minutes. Futures OFI measures changes in the displayed bid and ask queues over the last minute. Test whether requiring these two directions to agree improves the economics of buying an option for 15 minutes. [Breadth implementation](../src/lib/insight/pulse.ts) · [Original OFI research brief](hft-options-research-2026-11-23.md#1-futures-snapshot-ofi-and-within-minute-pressure)

- **A — breadth alone.** Take every eligible nonzero breadth vote.
- **B — breadth with OFI.** Take the same opportunity only when five-level OFI is usable and its nonzero sign equals the breadth vote.

Score each original breadth opportunity independently. The policies share the same option contract, execution scenario, 15-minute hold, and charges on each opportunity. Individual outcomes can overlap, so the day is the main unit for judging repeatability. The replay measures prediction economics, and portfolio constraints belong to the later paper-trading assessment. [Prediction scoreboard](predictions.md#how-a-minute-is-graded) · [Trading rules](trading.md)

## Data and replay version

The offline run read the local journals in `data/engine/journal/` against repository commit `d80eb3a0c7d0853a9509960f51055b15c8a13ad9`. The main journal supplied the index, constituent data, point-in-time contract descriptions, and option Full-feed quotes. The depth side journal supplied the future's raw bid and ask updates. The option chain side files are unnecessary for reproducing this comparison.

| Seen session | Main journal bytes | Depth journal bytes | Minutes with frames in each feed |
|---|---:|---:|---:|
| 18 Nov 2026 | 2,184,996,457 | 2,334,855,930 | 375 |
| 19 Nov 2026 | 2,401,751,168 | 2,403,401,813 | 375 |
| 20 Nov 2026 | 2,425,882,361 | 2,153,022,141 | 375 |
| 23 Nov 2026 | 1,914,365,281 | 1,643,028,880 | 375 |

The front contract on those four dates was `NSE_FNO:61471`, expiring 23 November. Discover it from each day's journal metadata when replaying. The 16 and 17 November sessions could be graded on direction only because they lack the depth and option quotes needed here. All four priced sessions had already been examined when the rule was frozen and count as development data. Frame presence at minute granularity can coexist with book staleness within a minute. [Journal format](journal.md#file-format) · [Research data](research.md) · [23 November restart report](data-report-2026-11-23.md#running-the-engine)

## Frozen opportunity and execution rules

1. Obtain the cash session from the repository calendar. In a normal session, `t = 0` is the bar starting at 09:15 IST. Read the finished bar at `cutoff = sessionOpen + (t + 1) × 60,000 ms + 1,500 ms`. Rebuild the existing Pulse state from main-journal records received by that cutoff and read `signal:breadth`. Keep each `+1` or `−1` vote whose latest modeled exit is strictly before the cash auction at 15:15 IST. The latest possible cutoff on a normal day is 14:59:01.500 IST. [Decision day table](../src/engine/decide/day-table.ts) · [Predictor definition](../src/lib/decide/predict.ts)
2. Use NIFTY's close for the voted minute and the nearest NIFTY option expiry described by cutoff. Call `entryAt` with CE for up and PE for down. It picks the closest available strike to spot within 100 points and applies its ₹5 minimum premium and 3% maximum book spread. Equal distances go to the first contract in quote insertion order. Apply the cutoff book checks to the selected key. A failed check makes the vote ineligible for both policies. [Shared contract selection and entry guards](../src/lib/decide/simulate.ts)
3. At cutoff require a Full-feed top quote for that option, with positive bid and ask prices and quantities, `ask >= bid`, and at least one lot displayed at the ask. Use the recorded lot size. The observed lot size was 65 units. The quote must have arrived within the last 2,000 ms and belong to the current engine run and feed connection. Restart and gap controls invalidate earlier quotes. Record rejected entries by reason before scoring either policy. [Main-feed decoder](../src/lib/live/feed/packets.ts) · [Contract recorder](../src/engine/recording/recorder.ts)
4. For delay `d`, model entry at `cutoff + d` and exit at `cutoff + d + 900,000 ms`. Use the latest quote received at or before each timestamp. Apply the same freshness and uncrossed-book checks at both legs. Require at least one lot at the ask on entry and at the bid on exit. The chosen option and cutoff selection stay fixed through every scenario. Run 0, 100, **300**, 500, 1,000, and 3,000 ms. The 300 ms primary delay came from the paper configuration. These are illustrative delays with a fixed 15-minute hold and as-of quotes. The live paper scheduler waits for a post-delay quote, so its order timing is a different measurement. [Paper defaults](../src/lib/engine/trading.ts) · [Paper fill scheduling](trading.md#paper-fills)
5. Price the buy and sell with `fillPrice` at the ask + ₹0.05 and bid − ₹0.05, respectively, rounded against the trader to the contract tick. Use the 5-paise tick when metadata carries no tick size. Price from the book on both legs. Compute `paise((sell − buy) × lotSize − roundTripCharges(buy × lotSize, sell × lotSize).total)` and sum net rupees from per-trade paise. Charges include brokerage and the shared exchange and statutory fees. [Paper fill prices](../src/engine/trading/paper-broker.ts) · [Shared Dhan charges](../src/lib/trading/charges.ts)
6. When an eligible option cannot be bought at modeled entry, log a missed entry and count ₹0 for both policies. When it can be bought and the scheduled exit bid is unusable, log an unpriced exit. Flag the eligible-cohort score as incomplete and report the common priced cohort separately, excluding that row from both priced totals and their denominator. In the exploratory run all 135 eligible opportunities had both fills at all delays, so the eligible and priced cohorts were identical.

## Frozen snapshot OFI

### Build each valid snapshot in receive order

- Select the NIFTY future with the earliest expiry on or after the session date using main-journal `instruments` controls already received. Use the instrument key to break an expiry tie. Start with empty depth state at session open. Apply main-journal controls before depth frames at equal receive timestamps, and preserve file order within each stream. The receive timestamp is the time available to the decision. [Journal cursor](../src/engine/journal/byte-source.ts) · [Contract recorder](../src/engine/recording/recorder.ts)
- Decode the front future's bid and ask messages from the raw `.depth.bin` frames. Keep the latest update for each side within a frame and evaluate the assembled book once for that frame. Keep separate receive times for the bid and ask. Use exactly five positive-price, positive-quantity ranks on each side. Prices must strictly descend on bids and strictly ascend on asks. For a complete book the best bid must be strictly below the best ask. Both sides must be at most 2,000 ms old. [Depth decoder](../src/lib/live/feed/depth-packets.ts)
- Clear both sides, the previous valid snapshot, and the rolling window on a contract change, a stale side, or known interruption. The replay used main-journal `file-open`, engine start/stop, replay start/stop, and global or suspend gaps. It used depth `file-open`, `state`, `gap`, and disconnect messages. Discard a depth record whose receive time moves backward, and reset. Three such records were encountered on 23 November. Treat an invalid side as a reset. A valid opposite side included in that same frame can seed the new state.
- If individually valid sides form a transient crossed or locked book, break the snapshot pair and suspend coverage for that period. When a later frame restores a valid book it becomes the new predecessor. Keep earlier valid contributions still in the 60-second window unless a reset occurred. A snapshot continues to contribute valid time until the next book update, reset, or expiry of its older side, whichever comes first.

### Calculate the five-rank value

For each rank `r`, `b` and `a` are the current bid and ask prices and `bQty` and `aQty` are their displayed sizes. `prev` is the previous valid snapshot in the same uninterrupted sequence. Brackets evaluate to `1` when their condition is true and `0` otherwise.

```text
bidFlow[r] = [b >= prev.b] * bQty - [b <= prev.b] * prev.bQty
askFlow[r] = [a <= prev.a] * aQty - [a >= prev.a] * prev.aQty
increment[r] = bidFlow[r] - askFlow[r]

flowSum[r] = sum of increment[r] with newer snapshot in (cutoff - 60 s, cutoff]
meanDepth[r] = mean of (bQty + aQty) at rank r across valid snapshots in that window
OFI5 = sum over r = 1..5 of (flowSum[r] / meanDepth[r]) / r
```

At unchanged prices the formula uses the difference in displayed quantity. A bid increasing from 200 to 240 at the same price contributes `+40`. If the ask moves up at the same time and its old displayed quantity was 120, that rank's combined increment is `+160`. The measure describes visible queue changes and cannot identify whether specific orders traded or were pulled.

The previous snapshot for the first in-window increment may precede the left boundary when continuity holds. The depth mean uses valid received snapshots in the window and includes unchanged books. Coverage is elapsed valid time within the window, measured independently of the number of frames. Require a fresh valid book at cutoff, at least 45,000 ms of valid coverage since the last reset within the window, and at least one valid consecutive pair ending in the window.

### Decide without looking ahead

| Gate outcome | Condition | B's action |
|---|---|---|
| Agreement | Usable OFI, magnitude above `1e-12`, same sign as breadth | Use the same trade outcome as A |
| Disagreement | Usable OFI, magnitude above `1e-12`, opposite sign | Skip and score ₹0 |
| Flat | Usable OFI with magnitude at most `1e-12` | Skip and score ₹0, count flat separately |
| Book abstention | Missing, stale, invalid, or still warming up after reset | Skip and score ₹0, save the reason |

Freeze the gate at cutoff across all execution delays. Track the option result A would get on each B skip. This makes the improvement traceable to the skipped trades and keeps book availability visible alongside directional agreement.

## Exploratory results

### Paired results by day at the primary 300 ms delay

Net columns use rupees after fees. OFI coverage is the share of original opportunities for which OFI was usable, including flat values if present. There were zero flat values in this run.

| Date | Opportunities | OFI coverage | Trades A / B | Net ₹ A / B | Lift ₹ per opportunity | Disagreements / A net ₹ | Abstentions / A net ₹ |
|---|---:|---:|---:|---:|---:|---:|---:|
| 18 Nov | 32 | 23/32 | 32 / 19 | −1,472.96 / −175.71 | +40.54 | 4 / −260.88 | 9 / −1,036.37 |
| 19 Nov | 34 | 26/34 | 34 / 18 | 16,881.61 / 16,582.21 | −8.81 | 8 / +1,493.35 | 8 / −1,193.95 |
| 20 Nov | 36 | 25/36 | 36 / 18 | −4,086.89 / 4,173.04 | +229.44 | 7 / −5,532.16 | 11 / −2,727.77 |
| 23 Nov | 33 | 19/33 | 33 / 15 | 25,486.93 / 31,273.28 | +175.34 | 4 / −2,717.72 | 14 / −3,068.63 |
| **All** | **135** | **93/135 (68.9%)** | **135 / 70** | **36,808.69 / 51,852.82** | **+111.44** | **23 / −7,017.41** | **42 / −8,026.72** |

The 42 abstentions were 39 warm-ups below 45 seconds of coverage and three stale cutoff books, all three on 23 November. Among the 93 covered opportunities, the 23 disagreements cost A ₹7,017.41 net. The other ₹8,026.72 of lift came from the abstentions. These are contributions measured on the seen sessions. Coverage and those skipped-trade counterfactuals need the same visibility on future days.

### Execution-delay sensitivity across the same 135 opportunities

All rows have 135 A trades, 70 B trades, and 93 usable OFI readings. Primary score is `policy net rupees / original breadth opportunities`. The lift is `(B net − A net) / original breadth opportunities`, calculated before display rounding.

| Delay on each leg | A net ₹ | B net ₹ | A ₹ per opportunity | B ₹ per opportunity | Lift ₹ per opportunity |
|---|---:|---:|---:|---:|---:|
| 0 ms | 36,280.55 | 51,260.56 | 268.74 | 379.71 | +110.96 |
| 100 ms | 36,975.56 | 51,829.11 | 273.89 | 383.92 | +110.03 |
| **300 ms** | **36,808.69** | **51,852.82** | **272.66** | **384.09** | **+111.44** |
| 500 ms | 35,955.03 | 51,431.10 | 266.33 | 380.97 | +114.64 |
| 1,000 ms | 34,617.11 | 50,934.32 | 256.42 | 377.29 | +120.87 |
| 3,000 ms | 36,350.99 | 53,161.09 | 269.27 | 393.79 | +124.52 |

## Verification and regression cases

The scratch reducer passed checks for signed price and size changes, depth normalization, rank weights, cutoff boundaries, crossed books, stale sides, and resets. On a prefix of 18 November, the scratch replay matched the regular day table on all 18 sampled breadth votes and option selections and all 16 comparable zero-delay net P&Ls. The following cases let a future implementation verify parity using the original journals. [Day-table replay](../src/engine/decide/day-table.ts) · [Scoreboard outcomes](../src/lib/decide/predict.ts)

| Cutoff on 23 Nov (IST) | Breadth / OFI | Expected gate | Option key | Buy / sell at 300 ms | A net ₹ |
|---|---|---|---|---:|---:|
| 09:26:01.500 | −1 / −83.6979479798 | Agreement | `NSE_FNO:64488` | 108.75 / 167.80 | +3,766.92 |
| 09:28:01.500 | −1 / +3.2202883707 | Disagreement | `NSE_FNO:64482` | 101.25 / 129.20 | +1,750.46 |
| 09:29:01.500 | −1 / unavailable | Warm-up after restart, 445 ms valid | `NSE_FNO:64482` | 128.05 / 121.00 | −524.30 |
| 10:53:01.500 | −1 / unavailable | Stale, zero coverage after reset | `NSE_FNO:64476` | 71.95 / 63.70 | −593.51 |

For the 09:26 case, the raw window contains 245 valid snapshots and 245 consecutive increments ending in the window. Bid and ask ages are both 97 ms and valid coverage is 60,000 ms. The option lot is 65 units. These vectors distinguish implementation differences in queue arithmetic and normalization even when the resulting sign agrees.

```text
cutoff epoch ms  1795406161500
flowSum          [-18330, -10140, -10465, -11830, -14495]
depthSum         [108095, 81835, 77675, 71435, 121875]
meanDepth        depthSum / 245 at each rank
charges          ₹71.3301789755 before display rounding
```

## Implementation handoff

1. **Keep one reducer for live and replay.** Feed it contract changes, resets, and raw depth frames with receive times. Give it a method that grades state at a cutoff. Buffer only the rolling horizon and sufficient metadata for continuity. The current side-data view exposes a latest combined book and its newer side timestamp. Use the raw packet path for the feature so both receive ages and every consecutive transition are available. [Depth feed](../src/engine/recording/depth-feed.ts) · [Existing replay side view](../src/engine/replay/side-data.ts) · [Minute side summaries](../src/engine/journal/side-series.ts)
2. **Grade with the existing decision loop.** Use the real breadth predictor and the decision-table cutoff, and keep OFI as a versioned shadow input. Replay by advancing read-only cursors without launching a broker or a Decision API. Reuse the pricing and fee functions above. Emit an audit row per breadth vote with the date, minute and cutoff, breadth value and sign, future key, OFI status and value, both side ages, coverage, and reset reason. Attach the selected option, modeled fill times and prices, fees, eligibility or fill failures, and paired outcomes. Persist research tables through the existing Parquet store if persistence is needed. [Decision day table](../src/engine/decide/day-table.ts) · [Prediction grading](../src/lib/decide/predict.ts) · [Parquet store](../src/lib/db/parquet-store.ts)
3. **Reproduce the seen days before grading new dates.** Check the four classified examples, the daily totals, and the six pooled delay rows. Include explicit tests for no lookahead, clearing on restart and roll, stale one-sided books, transient crosses, and preserving the cutoff-selected option through a delayed fill. Check that B's net on each agreement equals A's and that, for complete rows, `B net − A net` equals the negative of A's net on the skipped rows.
4. **Apply the frozen holdout date.** Begin with completed recorded sessions on or after 25 November 2026 that were unseen when this rule was fixed. Keep day totals, original and priced opportunity counts, trades filled, coverage, and the A counterfactual for disagreement, missing/stale book, warm-up, and flat. Carry all six delays forward. A code change that alters decision semantics creates a new version with a fresh unseen start. [Constitution](constitution.md#4-principles)

**Research decision.** Keep collecting five-level evidence first. Review the paired 300 ms result across at least 20 unseen live sessions and check how much of any lift comes from directional disagreements with valid books. The 20-level extension and option break-even filter are separate experiments. Any future change to the trading policy also needs the constitution's benchmarks, paper evidence, and go-live requirements. [Constitution](constitution.md#6-going-live) · [Option break-even research](hft-options-research-2026-11-23.md#3-parity-based-iv-and-the-long-option-break-even-move)
