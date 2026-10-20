import type { WidgetConfig } from "../api/types";
import type { DisplayItem, DisplayStatus } from "./displayApi";
import type { BandKind } from "./wallTypes";

// The wall's rules as pure functions and numbers, so every threshold has a test at its boundary. No React, no DOM, no clock of its own:
// whoever calls passes the time in. The numbers are the brief's (R2 to R10) and the plan's amendments.

/** A swap asks for the next item's cards this long before its turn (at once when the item's `seconds` are fewer). */
export const FETCH_AHEAD_MS = 8_000;
/** A swap waits this long after the turn for the next item's cards, then fades anyway. */
export const SWAP_WAIT_MS = 5_000;
/** One half of the fade between two items: out, then in. */
export const FADE_HALF_MS = 150;
/** The heartbeat that notices a wall-clock jump (a sleeping machine wakes with the clock far ahead). */
export const HEARTBEAT_MS = 5_000;
export const WAKE_JUMP_MS = 15_000;
/** A card whose own failures are this old is dimmed and tagged "Not updated since". */
export const NOT_UPDATED_MS = 120_000;
/** No answer for this long: the band "This screen has not been updated". */
export const SCREEN_BAND_MS = 120_000;
/**
 * A playlist read this old counts as no answer for the screen band (whole-wave review M5): the band clock follows the card answers, so without this a
 * playlist that never reads again (a 5xx for good) would freeze the collector and readings status and keep "Updated" fresh over figures that stopped changing.
 */
export const PLAYLIST_STALE_MS = 300_000;
/** After a wake the screen band stays away this long (the first reads are on their way). */
export const WAKE_HOLD_MS = 10_000;
/** At most one automatic reload in this time. */
export const RELOAD_GUARD_MS = 10_000;
/** A read that follows a 404 (the playlist moved) comes at most this often. */
export const REREAD_MIN_MS = 10_000;
/** The most widget requests of one display on the wire at once (w28 leaves ten screens about one slot each). */
export const MAX_IN_FLIGHT = 2;
/** The wait after the 1st, 2nd, 3rd, 4th and later failure of a request; jittered. */
export const BACKOFF_STEPS_MS: readonly number[] = [5_000, 10_000, 20_000];
/** Every wait grows by a random 0 to 30 percent, so ten screens that failed together do not come back together. */
export const JITTER_MAX = 0.3;
/** A revoked link is asked about again after these waits, then never (a reload asks again). */
export const REVOKED_STEPS_MS: readonly number[] = [300_000, 900_000, 3_600_000];
/** The collector band needs the collector to have been down this long (reads at least this far apart, none alive between). */
export const COLLECTOR_DOWN_MS = 50_000;
/** The server never calls readings stale under a minute, so an age under this carries no time worth saying. */
export const READINGS_FLOOR_SECONDS = 60;

const DATA_TYPES = new Set(["timeseries", "bar", "stat", "gauge", "table"]);
const WALL_REFETCH_MS = 30_000;
const WALL_COMPARE_REFETCH_MS = 60_000;
const BUSY_DEFAULT_S = 60;
const BUSY_MIN_S = 1;
const BUSY_MAX_S = 120;
/** A change of the clock offset this small is the `Date` header's one-second resolution, not a clock that moved. */
const OFFSET_NOISE_MS = 2_000;

/** The items the wall can draw, in order: not skipped, with a dashboard that has at least one widget. */
export function shownItems(items: readonly DisplayItem[]): DisplayItem[] {
  return items.filter((item) => item.skipped === null && item.dashboard !== null && item.dashboard.widgets.length > 0);
}

/** The 1-based place of an item among the shown ones, or null when it is not one of them. */
export function positionOf(shown: readonly DisplayItem[], id: number): { index: number; of: number } | null {
  const at = shown.findIndex((item) => item.id === id);
  return at < 0 ? null : { index: at + 1, of: shown.length };
}

/** The item after `currentId` (wrapping); the first one when nothing is current or the current one is no longer shown; null when nothing is shown. */
export function nextShown(shown: readonly DisplayItem[], currentId: number | null): DisplayItem | null {
  if (shown.length === 0) return null;
  const at = currentId === null ? -1 : shown.findIndex((item) => item.id === currentId);
  return shown[at < 0 ? 0 : (at + 1) % shown.length];
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, at) => same(value, b[at]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && same(left[key], right[key]));
}

/** True when the two definitions of an item differ in anything the wall draws: id, seconds, focus, or the dashboard (id, name, range and every field of every widget, its config compared structurally). */
export function itemsDiffer(a: DisplayItem, b: DisplayItem): boolean {
  return a.id !== b.id || a.seconds !== b.seconds || !same(a.focus, b.focus) || !same(a.dashboard, b.dashboard);
}

/** The five types whose figures the server computes; `text` and anything the wall does not know draws without a request. */
export function isDataWidget(type: string): boolean {
  return DATA_TYPES.has(type);
}

/** How old a card's figures may get before they are asked for again: a minute for a comparison (the server's figure cache adds up to a minute), 30 s for the others. */
export function wallRefetchMs(config: WidgetConfig | null | undefined): number {
  return config?.compare === "same_days_last_month" ? WALL_COMPARE_REFETCH_MS : WALL_REFETCH_MS;
}

