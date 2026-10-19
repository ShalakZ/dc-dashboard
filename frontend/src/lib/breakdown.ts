import type { WidgetBreakdown, WidgetData } from "../api/types";
import { kindKey } from "./kinds";
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

/** The total of the bars left out, as a figure with its `~` and `*` marks and unit; a dash when nobody could work it out. `without` is how many of them had no figure (the total leaves them out). */
export function moreFigure(breakdown: WidgetBreakdown, unit: string | null): { text: string; without: number } {
  const { more } = breakdown;
  if (more.value === null) return { text: DASH, without: 0 };
  return { text: `${figureText(more.value, more)}${unitSuffix(unit)}`, without: Math.max(0, more.count - more.with_value) };
}

/**
 * "and 107 more Racks: 1234.50 kWh in all" - the sum of the bars left out (never an "Other" bar), with its `~` and `*` marks, and how many of them had no
 * figure (the sum leaves them out). Empty when nothing was left out. A sum nobody could work out is a dash.
 */
export function moreText(breakdown: WidgetBreakdown, unit: string | null): string {
  const { more } = breakdown;
  if (more.count <= 0) return "";
  const head = `and ${more.count} more ${kindNoun(breakdown.kind, more.count)}:`;
  const { text, without } = moreFigure(breakdown, unit);
  if (more.value === null) return `${head} ${text}`;
  return `${head} ${text} in all${without > 0 ? ` (${without} with no data)` : ""}`;
}

/** "3 Racks are inside other Racks and are counted there." Empty when none is. */
export function insideOthersText(breakdown: WidgetBreakdown): string {
  const n = breakdown.inside_others;
  if (n <= 0) return "";
  const noun = kindNoun(breakdown.kind, n);
  return n === 1
    ? `1 ${noun} is inside another ${breakdown.kind} and is counted there.`
    : `${n} ${noun} are inside other ${pluralKind(breakdown.kind)} and are counted there.`;
}

/** The card's ONE line under the chart: the "more" sentence, then the "inside others" one. Empty when neither applies. */
export const breakdownLine = (breakdown: WidgetBreakdown, unit: string | null): string =>
  [moreText(breakdown, unit), insideOthersText(breakdown)].filter(Boolean).join(" ");

/**
 * A bar of a breakdown that recorded nothing: no figure, or the zero of a meter that was silent for the whole range, both flagged `no_data`. It is drawn as
 * the dash mark with the words "no data" in its tooltip, never as a bar (a zero-height bar reads as a real zero). A zero that was recorded (no `no_data`) is a zero.
 */
export const isNoDataBar = (bar: { value: number | null; no_data: boolean }): boolean => bar.no_data && (bar.value === null || bar.value === 0);

/** True when no bar has a figure (or only a silent meter's zero), or there is no bar: the chart has nothing to draw. */
export const hasNoBars = (values: WidgetData["values"]): boolean => values.every((v) => v.value === null || isNoDataBar(v));

/**
 * The sentence that stands in the chart's place when it has nothing to draw: no asset of the kind under the root, or none of them has a figure.
 * `source` decides the noun ("energy readings", "cost figures").
 */
export function emptyBreakdownText(breakdown: WidgetBreakdown, source: WidgetData["source"]): string {
  const where = breakdown.root?.name ?? "the site";
  if (breakdown.count === 0) return `No ${pluralKind(breakdown.kind)} under ${where}.`;
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

/** The accessible name of the breakdown chart (the canvas is a picture). */
export function breakdownDescription(data: WidgetData, breakdown: WidgetBreakdown): string {
  const where = breakdown.root?.name ?? "the site";
  const measure = data.source === "cost" ? "Cost" : "Energy";
  const unit = data.unit ? ` in ${data.unit}` : "";
  const shown = data.values.length;
  const of = breakdown.count > shown ? ` of ${breakdown.count}` : "";
  return `Bar chart of ${shown}${of} ${kindNoun(breakdown.kind, breakdown.count)} under ${where}. ${measure}${unit}. Open Details for the figures.`;
}
