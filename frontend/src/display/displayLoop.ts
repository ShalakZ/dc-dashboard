import { claim, getPlaylist, type PlaylistReply } from "./displayApi";
import type { SecretHandle } from "./secretHandle";

// What the display screen does after the page loaded: trade the link's secret for the cookie (once), read the playlist, read it again
// every minute, and say in one sentence how it is doing. No React in here, so the clock and the requests can be stood in for.

/** Timers the tests can move by hand (the shape of lib/progress's, which this file does not import). */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** How the screen reads the playlist while all is well. */
export const POLL_MS = 60_000;
/** A revoked or unknown link: ask again this rarely (an administrator may have made the link valid again by restoring a backup). */
export const REVOKED_RECHECK_MS = 300_000;
/** A blocked address stays blocked for 15 minutes: the claim's own `Retry-After` is used, within 5 seconds to 15 minutes, and 15 minutes without one. */
export const BLOCKED_RETRY_MS = 900_000;
export const BLOCKED_RETRY_MIN_MS = 5_000;
/** A playlist 429 means "busy" or "a few reads too many": ask again after its `Retry-After`, within 1 to 60 seconds, and 60 without one. */
export const BUSY_RETRY_MIN_MS = 1_000;
export const BUSY_RETRY_MAX_MS = 60_000;

/** The wait in milliseconds for a `Retry-After` in seconds (null: missing or not a number), kept between `min` and `max`; `max` when null. */
function retryWait(retryAfter: number | null, min: number, max: number): number {
  return retryAfter === null ? max : Math.min(Math.max(retryAfter * 1000, min), max);
}
/** The wait after the first failure to reach the server; it doubles each time up to the cap and starts again after any answer. */
export const BACKOFF_START_MS = 5_000;
export const BACKOFF_CAP_MS = 60_000;

export type DisplayState =
  | { kind: "connecting" }
  | { kind: "connected"; displayName: string; playlistName: string; dashboards: number; skipped: number }
  | { kind: "notConnected" }
  | { kind: "revoked" }
  | { kind: "blocked" }
  | { kind: "offline" };

/** `blocked` carries how long the address stays blocked (milliseconds, from the claim's `Retry-After`); the other three are plain answers. */
export type ClaimOutcome = "ok" | "refused" | "unreachable" | { kind: "blocked"; waitMs: number };

/**
 * The one claim of this page load. The address was cleared before anything ran, so the secret exists only in the page's memory, and only
 * until the claim has had a definite answer. A second start of the screen (StrictMode runs an effect twice; an error boundary mounts the
 * screen again) shares the first claim, and a claim that had no answer (no network, a 5xx, a block) is forgotten so the next try can be
 * made, with the secret still in the handle. A definite answer (accepted, or refused as wrong, revoked or malformed) is kept as the
 * answer and the secret is released at that moment: asking again would only be a wrong secret to count. The memo holds the answer, never
 * the secret and never the handle.
 */
let claimed: { outcome: Promise<ClaimOutcome> } | null = null;

function claimOnce(handle: SecretHandle): Promise<ClaimOutcome> {
  if (claimed !== null) return claimed.outcome;
  const secret = handle.secret();
  if (secret === null) return Promise.resolve("refused"); // already released with no answer kept: only a reset memo (a test) gets here
  const entry = {
    outcome: claim(secret).then(
      ({ status, retryAfter }): ClaimOutcome => {
        if (status >= 200 && status < 300) return answered(handle, "ok");
        if (status === 401 || status === 403 || status === 422) return answered(handle, "refused");
        // A 429 is never a definite answer: the secret stays in the handle for the retry.
        return status === 429 ? { kind: "blocked", waitMs: retryWait(retryAfter, BLOCKED_RETRY_MIN_MS, BLOCKED_RETRY_MS) } : "unreachable";
      },
      (): ClaimOutcome => "unreachable",
    ),
  };
  claimed = entry;
  void entry.outcome.then((outcome) => {
    if (outcome !== "ok" && outcome !== "refused" && claimed === entry) claimed = null;
  });
  return entry.outcome;
}

