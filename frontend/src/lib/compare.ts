import type { CompareAsset, CompareChange, CompareSide, CompareWhyNone, WidgetCompare, WidgetData } from "../api/types";
import type { Scale } from "./figures";
import { amountText, cardFigure, familyOf, IDENTITY, percentDigits, pickScale } from "./figures";
import type { Flags } from "./widgetFormat";
import { figureText, lastCostGone, unitSuffix } from "./widgetFormat";

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

/** The figure of one side, or null when it has none: a side whose every day has no readings has no figure whatever its sum says (a sum of nothing is not a zero). */
function sideValue(side: CompareSide | null | undefined, measure: Measure, days: number): number | null {
  if (!side || (days > 0 && side.no_data_days >= days)) return null;
  return measure === "kwh" ? side.kwh : side.cost;
}

/** The marks of one side's figure: `~` for an estimate, and `*` for a partial COST only (a kWh figure never gets a star). */
const sideMarks = (side: CompareSide, measure: Measure): Flags => ({ estimated: side.estimated, partial: measure === "cost" && side.partial });

/**
 * One side of the comparison as an EXACT figure with its marks and no unit: "~12.30", "1,234.50*", a dash when there is no figure. A side whose every day has no
 * readings has no figure whatever its sum says, and a cost the rates did not reach is a dash too. The `*` belongs to cost only and comes last (`costMarkMeanings`
 * reads `.endsWith("*")`). The Details drawer and the `title` of a card figure use this face; the stat card uses `sideCardText`.
 */
export function sideText(side: CompareSide | null | undefined, measure: Measure, days: number): string {
  const value = sideValue(side, measure, days);
  return value === null ? DASH : figureText(value, sideMarks(side!, measure));
}

/** `sideText` with its unit, on one line. A dash has no unit. */
export function sideFigure(side: CompareSide | null | undefined, measure: Measure, days: number, currency: string | null): string {
  const text = sideText(side, measure, days);
  return text === DASH ? text : `${text}${unitSuffix(measureUnit(measure, currency))}`;
}

/**
 * The ONE scale both sides of a comparison share on the card (w27 R3): the larger side decides, so "~275.43 MWh" stands against "~275.99 MWh" and never against
 * "275,993.08 kWh". A side with no figure (no readings, a cost without a rate) is left out of the pick. `extra` adds more members of the group (the stat's
 * headline, which is this month's side). With no figure at all the scale is the base unit.
 */
export function compareScale(
  asset: Pick<CompareAsset, "this" | "last">, measure: Measure, days: number, currency: string | null, extra: readonly (number | null | undefined)[] = [],
): Scale {
  const unit = measureUnit(measure, currency);
  const values = [sideValue(asset.this, measure, days), sideValue(asset.last, measure, days), ...extra];
  return pickScale(familyOf(unit, measure === "cost" ? "cost" : "energy"), unit, values);
}

/** One side on the CARD face at a scale (`compareScale`), without its unit: "~275.43", "275.43k*". A side with no figure is a dash. */
export function sideCardText(side: CompareSide | null | undefined, measure: Measure, days: number, scale: Scale): string {
  const value = sideValue(side, measure, days);
  return value === null ? DASH : cardFigure(value, scale, sideMarks(side!, measure));
}

/** `sideCardText` with the scale's unit, on one line: "~275.99 MWh", "275.43k QAR". A dash has no unit. */
export function sideCardFigure(side: CompareSide | null | undefined, measure: Measure, days: number, scale: Scale): string {
  const text = sideCardText(side, measure, days, scale);
  return text === DASH ? text : `${text}${unitSuffix(scale.unit)}`;
}

/**
 * The marks a change carries, the ones of the figures it is made from: `~` when either side is estimated, and `*` when either side is a partial COST (a kWh
 * change never has one, whatever the sides say: the star belongs to cost, as in `sideText`).
 */
export function changeMarks(asset: Pick<CompareAsset, "this" | "last">, measure: Measure): Flags {
  const sides = [asset.this, asset.last];
  return { estimated: sides.some((side) => side?.estimated === true), partial: measure === "cost" && sides.some((side) => side?.partial === true) };
}

