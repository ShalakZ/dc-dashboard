import type { DisplayRow, PlaylistItemRow } from "../../api/types";
import { relativeTime } from "../../lib/relativeTime";
import { formatSiteDateTime } from "../../lib/siteTime";

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

/** "Last connected 3 min ago from 10.0.0.12", or "Never connected". After two weeks the age is not written, so the date in the site's zone stands in. */
export function lastConnectedText(screen: DisplayRow, now: Date, timezone: string): string {
  if (screen.last_seen_at === null) return "Never connected";
  const when = relativeTime(screen.last_seen_at, now, timezone) ?? formatSiteDateTime(screen.last_seen_at, timezone);
  return `Last connected ${when}${screen.last_client ? ` from ${screen.last_client}` : ""}`;
}
