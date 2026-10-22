import type { Source } from "../api/types";
import { formatSpanLong } from "./age";
import { hostPortOfEndpoint, offerOf, TWO_SERVERS_TEXT } from "./moves";
import { formatSiteDateHour } from "./siteTime";

/**
 * What the Status column says. The collector polls only enabled sources and only their mapped points, so a source with none of
 * either reads "not polled". Test and Browse jobs still write the stored status of such a source, so the last check stays visible.
 * A source that is filled by importing files (`polls` false) is never polled by design, so "not polled" would read as a fault: it says how it is filled.
 */
export function sourceStatusText(s: Pick<Source, "enabled" | "status" | "mapped_points" | "polls">): { text: string; polled: boolean } {
  if (s.polls === false) return { text: "filled by file import", polled: false };
  const last = s.status === "unknown" ? "" : `; last check: ${s.status}`;
  if (!s.enabled) return { text: `not polled (disabled)${last}`, polled: false };
  if (s.mapped_points === 0) return { text: `not polled (no mapped points)${last}`, polled: false };
  return { text: s.status, polled: true };
}

/**
 * A polled source is called "offline for a while" once it has been out of reach for more than this many seconds (w32, Ruling P7). The same number is
 * `OFFLINE_BANNER_SECONDS` in lib/eventText.ts (Task 4b, not committed yet when this was written); it is defined here so that this file stands alone, and the two must stay equal.
 */
export const OFFLINE_BANNER_SECONDS = 120;

/** A source the Sources banner names: how long it has been offline (as of the `nowMs` it was asked for) and whether it ever answered. */
export interface LongOffline { source: Source; since: string; seconds: number; neverAnswered: boolean }

/**
 * The sources the banner of the Sources page names (Ruling P7): enabled, polled (`polls` not false, at least one mapped point; a missing field counts as
 * polled, like the Status column), stored status `offline`, and `offline_since` older than `OFFLINE_BANNER_SECONDS` at `nowMs` (epoch milliseconds; the page
 * passes its ticking clock, a test passes any time it likes). A source with no `offline_since` (or one that is not a time) is left out: there is nothing to
 * say about how long. Longest outage first, ties by name. Pure: nothing here reads a clock.
 */
export function longOffline(sources: readonly Source[], nowMs: number): LongOffline[] {
  const found: LongOffline[] = [];
  for (const source of sources) {
    if (source.status !== "offline" || !sourceStatusText(source).polled || !source.offline_since) continue;
    const seconds = (nowMs - Date.parse(source.offline_since)) / 1000;
    if (!(seconds > OFFLINE_BANNER_SECONDS)) continue; // also false for NaN (a value that is not a time)
    found.push({ source, since: source.offline_since, seconds, neverAnswered: source.last_seen === null });
  }
  return found.sort((a, b) => b.seconds - a.seconds || a.source.name.localeCompare(b.source.name));
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `18 Oct 07:52`: the day (no leading zero: the same shape as `formatShortTime` of lib/eventText.ts, so the Sources page and the System events page date an outage
 * alike), the month and the time of day on the wall clock of the site zone. Null for a time or a zone that cannot be read, so that the caller leaves the time out
 * instead of showing one in the browser's zone.
 */
export function formatOfflineSince(iso: string, timezone: string): string | null {
  const m = /^\d{4}-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(formatSiteDateHour(iso, timezone));
  return m ? `${Number(m[2])} ${SHORT_MONTHS[Number(m[1]) - 1]} ${m[3]}:${m[4]}` : null;
}

/** The banner's words are the last full stop's job: an error that already ends in one (or in ! or ?) does not get a second. */
const stop = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * The sentence of the Sources banner. One source: its name, how long, since when (site zone; left out while the zone is unknown) and its last error:
 * `1 source is offline: OPC UA server at 172.20.0.3:4840, for 4 d 2 h (since 18 Oct 07:52): Connect call failed ('172.20.0.3', 4840).` A source that never
 * answered has not answered since it was added. Several: at most three named, each with how long, then `and 2 more`. Plain text, no markup.
 * (w33 adds to this sentence only for a source with a move candidate: see `offlineBannerParts`.)
 */
function plainBannerText(list: readonly LongOffline[], timezone: string | undefined): string {
  if (list.length === 0) return "";
  const when = (item: LongOffline) => (timezone ? formatOfflineSince(item.since, timezone) : null);
  if (list.length === 1) {
    const [one] = list;
    const how = one.neverAnswered
      ? ", which has not answered since it was added"
      : `, for ${formatSpanLong(one.seconds)}${when(one) ? ` (since ${when(one)})` : ""}`;
    const error = one.source.last_error ? `: ${one.source.last_error}` : "";
    return stop(`1 source is offline: ${one.source.name}${how}${error}`);
  }
  const named = list.slice(0, 3).map((item) => `${item.source.name} (${item.neverAnswered ? "has not answered since it was added" : `for ${formatSpanLong(item.seconds)}`})`);
  const more = list.length - named.length;
  if (more > 0) named.push(`${more} more`);
  const last = named.pop() as string;
  return `${list.length} sources are offline: ${named.length > 0 ? `${named.join(", ")} and ` : ""}${last}.`;
}

/** The words of the link that opens the move dialog (the row menu's item and the banner's button say the same). */
export const MOVE_LINK_TEXT = "Move to new address...";

/** What the banner's button opens: the source that was found again at a new address, and where (`172.20.0.5:4840`). */
export interface BannerMove { sourceId: number; name: string; hostPort: string }

/**
 * The sentence of the Sources banner (`plainBannerText`) with what a scan found added to it (w33), and the one source its link opens.
 * - One source with an offer: `... A scan found it at 172.20.0.5:4840:`, and `move` names it. A person who cannot edit sources reads the same sentence ending
 *   in a full stop and gets no `move` (there is no link for them).
 * - One source that two new servers look like: `Two servers could be this one; edit the address by hand.`
 * - Several sources, some with an offer: how many a scan found a new address for, and where to go (the row menus); no `move`.
 * A source without a candidate changes nothing: the text is exactly `plainBannerText`.
 */
export function offlineBannerParts(list: readonly LongOffline[], timezone: string | undefined, canMove: boolean): { text: string; move: BannerMove | null } {
  const base = plainBannerText(list, timezone);
  if (list.length === 1) {
    const { source } = list[0];
    const offer = offerOf(source);
    if (offer) {
      const hostPort = hostPortOfEndpoint(offer.to_endpoint);
      return canMove
        ? { text: `${base} A scan found it at ${hostPort}:`, move: { sourceId: source.id, name: source.name, hostPort } }
        : { text: `${base} A scan found it at ${hostPort}.`, move: null };
    }
    if (source.move_candidate?.kind === "two") return { text: `${base} ${TWO_SERVERS_TEXT}.`, move: null };
    return { text: base, move: null };
  }
  const found = list.filter((item) => offerOf(item.source) !== null).length;
  if (found === 0) return { text: base, move: null };
  const where = canMove ? `: use ${MOVE_LINK_TEXT} in ${found === 1 ? "its row menu" : "the row menu of each"}` : "";
  return { text: `${base} A scan found a new address for ${found} of them${where}.`, move: null };
}

/** The whole banner sentence as plain text: `offlineBannerParts`' text, and the words of the link after it when the person can move the source. */
export function offlineBannerText(list: readonly LongOffline[], timezone: string | undefined, canMove = false): string {
  const parts = offlineBannerParts(list, timezone, canMove);
  return parts.move ? `${parts.text} ${MOVE_LINK_TEXT}` : parts.text;
}
