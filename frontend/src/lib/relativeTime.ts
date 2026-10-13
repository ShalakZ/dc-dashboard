import { siteDay } from "./siteTime";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_DAYS = 14;

/** Whole calendar days from the local day `from` to `to` (both `YYYY-MM-DD`): pure calendar arithmetic, so a 23- or 25-hour day still counts as one. */
function daysBetween(from: string, to: string): number {
  const utc = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  return Math.round((utc(to) - utc(from)) / (24 * HOUR));
}

/**
 * How long ago `ts` was, as a short quiet line under its exact time: "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago".
 * Under a minute, and any time in the future, is "just now" (never a negative age). Minutes and hours are for the site day of `now`;
 * every other day is counted in calendar days on the site's clock (`timezone`, the clock the exact time is written in), so an entry from
 * 23:50 seen at 00:10 reads "yesterday". From 15 days on there is no line (null, and for a time it cannot read). Pure: `now` is injected.
 */
export function relativeTime(ts: string, now: Date, timezone: string): string | null {
  const then = new Date(ts);
  if (Number.isNaN(then.getTime()) || Number.isNaN(now.getTime())) return null;
  const age = now.getTime() - then.getTime();
  if (age < MINUTE) return "just now";
  const today = siteDay(now, timezone);
  const day = siteDay(then, timezone);
  if (day === today) return age < HOUR ? `${Math.floor(age / MINUTE)} min ago` : `${Math.floor(age / HOUR)} h ago`;
  const days = daysBetween(day, today);
  if (days > MAX_DAYS) return null;
  return days <= 1 ? "yesterday" : `${days} days ago`;
}
