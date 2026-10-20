// The display screen's own requests. It never imports api/client.ts: that module reports a 401 to the sign-in machinery and the
// screen has no user, no session and no /api/me. Every request is same-origin, never cached, JSON, and carries no Authorization.

/** The playlist answer (`GET /api/display/playlist`); only what the screen reads is typed, the rest is left as `unknown` for w29. */
export interface DisplayItem {
  id: number;
  seconds: number;
  /** Why the item cannot be shown ("dashboard_deleted", "focus_gone", "no_widgets"), else null. */
  skipped: string | null;
  dashboard: unknown;
  focus: unknown;
}
export interface DisplayPlaylist {
  display: { name: string };
  playlist: { name: string; items: DisplayItem[] };
  site: unknown;
  build: unknown;
  status: unknown;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

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
      dashboard: item.dashboard ?? null,
      focus: item.focus ?? null,
    });
  }
  return { display: { name: display.name }, playlist: { name: playlist.name, items }, site: data.site, build: data.build, status: data.status };
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
  });
  const retryAfter = retryAfterSeconds(response);
  if (response.status === 401) {
    let linkNotValid = false;
    try {
      const body: unknown = await response.json();
      linkNotValid = record(body) && body.detail === LINK_NOT_VALID;
    } catch {
      // not JSON (a proxy's page): the same as any other 401, "not connected"
    }
    return { status: 401, playlist: null, retryAfter, linkNotValid };
  }
  if (response.status !== 200) return { status: response.status, playlist: null, retryAfter, linkNotValid: false };
  try {
    return { status: 200, playlist: parsePlaylist(await response.json()), retryAfter, linkNotValid: false };
  } catch {
    return { status: 200, playlist: null, retryAfter, linkNotValid: false };
  }
}
