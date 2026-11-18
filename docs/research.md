# Research data

What data there is for building and testing strategies, where it lives, and what to watch out for when using it. The live recording itself is described in [engine.md](engine.md#journal) and [engine.md](engine.md#research-recording).

## Contents

1. [What there is](#what-there-is)
2. [Minute history](#minute-history)
3. [Things the data taught us](#things-the-data-taught-us)
4. [Data quality of the recorded days](#data-quality-of-the-recorded-days)

## What there is

| Data | Span | Where | Good for |
|---|---|---|---|
| 1-minute candles: NIFTY, India VIX, BANKNIFTY, FINNIFTY and the NIFTY and BANKNIFTY stocks (63 instruments) | November 2025 onwards | `history/candles-1m/YYYY-MM.parquet` in the file store | Price, volume, breadth, momentum, volatility and time-of-day features over a year |
| Journal: every raw feed frame | From 16 November 2026 | `data/engine/journal/<date>.bin` | Tick-level checks, replays, and from 18 November order-book and option features. The session summary turns NIFTY's futures and options into per-minute series (`derivatives`): open interest, who traded, the book, near-the-money call and put open interest, the straddle |
| 20-level depth and option chain snapshots | From 18 November 2026 | `<date>.depth.bin`, `<date>.chain.bin` beside the journal | Order-book and IV/OI features. Replays read them at their position; the journal session carries them per minute (`derivatives.book`, `derivatives.chain`), see [engine.md](engine.md#replay) |

Order-book data can't be downloaded later: it exists only from the day it was recorded.

## Minute history

[candle-history.ts](../src/lib/research/candle-history.ts) downloads Dhan's 1-minute candles (`/charts/intraday`, five years available, 90 days per request) for the instruments the live universe records, and keeps one Parquet file per calendar month with every instrument in it:

| Column | Type | Meaning |
|---|---|---|
| `key` | VARCHAR | Feed key, `IDX_I:13` or `NSE_EQ:1333`, the same as the journal uses |
| `t` | DOUBLE | Start of the minute, epoch ms |
| `open`, `high`, `low`, `close` | DOUBLE | Rupees (index points for indices) |
| `volume` | DOUBLE | Shares traded in the minute; for indices, Dhan's own figure |

Only 09:00–15:30 IST is kept. A month is one file, rewritten whole when it is downloaded again, so the current month can be refreshed as days pass.

```sql
-- NIFTY's 1-minute closes for a day
SELECT t, close FROM read_parquet('s3://<bucket>/option-trader/history/candles-1m/2026-11.parquet')
WHERE key = 'IDX_I:13' AND t >= epoch_ms(TIMESTAMP '2026-11-17 03:45:00') ORDER BY t;
```

**Survivorship.** The stock list is today's NIFTY and BANKNIFTY membership. A year back a few members were different, which slightly flatters breadth-style features. Acceptable for research; worth remembering when a result is marginal.

## Things the data taught us

**NSE closes with an auction.** Stocks trade continuously until 15:15. From 15:15 to 15:30 a closing auction runs: stock candles stop at 15:14, and the NIFTY index holds flat at its 15:14 level until the auction price lands at about 15:28 (seen on 16 and 17 November 2026; 17 November: flat at 25413 from 15:15 to 15:27, then 25387.40). Futures and options keep trading until 15:30. So:

- From 15:15, only futures and options show live prices. Index- and stock-based features (breadth, basket lead, index momentum) must stop at 15:15.
- The jump at about 15:28 is the auction price, not a move anyone could trade. A backtest that trades it books profits that never existed.
- Pulse and the trading engine's signals read nothing from 15:15 and measure no outcome across it (`AUCTION_MINUTE` in [pulse.ts](../src/lib/insight/pulse.ts), since 18 November 2026).

**The feed's timestamp is the last trade's.** Dhan's `ltt` is when the instrument last traded, and quote packets also arrive between trades, when the book or the totals change. So `ltt` can lag the arrival time by seconds for a stock and hours for an illiquid option, and can step back a second. It is not feed latency. Feed latency, measured on the NIFTY index (which updates every second), is about 0.5 s typically and 1 s at worst.

**Restarts aren't gap records.** A socket that drops writes a `gap` record; an engine restart writes only `engine-stop` and `engine-start`. Anything reading a journal must treat the time between those two as missing.

## Data quality of the recorded days

Checked 17 November 2026 on 16 and 17 November.

| | 16 Nov | 17 Nov |
|---|---|---|
| NIFTY index | Every second from 09:15:00 to 15:29:59 | Same |
| Session minutes with no frames at all | 0 | 0 |
| Gaps in market hours | None | Two engine restarts: 09:19:57–09:20:05 and 09:34:49–09:35:45 |
| Socket drops | 07:40 and 08:31–08:34 IST, before the open (Dhan's side; both days) | Same |
| Stocks | Quote mode, all 50, until the 15:15 auction | Same |
| Options | None recorded | The trader's window only; strikes it moved away from stop after the 09:20 restart |
| Bad prices | None on the index or stocks | None |
