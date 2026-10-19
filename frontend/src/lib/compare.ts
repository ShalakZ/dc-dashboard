import type { CompareAsset, CompareChange, CompareSide, CompareWhyNone, WidgetCompare, WidgetData } from "../api/types";
import { figureText, unitSuffix } from "./widgetFormat";

/*
 * Everything a widget says about a month-to-date comparison (w24), as pure functions, so each phrase is tested once and the stat, the daily chart and the
 * Details drawer all use the same words. Dates are the site's local dates as `YYYY-MM-DD` strings and are split by hand: a `new Date(iso)` would read them in
 * the browser's zone. Money rules: kWh and cost are never mixed; an estimated figure keeps its `~`, a partial cost its `*` (a kWh figure never gets a `*`);
 * a missing figure is a dash, never a zero; no percentage is ever worked out here (the server gives it, or says why not).
 */

export type Measure = "kwh" | "cost";

export const NOTHING_YET = "Nothing to compare yet";
const DASH = "—";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** The measure a widget of this source compares: an energy widget compares kWh, a cost widget cost. */
export const measureOf = (source: WidgetData["source"]): Measure => (source === "cost" ? "cost" : "kwh");

interface Ymd { year: number; month: number; day: number }

/** The parts of `YYYY-MM-DD` (or of `YYYY-MM`, day 1); null when the text is neither. */
function parts(iso: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso);
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? { year: Number(m[1]), month, day: m[3] ? Number(m[3]) : 1 } : null;
}

/** "October" for "2026-10" or "2026-10-17"; empty when `iso` is not a date. */
export function monthName(iso: string): string {
  const p = parts(iso);
  return p ? MONTHS[p.month - 1] : "";
}

const shortMonth = (month: number): string => MONTHS[month - 1].slice(0, 3);

/** "17 Oct" for "2026-10-17"; the text itself when it is not a date. */
export function dayLabel(iso: string): string {
  const p = parts(iso);
  return p ? `${p.day} ${shortMonth(p.month)}` : iso;
}

/** "17 Oct" for day 17 of the month that `monthIso` ("2026-10" or any date of it) belongs to: the chart's labels, which never read a timestamp. */
export function dayOfMonthLabel(monthIso: string, day: number): string {
  const p = parts(monthIso);
  return p ? `${day} ${shortMonth(p.month)}` : String(day);
}

/** A window as a person says it: "1 to 17 Oct", one day "1 Oct", and, should a window ever cross a month, "28 Sep to 3 Oct". */
export function windowLabel(window: { from: string; to: string }): string {
  const a = parts(window.from);
  const b = parts(window.to);
  if (!a || !b) return `${window.from} to ${window.to}`;
  if (a.year === b.year && a.month === b.month) return a.day === b.day ? `${a.day} ${shortMonth(a.month)}` : `${a.day} to ${b.day} ${shortMonth(a.month)}`;
  return `${a.day} ${shortMonth(a.month)} to ${b.day} ${shortMonth(b.month)}`;
}

/** The window by its dates, for the Details panel: "2026-10-01 to 2026-10-17". */
export const windowDates = (window: { from: string; to: string }): string => `${window.from} to ${window.to}`;

/** "29", "29 and 30", "29, 30 and 31". */
function listDays(days: readonly number[]): string {
  if (days.length <= 1) return days.join("");
  return `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}`;
}

/** The unit after a figure of this measure: kWh, or the site currency (none when it has none). */
export const measureUnit = (measure: Measure, currency: string | null): string | null => (measure === "kwh" ? "kWh" : currency);

/**
 * One side of the comparison as a figure with its marks and no unit: "~12.30", "12.30*", a dash when there is no figure. A side whose every day has no
 * readings has no figure whatever its sum says (a sum of nothing is not a zero), and a cost the rates did not reach is a dash too. The `*` belongs to cost only.
 */
export function sideText(side: CompareSide | null | undefined, measure: Measure, days: number): string {
  if (!side || (days > 0 && side.no_data_days >= days)) return DASH;
  if (measure === "kwh") return figureText(side.kwh, { estimated: side.estimated, partial: false });
  return figureText(side.cost, { estimated: side.estimated, partial: side.partial });
}

