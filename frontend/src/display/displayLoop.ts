import { claim, getPlaylist, type DisplayPlaylist, type PlaylistReply } from "./displayApi";
import { reloadClean } from "./reloadClean";
import type { SecretHandle } from "./secretHandle";
import { jittered, revokedWait } from "./wallRules";

// What the display screen does after the page loaded: trade the link's secret for the cookie (once), read the playlist, read it again
// every minute, and say in one sentence how it is doing (once connected, it hands every playlist to the wall instead). No React in here,
// so the clock and the requests can be stood in for.

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
// A revoked or unknown link is asked about again after 5, 15 and 60 minutes, then never: `revokedWait` in wallRules.ts.
/** A blocked address stays blocked for 15 minutes: the claim's own `Retry-After` is used, within 5 seconds to 15 minutes, and 15 minutes without one. */
export const BLOCKED_RETRY_MS = 900_000;
export const BLOCKED_RETRY_MIN_MS = 5_000;
/** A playlist 429 means "busy" or "a few reads too many": ask again after its `Retry-After`, within 1 to 60 seconds, and 60 without one. */
export const BUSY_RETRY_MIN_MS = 1_000;
export const BUSY_RETRY_MAX_MS = 60_000;

/** A claim 429 that says "busy, try again" (one display claiming too often) is no block: ask again after its `Retry-After`, within 5 to 120 seconds, and 60 without one. */
export const CLAIM_BUSY_RETRY_MIN_MS = 5_000;
export const CLAIM_BUSY_RETRY_MAX_MS = 120_000;
export const CLAIM_BUSY_RETRY_DEFAULT_MS = 60_000;

/** The wait in milliseconds for a `Retry-After` in seconds (null: missing or not a number), kept between `min` and `max`; `fallback` (`max` unless given) when null. */
function retryWait(retryAfter: number | null, min: number, max: number, fallback: number = max): number {
  return retryAfter === null ? fallback : Math.min(Math.max(retryAfter * 1000, min), max);
}
/** The wait after the first failure to reach the server; it doubles each time up to the cap and starts again after any answer. */
export const BACKOFF_START_MS = 5_000;
export const BACKOFF_CAP_MS = 60_000;
/** Once a dashboard was drawn the wait stays short (5, 10, 20 s, each with a random 0 to 30 percent added), so a server that comes back is reached soon. */
export const RECONNECT_CAP_MS = 20_000;

export type DisplayState =
  | { kind: "connecting" }
  // `receivedAt` is this machine's clock (ms) at the answer, `serverDate` the server's (its `Date` header, ms) or null; a new object after EVERY good read.
  | { kind: "connected"; reply: DisplayPlaylist; receivedAt: number; serverDate: number | null }
  | { kind: "notConnected" }
  | { kind: "revoked" }
  | { kind: "blocked" }
  | { kind: "offline" };

/**
 * `blocked` carries how long the address stays blocked and `busy` how long to wait before claiming again (both milliseconds, from the
 * claim's `Retry-After`); the other three are plain answers. Neither `blocked` nor `busy` is a definite answer.
 */
export type ClaimOutcome = "ok" | "refused" | "unreachable" | { kind: "blocked"; waitMs: number } | { kind: "busy"; waitMs: number };

/**
 * The one claim of this page load. The address was cleared before anything ran, so the secret exists only in the page's memory, and only
 * until the claim has had a definite answer. A second start of the screen (StrictMode runs an effect twice; an error boundary mounts the
 * screen again) shares the first claim, and a claim that had no answer (no network, a 5xx, a block, a busy server) is forgotten so the next try can be
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
      ({ status, retryAfter, busy }): ClaimOutcome => {
        if (status >= 200 && status < 300) {
          // The cookie is set. The browser keeps this document's first address (with the secret) in its navigation entry for as long as the
          // document lives, so the page is loaded again without it. Only an accepted claim does this: after a refusal the page must keep
          // saying so (a fresh load has no link and would say "not connected"). It is here, in the one claim of the page load, so a second
          // start of the screen (StrictMode, an error boundary) shares the answer and never reloads twice.
          const outcome = answered(handle, "ok");
          reloadClean();
          return outcome;
        }
        if (status === 401 || status === 403 || status === 422) return answered(handle, "refused");
        // A 429 is never a definite answer: the secret stays in the handle for the retry. "Busy" (this display claims too often) is a short
        // wait; any other 429 is the blocked address.
        if (status === 429 && busy) {
          return { kind: "busy", waitMs: retryWait(retryAfter, CLAIM_BUSY_RETRY_MIN_MS, CLAIM_BUSY_RETRY_MAX_MS, CLAIM_BUSY_RETRY_DEFAULT_MS) };
        }
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
  /** Local ms, to remember when a `Retry-After` wait ends and to stamp each answer; the clock by default. */
  now?: () => number;
  /** 0 up to 1, for the jitter of the retries after a first success; `Math.random` by default. */
  random?: () => number;
}

/** What `startDisplay` returns: call it to stop; `refresh()` asks for a playlist read now (see there). */
export type DisplayLoop = (() => void) & { refresh(): void };

/**
 * Starts the screen. `link` is the handle on the link's secret when the page was opened with one, else null (the cookie may already be
 * there); the claim reads the secret from it and releases it at the first definite answer, and this function never keeps the string.
 * `onState` hears every change of state, never after `stop()`. Returns `stop()`, which clears the timer and ignores any answer still on its way,
 * with `stop.refresh()` on it.
 */
