// The words of the Billing month check. Pure functions over the server's structured answer (no React, no DOM): the server sends facts, this file turns
// them into sentences, so a test can scan every sentence for words that would read as a promise that the month is right.
//
// The rules for every string in here (the vitest suite scans them all):
//  - plain and short, no jargon, and NEVER a word that promises correctness: ok, ready, verified, correct, accurate, guarantee, safe, all good, passed
//    (whole words, any case), and no percent sign ("one part in a hundred");
//  - times come through `formatSiteDateHour`, in the site zone, `2026-09-20 09:00`;
//  - hours read "6 hours" / "1 hour", energy reads `1,234.6 kWh` (one decimal at most), counts have a thousands separator;
//  - a counter and a power meter lose different things in a gap: a counter's energy is NOT lost, it is counted in the hour the readings come back
//    (in a later month if that is after this one ends); a power meter's time without a reading counts as 0 kWh. Every sentence keeps them the right way round.
import type {
  EstimatedItem, FlatItem, GapsItem, LaterItem, MonthCheck, MonthCheckGroup, MonthCheckHead, MonthCheckLimits, ResetKind, ResetsItem, SilentItem, StartedItem,
  UnmeteredItem, UnpricedItem,
} from "../api/types";
import { formatSiteDateHour } from "./siteTime";

/** The seven counted groups, in the order the drawer lists them: how much each can change a bill, most first. `unmetered` and `later` are information blocks and are not here. */
export const GROUP_ORDER = ["silent", "gaps", "estimated", "resets", "started", "unpriced", "flat"] as const;
export type CheckGroupKey = (typeof GROUP_ORDER)[number];

/** The finding each group holds (what `itemLines` is called with). */
export interface CheckItems {
  silent: SilentItem; gaps: GapsItem; estimated: EstimatedItem; resets: ResetsItem; started: StartedItem; unpriced: UnpricedItem; flat: FlatItem;
}

/** What the page knows about the check of the month on screen: still reading, failed, or an answer. */
export type MonthCheckStatus = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: MonthCheck };

/** A flat stretch is a finding from this many hours when the server did not say (it always does: `limits.flat_hours`). */
const DEFAULT_FLAT_HOURS = 24;

// ---- small pieces ----

