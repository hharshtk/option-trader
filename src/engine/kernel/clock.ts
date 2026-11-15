// Kernel components get time only from a Clock. The live clock follows the wall clock; the
// virtual clock moves only when a replay or backtest advances it, so a run's results depend on
// its input alone.

export interface Clock {
  /** Milliseconds since the epoch. Virtual in replays and backtests. */
  now(): number;
  /** Calls `fire` once the clock reaches `time`. Returns a function that cancels it. */
  at(time: number, fire: () => void): () => void;
}

export interface VirtualClock extends Clock {
  /** Moves time forward to `time`, firing due timers in time order, then insertion order. */
  advanceTo(time: number): void;
  /** Timers not fired or cancelled yet. */
  readonly pending: number;
}

// setTimeout fires at once for delays above 2^31 - 1 ms (about 24.8 days), so longer waits
// are chained.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function createLiveClock(): Clock {
  return {
    // eslint-disable-next-line no-restricted-properties -- the live clock is the one place that reads wall time
    now: () => Date.now(),
    at(time, fire) {
      let handle: ReturnType<typeof setTimeout> | undefined;
      let cancelled = false;
      const schedule = () => {
        // eslint-disable-next-line no-restricted-properties -- see above
        const delay = time - Date.now();
        if (delay <= 0) {
          fire();
          return;
        }
        // eslint-disable-next-line no-restricted-globals -- see above
        handle = setTimeout(() => {
          if (!cancelled) schedule();
        }, Math.min(delay, MAX_TIMEOUT_MS));
      };
      // Fire asynchronously even when already due, so callers never re-enter themselves.
      // eslint-disable-next-line no-restricted-globals -- see above
      handle = setTimeout(() => {
        if (!cancelled) schedule();
      }, 0);
      return () => {
        cancelled = true;
        // eslint-disable-next-line no-restricted-globals -- see above
        clearTimeout(handle);
      };
    },
  };
}

interface Timer {
  time: number;
  order: number;
  fire: () => void;
}

export function createVirtualClock(start: number): VirtualClock {
  let now = start;
  let order = 0;
  // Kept sorted by (time, order). Runs have few timers, so a sorted array is enough.
  const timers: Timer[] = [];

  function insert(timer: Timer) {
    let index = timers.length;
    while (index > 0 && compare(timers[index - 1], timer) > 0) index -= 1;
    timers.splice(index, 0, timer);
  }

  return {
    now: () => now,
    at(time, fire) {
      // A time in the past fires on the next advance, at the current time.
      const timer: Timer = { time: Math.max(time, now), order: order++, fire };
      insert(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index !== -1) timers.splice(index, 1);
      };
    },
    advanceTo(time) {
      if (time < now) throw new Error(`Virtual clock can't go back from ${now} to ${time}`);
      // A fired timer may schedule more; they fire in this same advance if they are due.
      while (timers.length > 0 && timers[0].time <= time) {
        const timer = timers.shift()!;
        now = timer.time;
        timer.fire();
      }
      now = time;
    },
    get pending() {
      return timers.length;
    },
  };
}

function compare(a: Timer, b: Timer) {
  return a.time - b.time || a.order - b.order;
}
