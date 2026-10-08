const formats = new Map<string, Intl.DateTimeFormat>();

function format(timezone: string): Intl.DateTimeFormat {
  let known = formats.get(timezone);
  if (!known) {
    // hourCycle h23, not hour12:false: some engines print midnight as "24" for the latter.
    known = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    formats.set(timezone, known);
  }
  return known;
}

interface Fields { year: string; month: string; day: string; hour: string; minute: string; second: string }

/** Wall-clock fields of `date` in `timezone`; null for an invalid date or an unknown zone. Built from parts, never from toLocaleString. */
function fields(date: Date, timezone: string): Fields | null {
  if (Number.isNaN(date.getTime())) return null;
  try {
    const out: Record<string, string> = {};
    for (const part of format(timezone).formatToParts(date)) out[part.type] = part.value;
    return out as unknown as Fields;
  } catch {
    return null;
  }
}

/** `2026-10-07 13:00:00` in the site zone. Returns `iso` unchanged when it cannot be formatted. */
export function formatSiteDateTime(iso: string, timezone: string): string {
  const f = fields(new Date(iso), timezone);
  return f ? `${f.year}-${f.month}-${f.day} ${f.hour}:${f.minute}:${f.second}` : iso;
}

/** Short axis label: `13:00` (no bucket), `10-07 13:00` (hour) or `10-07` (day), in the site zone. */
export function formatSiteTick(iso: string, timezone: string, bucket: "hour" | "day" | null): string {
  const f = fields(new Date(iso), timezone);
  if (!f) return iso;
  if (bucket === "day") return `${f.month}-${f.day}`;
  return bucket === "hour" ? `${f.month}-${f.day} ${f.hour}:${f.minute}` : `${f.hour}:${f.minute}`;
}

/** `YYYY-MM` of `now` on the wall clock of the site zone (UTC when the zone is unknown). */
export function siteMonth(now: Date, timezone: string): string {
  const f = fields(now, timezone) ?? fields(now, "UTC");
  return f ? `${f.year}-${f.month}` : "";
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Wed 07 Oct` for a local day `YYYY-MM-DD`. Pure calendar arithmetic: a day has no timezone, so nothing shifts. */
export function formatSiteDay(day: string): string {
  const m = DAY.exec(day);
  if (!m) return day;
  const [year, month, date] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = new Date(Date.UTC(year, month - 1, date));
  if (utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== date) return day; // 2026-02-30 and friends
  return `${WEEKDAYS[utc.getUTCDay()]} ${m[3]} ${MONTHS[month - 1]}`;
}
