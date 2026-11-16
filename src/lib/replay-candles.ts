// Index chart candles during an engine replay. Bar times are shifted +5:30 (the chart labels its
// axis in UTC, so the shift makes it read in IST).

const IST_OFFSET_SECONDS = 5.5 * 3600;

export interface ChartBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * During an engine replay: the day's candles as Dhan would have served them at `until`, built
 * from 1-minute candles that had closed by then. The 5-minute candle in progress holds only its
 * finished minutes; replayed ticks extend it from there, as live ticks do.
 */
export function replayBars(oneMinute: ChartBar[], date: string, until: number, intervalMinutes: number): ChartBar[] {
  const bucketSeconds = intervalMinutes * 60;
  const untilShifted = until / 1000 + IST_OFFSET_SECONDS;
  const bars: ChartBar[] = [];
  for (const bar of oneMinute) {
    if (new Date(bar.time * 1000).toISOString().slice(0, 10) !== date || bar.time + 60 > untilShifted) continue;
    const time = Math.floor(bar.time / bucketSeconds) * bucketSeconds;
    const last = bars.at(-1);
    if (last?.time === time) {
      last.high = Math.max(last.high, bar.high);
      last.low = Math.min(last.low, bar.low);
      last.close = bar.close;
    } else {
      bars.push({ ...bar, time });
    }
  }
  return bars;
}
