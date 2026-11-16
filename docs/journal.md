# The journal

What the engine's journal is, what it records, how it behaves, and what it is for. Written 2026-11-15. For the engine as a whole see [engine.md](engine.md); for what comes next see [engine-plan.md](engine-plan.md).

## Contents

1. [In one paragraph](#in-one-paragraph)
2. [Why it exists](#why-it-exists)
3. [What it records](#what-it-records)
4. [How it behaves](#how-it-behaves)
5. [What it is for](#what-it-is-for)
6. [What it doesn't do yet](#what-it-doesnt-do-yet)
7. [Where to see it](#where-to-see-it)
8. [File format](#file-format)
9. [Reading a journal file](#reading-a-journal-file)
10. [Size](#size)
11. [When something goes wrong](#when-something-goes-wrong)
12. [Code](#code)

## In one paragraph

The journal is a recording of the market data stream, exactly as Dhan sent it. Every WebSocket frame the engine receives is written to a file on disk, byte for byte, before anything parses it, together with the time it arrived and a running number that fixes its order. Alongside the frames, it records what the engine was doing: when it started and stopped, what was subscribed, when a socket connected or dropped, and where data is missing. One file per trading day, in IST: `data/engine/journal/2026-11-16.bin`.

## Why it exists

Everything the engine computes (bars, VWAP, signals, strategy decisions, paper fills) is derived from the feed. The journal keeps the one thing that can't be derived or bought back later: the raw input.

| Without a journal | With the journal |
|---|---|
| A bug in the parser or bar builder silently corrupts the data you keep, and the original is gone | Fix the code and decode the day again from the raw frames |
| A strategy can only be tested on 1-minute candles from Dhan's history API: no bid/ask, no order of trades within a minute | Replay a recorded day tick by tick through the same code that ran live |
| "Why did the strategy do that at 10:42?" can't be answered after the fact | Replay the day to 10:42 and watch every event that led there |
| UI and analytics work needs the market open | Replay a recorded session in the evening or at the weekend, at ×1, ×10 or ×60 ([built](engine.md#replay)) |
| Open questions about Dhan's feed (what `ltt` measures, packet 7, candle stamping) need a live session to answer | Answer them from a recorded day |

Dhan's history API keeps candles, not ticks. A session not recorded on the day is lost at tick level for good. That is why the journal is always on and why recording started before the analytics exist.

## What it records

Two kinds of records, interleaved in arrival order.

**Frames.** Each WebSocket message from Dhan, unchanged. A frame holds a binary packet: a ticker (last price), a previous close, a quote, OI, market depth and so on, depending on the subscription mode. Today the NIFTY index streams in Ticker mode (16-byte packets) and its 50 constituents in Quote mode (50-byte packets with volume, VWAP, last traded quantity, buy/sell quantity and day OHLC). Full mode (162 bytes, adding OI and depth) is recorded the same way when used.

**Control records**, as small JSON objects:

| Record | Written when | Carries |
|---|---|---|
| `file-open` | A new day's file is opened (engine start, or the first record after midnight IST) | The engine's version and every subscription in force, so a day replays on its own |
| `engine-start` | The engine starts | Version, pid, universe name |
| `engine-stop` | The engine stops cleanly | The reason (SIGINT, SIGTERM, crash) |
| `subscribe` / `unsubscribe` | Instruments are added to or removed from a socket | The instrument keys, the socket, and for `subscribe` the mode (`ticker`, `quote`, `full`) |
| `state` | A socket changes state | `connecting`, `live`, `reconnecting` (with the reason), `stopped` (with the reason), `idle` |
| `gap` | Data is known to be missing | `reason` (`reconnect`, `suspend`, or `replay` for time spent replaying), `from` and `to` times |
| `replay-start` / `replay-stop` | The feed switched to replaying a recorded day, and back to live | The day, start time and speed; the reason for stopping. See [engine.md](engine.md#replay) |

Example: the start of the 15 November file, from a run with the always-on universe and one browser tab open:

```
seq 1  control  file-open     version 524a9af-dirty, subscriptions []
seq 2  control  engine-start
seq 3  control  subscribe     51 keys on socket 1 (the NIFTY universe)
seq 4  control  state         socket 1 connecting
seq 5  control  state         socket 1 live
seq 6  frame    socket 1      16 bytes: ticker
...
seq …  control  subscribe     keys from a browser tab (Market Watch) on socket 1
```

**What is not recorded:** parsed packets (they come from the frames), log lines (they go to `data/engine/logs/`), REST calls, orders. The journal records the market data input; operational state such as orders will live in SQLite from E7.

## How it behaves

- **Always on.** It starts with the engine. There is no switch; `FEED_CAPTURE` no longer applies to the engine.
- **Written before parsing.** During market hours a frame is journaled the moment it arrives, unparsed, even if the parser later fails on it.
- **Repeats skipped while closed.** After the close Dhan keeps sending index ticker packets several times a second with the same last price and only the timestamp moving (16 November: about 36,000 NIFTY and BANKNIFTY packets between 15:31 and 16:47 IST, 4 with a new price). While a packet's segment is closed, the engine parses the frame and skips it only if every packet in it repeats the last value journaled for that instrument, ignoring the timestamp. The first packet of each instrument (the subscribe snapshot, which gives the previous close), every price change, the pre-open auction and frames it can't read are always kept, and so are segments missing from the calendar. On 16 November this kept 1,620 of 37,870 frames after the close (136 KB instead of 1.6 MB). The engine counts skipped frames in the `journal.frames_skipped` metric. Code: [closed-market-filter.ts](../src/engine/journal/closed-market-filter.ts).
- **One order across sockets.** The engine numbers records as they arrive (`seq`), across all up to 5 sockets. Together with the receive time, that fixes a single order for the day, which is what makes a replay reproduce the live run exactly. Numbering restarts at each engine start (an `engine-start` record marks it) and at each new day.
- **A file per IST day.** The file is named by the IST date of the record's receive time, so a session never spans two files. The server runs in UTC; the engine computes IST itself.
- **Restarts append.** Restarting the engine during the day appends to that day's file.
- **Gaps are explicit.** When a socket drops and reconnects, the engine records a `gap` from when it went down to when it was live again. If the engine's 1-second heartbeat fires more than 5 seconds late (the process was suspended or starved), it records a `gap` with reason `suspend`. Both are also logged as warnings. A replay knows exactly where data is missing instead of mistaking silence for a quiet market.
- **Crash-safe enough.** Writes go to the file through a stream; a crash loses at most what was in flight. A last record cut off mid-write is detected and skipped when the file is read.
- **Never slows the feed.** Writes are asynchronous. If the disk falls behind by more than 8 MB, the `journal` health turns degraded; on a write error (for example a full disk), failing.

## What it is for

| Use | Arrives with |
|---|---|
| Keeping every session from Monday 16 November 2026 on | Now |
| Checking the engine's 1-minute bars against Dhan's candles | E3 |
| **Feed replay:** a recorded day streamed through a stand-in for Dhan's socket, at a chosen speed, so every page works on recorded prices ([engine.md](engine.md#replay)) | Now |
| **Replay:** a recorded day through the same engine code, on a virtual clock, at chosen speed, watchable on the web like live | E4 |
| **Golden-file tests:** replaying a recorded day must produce exactly the bars the live run built, after every code change | E4 |
| Volume, VWAP and buy/sell pressure for the constituents, from the Quote packets | E3 onwards (recorded from 16 November 2026) |
| Tick-level strategy tests and paper trading on recorded days, with fills against recorded bid/ask | E6–E7 (bid/ask needs Full mode recordings of the traded contracts) |
| Measuring how far candle-only backtests are off, by comparing them with a replay of the same day | E5 |

## What it doesn't do yet

| Not yet | Plan |
|---|---|
| **Backup off the server.** Files exist only on the VM's disk; losing the disk loses every recorded session | Compress each finished day with zstd and upload it to the S3 bucket (`<prefix>journal/YYYY-MM-DD.bin.zst`), and catch up on start. Next in E2 |
| Compression | With the upload. Raw frames compress well |
| Retention | Decide after measuring a full session. Nothing is deleted today |
| Deterministic replay on a virtual clock (the feed replay runs on the wall clock) | E4 |
| OI and bid/ask (Full mode) | With NIFTY futures in the universe, next in E2 |

## Where to see it

- **Engine page → Session:** the day decoded from this file: NIFTY 1-minute bars, breadth, movers, every instrument's prices, volume and VWAP, and what the feed delivered (packets by kind, gaps, socket states, engine runs). See [engine.md](engine.md#what-you-see-on-the-web).
- **Engine page → Overview → Journal panel:** today's file, its size, frames, events and gaps written by this engine run, last write, write latency p99, any disk backlog, and recorded days with sizes.
- **Health:** the `journal` component in the Health panel and in the header dot's tooltip.
- **Metrics panel:** `journal.bytes`, `journal.backlog_bytes`, and `journal.write_ms` (write latency).
- **Logs:** `journal` lines for each new file and any write error; `feed` warnings for each gap.
- **On disk:** `ls -l ~/option-trader/data/engine/journal/`.

## File format

Defined in [format.ts](../src/engine/journal/format.ts).

```
file   = MAGIC record*
MAGIC  = "OTJRNL01"                         8 bytes, ASCII
record = length      u32                    bytes after this field
         type        u8                     1 = frame, 2 = control
         reserved    u8                     0
         connection  u16                    socket id; 0 for engine-wide records
         seq         f64                    1, 2, 3 … within an engine run and day
         recvTs      f64                    receive time, ms since the epoch
         payload     length − 20 bytes      raw frame, or UTF-8 JSON { "kind": …, … }
```

All numbers little-endian. The header is 24 bytes. `seq` and `recvTs` are stored as f64, which holds integers exactly up to 2^53.

Why binary and not JSON lines: the earlier `FEED_CAPTURE` files stored each frame as hex inside JSON, which doubles every byte and adds the JSON around it. Binary keeps frames as they are and makes reading fast.

## Reading a journal file

`decodeJournal(bytes)` returns every record and how many bytes at the end were cut off. A throwaway script, run from the repo:

```ts
// inspect.ts — run with: node inspect.ts data/engine/journal/2026-11-16.bin
import { readFileSync } from "node:fs";
import { decodeJournal } from "./src/engine/journal/format.ts";

const { records, truncatedBytes } = decodeJournal(readFileSync(process.argv[2]));
const kinds: Record<string, number> = {};
for (const r of records) kinds[r.control?.kind ?? "frame"] = (kinds[r.control?.kind ?? "frame"] ?? 0) + 1;
console.log(records.length, "records", kinds, "cut off:", truncatedBytes, "bytes");
for (const gap of records.filter((r) => r.control?.kind === "gap")) console.log("gap", gap.control);
```

To read a file while the engine is still writing it, use `readRecords(bytes, offset, onRecord)`: it stops before a record cut off at the end and returns where to resume. [session-reader.ts](../src/engine/journal/session-reader.ts) follows today's file this way.

To turn frames back into packets, pass `record.frame` to the feed parser in [packets.ts](../src/lib/live/feed/packets.ts), the same code the live feed uses.

## Size

Measured on 15 November 2026: a Ticker frame is 16 bytes (40 bytes on disk with the 24-byte record header); a Quote frame is 50 bytes (74 on disk). Full frames will be 162 bytes (186 on disk).

Rough estimate for a full session, to be replaced by Monday's real number: the 50 constituents updating about once a second each for 6¼ hours is around 1.1 million Quote records, about 80 MB a day. The disk has about 90 GB free.

## When something goes wrong

| Symptom | Meaning and fix |
|---|---|
| `journal` failing: "Write error" | The disk refused a write, usually because it's full: `df -h /`. Frames received while it fails are lost |
| `journal` degraded: "Disk is behind" | Writes queue faster than the disk takes them. Check disk load; it recovers on its own |
| No new frames during market hours | Not a journal problem: the Dhan feed panel shows the Main socket's state. A stopped socket usually means an expired token |
| Gaps in the panel | Each is a reconnect or a stall, with times in the logs. Short reconnect gaps are normal; many in a row point to the network or Dhan |
| A file looks cut off at the end | The engine stopped mid-write. Reading skips the partial last record; nothing else is affected |

## Code

| File | Role |
|---|---|
| [src/engine/journal/format.ts](../src/engine/journal/format.ts) | Encode and decode records |
| [src/engine/journal/writer.ts](../src/engine/journal/writer.ts) | Today's file, day rollover, counts, recorded days |
| [src/engine/feed.ts](../src/engine/feed.ts) | Sends frames and feed events to the journal; records reconnect gaps |
| [src/engine/journal/closed-market-filter.ts](../src/engine/journal/closed-market-filter.ts) | Skips repeated packets while the market is closed |
| [src/engine/main.ts](../src/engine/main.ts) | Creates the journal; `engine-start`/`engine-stop`, suspend gaps, `journal` health |
| [src/engine/journal/journal.test.ts](../src/engine/journal/journal.test.ts) | Format round trip, day rollover, restarts, cut-off files |