const NO_MARKS: Flags = { estimated: false, partial: false };

/** The words of a change at a scale; the amount is printed in that scale and the direction is read from what is PRINTED (see `changeLine`). */
function changeText(change: CompareChange, scale: Scale, marks: Flags): string {
  if (change.abs === null || !Number.isFinite(change.abs)) return DASH;
  const amount = amountText(change.abs, scale);
  if (amount.zero) return "no change";
  const direction = amount.negative ? "down" : "up";
  const tilde = marks.estimated ? "~" : "";
  const figure = `${amount.digits}${scale.letter}${marks.partial ? "*" : ""}${unitSuffix(scale.unit)}`;
  if (change.percent === null || !Number.isFinite(change.percent)) return `${direction} ${tilde}${figure}`;
  return `${direction} ${tilde}${percentDigits(change.percent)} % (${tilde}${amount.negative ? "-" : "+"}${figure})`;
}

/**
 * The change line on the EXACT face (the base unit, grouped digits): "up 12.4 % (+340.00 kWh)", "down 3.1 % (-120.00 kWh)", "no change", or just
 * "up 340.00 kWh" when the server gave no percentage (the reason is a note). The direction is read from the amount as it is PRINTED (two decimals, like every
 * figure of the stat), so -0.004 is "no change" and never "down (-0.00 kWh)", while -0.125 prints "-0.13" and is "down". The words and the sign carry the
 * direction; colour never does. A change without an amount is a dash.
 * The marks of its figures travel with it (`changeMarks`): `~` in front of the percentage and of the amount ("down ~0.2 % (~-294.32 kWh)"), `*` behind the
 * amount ("up 18.60* QAR", also when the percentage is withheld because the cost is partial). "no change" and a dash show no figure, so they carry none.
 * The Details drawer and the `title` of the stat's change line use this face; the card itself uses `changeCard`.
 */
export function changeLine(change: CompareChange, unit: string | null, marks: Flags = NO_MARKS): string {
  return changeText(change, IDENTITY(unit), marks);
}

/**
 * The change line on the CARD face: the same words and rules as `changeLine`, but the amount picks its OWN scale from its size ("up ... (+150.00 MWh)" for
 * 150,000 kWh, "down ~0.2 % (~-562.82 kWh)" under two MWh figures) and a cost amount may carry k or M ("+18.60k* QAR"). Direction and "no change" still come
 * from the printed amount.
 */
export function changeCard(change: CompareChange, measure: Measure, unit: string | null, marks: Flags = NO_MARKS): string {
  return changeText(change, pickScale(familyOf(unit, measure === "cost" ? "cost" : "energy"), unit, [change.abs]), marks);
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
    case "no_previous": return ctx.days > 0 && (ctx.thisSide === null || ctx.thisSide.no_data_days >= ctx.days) ? "No readings this month or last month." : "No readings last month.";
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
  // an asset whose currency changed after the close has a dash for last month's cost because of the currency, which is not a missing rate
  const sides = compare.assets.flatMap((a) => [a.this, lastCostGone(a) ? null : a.last].filter((side): side is CompareSide => side !== null));
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
  const noLastCost = measure === "cost" && asset !== undefined && lastCostGone(asset); // another currency: a line with no figure carries no marks
  return [`${now}${marks(asset?.this)}`, `${before}${noLastCost ? "" : marks(asset?.last)}`];
}

/** The accessible name of the daily comparison chart (the canvas is a picture). */
export function compareChartDescription(data: WidgetData, compare: WidgetCompare): string {
  const asset = compare.assets[0];
  const [now, before] = [monthName(compare.this_window?.from ?? "") || "this month", monthName(compare.last_month.month) || "last month"];
  const measure = data.source === "cost" ? "Cost" : "Energy";
  const unit = data.unit ? ` in ${data.unit}` : "";
  return `Line chart comparing ${now} with ${before}, day by day${asset ? ` for ${asset.name}` : ""}. ${measure}${unit}. Open Details for the figures.`;
}
