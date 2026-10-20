import type { Asset, WidgetBreakdown, WidgetData } from "../api/types";
import { kindKey } from "./kinds";
import { cardText, familyOf, pickScale } from "./figures";
import { figureText, unitSuffix } from "./widgetFormat";

/*
 * What the bar widget says about a breakdown by kind (`bars: "kind"`, w24): the kind's plural, the line under the chart, the sentences for a chart that has
 * nothing to draw, the options of "Split by". Pure, so each sentence is tested once. A missing figure is a dash or words, never a zero.
 */

const DASH = "—";

/** "Rack" -> "Racks"; a kind that already ends in "s" is left alone. The kind keeps its own capitalisation. */
export const pluralKind = (kind: string): string => (/s$/i.test(kind) ? kind : `${kind}s`);
/** The kind for `count` assets: as it is for one, plural for any other number. */
export const kindNoun = (kind: string, count: number): string => (count === 1 ? kind : pluralKind(kind));

/** The total of the bars left out as text (marks and unit included; a dash when nobody could work it out), and `without`: how many of them had no figure (the total leaves them out). */
export interface MoreFigure { text: string; without: number }

const noneLeft = (): MoreFigure => ({ text: DASH, without: 0 });
const withoutOf = (more: WidgetBreakdown["more"]): number => Math.max(0, more.count - more.with_value);

/** The EXACT face (Details' "Not drawn" row, the line's title): the base unit, grouped, two decimals, marks kept: "~262,071.80 kWh". */
export function moreFigure(breakdown: WidgetBreakdown, unit: string | null): MoreFigure {
  const { more } = breakdown;
  if (more.value === null) return noneLeft();
  return { text: `${figureText(more.value, more)}${unitSuffix(unit)}`, without: withoutOf(more) };
}

/** The CARD face (the line under the chart, w27): the sum in a scale of its own, "~262.07 MWh", "275.43k* QAR". `source` decides the family (a cost scales in k and M). */
export function moreCard(breakdown: WidgetBreakdown, unit: string | null, source: WidgetData["source"]): MoreFigure {
  const { more } = breakdown;
  if (more.value === null) return noneLeft();
  return { text: cardText(more.value, pickScale(familyOf(unit, source), unit, [more.value]), more), without: withoutOf(more) };
}

/** The sentence around a figure: "and 107 more Racks: <figure> in all (3 with no data)". Empty when nothing was left out; a sum nobody could work out is a dash. */
function moreSentence(breakdown: WidgetBreakdown, figure: MoreFigure): string {
  const { more } = breakdown;
  if (more.count <= 0) return "";
  const head = `and ${more.count} more ${kindNoun(breakdown.kind, more.count)}:`;
  if (more.value === null) return `${head} ${figure.text}`;
  return `${head} ${figure.text} in all${figure.without > 0 ? ` (${figure.without} with no data)` : ""}`;
}

/** "and 107 more Racks: 1,234.50 kWh in all" on the EXACT face - the sum of the bars left out (never an "Other" bar), with its `~` and `*` marks, and how many of them had no figure. */
export const moreText = (breakdown: WidgetBreakdown, unit: string | null): string => moreSentence(breakdown, moreFigure(breakdown, unit));

/** The same sentence on the CARD face: "and 219 more Circuits: ~262.07 MWh in all (12 with no data)". */
export const moreCardText = (breakdown: WidgetBreakdown, unit: string | null, source: WidgetData["source"]): string =>
  moreSentence(breakdown, moreCard(breakdown, unit, source));

/** "3 Racks are inside other Racks and are counted there." Empty when none is. */
export function insideOthersText(breakdown: WidgetBreakdown): string {
  const n = breakdown.inside_others;
  if (n <= 0) return "";
  const noun = kindNoun(breakdown.kind, n);
  return n === 1
    ? `1 ${noun} is inside another ${breakdown.kind} and is counted there.`
    : `${n} ${noun} are inside other ${pluralKind(breakdown.kind)} and are counted there.`;
}

/** The exact face of the card's ONE line under the chart (its `title`): the "more" sentence, then the "inside others" one. Empty when neither applies. */
export const breakdownLine = (breakdown: WidgetBreakdown, unit: string | null): string =>
  [moreText(breakdown, unit), insideOthersText(breakdown)].filter(Boolean).join(" ");

/** The line as the card draws it: the card face of the sum, then the "inside others" sentence. Its `title` is `breakdownLine`. */
export const breakdownCardLine = (breakdown: WidgetBreakdown, unit: string | null, source: WidgetData["source"]): string =>
  [moreCardText(breakdown, unit, source), insideOthersText(breakdown)].filter(Boolean).join(" ");

