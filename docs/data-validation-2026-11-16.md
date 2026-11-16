# Live data validation, 16 November 2026

A check, during the live session, that the engine's feed and journal match what Dhan reports. Checked at about 14:02 IST on Monday 16 November 2026, against engine version `fa1a5ef`.

**Result: the data is correct.** Every stock's price, day range, volume, average price and previous close matches Dhan's REST API exactly. The journal has every session minute and no lost data.

## What was checked

| Source | How |
|---|---|
| Engine status | `GET /v1/status` on the control API |
| Decoded session | `GET /v1/journal/session?date=2026-11-16`: the journal file decoded with the live feed's parser |
| Raw journal | `data/engine/journal/2026-11-16.bin` read with `decodeJournal()` |
| Dhan's reference | One `POST /marketfeed/quote` for every subscribed instrument, taken 0.2 s before the engine snapshot |
| Engine log | `data/engine/logs/2026-11-16.jsonl`, warnings and errors |

## Engine state

| Item | Value |
|---|---|
| Overall health | `ok`, every component ok |
| Running since | 06:36 IST (pid 53811), before the 09:00 pre-open |
| Token | From Redis, valid until 17 November 06:23 IST |
| Data plan | Active until 16 December 2026 |
| Clock offset from Dhan | −2 ms (±525 ms) |
| Journal | 71.5 MB, about 748,000 frames, no disk backlog, no write errors |
| Process | 124 MB RSS, 1% CPU, event-loop delay p99 1.7 ms |

## The Live Feed panel's numbers

The Main socket panel read: 53 instruments · open 5h 26m · 7,46,511 frames · 50.9 MB · Ticker 3,07,463 · Prev close 16 · Quote 9,70,023.

| Number | Meaning |
|---|---|
| 53 instruments | The 51 always-on instruments (NIFTY in Ticker mode, its 50 constituents in Quote mode), plus BANKNIFTY and `NSE_EQ:764173`, which open pages added |
| open 5h 26m | The socket has been live since its last reconnect at 08:34 IST |
| Frames against packets | Ticker plus Quote is about 1.28 million packets in 746,000 frames. Dhan packs several packets into one frame |
| Prev close 16 | Expected: Dhan sends no previous-close packet in Quote mode, only for Ticker subscriptions |

## Compared with Dhan's REST quote

All 50 NIFTY constituents:

| Field | Result |
|---|---|
| Last price | Identical for all 50 |
| Day open, high, low | Identical for all 50 |
| Average traded price | Identical for all 50 |
| Volume | Identical. One stock was 1 share ahead because the engine had already received the next trade |
| Reference (previous close) | Identical to Dhan's official close for all 52 instruments that have one |

Several stocks have a previous close equal to today's open (RELIANCE, HDFCBANK, ITC, BAJFINANCE, BEL, BSE, HDFCLIFE). Dhan's REST figures agree, so this is real, not a reference bug.

## Journal integrity

| Check | Result |
|---|---|
| Session minutes, 09:15 to 14:01 | 287 of 287 present |
| Frames per minute | Minimum 1,040, median 2,385, maximum 2,561 |
| Longest silence during market hours | 253 ms (09:47:29) |
| Cut-off records | None |
| Record numbering | Continuous. It restarts only at engine starts, all before 06:37 |
| Timestamps going backwards | 2, each 1 ms, between control records at engine start. Harmless |
| NIFTY 1-minute bars | All consistent (low ≤ open, close ≤ high), no jumps over 15 points between bars |
| Always-on instruments | All 51 ticked within the last second |
| Stock data | Every stock has a reference, an open, high and low, an average price and volume. Last price and open lie within the day's range |

## Gaps

Both were before the market opened, so no session data was lost.

| From | To | Cause |
|---|---|---|
| 07:40:09 | 07:40:13 | Dhan closed the socket (1006); it reconnected on its own |
| 08:34:17 | 08:34:25 | The same |

## Known limitations

1. **Index open, high and low are approximate.** Indices stream in Ticker mode, so the engine builds these from about one tick a second and can miss the exact extremes. On the day: NIFTY open 25203.75 against the exchange's 25206.15, low 25182.55 against 25182.50, high exact. Last prices are exact. Use the REST quote when you need the official index range.
2. **Instruments that only pages subscribe are recorded with gaps.** BANKNIFTY was released at 13:24:59 and subscribed again at 13:56:52, so the day's file is missing about 32 minutes of it. FINNIFTY, MIDCPNIFTY, SENSEX and BANKEX came and went with a page the same way. Add an instrument to [config/engine/universe.json](../config/engine/universe.json) to record it all day.

## Repeating this check

1. `GET /v1/status` with `Authorization: Bearer $ENGINE_TOKEN`. Check that overall is `ok`, the journal has no backlog or error, and the gaps are explained in the log.
2. `GET /v1/journal/session?date=<IST date>`. Check that every session minute is present, the always-on instruments ticked recently, and every stock has a reference, an open, high and low, and volume.
3. Make one `POST /marketfeed/quote` for the same instruments (through `dhanRequest`), then compare last price, open, high, low, `average_price`, `volume` and `ohlc.close` (previous close) with the session view taken at the same moment.
4. Read the raw file with `decodeJournal()`: check `truncatedBytes` is 0, record numbers run on without breaks between restarts, and no silence in market hours lasts longer than a second.