const num = (n: number) => n.toLocaleString("en-US");
const noun = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const hoursText = (n: number) => noun(n, "hour");
const timesText = (n: number) => noun(n, "time");
const kwhText = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })} kWh`;

/** `2 hours 24 minutes`, `1 hour`, `59 minutes`. */
function minutesText(total: number): string {
  const whole = Math.round(total);
  const hours = Math.floor(whole / 60);
  const minutes = whole % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(hoursText(hours));
  if (minutes > 0 || hours === 0) parts.push(noun(minutes, "minute"));
  return parts.join(" ");
}

/** `Reads kWh total (Hall PLC)`; the source is left out when the caller may not see sources; null when the point name is hidden too. */
function readsLine(item: MonthCheckHead): string | null {
  if (item.point === null) return null;
  return item.source ? `Reads ${item.point} (${item.source})` : `Reads ${item.point}`;
}

/** True when the check read nothing yet or found no meter to read: the month has not begun, its first hour is not over, or no meter recorded in it. */
function lookedAtNothing(check: MonthCheck): boolean {
  return check.state === "not_begun" || check.hours === 0 || check.meters === 0;
}

// ---- the answer as a whole ----

/**
 * The line at the top of the drawer. In this order: findings first (so a month whose every meter is silent still says `N things to check`), then
 * `Nothing to look at yet` when nothing was read, and only then `Nothing to check`, which says what was found, not that the month is right.
 */
export function headline(check: MonthCheck): string {
  if (check.things > 0) return `${noun(check.things, "thing")} to check`;
  return lookedAtNothing(check) ? "Nothing to look at yet" : "Nothing to check";
}

/** Why `headline` says `Nothing to look at yet`; null for every other headline. */
export function headlineReason(check: MonthCheck): string | null {
  if (check.things > 0) return null;
  if (check.state === "not_begun") return "This month has not begun.";
  if (check.hours === 0) return "The first hour of this month is not over yet.";
  if (check.meters === 0) return "No meter has recorded anything in this month.";
  return null;
}

/**
 * What was read, so an empty answer is never mistaken for a clean one: the meters, the hours, the total hours of readings (left out when it only
 * repeats the hours), the span in the site zone, and that only the hourly readings billing uses were read. An open month ends at its last full hour.
 */
export function lookedAtLine(check: MonthCheck, timezone: string): string {
  if (check.state === "not_begun" || check.hours === 0) return "Nothing was read.";
  const total = check.meter_hours === check.hours ? "" : ` (${noun(check.meter_hours, "hour")} of readings)`;
  const span = `from ${formatSiteDateHour(check.from, timezone)} to ${formatSiteDateHour(check.to, timezone)}${check.state === "open" ? ", the last full hour" : ""}`;
  return `Looked at ${noun(check.meters, "meter")} over ${hoursText(check.hours)}${total}, ${span}. Only the hourly readings that billing uses were read.`;
}

/** One sentence about the month's state: a closed month (the bill is frozen, the check is not) or an open one; null otherwise. */
export function stateNote(check: MonthCheck): string | null {
  if (check.closed) return "This month is closed: its billed figures are frozen. This check describes the readings as they are stored today.";
  if (check.state === "open") return "This month is still running: the check stops at the last full hour.";
  return null;
}

// ---- the groups ----

const TITLES: Record<CheckGroupKey, string> = {
  silent: "Meters with no readings",
  gaps: "Gaps in the readings",
  estimated: "Estimated from power",
  resets: "Counter went back or dipped",
  started: "Started part way through the month",
  unpriced: "Energy with no rate",
  flat: "Readings that did not change",
};

export function groupTitle(key: CheckGroupKey): string {
  return TITLES[key];
}

/** The estimate rule, as ONE sentence. The same words the owner gave; do not split it. */
const ESTIMATE_RULE =
  "An hour is marked estimated when the asset has no energy (kWh) counter, so its energy is worked out from average power (kW) readings; anything that adds up estimated hours is marked estimated too.";

/** One part in `1 / share`, as a whole number (`0.01` -> 100). */
const oneIn = (share: number) => (share > 0 ? num(Math.round(1 / share)) : "0");

/**
 * What the group is, in one or two plain sentences. `gaps` and `flat` state the thresholds the server used (`check.limits`). What a gap or a silent
 * meter costs depends on the meter kind, so that is said in each item's own lines, not here.
 */
export function groupIntro(key: CheckGroupKey, check: MonthCheck): string {
  const limits = check.limits;
  switch (key) {
    case "silent":
      return "Meters that recorded nothing in this month, or that stopped recording before it ended.";
    case "gaps":
      return (
        "Hours in a row with no reading at all. " +
        `A counter read less often than once an hour may miss up to ${hoursText(limits.max_tolerated_hours)} by design, and that is allowed for. ` +
        `A power meter also lists the time missing inside hours that have readings, from ${noun(limits.short_minutes, "minute")} and one part in ${oneIn(limits.short_share)} of the time looked at.`
      );
    case "estimated":
      return ESTIMATE_RULE;
    case "resets":
      return "A counter should only count up. These went back down, or dipped below an earlier reading, at least once.";
    case "started":
      return "These meters gave their first reading after the month began. Before that, the asset counts what the assets under it add up to.";
    case "unpriced":
      return "Energy that no rate covers. It is in the kWh figures but not in the cost. Add a rate on the Tariffs page to price it.";
    case "flat":
      return `Readings that stay exactly the same for ${hoursText(limits.flat_hours)} or more. That can mean a meter that stopped updating.`;
  }
}

/** The times of one kind of counter event: the ones the server listed, then `and later ones` when it counted more than it listed. */
function eventTimes(item: ResetsItem, kind: ResetKind, count: number, timezone: string): string {
  const listed = item.events.filter((event) => event.kind === kind).map((event) => formatSiteDateHour(event.at, timezone));
  if (listed.length < count) listed.push(listed.length > 0 ? "and later ones" : "later ones");
  return listed.join(", ");
}

function silentLines(item: SilentItem, timezone: string): string[] {
  const counter = item.kind === "counter";
  const zero = counter ? "It counts as 0 kWh." : "Its energy counts as an estimated 0 kWh.";
  if (item.reason === "never") return ["No reading has ever been recorded.", zero];
  if (item.reason === "none_in_month") {
    const last = item.last_reading ? ` (the last one before it was ${formatSiteDateHour(item.last_reading, timezone)})` : "";
    return [`No readings in this month${last}.`, zero];
  }
  const since = item.since
    ? `No readings since ${formatSiteDateHour(item.since, timezone)} (${hoursText(item.hours)} at the end of what was looked at).`
    : `No readings at the end of what was looked at (${hoursText(item.hours)}).`;
  const effect = counter
    ? "The energy it measures in that time is not lost: it is counted when readings come back, in a later month if they come back after this one ends."
    : "That time counts as 0 kWh.";
  return [since, effect];
}

function gapsLines(item: GapsItem, timezone: string): string[] {
  const at = (iso: string | null) => (iso === null ? null : formatSiteDateHour(iso, timezone));
  const lines: string[] = [];
  if (item.runs > 0) {
    const first = at(item.first_start);
    const last = at(item.last_end);
    if (item.runs === 1) {
      const where = first !== null && last !== null ? ` It starts ${first} and ends ${last}.` : "";
      lines.push(`1 gap: ${hoursText(item.hours)} without any reading.${where}`);
    } else {
      const longest = item.longest_hours !== null && item.longest_start !== null ? ` The longest is ${hoursText(item.longest_hours)} from ${at(item.longest_start)}.` : "";
      const ends = first !== null && last !== null ? ` The first starts ${first}, the last ends ${last}.` : "";
      lines.push(`${noun(item.runs, "gap")}: ${hoursText(item.hours)} without any reading in all.${longest}${ends}`);
    }
    if (item.kind === "counter") {
      lines.push("The energy in a gap is not lost: it is counted in the hour the readings come back, so the days around a gap can be off.");
      if (item.leading_hours > 0 && item.previous_reading) {
        lines.push(
          `The gap starts the month: the first reading after it counts everything since ${at(item.previous_reading)}, including energy used before this month began.`,
        );
      }
    } else {
      lines.push("Time without a reading counts as 0 kWh, so this meter reads low by whatever it used in that time.");
    }
  }
  if (item.short_minutes > 0) {
    const lead = item.runs > 0 ? "Another " : "";
    lines.push(`${lead}${hoursText(item.short_hours)} had readings for only part of the hour (${minutesText(item.short_minutes)} missing in all); the missing part counts as 0 kWh.`);
  }
  return lines;
}

function resetsLines(item: ResetsItem, timezone: string): string[] {
  const lines: string[] = [];
  if (item.resets > 0) {
    lines.push(
      `The counter went back down ${timesText(item.resets)} (${eventTimes(item, "reset", item.resets, timezone)}): a reset or a rollover. ` +
        "The energy of that hour is approximate: what was counted just before and just after it is kept, what happened in between is not.",
    );
  }
  if (item.dips > 0) {
    lines.push(
      `The counter dipped below its earlier reading and recovered ${timesText(item.dips)} (${eventTimes(item, "dip", item.dips, timezone)}). ` +
        "The figure ignores the dip and counts the rise from the earlier reading.",
    );
  }
  if (item.falls > 0) {
    lines.push(`A reading went down inside an hour ${timesText(item.falls)} (${eventTimes(item, "fell", item.falls, timezone)}); the hour is counted from its last reading.`);
  }
  return lines;
}

function flatLines(item: FlatItem, timezone: string, limits?: MonthCheckLimits): string[] {
  const stretches = `${noun(item.runs, "stretch", "stretches")} of ${hoursText(limits?.flat_hours ?? DEFAULT_FLAT_HOURS)} or more`;
  const since = `${hoursText(item.longest_hours)} in a row from ${formatSiteDateHour(item.longest_start, timezone)} (${stretches})`;
  if (item.kind === "counter") {
    return [`The readings did not change for ${since}.`, "It counts 0 kWh for that time. If the equipment was in use, check the meter."];
  }
  return [
    `The power reading did not change for ${since}.`,
    "The energy for that time is worked out as if the power had stayed the same. If the load moved, check the meter.",
  ];
}

/**
 * The sentences of one finding. `reads` is `Reads <point> (<source>)`, or null when the caller may not see point names. `lines` is one entry per
 * sentence group (render them as separate lines, or join them with a space). `limits` is optional: pass `check.limits` so a flat finding names the
 * threshold the server used (it falls back to 24 hours).
 */
export function itemLines<K extends CheckGroupKey>(
  key: K, item: CheckItems[K], timezone: string, limits?: MonthCheckLimits,
): { reads: string | null; lines: string[] } {
  const reads = readsLine(item);
  switch (key) {
    case "silent":
      return { reads, lines: silentLines(item as SilentItem, timezone) };
    case "gaps":
      return { reads, lines: gapsLines(item as GapsItem, timezone) };
    case "estimated": {
      const { hours_estimated, hours_total } = item as EstimatedItem;
      return { reads, lines: [`Its energy is worked out from power readings in ${num(hours_estimated)} of its ${hoursText(hours_total)}.`] };
    }
    case "resets":
      return { reads, lines: resetsLines(item as ResetsItem, timezone) };
    case "started": {
      const { first_reading, children } = item as StartedItem;
      const nothing = children === 0 ? " (nothing, it has none)." : ".";
      return { reads, lines: [`First reading ${formatSiteDateHour(first_reading, timezone)}. Before that this asset counts what the assets under it add up to${nothing}`] };
    }
    case "unpriced": {
      const { kwh, hours, days, first_day, last_day } = item as UnpricedItem;
      const span = first_day === last_day ? first_day : `${first_day} to ${last_day}`;
      return { reads, lines: [`${kwhText(kwh)} in ${hoursText(hours)} had no rate, on ${noun(days, "day")} (${span}). Those hours are in the kWh but not in the cost.`] };
    }
    case "flat":
      return { reads, lines: flatLines(item as FlatItem, timezone, limits) };
    default:
      return { reads, lines: [] };
  }
}

/** `and 12 more` when the group holds more findings than the list shows (`cap` is the most the server lists per group); null when all are shown. */
export function moreLine(group: MonthCheckGroup<unknown>, cap: number): string | null {
  const more = group.total - Math.min(group.items.length, cap);
  return more > 0 ? `and ${num(more)} more` : null;
}

// ---- the two information blocks (never counted in the number) ----

/** Introduces the assets that nothing measures. */
export function unmeteredIntro(check: MonthCheck): string {
  const total = check.groups.unmetered.total;
  if (total === 0) return "Every asset at the bottom of the tree has a meter of its own or one above it.";
  if (total === 1) return "1 asset has no meter of its own and no meter above it, so no energy is counted for it. It is not part of the number at the top.";
  return `${num(total)} assets have no meter of their own and no meter above them, so no energy is counted for them. They are not part of the number at the top.`;
}

/** What is missing for one such asset; the ones beside measured assets say that the figure above leaves their power out. */
export function unmeteredLines(item: UnmeteredItem): string {
  return item.beside_measured
    ? "The asset above is billed from other meters under it; if this one uses power, that power is not in that figure."
    : "Nothing measures this asset or any asset above it.";
}

/** A meter whose first reading came after everything that was looked at. */
export function laterLine(item: LaterItem, timezone: string): string {
  return `First reading ${formatSiteDateHour(item.first_reading, timezone)}: after what was looked at.`;
}

// ---- the button and the Close month dialog ----

/**
 * The count drawn on the Check month button: empty while reading, after a failure and when nothing was looked at; `0` when meters were looked at
 * and nothing was found; the number of things; `99+` above 99. The exact number reaches assistive technology through `describedByText`.
 */
export function countSlotText(status: MonthCheckStatus): string {
  if (status.status !== "ready") return "";
  const { things } = status.data;
  if (things > 0) return things > 99 ? "99+" : String(things);
  return lookedAtNothing(status.data) ? "" : "0";
}

/** The sentence a screen reader gets for the button's count: `3 things to check`, `nothing to check`, `nothing to look at yet` or `not read yet`. */
export function describedByText(status: MonthCheckStatus): string {
  if (status.status !== "ready") return "not read yet";
  const { data } = status;
  if (data.things > 0) return `${noun(data.things, "thing")} to check`;
  return lookedAtNothing(data) ? "nothing to look at yet" : "nothing to check";
}

/** The one line of the Close month dialog. Loading and a failure both say `not read yet`. */
export function checkLineText(status: MonthCheckStatus): string {
  return `Month check: ${describedByText(status)} (see Check month on the page).`;
}