/**
 * A bar of a breakdown that recorded nothing: no figure, or the zero of a meter that was silent for the whole range, both flagged `no_data`. It is drawn as
 * the dash mark with the words "no data" in its tooltip, never as a bar (a zero-height bar reads as a real zero). A zero that was recorded (no `no_data`) is a zero.
 */
export const isNoDataBar = (bar: { value: number | null; no_data: boolean }): boolean => bar.no_data && (bar.value === null || bar.value === 0);

/** True when no bar has a figure (or only a silent meter's zero), or there is no bar: the chart has nothing to draw. */
export const hasNoBars = (values: WidgetData["values"]): boolean => values.every((v) => v.value === null || isNoDataBar(v));

/** The end of the "none of this kind" sentence under an asset. */
const CHOOSE_KIND = "Choose another kind in Split by.";

/**
 * The sentence that stands in the chart's place when it has nothing to draw: no asset of the kind under the root, or none of them has a figure.
 * `source` decides the noun ("energy readings", "cost figures").
 */
export function emptyBreakdownText(breakdown: WidgetBreakdown, source: WidgetData["source"]): string {
  const where = breakdown.root?.name ?? "the site";
  if (breakdown.count === 0) {
    const none = `No ${pluralKind(breakdown.kind)} under ${where}.`;
    // Looking under an asset (the dashboard was narrowed to it, w25), the asset may hold other kinds than this one: say where to change it.
    const key = kindKey(breakdown.kind);
    return breakdown.root !== null && breakdown.kinds.some((k) => kindKey(k.kind) !== key) ? `${none} ${CHOOSE_KIND}` : none;
  }
  const what = source === "cost" ? "cost figures" : "energy readings";
  if (breakdown.count === 1) return `The ${breakdown.kind} under ${where} has no ${what}.`;
  return `None of the ${breakdown.count} ${pluralKind(breakdown.kind)} under ${where} has ${what}.`;
}

export interface KindOption { value: string; label: string }

/** The options of "Split by": each kind present under the root as "Rack (117)"; the kind being shown is added first when the list does not hold it. */
export function kindOptions(breakdown: WidgetBreakdown, current: string): KindOption[] {
  const options = breakdown.kinds.map(({ kind, count }): KindOption => ({ value: kind, label: `${kind} (${count})` }));
  const key = kindKey(current);
  if (current.trim() === "" || options.some((o) => kindKey(o.value) === key)) return options;
  return [{ value: current, label: `${current} (0)` }, ...options];
}

/** The option whose kind is `current` (same spelling or not: the comparison key is the server's); `current` itself when none matches. */
export function selectedKind(options: readonly KindOption[], current: string): string {
  const key = kindKey(current);
  return options.find((o) => kindKey(o.value) === key)?.value ?? current;
}

/** The ids of the assets that have a child in `assets` (a child's `parent_id` is the asset). */
export const parentIds = (assets: readonly Asset[]): Set<number> =>
  new Set(assets.flatMap((asset) => (asset.parent_id === null ? [] : [asset.parent_id])));

/**
 * What a click on a bar of a breakdown does (w25, R10): narrow the dashboard to an asset that has children, open the page of one that has none. Where no card of the
 * dashboard follows the focus (`narrowing` false) narrowing would change nothing on the page, so an asset with children opens its page like a leaf (W2).
 */
export type DrillAction = "narrow" | "open";
export const drillAction = (id: number, parents: ReadonlySet<number>, narrowing = true): DrillAction => (narrowing && parents.has(id) ? "narrow" : "open");

/**
 * The last line of a bar's tooltip when a click does something; `name` is the bar's name as the chart shows it. A bar with no shape (`nameOnly`: no data) cannot be
 * clicked, only its name can, and the line says so.
 */
export const drillTip = (action: DrillAction, name: string, nameOnly = false): string => {
  const click = nameOnly ? "Click its name to" : "Click to";
  return action === "narrow" ? `${click} narrow the dashboard to ${name}` : `${click} open ${name}'s page`;
};

/** The name of the Details panel's keyboard route to the same narrowing. */
export const narrowLabel = (name: string): string => `Narrow to ${name}`;

/** The accessible name of the breakdown chart (the canvas is a picture). */
export function breakdownDescription(data: WidgetData, breakdown: WidgetBreakdown): string {
  const where = breakdown.root?.name ?? "the site";
  const measure = data.source === "cost" ? "Cost" : "Energy";
  const unit = data.unit ? ` in ${data.unit}` : "";
  const shown = data.values.length;
  const of = breakdown.count > shown ? ` of ${breakdown.count}` : "";
  return `Bar chart of ${shown}${of} ${kindNoun(breakdown.kind, breakdown.count)} under ${where}. ${measure}${unit}. Open Details for the figures.`;
}
