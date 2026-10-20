// The display screen's own requests. It never imports api/client.ts: that module reports a 401 to the sign-in machinery and the
// screen has no user, no session and no /api/me. Every request is same-origin, never cached, JSON, and carries no Authorization.
import type { WidgetData } from "../api/types"; // a TYPE only: nothing of api/client.ts, api/queries.ts or auth/ may be imported here

/** One widget of a dashboard as the playlist carries it (`config` is the stored one; the wall reads it per type). */
export interface DisplayWidget {
  id: number;
  type: string;
  title: string;
  config: unknown;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface DisplayDashboard {
  id: number;
  name: string;
  range: string;
  widgets: DisplayWidget[];
}
/** The focus asset of an item: its name and the path to it, top first. */
export interface DisplayFocus {
  id: number;
  name: string;
  trail: string[];
}
/** The playlist answer (`GET /api/display/playlist`). */
export interface DisplayItem {
  id: number;
  seconds: number;
  /** Why the item cannot be shown ("dashboard_deleted", "focus_gone", "no_widgets"), else null. */
  skipped: string | null;
  /** Null for a skipped item, and for a dashboard the screen cannot read (a widget without its place or type). */
  dashboard: DisplayDashboard | null;
  focus: DisplayFocus | null;
}
export interface DisplaySite {
  name: string;
  timezone: string;
}
/** What the server knows about the data: `readingsFresh` is null while nothing was ever read. */
export interface DisplayStatus {
  collectorAlive: boolean;
  readingsFresh: boolean | null;
  lastReadingAgeSeconds: number | null;
}
/** `site`, `build` and `status` are null when the server did not send them (an older server) or sent something unreadable. */
export interface DisplayPlaylist {
  display: { name: string };
  playlist: { name: string; items: DisplayItem[] };
  site: DisplaySite | null;
  build: string | null;
  status: DisplayStatus | null;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseWidget(value: unknown): DisplayWidget | null {
  if (!record(value)) return null;
  const { id, type, title, config, x, y, w, h } = value;
  if (typeof id !== "number" || typeof type !== "string" || typeof title !== "string") return null;
  if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") return null;
  return { id, type, title, config, x, y, w, h };
}
/** A dashboard whose every widget is readable, else null: half a dashboard would be a wrong picture. */
function parseDashboard(value: unknown): DisplayDashboard | null {
  if (!record(value) || typeof value.id !== "number" || typeof value.name !== "string" || typeof value.range !== "string" || !Array.isArray(value.widgets)) return null;
  const widgets: DisplayWidget[] = [];
  for (const raw of value.widgets) {
    const widget = parseWidget(raw);
    if (widget === null) return null;
    widgets.push(widget);
  }
  return { id: value.id, name: value.name, range: value.range, widgets };
}
function parseFocus(value: unknown): DisplayFocus | null {
  if (!record(value) || typeof value.id !== "number" || typeof value.name !== "string" || !Array.isArray(value.trail)) return null;
  if (!value.trail.every((step) => typeof step === "string")) return null;
  return { id: value.id, name: value.name, trail: value.trail as string[] };
}
function parseSite(value: unknown): DisplaySite | null {
  return record(value) && typeof value.name === "string" && typeof value.timezone === "string" ? { name: value.name, timezone: value.timezone } : null;
}
function parseStatus(value: unknown): DisplayStatus | null {
  if (!record(value) || typeof value.collector_alive !== "boolean") return null;
  const fresh = value.readings_fresh;
  if (typeof fresh !== "boolean" && fresh !== null) return null;
  const age = value.last_reading_age_seconds ?? null;
  if (typeof age !== "number" && age !== null) return null;
  return { collectorAlive: value.collector_alive, readingsFresh: fresh, lastReadingAgeSeconds: age };
}

/** The answer as a typed playlist, or null when it is not one (a proxy's page, an older server): the screen then treats it as "cannot reach". */
export function parsePlaylist(data: unknown): DisplayPlaylist | null {
  if (!record(data) || !record(data.display) || !record(data.playlist)) return null;
  const { display, playlist } = data;
  if (typeof display.name !== "string" || typeof playlist.name !== "string" || !Array.isArray(playlist.items)) return null;
  const items: DisplayItem[] = [];
  for (const item of playlist.items) {
    if (!record(item)) return null;
    items.push({
      id: typeof item.id === "number" ? item.id : 0,
      seconds: typeof item.seconds === "number" ? item.seconds : 0,
      skipped: typeof item.skipped === "string" ? item.skipped : null,
      dashboard: parseDashboard(item.dashboard),
      focus: parseFocus(item.focus),
    });
  }
  return {
    display: { name: display.name },
    playlist: { name: playlist.name, items },
    site: parseSite(data.site),
    build: typeof data.build === "string" ? data.build : null,
    status: parseStatus(data.status),
  };
}

/** The server's clock at an answer: the `Date` header in ms, or null when it is absent or cannot be read. (The header has a resolution of one second.) */
export function serverDateOf(response: Response): number | null {
  const header = response.headers.get("Date");
  if (header === null) return null;
  const parsed = Date.parse(header);
  return Number.isNaN(parsed) ? null : parsed;
}

/** A signal that aborts after `ms` (20 s): a request that never answers is then a failure like any other. `AbortSignal.timeout` when the browser has it. */
export function timeoutSignal(ms = 20_000): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** The `Retry-After` of an answer in whole seconds, or null when it is missing or not a plain number (an HTTP date, text, a sign). */
export function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get("Retry-After")?.trim() ?? "";
  return /^\d+$/.test(value) ? Number(value) : null;
}

export interface ClaimReply {
  status: number;
  /** The seconds the server asked to wait (a 429 sends them), else null. */
  retryAfter: number | null;
  /** True for a 429 whose detail is exactly `CLAIM_BUSY`: this display claimed too often, which says nothing about the address being blocked. */
  busy: boolean;
}

/** The detail of the claim's "busy" 429 (one display claiming more than 30 times a minute); the same text as the server's, keep them identical. */
export const CLAIM_BUSY = "busy, try again";

/**
 * Trades the secret for the display cookie. The secret goes in the JSON body only, never in a URL, a header or the query, and this function
 * is the only place that holds it. Resolves with the HTTP status (204 on success), the `Retry-After` seconds and, for a 429, whether its
 * detail says "busy" (any other 429, or one with no readable body, is the blocked address); rejects when the request never completed.
 */
export async function claim(secret: string): Promise<ClaimReply> {
  const response = await fetch("/api/display/claim", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
    signal: timeoutSignal(), // a claim that never answers rejects like a network error: "unreachable", the secret stays in the handle
  });
  let busy = false;
  if (response.status === 429) {
    try {
      const body: unknown = await response.json();
      busy = record(body) && body.detail === CLAIM_BUSY;
    } catch {
      // not JSON (a proxy's page): the blocked address, as before
    }
  }
  return { status: response.status, retryAfter: retryAfterSeconds(response), busy };
}