/** True when a card has no answer yet, or its answer is old enough to ask again; a negative age (the clock moved back) counts as due. */
export function refetchDue(config: WidgetConfig | null | undefined, answeredAt: number | null, now: number): boolean {
  if (answeredAt === null) return true;
  const age = now - answeredAt;
  return age < 0 || age >= wallRefetchMs(config);
}

/** `ms` plus a random 0 to 30 percent, in whole milliseconds. */
export function jittered(ms: number, random: () => number): number {
  return Math.round(ms * (1 + JITTER_MAX * random()));
}

/** The wait after a failure; `attempt` 0 is the first failure in a row: 5, 10, 20 s, then 20 s, each jittered. */
export function failureWait(attempt: number, random: () => number): number {
  const step = Math.min(Math.max(Math.trunc(attempt), 0), BACKOFF_STEPS_MS.length - 1);
  return jittered(BACKOFF_STEPS_MS[step], random);
}

/** The wait after a 429: its `Retry-After` (60 s when there is none), kept within 1 to 120 s, jittered. */
export function busyWait(retryAfterSeconds: number | null, random: () => number): number {
  const seconds = retryAfterSeconds === null ? BUSY_DEFAULT_S : Math.min(Math.max(retryAfterSeconds, BUSY_MIN_S), BUSY_MAX_S);
  return jittered(seconds * 1000, random);
}

/**
 * The server's time minus this machine's, from an answer. An unreadable `Date` keeps `previous`; a readable one replaces it only when it differs by
 * more than 2 s (the header counts whole seconds, so a smaller change is noise, not a clock that moved). The first reading (`previous` null) is always taken.
 */
export function clockOffset(serverDate: number | null, receivedAt: number, previous: number | null): number {
  if (serverDate === null) return previous ?? 0;
  const next = serverDate - receivedAt;
  return previous === null || Math.abs(next - previous) > OFFSET_NOISE_MS ? next : previous;
}

/** "14:02" in the zone (24 hours); null for a zone the browser does not know or a moment that is no time, so nothing is drawn instead of a wrong hour. */
export function formatClock(ms: number, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(ms);
  } catch {
    return null;
  }
}

/** True when the server is now running another build than the one this page first saw (never `dev` to `dev`, never when either is unknown). */
export function buildChanged(first: string | null, current: string | null): boolean {
  return first !== null && current !== null && first !== current && !(first === "dev" && current === "dev");
}

/** At most one automatic reload per 10 s; a last reload in the future (the clock moved back) counts as recent. */
export function reloadAllowed(lastReloadAt: number | null, now: number): boolean {
  return lastReloadAt === null || now - lastReloadAt >= RELOAD_GUARD_MS;
}

/** The wait before asking again about a revoked link after the `attempt`th time (0 is the first): 5, 15, 60 minutes; null after that (stop asking). */
export function revokedWait(attempt: number): number | null {
  return Number.isInteger(attempt) ? (REVOKED_STEPS_MS[attempt] ?? null) : null;
}

/** When the readings stopped (server clock, ms): now minus the age the server reported; null when the age is unknown or under the 60 s floor. */
export function readingsStoppedAt(statusAgeSeconds: number | null, serverNow: number): number | null {
  if (statusAgeSeconds === null || !Number.isFinite(statusAgeSeconds) || statusAgeSeconds < READINGS_FLOOR_SECONDS) return null;
  return serverNow - statusAgeSeconds * 1000;
}

export interface Band {
  kind: BandKind;
  text: string;
}
export interface BandInput {
  /** The server-clock time now. */
  now: number;
  /** The last successful answer the screen band counts from (A3). */
  bandClock: number;
  /** The screen band stays away until this time (a wake holds it for 10 s). */
  wakeHoldUntil: number;
  status: DisplayStatus | null;
  /** How long the collector has been down by the polls (reads at least 50 s apart, none alive between); null when it is not known to be down. */
  collectorDownMs: number | null;
  /** When the readings stopped, fixed once when the readings band opens; null when it is not known (the band then has no time). */
  readingsStoppedAt: number | null;
  timeZone: string;
}

/** The one band to show, or null. The screen not being updated beats the collector stopping, which beats the readings stopping: one at a time. */
export function bandFor(input: BandInput): Band | null {
  const { now, bandClock, wakeHoldUntil, status, collectorDownMs, readingsStoppedAt: stoppedAt, timeZone } = input;
  if (now - bandClock >= SCREEN_BAND_MS && now >= wakeHoldUntil) {
    const time = formatClock(bandClock, timeZone);
    return { kind: "screen", text: `This screen has not been updated${time === null ? "" : ` since ${time}`}. Trying again...` };
  }
  if (collectorDownMs !== null && collectorDownMs >= COLLECTOR_DOWN_MS) return { kind: "collector", text: "The data collector stopped." };
  if (status !== null && status.readingsFresh === false) {
    const time = stoppedAt === null ? null : formatClock(stoppedAt, timeZone);
    return { kind: "readings", text: time === null ? "Readings stopped arriving." : `Readings stopped arriving at ${time}.` };
  }
  return null;
}