/** `sideText` with its unit, on one line. A dash has no unit. */
export function sideFigure(side: CompareSide | null | undefined, measure: Measure, days: number, currency: string | null): string {
  const text = sideText(side, measure, days);
  return text === DASH ? text : `${text}${unitSuffix(measureUnit(measure, currency))}`;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * The change line: "up 12.4 % (+340.00 kWh)", "down 3.1 % (-120.00 kWh)", "no change", or just "up 340.00 kWh" when the server gave no percentage (the reason
 * is a note). The direction is read from the amount as it is shown (two decimals, like every figure of the stat), so -0.004 is "no change" and never
 * "down (-0.00 kWh)". The words and the sign carry the direction; colour never does. A change without an amount is a dash.
 */
export function changeLine(change: CompareChange, unit: string | null): string {
  if (change.abs === null) return DASH;
  const shown = round2(change.abs);
  if (shown === 0) return "no change";
  const direction = shown > 0 ? "up" : "down";
  const amount = `${Math.abs(shown).toFixed(2)}${unitSuffix(unit)}`;
  if (change.percent === null) return `${direction} ${amount}`;
  return `${direction} ${Math.abs(change.percent).toFixed(1)} % (${shown > 0 ? "+" : "-"}${amount})`;
}

interface NoteContext { days: number; thisSide: CompareSide | null; lastSide: CompareSide | null }

/** "last month has no readings on 3 of the 17 days", "this month ... on 1 of the 17 days", or both in one sentence. */
function missingDaysClause(ctx: NoteContext): string {
  const last = ctx.lastSide?.no_data_days ?? 0;
  const now = ctx.thisSide?.no_data_days ?? 0;
  if (last > 0 && now > 0) return `last month has no readings on ${last} and this month on ${now} of the ${ctx.days} days`;
  if (last > 0) return `last month has no readings on ${last} of the ${ctx.days} days`;
  if (now > 0) return `this month has no readings on ${now} of the ${ctx.days} days`;
  return "some days have no readings";
}

/** The sentence for a withheld percentage (or comparison). `measure` only changes the wording of a zero. */
export function whyNoneText(why: CompareWhyNone, measure: Measure, ctx: NoteContext): string {
  switch (why) {
    case "missing_days": return `No percentage: ${missingDaysClause(ctx)}.`;
    case "partial": return "No percentage: some of the cost has no rate.";
    case "previous_zero": return measure === "kwh" ? "No percentage: last month used nothing." : "No percentage: last month's cost was zero.";
    case "no_previous": return "No readings last month.";
    case "no_current": return "No readings this month.";
    case "currency": return "No cost comparison: the currency changed since last month closed.";
    case "no_cost": return "No cost comparison: no rate applies to these days.";
  }
}

/** What a `last_state` other than "ok" says in place of the percentage's reason; null for the states that need no sentence of their own. */
export function lastStateText(state: CompareAsset["last_state"]): string | null {
  if (state === "not_in_closed") return "Not in last month's closed figures.";
  if (state === "other_zone") return "Last month was closed in another time zone, so it cannot be compared day by day.";
  return null;
}

/** "29 and 30 March have no matching day in February." `days` are this month's left-out dates, `lastMonth` is "2026-02". */
export function leftOutText(days: readonly string[], lastMonth: string): string {
  if (days.length === 0) return "";
  const numbers = days.map((d) => parts(d)?.day).filter((n): n is number => n !== undefined);
  return `${listDays(numbers)} ${monthName(days[0])} ${days.length === 1 ? "has" : "have"} no matching day in ${monthName(lastMonth)}.`;
}

/** "A rate changed on 5 Oct, so the cost change is not only usage." */
export const rateNoteText = (date: string): string => `A rate changed on ${dayLabel(date)}, so the cost change is not only usage.`;

export const CLOSED_NOTE = "Last month is closed: these are its closed figures.";

/**
 * Every note that applies to one measure of one asset, most important first: the reason for a withheld percentage (or, when last month cannot be
 * compared at all, what `last_state` says, never both), the rate note (cost only, and only when there is something to compare), the days left out, and the
 * closed note. The card shows the first and counts the rest; Details lists them all.
 */
export function compareNotes(compare: WidgetCompare, asset: CompareAsset, measure: Measure): string[] {
  const notes: string[] = [];
  const state = lastStateText(asset.last_state);
  const why = asset[measure].why_none;
  if (state) notes.push(state);
  else if (why) notes.push(whyNoneText(why, measure, { days: compare.days, thisSide: asset.this, lastSide: asset.last }));
  if (measure === "cost" && !state && asset.rate_change) notes.push(rateNoteText(asset.rate_change.date));
  if (compare.left_out_days.length > 0) notes.push(leftOutText(compare.left_out_days, compare.last_month.month));
  if (compare.last_month.closed && !state) notes.push(CLOSED_NOTE);
  return notes;
}

/**
 * Every note for the Details panel, which lists both measures: what only one measure says (the reason a percentage is withheld, the rate note) is
 * prefixed "Energy: " or "Cost: " unless both say the same; what is about the comparison itself (last month cannot be compared, the days left
 * out, the closed month) is said once.
 */
export function detailNotes(compare: WidgetCompare, asset: CompareAsset): string[] {
  const energy = compareNotes(compare, asset, "kwh");
  const cost = compareNotes(compare, asset, "cost");
  const shared = new Set(energy.filter((text) => cost.includes(text)));
  const prefixed = (label: string, notes: readonly string[]) => notes.filter((text) => !shared.has(text)).map((text) => `${label}: ${text}`);
  const ordered = [...energy.filter((text) => shared.has(text)), ...prefixed("Energy", energy), ...prefixed("Cost", cost)];
  // The shared ones keep the order of the energy list; the measure-specific ones follow.
  return ordered;
}

/**
 * A `*` is a COST mark (an hour without a rate understates a cost). On a comparison of energy the figures are kWh, so no `*` is ever drawn on one, whatever
 * flag the answer carries: this clears `partial` on the series, their points, the values and last month's points, and touches nothing else (the sides keep
 * theirs: the Details panel's cost column is a cost). It returns `data` itself when there is nothing to clear, so it costs nothing for any other widget.
 */
export function withoutEnergyStars(data: WidgetData): WidgetData {
  const compare = data.compare;
  if (!compare || data.source === "cost") return data;
  const flagged = (rows: readonly { partial: boolean }[]) => rows.some((r) => r.partial);
  const dirty = flagged(data.values) || data.series.some((s) => s.partial || flagged(s.points)) || compare.assets.some((a) => flagged(a.last_points));
  if (!dirty) return data;
  const clear = <T extends { partial: boolean }>(row: T): T => ({ ...row, partial: false });
  return {
    ...data,
    values: data.values.map(clear),
    series: data.series.map((s) => ({ ...clear(s), points: s.points.map(clear) })),
    compare: { ...compare, assets: compare.assets.map((a) => ({ ...a, last_points: a.last_points.map(clear) })) },
  };
}

/**
 * What the cost marks of Details' comparison table mean when the widget itself is about energy: the card draws none, so `flagsOf` does not count them and
 * the panel's "What the markers mean" would not say what the `*` and the dash of the cost column are. Same words as `markerMeanings`. Empty for a cost widget
 * (there the ordinary meanings already cover them) and when the table draws neither mark.
 */
export function costMarkMeanings(data: Pick<WidgetData, "source" | "compare">): string[] {
  const compare = data.compare;
  if (!compare || data.source === "cost") return [];
  const sides = compare.assets.flatMap((a) => [a.this, a.last].filter((side): side is CompareSide => side !== null));
  const out: string[] = [];
  if (sides.some((side) => sideText(side, "cost", compare.days).endsWith("*"))) out.push("* partial: some energy in the period had no rate, so the cost is incomplete");
  if (sides.some((side) => side.cost === null && side.no_data_days < compare.days)) out.push("— no rate: no tariff applies to this figure");
  return out;
}

/** The card's one note line: the first note, and how many more wait in Details. Empty when there is none. */
export function noteLine(notes: readonly string[]): string {
  if (notes.length === 0) return "";
  return notes.length === 1 ? notes[0] : `${notes[0]} (+${notes.length - 1} more in Details)`;
}

/** The names of the two lines of the daily chart: the months, with the marks of the side ("October ~", "September *"). */
export function compareLineNames(compare: WidgetCompare, asset: CompareAsset | undefined, measure: Measure): [string, string] {
  const marks = (side: CompareSide | null | undefined): string => `${side?.estimated ? " ~" : ""}${measure === "cost" && side?.partial ? " *" : ""}`;
  const now = monthName(compare.this_window?.from ?? "") || "This month";
  const before = monthName(compare.last_month.month) || "Last month";
  return [`${now}${marks(asset?.this)}`, `${before}${marks(asset?.last)}`];
}

/** The accessible name of the daily comparison chart (the canvas is a picture). */
export function compareChartDescription(data: WidgetData, compare: WidgetCompare): string {
  const asset = compare.assets[0];
  const [now, before] = [monthName(compare.this_window?.from ?? "") || "this month", monthName(compare.last_month.month) || "last month"];
  const measure = data.source === "cost" ? "Cost" : "Energy";
  const unit = data.unit ? ` in ${data.unit}` : "";
  return `Line chart comparing ${now} with ${before}, day by day${asset ? ` for ${asset.name}` : ""}. ${measure}${unit}. Open Details for the figures.`;
}