export interface PlaylistReply {
  status: number;
  /** Set for a 200 whose body is a playlist; a 200 that is not one has `playlist: null`. */
  playlist: DisplayPlaylist | null;
  /** The seconds the server asked to wait (a 429 sends them), else null. */
  retryAfter: number | null;
  /** True for a 401 whose detail says a cookie WAS sent but matches no active display (revoked, deleted or forged), not "no cookie". */
  linkNotValid: boolean;
  /** The server's clock at this answer (its `Date` header, in ms), or null when the header is missing or unreadable. */
  serverDate: number | null;
}

/** The detail of a 401 from a display route that had a cookie which matches no active display (a cookie being present is no secret). */
export const LINK_NOT_VALID = "this display link is not valid";

/** Reads the connected display's playlist (the cookie is the credential). Rejects when the request never completed. */
export async function getPlaylist(): Promise<PlaylistReply> {
  const response = await fetch("/api/display/playlist", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: timeoutSignal(),
  });
  const retryAfter = retryAfterSeconds(response);
  const serverDate = serverDateOf(response);
  if (response.status === 401) {
    let linkNotValid = false;
    try {
      const body: unknown = await response.json();
      linkNotValid = record(body) && body.detail === LINK_NOT_VALID;
    } catch {
      // not JSON (a proxy's page): the same as any other 401, "not connected"
    }
    return { status: 401, playlist: null, retryAfter, linkNotValid, serverDate };
  }
  if (response.status !== 200) return { status: response.status, playlist: null, retryAfter, linkNotValid: false, serverDate };
  try {
    return { status: 200, playlist: parsePlaylist(await response.json()), retryAfter, linkNotValid: false, serverDate };
  } catch {
    return { status: 200, playlist: null, retryAfter, linkNotValid: false, serverDate };
  }
}

export interface WidgetReply {
  status: number;
  /** The figures of a 200 whose body is a figure answer; null for every other status, and for a 200 that is not one (the caller treats that as a failure). */
  data: WidgetData | null;
  /** The seconds the server asked to wait (a 429 sends them), else null. */
  retryAfter: number | null;
  /** The server's clock at this answer (its `Date` header, in ms), or null when the header is missing or unreadable. */
  serverDate: number | null;
}

/** A figure answer has a `type` and both lists, as `/api/widget-data` always sends them. */
function isFigureAnswer(body: unknown): body is WidgetData {
  return record(body) && typeof body.type === "string" && Array.isArray(body.series) && Array.isArray(body.values);
}

/**
 * The figures of one card of an item (`POST /api/display/widget-data`). The ids are the only thing sent: the server holds the widget's stored
 * configuration, so the screen cannot ask for anything the playlist does not list. Resolves with the status for any answer (404: the playlist
 * moved; 422: the server will not draw this widget; 429: wait `retryAfter`); rejects when the request never completed or timed out.
 */
export async function widgetData(item: number, widget: number): Promise<WidgetReply> {
  const response = await fetch("/api/display/widget-data", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ item, widget }),
    signal: timeoutSignal(),
  });
  const retryAfter = retryAfterSeconds(response);
  const serverDate = serverDateOf(response);
  if (response.status !== 200) return { status: response.status, data: null, retryAfter, serverDate };
  try {
    const body: unknown = await response.json();
    return { status: 200, data: isFigureAnswer(body) ? body : null, retryAfter, serverDate };
  } catch {
    return { status: 200, data: null, retryAfter, serverDate };
  }
}
