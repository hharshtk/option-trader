# What 18 November 2026 recorded, and what to build next

The first full session with futures, options, 20-level order books and option chains all recorded. Decoded read-only from the prod engine's journal on the evening of 18 November.

## Bottom line

- **The recording works.** Every second of NIFTY from 09:15 to 15:30, no gaps in market hours, no bad packets in any file. The one hole: option chains start at 09:54 instead of 09:15 (the dev engine took the chain calls; fixed by `ENGINE_RECORD_OPTION_CHAIN=false` on dev).
- **It is big.** 4.65 GB for one day. The disk has 73 GB free, so about 15 sessions before it fills. Compressed with zstd it is about 1.1 GB a day. **Compression and upload to S3 is the first thing to build.**
- **What the day says about trading:** read the future, trade the option. Crossing the near-month future's bid–ask costs about ₹330 a lot; crossing an at-the-money weekly option's costs about ₹25 a lot. Fast order-book signals moved the next minute by under a rupee's worth of NIFTY points, far less than the costs, as the scalp lab already found.
- **The most promising thing in the data is the option chain**, not the order book: it shows each minute how much movement the market is paying for, and on this day options were paying for more movement than NIFTY delivered.

## The three files

| File | Size | What is in it | Covers |
|---|---|---|---|
| `2026-11-18.bin` (main journal) | 2.18 GB, 11.8 million frames | Every tick of 7 indices, 59 stocks, 6 futures (NIFTY and BANKNIFTY, Nov/Dec/Jan) and 344 option contracts, in Full mode: price, volume, open interest, best 5 bids and asks | 08:45–15:56, every session minute |
| `2026-11-18.depth.bin` | 2.33 GB, 7 million book updates | 20 levels of bids and asks with order counts, about 3 updates a second, for 48 contracts: NIFTY and BANKNIFTY Nov/Dec futures and 44 NIFTY weekly options from 24900 to 25950 | 08:46–15:40 |
| `2026-11-18.chain.bin` | 134 MB, 1,645 snapshots | Once a minute for 5 expiries (NIFTY 23 Nov, 1 Dec, 8 Dec; BANKNIFTY 23 Nov, 29 Dec): per strike, Dhan's implied volatility, Greeks, OI and previous OI, volume, best bid and ask. 101 NIFTY strikes, 124 BANKNIFTY | 09:54–15:30 (329 of 375 minutes) |

Option windows in the main journal grew with the market: NIFTY's nearest expiry covers 24400 to 26450 by the close. Strikes added late (24900 at 12:46) start when they were added.

## The day in numbers

| | |
|---|---|
| NIFTY | Opened 25366, high 25381, low 25145, closed 25228: down 159 points (0.6%) from the previous close of 25387 |
| India VIX | 15.9 → 15.5 |
| Nearest expiry | Monday 23 November, three sessions away. The November futures expire the same day |
| Rollover | December NIFTY futures OI rose 41% (2.25 → 3.18 million); November barely changed. Traders have started moving to December |
| At-the-money weekly straddle | ₹359 at 09:54 → ₹329 at 15:30: lost ₹30 a unit (₹1,950 a lot) while NIFTY moved only 67 points between those times |
| Where OI sat (nearest expiry) | Largest put OI at 25000, largest call OI at 25500 and 26000. NIFTY stayed between them all day |
| Put–call OI near the money | 0.74 → 0.87 (more calls written than puts) |

## Costs to trade, from the order books

| | Typical bid–ask gap | One lot crossing it |
|---|---|---|
| NIFTY Nov future | 5 points (1.5 to 11 through the day; widest 11:15–12:15) | about ₹330 (lot of 65) |
| NIFTY weekly option at the money | ₹0.25–0.60 | about ₹15–40 |
| NIFTY weekly option far out of the money | ₹0.10 (calls) to ₹2–5 (puts) | |
| BANKNIFTY Nov future | 13 points | about ₹390 (lot of 30) |

The future's 5-point gap is wider than expected for NIFTY's busiest future. Both the 5-level and the 20-level feeds agree on it; worth a glance at Dhan's own depth screen tomorrow to be sure.

## Things to watch out for in this data

