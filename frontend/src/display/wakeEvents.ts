import type { Timers } from "./displayLoop";
import { HEARTBEAT_MS, WAKE_JUMP_MS } from "./wallRules";

// The four signs that a screen has just come back: the page becomes visible, the browser restores it from its page cache (`pageshow`), the network
// returns (`online`), or the clock jumped (a sleeping PC or TV wakes with the time far ahead; no event says so, a heartbeat notices). Each one calls
// `onWake` once. A page that is still hidden never wakes: the `visibilitychange` to visible is what wakes a hidden tab, and a hidden tab's throttled
// timers must not read anything.

export interface WakeEventsDeps {
  timers: Timers;
  /** Local ms. */
  now: () => number;
  onWake: () => void;
  /** The document and window to listen to; the page's own by default. */
  target?: { document: Document; window: Window };
}

/** Starts listening and returns the function that stops it (listeners removed, heartbeat cleared). */
export function installWakeEvents(deps: WakeEventsDeps): () => void {
  const { timers, now, onWake } = deps;
  const doc = deps.target?.document ?? document;
  const win = deps.target?.window ?? window;
  let installed = true;
  let last = now();
  let heartbeat: unknown = null;

  const wake = () => {
    if (installed && !doc.hidden) onWake();
  };
  const beat = () => {
    heartbeat = null;
    if (!installed) return;
    try {
      const t = now();
      const elapsed = t - last;
      last = t;
      if (elapsed > WAKE_JUMP_MS) wake(); // only forwards: a clock that moved back is ignored
    } finally {
      if (installed) heartbeat = timers.set(beat, HEARTBEAT_MS);
    }
  };

  doc.addEventListener("visibilitychange", wake);
  win.addEventListener("pageshow", wake);
  win.addEventListener("online", wake);
  heartbeat = timers.set(beat, HEARTBEAT_MS);

  return () => {
    if (!installed) return;
    installed = false;
    doc.removeEventListener("visibilitychange", wake);
    win.removeEventListener("pageshow", wake);
    win.removeEventListener("online", wake);
    if (heartbeat !== null) timers.clear(heartbeat);
    heartbeat = null;
  };
}
