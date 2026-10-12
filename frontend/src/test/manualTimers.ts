import type { Timers } from "../lib/progress";

/**
 * A clock the test moves by hand, for `createProgress(timers)`. Vitest's global fake timers are not used with React Query:
 * it notifies through setTimeout(0), so `waitFor` would hang.
 */
export function manualTimers() {
  let now = 0;
  let next = 0;
  let scheduled = 0;
  const pending = new Map<number, { fn: () => void; at: number }>();
  const timers: Timers = {
    set(fn, ms) {
      next += 1;
      scheduled += 1;
      pending.set(next, { fn, at: now + ms });
      return next;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    /** Moves the clock by `ms`, running every timer that falls due, in order, including the ones they set. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending].filter(([, timer]) => timer.at <= end).sort(([a, x], [b, y]) => x.at - y.at || a - b)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    /** Timers waiting to run. */
    get count() { return pending.size; },
    /** Timers ever set, so a test can show that nothing was ever armed. */
    get scheduled() { return scheduled; },
  };
}