export function startDisplay(link: SecretHandle | null, onState: (state: DisplayState) => void, deps: DisplayDeps = {}): DisplayLoop {
  const timers = deps.timers ?? realTimers;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  let stopped = false;
  let handle: unknown = null;
  let backoff = BACKOFF_START_MS;
  // A 401 on the playlist reads "not connected" only on a screen that never had a link, never was connected, and was not told that its
  // cookie matches no display.
  const linkTried = link !== null;
  let wasConnected = false;
  // The revoked answers since the last 200: 5, 15 and 60 minutes to the next read, then none.
  let revokedAnswers = 0;
  // What refresh() checks: the last state emitted is "connected" (a failed read after that emits nothing, so a retrying wall still counts), no read
  // is on the wire, and no `Retry-After` wait is running (`waitUntil`, local ms).
  let onWall = false;
  let reading = false;
  let waitUntil = 0;

  const emit = (state: DisplayState) => {
    if (stopped) return;
    onWall = state.kind === "connected";
    onState(state);
  };
  const later = (ms: number, next: () => Promise<void>) => {
    if (stopped) return;
    handle = timers.set(() => {
      handle = null;
      void next();
    }, ms);
  };
  const unreachable = (next: () => Promise<void>) => {
    // Once a dashboard was drawn the wall stays and the retry is silent (a full-screen sentence over a working wall would be a lie about a blip);
    // "offline" is for a screen that never connected.
    if (!wasConnected) emit({ kind: "offline" });
    later(wasConnected ? jittered(backoff, random) : backoff, next);
    backoff = Math.min(backoff * 2, wasConnected ? RECONNECT_CAP_MS : BACKOFF_CAP_MS);
  };
  /** A revoked answer (a refused claim, a 401 on a link that was tried, a cookie that matches no display): say so, then ask again after 5, 15 and 60 minutes. After that nothing is scheduled (the sentence stays; a page reload asks again). */
  const revoked = (next: () => Promise<void>) => {
    emit({ kind: "revoked" });
    const wait = revokedWait(revokedAnswers);
    revokedAnswers += 1;
    if (wait !== null) later(wait, next);
  };

  async function checkPlaylist(): Promise<void> {
    let reply: PlaylistReply;
    reading = true;
    try {
      reply = await getPlaylist();
    } catch {
      reading = false;
      if (!stopped) unreachable(checkPlaylist);
      return;
    }
    reading = false; // everything below is synchronous: no other read can start in between
    waitUntil = 0;
    if (stopped) return;
    if (reply.status === 200 && reply.playlist) {
      backoff = BACKOFF_START_MS;
      revokedAnswers = 0; // only a 200 starts the revoked schedule over
      wasConnected = true;
      emit({ kind: "connected", reply: reply.playlist, receivedAt: now(), serverDate: reply.serverDate });
      later(POLL_MS, checkPlaylist);
    } else if (reply.status === 401) {
      backoff = BACKOFF_START_MS;
      // A cookie that matches no active display is a revoked link even on a fresh load (the page cannot read an HttpOnly cookie to know).
      if (linkTried || wasConnected || reply.linkNotValid) {
        revoked(checkPlaylist);
      } else {
        emit({ kind: "notConnected" });
        later(POLL_MS, checkPlaylist);
      }
    } else if (reply.status === 429) {
      // Busy, or a few reads a minute too many: not a blocked address (only the claim says that). The page keeps what it shows, the wall or
      // "Connecting...", and asks again when the server said it may.
      backoff = BACKOFF_START_MS;
      const wait = retryWait(reply.retryAfter, BUSY_RETRY_MIN_MS, BUSY_RETRY_MAX_MS);
      waitUntil = now() + wait;
      later(wait, checkPlaylist);
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
      revoked(checkPlaylist); // an older cookie may still be good, or a restored backup may have brought the link back
    } else if (outcome !== "unreachable" && outcome.kind === "busy") {
      // Busy, not blocked: the page keeps what it shows ("Connecting..." before the first answer) and the link stays in memory.
      backoff = BACKOFF_START_MS;
      later(outcome.waitMs, makeClaim);
    } else if (outcome !== "unreachable") {
      backoff = BACKOFF_START_MS;
      emit({ kind: "blocked" });
      later(outcome.waitMs, makeClaim); // the link is still in memory: try it once the block has run out
    } else {
      unreachable(makeClaim); // no answer: the claim is made again, the playlist would only say 401
    }
  }

  void (link === null ? checkPlaylist() : makeClaim());

  const stop = () => {
    stopped = true;
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
  /**
   * Reads the playlist now instead of at the next poll (the wall asks after a widget answered 404, and after a wake). It acts only while the wall is
   * what the screen shows (the last state emitted is "connected"; a failed read after that emits nothing, so the wall can still ask while the loop
   * retries), with no read on the wire and no `Retry-After` wait running; otherwise it does nothing. The pending poll is cleared first, so there is
   * never a second chain.
   * It never touches the claim, a claim timer, the secret handle or the revoked schedule: they are not reachable from here.
   */
  const refresh = () => {
    if (stopped || !onWall || reading || now() < waitUntil) return;
    if (handle !== null) timers.clear(handle);
    handle = null;
    void checkPlaylist();
  };
  return Object.assign(stop, { refresh });
}
