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

/** `13:05:00` in the site zone. Returns `iso` unchanged when it cannot be formatted. */
export function formatSiteClock(iso: string, timezone: string): string {
  const f = fields(new Date(iso), timezone);
  return f ? `${f.hour}:${f.minute}:${f.second}` : iso;
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

/** `YYYY-MM-DD` of `now` on the wall clock of the site zone (UTC when the zone is unknown). */
export function siteDay(now: Date, timezone: string): string {
  const f = fields(now, timezone) ?? fields(now, "UTC");
  return f ? `${f.year}-${f.month}-${f.day}` : "";
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** UTC midnight of a real local day `YYYY-MM-DD`; null for anything else (2026-02-30 and friends). */
function parseDay(day: string): Date | null {
  const m = DAY.exec(day);
  if (!m) return null;
  const [year, month, date] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, date); // not Date.UTC: it reads years 0-99 as 19xx
  return utc.getUTCMonth() === month - 1 && utc.getUTCDate() === date ? utc : null;
}

/** True for a real local day `YYYY-MM-DD`. */
export function isSiteDay(day: string): boolean {
  return parseDay(day) !== null;
}

/** `day` moved by `n` calendar days. Pure calendar arithmetic, so a 23- or 25-hour day still counts as one. Anything that is not a real day comes back unchanged. */
export function addDays(day: string, n: number): string {
  const utc = parseDay(day);
  if (!utc) return day;
  utc.setUTCDate(utc.getUTCDate() + n);
  return utc.toISOString().slice(0, 10);
}

/** `Wed 07 Oct` for a local day `YYYY-MM-DD`. Pure calendar arithmetic: a day has no timezone, so nothing shifts. */
export function formatSiteDay(day: string): string {
  const utc = parseDay(day);
  if (!utc) return day;
  return `${WEEKDAYS[utc.getUTCDay()]} ${day.slice(8)} ${MONTHS[utc.getUTCMonth()]}`;
}
