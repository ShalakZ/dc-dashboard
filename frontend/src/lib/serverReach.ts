import { useSyncExternalStore } from "react";

/** One request that gets no answer is a blip (a restart, a dropped connection); this many in a row say the server is down. */
const DOWN_AFTER = 2;

let failures = 0;
let down = false;
const listeners = new Set<() => void>();

/**
 * The api client reports every request here: `reached` is false for a network failure and for a 502, 503 or 504, and true for any
 * other answer (500 too: the server answered). One answer that came clears the count; no timer is involved.
 */
export function noteReach(reached: boolean): void {
  failures = reached ? 0 : failures + 1;
  const next = failures >= DOWN_AFTER;
  if (next === down) return;
  down = next;
  listeners.forEach((listener) => listener());
}

/** Forgets what was reported. For tests, which share this module's state. */
export function resetServerReach(): void {
  failures = 0;
  if (!down) return;
  down = false;
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** True while the last two requests in a row got no answer from the server. */
export const useServerDown = (): boolean => useSyncExternalStore(subscribe, () => down, () => false);