/** A definite answer: the secret has done its one job, so the handle lets go of it, whether or not the screen that asked is still mounted. */
function answered(handle: SecretHandle, outcome: ClaimOutcome): ClaimOutcome {
  handle.release();
  return outcome;
}

/** For tests: forgets the claim of the page load, so the next test starts clean. */
export function resetClaimMemo(): void {
  claimed = null;
}

/** For tests: the memo itself (null while no claim is remembered), to prove it holds the answer and not the secret. */
export function claimMemoSnapshot(): { outcome: Promise<ClaimOutcome> } | null {
  return claimed;
}

export interface DisplayDeps {
  timers?: Timers;
}

/**
 * Starts the screen. `link` is the handle on the link's secret when the page was opened with one, else null (the cookie may already be
 * there); the claim reads the secret from it and releases it at the first definite answer, and this function never keeps the string.
 * `onState` hears every change of state, never after `stop()`. Returns `stop()`, which clears the timer and ignores any answer still on its way.
 */
export function startDisplay(link: SecretHandle | null, onState: (state: DisplayState) => void, deps: DisplayDeps = {}): () => void {
  const timers = deps.timers ?? realTimers;
  let stopped = false;
  let handle: unknown = null;
  let backoff = BACKOFF_START_MS;
  // A 401 on the playlist reads "not connected" only on a screen that never had a link and never was connected.
  const linkTried = link !== null;
  let wasConnected = false;

  const emit = (state: DisplayState) => {
    if (!stopped) onState(state);
  };
  const later = (ms: number, next: () => Promise<void>) => {
    if (stopped) return;
    handle = timers.set(() => {
      handle = null;
      void next();
    }, ms);
  };
  const unreachable = (next: () => Promise<void>) => {
    emit({ kind: "offline" });
    later(backoff, next);
    backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
  };

  async function checkPlaylist(): Promise<void> {
    let reply: PlaylistReply;
    try {
      reply = await getPlaylist();
    } catch {
      if (!stopped) unreachable(checkPlaylist);
      return;
    }
    if (stopped) return;
    if (reply.status === 200 && reply.playlist) {
      backoff = BACKOFF_START_MS;
      wasConnected = true;
      const { items, name } = reply.playlist.playlist;
      emit({
        kind: "connected",
        displayName: reply.playlist.display.name,
        playlistName: name,
        dashboards: items.length,
        skipped: items.filter((item) => item.skipped !== null).length,
      });
      later(POLL_MS, checkPlaylist);
    } else if (reply.status === 401) {
      backoff = BACKOFF_START_MS;
      const revoked = linkTried || wasConnected;
      emit({ kind: revoked ? "revoked" : "notConnected" });
      later(revoked ? REVOKED_RECHECK_MS : POLL_MS, checkPlaylist);
    } else if (reply.status === 429) {
      // Busy, or a few reads a minute too many: not a blocked address (only the claim says that). The page keeps what it shows, the last
      // good "Connected as ..." or "Connecting...", and asks again when the server said it may.
      backoff = BACKOFF_START_MS;
      later(retryWait(reply.retryAfter, BUSY_RETRY_MIN_MS, BUSY_RETRY_MAX_MS), checkPlaylist);
    } else {
      unreachable(checkPlaylist); // a 5xx, a proxy's page, an answer that is not a playlist
    }
  }

  async function makeClaim(): Promise<void> {
    if (link === null) return;
    const outcome = await claimOnce(link);
    if (stopped) return;
    if (outcome === "ok") {
      backoff = BACKOFF_START_MS;
      await checkPlaylist();
    } else if (outcome === "refused") {
      backoff = BACKOFF_START_MS;
      emit({ kind: "revoked" });
      later(REVOKED_RECHECK_MS, checkPlaylist); // an older cookie may still be good, or a restored backup may have brought the link back
    } else if (outcome !== "unreachable") {
      backoff = BACKOFF_START_MS;
      emit({ kind: "blocked" });
      later(outcome.waitMs, makeClaim); // the link is still in memory: try it once the block has run out
    } else {
      unreachable(makeClaim); // no answer: the claim is made again, the playlist would only say 401
    }
  }

  void (link === null ? checkPlaylist() : makeClaim());

  return () => {
    stopped = true;
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
}
