// The answers the w21 spec gives the Billing page's month check: GET /api/billing/month-check is answered from this through page.route, so those cases depend on nothing the shared
// stack holds and write nothing to it. The shapes are written here again (as billingModel.ts does): importing them from src/ would pull the app's files into the strict e2e type-check.
// The contract is section 3 of docs/superpowers/plans/2026-10-18-w21-month-check.md (src/api/types.ts MonthCheck). The month is September 2026 in Asia/Qatar (UTC+3, no daylight
// saving), so 06:00Z reads 09:00 on every machine. Paths are the pilot hall's (docs/developing.md "The pilot hall").

export type CheckName = "pilot" | "clear" | "empty" | "not_begun" | "many" | "closed" | "open";

interface Head { asset_id: number; path: string; kind: "counter" | "power"; point: string | null; source: string | null; interval_seconds: number }
interface Group<T> { total: number; items: T[] }
interface GapItem extends Head {
  runs: number; hours: number; longest_hours: number | null; longest_start: string | null; first_start: string | null; last_end: string | null;
  leading_hours: number; hours_before_month: number; previous_reading: string | null; short_hours: number; short_minutes: number;
}
interface EstimatedItem extends Head { hours_estimated: number; hours_total: number; negative_hours: number; negative_kwh: number }
interface ResetItem extends Head { resets: number; dips: number; falls: number; events: { at: string; kind: "reset" | "dip" | "fell"; size: number }[] }
interface UnmeteredItem { asset_id: number; path: string; beside_measured: boolean }

/** GET /api/billing/month-check (src/api/types.ts MonthCheck). The groups the cases do not fill are empty ones. */
export interface ApiMonthCheck {
  month: string; timezone: string; state: "not_begun" | "open" | "finished"; closed: boolean;
  from: string; to: string; month_end: string;
  hours: number; meters: number; meter_hours: number; things: number;
  limits: { flat_hours: number; short_minutes: number; short_share: number; max_tolerated_hours: number; cap: number };
  groups: {
    silent: Group<Head>; gaps: Group<GapItem>; estimated: Group<EstimatedItem>; resets: Group<ResetItem>; started: Group<Head>; unpriced: Group<Head>; flat: Group<Head>;
    unmetered: Group<UnmeteredItem>; later: Group<{ asset_id: number; path: string; kind: "counter" | "power"; first_reading: string }>;
  };
}

const LIMITS = { flat_hours: 24, short_minutes: 60, short_share: 0.01, max_tolerated_hours: 24, cap: 50 };
const empty = <T>(): Group<T> => ({ total: 0, items: [] });
const group = <T>(items: T[], total = items.length): Group<T> => ({ total, items });
const times = <T>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));
const BASE_ID = 7_000; // synthetic, far from any row a seed has (billingModel.ts uses the same range)

const rack = (i: number) => `Site / Hall 1 / Pod A / Row 1 / Rack ${String(i + 1).padStart(2, "0")}`;
const head = (kind: "counter" | "power", id: number, path: string, interval = kind === "counter" ? 900 : 1800): Head => ({
  asset_id: BASE_ID + id, path, kind, point: kind === "counter" ? "Energy kWh" : "Active power kW", source: "Hall 1 PLC", interval_seconds: interval,
});

/** A feed that only reports power: its energy is worked out from average power for every hour of the month, so every hour is estimated. */
const estimatedFeed = (i: number): EstimatedItem => ({ ...head("power", 100 + i, `${rack(i)} / Feed B`), hours_estimated: 720, hours_total: 720, negative_hours: 0, negative_kwh: 0 });
/** The one gap of the pilot hall's September: a counter silent from 09:00 to 15:00 on the 20th (06:00Z to 12:00Z). */
const GAP: GapItem = {
  ...head("counter", 200, `${rack(20)} / Feed A`), runs: 1, hours: 6, longest_hours: 6, longest_start: "2026-09-20T06:00:00Z", first_start: "2026-09-20T06:00:00Z",
  last_end: "2026-09-20T12:00:00Z", leading_hours: 0, hours_before_month: 0, previous_reading: null, short_hours: 0, short_minutes: 0,
};
/** The one reset: a counter that went back to zero at 09:00 on the 12th. */
const RESET: ResetItem = { ...head("counter", 201, `${rack(30)} / Feed A`), resets: 1, dips: 0, falls: 0, events: [{ at: "2026-09-12T06:00:00Z", kind: "reset", size: 1250 }] };
/** 12 feeds of the free racks and the 8 panels: nothing measures them, and none sits beside a measured asset. */
const UNMETERED: UnmeteredItem[] = [
  ...times(12, (i) => ({ asset_id: BASE_ID + 300 + i, path: `Site / Hall 2 / Pod B / Row 4 / Rack ${106 + Math.floor(i / 2)} / Feed ${i % 2 === 0 ? "A" : "B"}`, beside_measured: false })),
  ...times(8, (i) => ({ asset_id: BASE_ID + 320 + i, path: `Site / Electrical / Panel ${i + 1}`, beside_measured: false })),
];

const base = (over: Partial<ApiMonthCheck> = {}, groups: Partial<ApiMonthCheck["groups"]> = {}): ApiMonthCheck => ({
  month: "2026-09", timezone: "Asia/Qatar", state: "finished", closed: false,
  from: "2026-08-31T21:00:00Z", to: "2026-09-30T21:00:00Z", month_end: "2026-09-30T21:00:00Z",
  hours: 720, meters: 217, meter_hours: 150_480, things: 0, limits: LIMITS,
  groups: {
    silent: empty(), gaps: empty(), estimated: empty(), resets: empty(), started: empty(), unpriced: empty(), flat: empty(),
    unmetered: empty(), later: empty(), ...groups,
  },
  ...over,
});

