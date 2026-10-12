/**
 * The state machine behind the thin loading bar along the top edge (`TopProgress` draws it). It only decides the phase; the bar's
 * motion is CSS. Timers are injected so the tests are deterministic.
 *
 * Phases: `idle` (nothing shown), `reset` (width 0 with no transition, one frame so a restart does not sweep backwards), `run`
 * (sweeping towards 85 percent, waiting for the load), `finish` (to 100 percent), `fade` (opacity out).
 * Sources: `fetching` and `mutating` are set by the component from React Query, `pending` by `Pending` (Suspense fallbacks); a
 * navigation is a `pulse()`. Without `attach()` (no bar mounted) nothing happens and no timer is started.
 */
export type Phase = "idle" | "reset" | "run" | "finish" | "fade";
export type Source = "fetching" | "mutating" | "pending";

/** A load shorter than this never shows the bar. */
export const SHOW_DELAY_MS = 120;
/** A navigation holds the bar at least this long, so a fast page still reads as a page change. */
export const MIN_SWEEP_MS = 400;
/** Quiet time before the bar finishes: chained loads (a lazy chunk and then its queries) would otherwise finish and restart. */
export const SETTLE_MS = 100;
export const FINISH_MS = 150;
export const FADE_MS = 200;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Progress {
  getPhase(): Phase;
  subscribe(listener: () => void): () => void;
  getCount(source: Source): number;
  setCount(source: Source, count: number): void;
  /** Counts one more load for `source`; the returned function takes it back (once, however often it is called). */
  add(source: Source): () => void;
  /** A navigation: shows the bar at once and holds it for MIN_SWEEP_MS. */
  pulse(): void;
  /** `reset` to `run`, called by the component after it has flushed the reset style. */
  advance(): void;
  /** A bar is mounted. Calls nest (StrictMode); the last `detach()` clears every timer and returns to `idle`. */
  attach(): void;
  detach(): void;
}

export function createProgress(timers: Timers = realTimers): Progress {
  let phase: Phase = "idle";
  const counts: Record<Source, number> = { fetching: 0, mutating: 0, pending: 0 };
  const listeners = new Set<() => void>();
  let attached = 0;
  let holding = false; // a pulse is being held
  let showTimer: unknown = null; // idle: the load has to last SHOW_DELAY_MS
  let stageTimer: unknown = null; // run: the quiet time, then finish, then fade, then idle
  let holdTimer: unknown = null;

  const wanted = () => holding || counts.fetching + counts.mutating + counts.pending > 0;
  const go = (next: Phase) => {
    if (phase === next) return;
    phase = next;
    for (const listener of [...listeners]) listener();
  };
  const clearShow = () => { if (showTimer !== null) timers.clear(showTimer); showTimer = null; };
  const clearStage = () => { if (stageTimer !== null) timers.clear(stageTimer); stageTimer = null; };
  const clearHold = () => { if (holdTimer !== null) timers.clear(holdTimer); holdTimer = null; };
  const stage = (ms: number, then: () => void) => {
    clearStage();
    stageTimer = timers.set(() => { stageTimer = null; then(); }, ms);
  };

  function evaluate() {
    if (attached === 0) return;
    if (phase === "idle") {
      if (holding) { clearShow(); go("run"); } // a navigation shows at once
      else if (!wanted()) clearShow();
      else if (showTimer === null) showTimer = timers.set(() => { showTimer = null; if (wanted()) go("run"); evaluate(); }, SHOW_DELAY_MS);
    } else if (phase === "run") {
      if (wanted()) clearStage();
      else if (stageTimer === null) {
        stage(SETTLE_MS, () => {
          if (wanted()) return;
          go("finish");
          stage(FINISH_MS, () => {
            go("fade");
            stage(FADE_MS, () => { go("idle"); evaluate(); });
          });
        });
      }
    } else if (phase !== "reset" && wanted()) { // finish or fade: start again from zero
      clearStage();
      go("reset");
    }
  }

  return {
    getPhase: () => phase,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getCount: (source) => counts[source],
    setCount(source, count) {
      const next = Math.max(0, Math.trunc(count));
      if (counts[source] === next) return;
      counts[source] = next;
      evaluate();
    },
    add(source) {
      counts[source] += 1;
      evaluate();
      let taken = false;
      return () => {
        if (taken) return;
        taken = true;
        counts[source] -= 1;
        evaluate();
      };
    },
    pulse() {
      if (attached === 0) return;
      holding = true;
      clearHold();
      holdTimer = timers.set(() => { holdTimer = null; holding = false; evaluate(); }, MIN_SWEEP_MS);
      evaluate();
    },
    advance() {
      if (phase !== "reset") return;
      go("run");
      evaluate();
    },
    attach() {
      attached += 1;
      evaluate(); // a count set before the bar mounted (or before StrictMode's second mount) must still show
    },
    detach() {
      if (attached === 0) return;
      attached -= 1;
      if (attached > 0) return;
      clearShow();
      clearStage();
      clearHold();
      holding = false;
      go("idle"); // the counts stay: they belong to their sources
    },
  };
}

/** The one bar of the app. */
export const progress = createProgress();
