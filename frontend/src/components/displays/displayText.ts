import { ApiError } from "../../api/client";
import type { DisplayRow, PlaylistItemRow } from "../../api/types";
import { relativeTime } from "../../lib/relativeTime";
import { sentence } from "../../lib/sentence";
import { formatSiteDateTime } from "../../lib/siteTime";

/** Why a role without `assets.view` is refused (the server's 403 does not say): the playlist names a focus asset, which only a role that may see the assets can send. */
export const FOCUS_NEEDS_ASSETS = "This playlist names a focus asset. Saving it or showing it on a screen also needs See the Assets Tree.";

/** True when any of these focus ids is set. The server sends the id of a focus asset even when the caller may not read its name. */
export const namesFocus = (focusIds: readonly (number | null)[]): boolean => focusIds.some((id) => id !== null);

/** A 403 for a playlist that names a focus asset says what is missing instead of the generic "Your role does not allow this."; anything else is left as it was. */
export function focusRefusal(error: unknown, applies: boolean): unknown {
  return applies && error instanceof ApiError && error.status === 403 ? new Error(FOCUS_NEEDS_ASSETS) : error;
}

const IN_USE_ADVICE = "Change their playlist or delete them first.";

/** What a refused playlist delete says: the server's sentence with a capital and a full stop, and, for the 409 (a screen still shows it), what to do about it. */
export function playlistDeleteRefusal(error: unknown): string {
  const text = sentence(error instanceof Error ? error.message : String(error));
  return error instanceof ApiError && error.status === 409 && !text.includes(IN_USE_ADVICE) ? `${text} ${IN_USE_ADVICE}` : text;
}

/** What the answer says in place of a name the caller may not read (the server sends null for it); only for a thing that exists. */
export const HIDDEN = "(hidden)";

/** Why a screen skips an item, as one sentence for a person; null for an item that plays. The names are the ones kept when the thing was deleted. */
export function skipSentence(item: PlaylistItemRow): string | null {
  switch (item.skipped) {
    case "dashboard_deleted": return item.dashboard_name ? `The dashboard ${item.dashboard_name} was deleted` : "The dashboard was deleted";
    case "focus_gone": return item.focus_name ? `The asset ${item.focus_name} no longer exists` : "The asset no longer exists";
    case "no_widgets": return "This dashboard has no widgets";
    default: return null;
  }
}

/** The dashboard's name; "(hidden)" when it exists and the caller may not read its name; null when the item has no dashboard. */
export function dashboardLabel(item: PlaylistItemRow): string | null {
  if (item.dashboard_id === null) return null;
  return item.dashboard_name ?? HIDDEN;
}

/** The focus asset's name; "(hidden)" when it is set and the caller may not read its name; null for no focus (the whole site). */
export function focusLabel(item: PlaylistItemRow): string | null {
  if (item.focus_asset_id === null) return null;
  return item.focus_name ?? HIDDEN;
}

export const countText = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
export const skippedText = (n: number): string => (n === 1 ? "1 item is skipped" : `${n} items are skipped`);

/** The age of the last connection ("3 min ago"); after two weeks the age is not written, so the date in the site's zone stands in. */
const agoText = (lastSeen: string, now: Date, timezone: string): string => relativeTime(lastSeen, now, timezone) ?? formatSiteDateTime(lastSeen, timezone);

/** "Last connected 3 min ago from 10.0.0.12", or "Never connected". The whole sentence, for a title; the cell itself draws `lastConnectedParts`. */
export function lastConnectedText(screen: DisplayRow, now: Date, timezone: string): string {
  if (screen.last_seen_at === null) return "Never connected";
  return `Last connected ${agoText(screen.last_seen_at, now, timezone)}${screen.last_client ? ` from ${screen.last_client}` : ""}`;
}

/**
 * The Last connected cell as two lines, so a narrow column wraps at a seam instead of scrolling the card sideways: "3 min ago" and "from 10.0.0.12" (the column
 * header already says "Last connected"). The first line starts with a capital when it is a word ("Just now", "Yesterday"); `from` is null when no address was kept.
 */
export function lastConnectedParts(screen: DisplayRow, now: Date, timezone: string): { when: string; from: string | null } {
  if (screen.last_seen_at === null) return { when: "Never connected", from: null };
  const when = agoText(screen.last_seen_at, now, timezone);
  return { when: when.charAt(0).toUpperCase() + when.slice(1), from: screen.last_client ? `from ${screen.last_client}` : null };
}