const pilot = (): ApiMonthCheck =>
  base({ things: 10 }, { gaps: group([GAP]), estimated: group(times(8, estimatedFeed)), resets: group([RESET]), unmetered: group(UNMETERED) });

/**
 * The answer for a case. `month` replaces the answer's month (the page names the drawer from the month on screen, not from the answer).
 *  pilot      the pilot hall's September: 8 estimated feeds, 1 gap of 6 hours, 1 reset, 20 assets nothing measures, 0 started later: 10 things to check.
 *  clear      217 meters looked at and nothing found: "Nothing to check".
 *  empty      no meter recorded in the month: "Nothing to look at yet".
 *  not_begun  a month that has not begun: nothing was read.
 *  many       60 estimated feeds sent of 217 (the cap of this answer is 60): Show all 60 and the cap line "and 157 more".
 *  closed     the pilot answer for a month that has an active close.
 *  open       a month still running: read up to the last full hour (10:00 on the 18th, 421 hours).
 */
export function checkAnswer(name: CheckName, month?: string): ApiMonthCheck {
  const answer: ApiMonthCheck =
    name === "pilot" ? pilot()
    : name === "clear" ? base()
    : name === "empty" ? base({ meters: 0, meter_hours: 0 })
    : name === "not_begun" ? base({ month: "2026-11", state: "not_begun", from: "2026-10-31T21:00:00Z", to: "2026-10-31T21:00:00Z", month_end: "2026-11-30T21:00:00Z", hours: 0, meters: 0, meter_hours: 0 })
    : name === "many" ? base({ things: 217, limits: { ...LIMITS, cap: 60 } }, { estimated: group(times(60, estimatedFeed), 217) })
    : name === "closed" ? { ...pilot(), closed: true }
    : base({
      month: "2026-10", state: "open", from: "2026-09-30T21:00:00Z", to: "2026-10-18T10:00:00Z", month_end: "2026-10-31T21:00:00Z", hours: 421, meters: 217, meter_hours: 91_357, things: 8,
    }, { estimated: group(times(8, estimatedFeed).map((feed) => ({ ...feed, hours_estimated: 421, hours_total: 421 }))), unmetered: group(UNMETERED) });
  return month === undefined ? answer : { ...answer, month };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What the page says for an answer. The words are written here again (src/lib/monthCheck.ts) so the spec reads the page against the JSON, never against the app's own code;
// the real-stack case computes its expectations from the API's JSON with these.

/** What a case asks the month-check route for: a fixture by name, or a 500 ("fail"). */
export type CheckChoice = CheckName | "fail";
/** The `detail` of the 500 a "fail" answer carries (the drawer shows it as its error line). */
export const FAIL_DETAIL = "w21: the month check failed";

/** The seven groups that are counted in the number at the top, in the order the drawer lists them. */
export const COUNTED_GROUPS = ["silent", "gaps", "estimated", "resets", "started", "unpriced", "flat"] as const;
export type CountedGroup = (typeof COUNTED_GROUPS)[number];
/** The title of each counted group (src/lib/monthCheck.ts TITLES). */
export const GROUP_TITLES: Record<CountedGroup, string> = {
  silent: "Meters with no readings",
  gaps: "Gaps in the readings",
  estimated: "Estimated from power",
  resets: "Counter went back or dipped",
  started: "Started part way through the month",
  unpriced: "Energy with no rate",
  flat: "Readings that did not change",
};

/** The estimate rule, ONE sentence (src/lib/monthCheck.ts ESTIMATE_RULE). */
export const ESTIMATE_RULE =
  "An hour is marked estimated when the asset has no energy (kWh) counter, so its energy is worked out from average power (kW) readings; anything that adds up estimated hours is marked estimated too.";

const num = (n: number) => n.toLocaleString("en-US");
/** True when the check read nothing: the month has not begun, its first hour is not over, or no meter recorded in it. */
export const lookedAtNothing = (a: ApiMonthCheck): boolean => a.state === "not_begun" || a.hours === 0 || a.meters === 0;

/** The line at the top of the drawer. */
export function headlineFor(a: ApiMonthCheck): string {
  if (a.things > 0) return `${num(a.things)} ${a.things === 1 ? "thing" : "things"} to check`;
  return lookedAtNothing(a) ? "Nothing to look at yet" : "Nothing to check";
}

/** The count drawn on the Check month button: empty when nothing was looked at, `0`, the number, or `99+`. */
export function slotFor(a: ApiMonthCheck): string {
  if (a.things > 0) return a.things > 99 ? "99+" : String(a.things);
  return lookedAtNothing(a) ? "" : "0";
}

/** The sentence a screen reader gets for the button's count (`null`: the answer has not arrived or failed). */
export function describedFor(a: ApiMonthCheck | null): string {
  if (a === null) return "not read yet";
  if (a.things > 0) return `${num(a.things)} ${a.things === 1 ? "thing" : "things"} to check`;
  return lookedAtNothing(a) ? "nothing to look at yet" : "nothing to check";
}

/** The one extra line of the Close month dialog, worded at the click (`null`: still reading, or the read failed). */
export const closeLineFor = (a: ApiMonthCheck | null): string => `Month check: ${describedFor(a)} (see Check month on the page).`;