- **Dhan's implied volatility doesn't add up.** At the same strike, the put's IV was 2–4 points above the call's all day (16.6 against 12.4 at 09:54). They should be nearly equal. Use Dhan's IV only as a rough guide; work out our own from the bid–ask middle, using the future's price.
- **Untraded strikes report a price of 0.** 17,000 such updates on far BANKNIFTY strikes. Skip zero prices.
- **Before 09:15 and after 15:15 are different markets.** The index sits still during the closing auction (15:15–15:28), as `research.md` already says; futures and options keep trading.
- **One day is one day.** Every number above is a single session in expiry week. Nothing here is a strategy yet.

## What the data lets us try

In order of how promising they look on this day's evidence. Each runs in paper or the lab first, for weeks, before anything else.

1. **Did options price more movement than NIFTY delivered?** The chain gives the straddle's price every minute; the journal gives what NIFTY then did. Recording "movement paid for" against "movement delivered" each day is cheap and tells us whether selling premium (or avoiding buying it) has an edge. This day favoured the seller. Option selling isn't built, and it needs margin and a hard loss cap, so it starts as a daily measurement, not trades.
2. **OI walls as a range.** Does NIFTY tend to stay between the largest put OI and the largest call OI? Easy to check daily from the chain. Useful as context for the Decision API even if it never trades on its own.
3. **Read the future, trade the option.** Any direction signal should buy the option, not the future: the option costs about a tenth as much to cross.
4. **Order-book lean.** On this day, minutes where the 20-level book leaned to buyers were followed by NIFTY rising about 0.8 points on average, and the reverse for sellers; a typical minute moves about 6 points and the trade costs about 3. Too small to trade, matching the scalp lab. Keep collecting.

## What is missing

| Gap | Why it matters | Size |
|---|---|---|
| No compression or upload; files stay on the VM's disk | Disk full in about 15 sessions; one bad disk loses everything, and order-book history can't be downloaded later | Small |
| Side files have no reader except one-off scripts | Every question about depth or chains means writing a decoder again | Medium |
| Nothing turns a day into tables | Research wants per-minute rows (future's book, ATM options, chain IV and OI), not 4 GB of frames. The storage rule says Parquet on S3 via DuckDB | Medium |
| Our own IV and Greeks | Dhan's IV disagrees with itself between call and put | Small |
| No daily data-quality check | 18 November's chain gap was found by hand. A day's coverage, gaps and bad prices should be reported automatically | Small |
| Depth window only follows the nearest NIFTY expiry ±5 strikes and stops at 50 contracts | 48 of 50 used on a 236-point day. A bigger move would leave the money without 20-level depth | Small |
| Chain not replayed; Pulse and the Decision API can't see IV or OI walls | Strategies built on chain data can't run on a replayed day | Medium |
| Option selling and spreads not built in paper trading | Needed to test idea 1 as trades | Large (later) |

## Next steps

**Before tomorrow's open (19 November)**

1. Check the dev engine still has `ENGINE_RECORD_OPTION_CHAIN=false` (it does tonight) so chains start at 09:15.
2. Nothing else: don't change prod during a session.

**This week**

1. **Archive job.** After 15:45, zstd each of the day's three files, upload to S3, check the upload, and delete the local copy after N days (keep the last few for replay). Shows on the Engine page.
2. **Daily data-quality report.** Run after the close: minutes covered per file, gaps, restarts, zero prices, chain minutes missing. Saved as Parquet, shown on the Engine page. Replaces the hand-made table in `research.md`.
3. **Day → Parquet features.** One table per day, one row per minute: NIFTY, VIX, the near future's price, spread, book lean and OI, the ATM straddle, call and put OI near the money, the OI walls, and our own ATM IV. Built from the three files with the existing parsers.

**Next week**

4. **"Movement paid for vs delivered" report**, from the features table: straddle price at fixed times against NIFTY's actual move to the close and to expiry. One line a day; after two or three weeks it says whether premium selling deserves a paper strategy.
5. **Chain into the journal session**, so Pulse, the Decision API and replays see IV and OI walls.
6. **Widen depth for big days:** recentre the 20-level window when NIFTY moves far, dropping strikes far from the money, instead of only growing.

**Later, only if the reports earn it**

7. Paper-trade defined-risk option selling (a short straddle with protective wings, so the loss is capped), with its own daily loss limit.
