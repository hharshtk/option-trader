# What 23 November 2026 traded and recorded

The prod engine's first session with the breadth signal, the Decision API gate and the live pilot built. I read the prod engine's files without changing them on the evening of 23 November: the journal and its side files (`data/engine/journal/2026-11-23.*`), the paper run (`trading/runs/live-2026-11-23.jsonl`), the decision cache, the live desk's file and the engine log. All times are IST.

## Bottom line

- **Paper made +₹1,464 after ₹451 of charges, on 7 trades: 3 won, 4 lost.** All of the profit came in the first 10 minutes. From 09:36 on, every trade lost.
- **No real order reached Dhan.** Live never switched on. The live desk's file for the day is empty (see [Live pilot](#live-pilot)).
- **The prediction was right, and the exits threw it away.** NIFTY fell 451 points (1.7%) and kept falling until 15:12. The breadth signal and the Decision API said "down" every time they were asked. Every put bought today was worth 2.2 to 3.6 times what was paid for it by 15:10. But the 10% stop was about one minute's normal wobble away from the entry price, so each trade was settled within 16 seconds to 5 minutes by noise, not by the direction call.
- **The gate saved ₹1,443.** It turned down both call (up) trades. Run on the shadow book with the same exits, they lost ₹1,443. Held to 15:10, both calls would have been worth almost nothing.
- **Two things to fix before the next live day:** a restarted engine bought on a minute it had already passed over (this cost ₹888 today), and the engine was restarted three times during market hours.

## The day in numbers

| | |
|---|---|
| NIFTY | Previous close 25,800.60. Opened about 120 points higher, reached a high of 25,990 at 09:15:44, fell 420 points to 25,570 by 09:35, then slid all day to a low of 25,346 at 15:12. Closed at 25,349.65: down 451 points (1.7%) |
| BANKNIFTY | 64,635 → 62,585: down 2,050 (3.2%) |
| India VIX | 17.3 → 17.7, peak 18.65 |
| Expiry | Expiry day for both the weekly options (23 Nov) and the November futures |
| What options paid for vs what happened | At 09:15 the at-the-money call and put together (the straddle) cost ₹165, which means the market was paying for about a 165-point move. NIFTY moved 581 points from 09:15 to the close, about 3.5 times that. This was a day for option buyers. On 18 November it was the other way round |
| Where open interest sat (today's expiry) | The most call open interest was at 26,000 until about 13:30, then at 25,500. From 10:30 the most put open interest was at 25,500, and NIFTY fell through that level around 12:45 |

## The trades

The breadth signal fires when the number of NIFTY's 50 stocks that are up, minus the number that are down, changes by 6 or more within 5 minutes. Each trade was 1 lot (65 units) of a weekly option near the money, with a stop at 10% below the price paid, a target at 20% above it and a 60-minute hold. The Decision API gated each entry.

| # | Bought at | Contract | Paid | Sold | Why it sold | Held for | After charges |
|---|---|---|---|---|---|---|---|
| 1 | 09:25 | 25800 PUT | ₹115.20 | ₹137.95 | target | 16 s | **+₹1,411** |
| 2 | 09:28 | 25750 PUT | ₹126.50 | ₹151.40 | target | 36 s | **+₹1,549** |
| 3 | 09:33 | 25650 PUT | ₹123.05 | ₹147.50 | target | 78 s | **+₹1,520** |
| 4 | 09:36 | 25650 PUT | ₹108.00 | ₹95.30 | stop | 55 s | **−₹888** |
| 5 | 10:13 | 25600 PUT | ₹93.85 | ₹84.30 | stop | 59 s | **−₹681** |
| 6 | 10:22 | 25600 PUT | ₹99.65 | ₹89.60 | stop | 36 s | **−₹715** |
| 7 | 10:45 | 25600 PUT | ₹90.65 | ₹80.30 | stop | 5 min 10 s | **−₹733** |
| | | | | | | **Total** | **+₹1,464** |

These two were turned down by the gate and run on the shadow book instead:

| Bought at | Contract | Paid | Sold | Why | After charges | Worth at 15:10 |
|---|---|---|---|---|---|---|
| 09:40 | 25700 CALL | ₹100.75 | ₹90.45 | stop after 6 s | −₹731 | ₹0.70 |
| 09:58 | 25700 CALL | ₹84.60 | ₹74.55 | stop after 40 s | −₹712 | ₹0.70 |

After trade 6, three losses in a row stopped trading for the day at 10:22. Someone resumed trading by hand at 10:34. Trade 7 lost ₹733, and the same limit stopped trading again at 10:50. Nothing traded after that.

Fills and charges look right. Buys filled at the ask plus ₹0.05 and sells at the bid minus ₹0.05. Charges came to about ₹64 for each trade there and back.

## What the prediction got right, and what the exits did

Think of it as a classifier feeding an executor. The classifier labelled the day correctly. The executor's timeout was shorter than the system's normal jitter.

**The direction call.** Every one of the 9 Decision API answers said "trend down", and NIFTY did trend down all day.

| Checked | Approved puts (7) | Refused calls (2) |
|---|---|---|
| NIFTY 15 minutes later (the prediction window) | Lower after 3, higher after 4 | Lower after both: refusing was right |
| NIFTY 60 minutes later (the planned hold) | Lower after 6 of 7 | Lower after both |
| The put's price by 15:10 | 2.2 to 3.6 times what was paid, every one | The calls lost 99% |

How sure the API said it was (0.80 to 0.91) didn't separate the winners from the losers. The simple benchmark "NIFTY keeps going the way it has gone since the open" also said "down" all day. So today shows that the API agreed with that simple benchmark, not that it beat it.

**The exits.**

- The four stops were hit after NIFTY moved only 8 to 21 points the wrong way. At those moments, a typical one-minute move was 8 to 29 points. Expiry-day options swing hard, so a 10% stop sat about one ordinary minute away.
- The three targets were hit after NIFTY fell 30 to 44 points during the crash at the open. That is why the first three trades won within seconds.
- A wider stop would not have been free money. Within the hour after each losing entry, the put dropped 25% to 54% at its worst before it recovered. Riding that out would have risked ₹1,500 to ₹3,500 a lot. An hour after entry, 4 of the 7 puts were worth more than was paid and 3 were worth less.

**What not to do with this.** Don't change the stop or the target because of today. One trending day flatters holding on, and the constitution forbids fitting settings to a day already seen. Today does show that the paper P&L mostly measured the 10% stop, not the prediction. To judge the predictor, use the prediction scoreboard: it grades every minute on a 15-minute hold with no stop and no target. Watch over the coming sessions how often a stop is hit within 2 minutes on a call whose direction turned out right.

## Live pilot

- **No real orders.** `trading/live/2026-11-23.jsonl` is empty, and nothing in the engine log mentions the live desk.
- [trading.md](trading.md#before-the-first-live-day) records the cause. Dhan answered "Invalid IP" (DH-905) because the access token was generated before the IP was whitelisted. Prod's engine log doesn't show that refusal: prod runs `b6a2cbf`, and the logging for refusals came in `d80eb3a` this afternoon, which isn't on prod yet.
- The daily loss limit is ₹3,000. Paper's result for the day never went below zero, so the limit was never close. Had live been on, the desk would have copied each of the 7 paper trades with one real lot, with real fills a little different from paper's.

## Running the engine

| What | When | Effect |
|---|---|---|
| Engine restarted to deploy `b6a2cbf` | 09:28:43, down 12 s | A 12-second hole in all three recordings |
| Engine restarted again | 09:36:31, down 21 s | A 21-second hole. Then trade 4 (below) |
| Engine restarted | 15:15:19, down 2 s | A 2-second hole |
| Trading settings changed (signal: "agree" → "breadth") | 09:18:36 | Today was the breadth signal's first day. 17–20 November traded the "agree" signal |
| The three-losses limit lifted by hand | 10:34:26 | The next trade lost ₹733 |
| Feed reconnects | 07:40 and 08:31, 8 s each, before the open | None. No feed gaps during market hours |
| Dhan token refused at start ("Invalid Token") | 06:25 | Restarted at 06:26 with a working token |
| Decision API | 9 calls | 0.44 to 0.65 s each, no errors or timeouts. Cost about 0.001 for all nine, in the provider's billing units |

**A restart bug.** After a restart, the trader looks again at the last finished minute, even if the engine had already passed over it before the restart. In [trader.ts](../src/engine/trading/trader.ts), a resumed run starts with `lastEvaluated: 0`. Here is what happened:

1. At 09:36:01 the engine read the 09:35 minute (−11 stocks). It bought nothing, because the 2-minute cooldown after trade 3 ran until 09:36:20.
2. The engine restarted at 09:36:52. At 09:36:54 it read the same 09:35 minute again. The cooldown was over by then, so it bought the 25650 PUT 54 seconds late, at ₹108.00 against the ₹111.50 the signal had seen.
3. That was trade 4, the day's biggest loss: −₹888.

On paper that is a wrong trade. With live on, it would have bought a real lot. It also means a replay of the day wouldn't make the same trades as the live run, against the rule that the trader and replays share one set of rules. The fix is small: when resuming, don't act on a minute whose decision time has already gone by.

## The files

| File | Size | Covers |
|---|---|---|
| `2026-11-23.bin` (main journal) | 1.91 GB, 10.4 million frames | Every session minute 09:15–15:30. Holes only during the three restarts (35 s in all) |
| `2026-11-23.depth.bin` (20-level books) | 1.64 GB | 08:50–15:40. Every session minute has data. It paused during each restart |
| `2026-11-23.chain.bin` (option chains) | 156 MB, 1,895 snapshots | NIFTY 23 Nov chain once a minute, 09:15–15:30, all 375 minutes plus a few around them. Unlike 18 November, no late start |

Today's files total 3.7 GB, smaller than 18–20 November (4.5–5 GB). The disk has 39 GB free, which is about 10 more sessions. Backing up to S3 is still open in [roadmap.md](roadmap.md).

## Paper so far

| Day | Signal | Paper trades | After charges |
|---|---|---|---|
| 17 Nov | agree | 6 | −₹1,279 |
| 18 Nov | agree | 4 | −₹927 |
| 19 Nov | agree | 3 | −₹287 |
| 20 Nov | agree | 3 | +₹3,842 |
| 23 Nov | breadth | 7 | +₹1,464 |

That is 5 live paper sessions, +₹2,813 in all. The breadth signal has 1 of the 20 sessions the constitution asks for. One good day on a one-way market proves nothing yet.

## Next steps

**Before tomorrow's open (24 November)**

1. Push `d80eb3a`, so a refused live switch-on shows up in the engine log. Restart prod **before 08:55**, not during the session.
2. Renew the Dhan token, now that the IP is whitelisted. Then press **Trade live today**, if you want live tomorrow.
3. Fix the restart bug above before live is switched on again. Otherwise a restart during the session could buy a real lot on a minute that had already been passed over.

**House rules the day bumped into**

- No engine restarts between 09:15 and 15:30 ([constitution §4.2](constitution.md#4-principles): nothing may pause the recorder in market hours). Deploy before 08:55 or after 15:40.
- Leave the three-losses stop in place when it trips ([§4.7](constitution.md#4-principles): risk limits are never loosened). Today's override cost ₹733.

**To watch over the next sessions, not to act on yet**

- How many trades the stop settles within 2 minutes, and whether NIFTY then went the predicted way. If that keeps happening, the exits need a rethink before live gets more than one lot. That rethink would happen on days not yet seen, not tuned on today.
- Whether "options paid for less movement than happened" repeats on non-expiry days, or was only an expiry-day crash.
