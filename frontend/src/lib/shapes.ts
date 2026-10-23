import { METRICS, type Metric, type TagListReport } from "../api/types";
import {
  SEARCH_MAX, SEARCH_MIN, type CheckSeverity, type NameFrom, type Shape, type ShapeCheck, type ShapeDecision, type ShapeExample, type ShapeLinesByShape, type ShapeRule, type ShapeRules,
} from "../api/shapes";
import { upperFirst } from "./upperFirst";

// w36 Map by tag shape: the pure helpers of the page. The server groups the tags into shapes and checks the decisions; nothing here works out a shape.

/** The server takes at most this many decisions in one request (a 422 above). */
export const MAX_DECISIONS = 60;

export const grouped = (n: number) => n.toLocaleString("en-US");
export const plural = (n: number, one: string, many = `${one}s`) => `${grouped(n)} ${n === 1 ? one : many}`;

/** The words of a metric in the decision select ("Map as energy counter"). */
export const METRIC_WORDS: Record<Metric, string> = {
  active_power_kw: "active power",
  energy_kwh: "energy counter",
  voltage_v: "voltage",
  current_a: "current",
  power_factor: "power factor",
  frequency_hz: "frequency",
  reactive_power_kvar: "reactive power",
  apparent_power_kva: "apparent power",
  custom: "custom",
};
/** The words of a suggestion in a row ("kWh counter, a guess from the unit kWh"). */
const SUGGESTION_WORDS: Record<Metric, string> = {
  active_power_kw: "kW power reading",
  energy_kwh: "kWh counter",
  voltage_v: "voltage reading",
  current_a: "current reading",
  power_factor: "power factor reading",
  frequency_hz: "frequency reading",
  reactive_power_kvar: "reactive power reading",
  apparent_power_kva: "apparent power reading",
  custom: "custom reading",
};

/** "a", "a and b", "a, b and c". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The suggestion of a shape in words, and what it comes from. Always a guess. */
export function suggestionSentence(shape: Shape): string {
  const words = SUGGESTION_WORDS[shape.suggestion.metric];
  const from = shape.unit_hints.length > 0 ? `a guess from the unit ${listOf(shape.unit_hints)}` : "a guess from the tag name";
  return shape.suggestion.mixed ? `${words}, ${from} (the tags of this shape do not all agree)` : `${words}, ${from}`;
}

export interface Option { value: string; text: string }
/** Ignore (the default), then Map as <the suggestion>, then every other metric. */
export function decisionOptions(shape: Shape): Option[] {
  const suggested = shape.suggestion.metric;
  return [
    { value: "", text: "Ignore" },
    { value: suggested, text: `Map as ${METRIC_WORDS[suggested]}` },
    ...METRICS.filter((metric) => metric !== suggested).map((metric) => ({ value: metric, text: `Map as ${METRIC_WORDS[metric]}` })),
  ];
}

export const NAME_OPTIONS: readonly (Option & { value: NameFrom })[] = [
  { value: "part1", text: "part 1" },
  { value: "parts12", text: "parts 1 and 2" },
  { value: "part1_part2", text: "part 1 / part 2" },
];
const NAME_TEXT = Object.fromEntries(NAME_OPTIONS.map((option) => [option.value, option.text])) as Record<NameFrom, string>;

/** The tag text split into parts at the server's separators (core/discovery.py `_SEPARATORS`). */
export const partsOf = (text: string): string[] => text.trim().split(/[_\s./:-]+/).filter((part) => part !== "");

/** The text of an example the parts are taken from: its name, or, when the name fell back to the node id, the part after the cluster of a `s=<cluster>.<tag>` id. */
export function exampleText(example: ShapeExample): string {
  if (example.name !== example.address) return example.name;
  return /^(?:ns=[0-9]+;)?s=[^.\s]*\.(\S+)$/.exec(example.address)?.[1] ?? example.name;
}

/** The asset the first example would get, as the select shows it ("PDUA01", "PDUA01 PM0", "PDUA01 / PM0"); null when the example has too few parts. A preview only: the Review shows the server's own. */
export function derivedAsset(example: ShapeExample | undefined, nameFrom: NameFrom): string | null {
  if (example === undefined) return null;
  const parts = partsOf(exampleText(example));
  if (parts.length === 0) return null;
  if (nameFrom === "part1") return parts[0];
  if (parts.length < 2) return null;
  return nameFrom === "parts12" ? `${parts[0]} ${parts[1]}` : `${parts[0]} / ${parts[1]}`;
}

/** What a person decided about one shape: `metric` null is Ignore. */
export interface Choice { metric: Metric | null; nameFrom: NameFrom }
export const DEFAULT_CHOICE: Choice = { metric: null, nameFrom: "part1" };

/** The decisions of the page, by shape KEY (never by label): the choices, and which rows have their "Same decision for ..." tick on. */
export interface Decisions { choices: Readonly<Record<string, Choice>>; ticks: Readonly<Record<string, boolean>> }
export const NO_DECISIONS: Decisions = { choices: {}, ticks: {} };
export const choiceOf = (state: Decisions, key: string): Choice => state.choices[key] ?? DEFAULT_CHOICE;
/** The keys a shape is similar to that the page knows (a similar shape the page has never been shown cannot be counted or labelled). */
export type SimilarOf = (key: string) => readonly string[];

/** A row's choice changed. While its tick is on, every similar shape gets the same choice (and, if one of those has its own tick on, its similar shapes too). */
export function decide(state: Decisions, key: string, patch: Partial<Choice>, similarOf: SimilarOf): Decisions {
  const next: Choice = { ...choiceOf(state, key), ...patch };
  const choices: Record<string, Choice> = { ...state.choices, [key]: next };
  const seen = new Set([key]);
  const queue = [key];
  while (queue.length > 0) {
    const from = queue.shift()!;
    if (state.ticks[from] !== true) continue;
    for (const other of similarOf(from)) {
      if (seen.has(other)) continue;
      seen.add(other);
      choices[other] = { ...next };
      queue.push(other);
    }
  }
  return { ...state, choices };
}

/** The tick of a row: on, it copies the row's choice to the similar shapes at once and keeps them in step; off, they keep what they have. */
export function tick(state: Decisions, key: string, on: boolean, similarOf: SimilarOf): Decisions {
  const next: Decisions = { ...state, ticks: { ...state.ticks, [key]: on } };
  return on ? decide(next, key, {}, similarOf) : next;
}

/** "Same decision for PDUB#_PM0_PENRG" (one name, two, or the first two and a count). A key the page has no label for is named by the key. */
export function similarSentence(keys: readonly string[], labelOf: (key: string) => string): string {
  const names = keys.map(labelOf);
  const shown = names.length > 2 ? [...names.slice(0, 2), `${names.length - 2} more`] : names;
  return `Same decision for ${listOf(shown)}`;
}

/** The shapes with a metric chosen, in the order the page has seen them. A decision for a shape the page never saw is not counted (it cannot be: choices come from rows). */
export function chosenShapes(state: Decisions, known: ReadonlyMap<string, Shape>): { shape: Shape; choice: Choice & { metric: Metric } }[] {
  const out: { shape: Shape; choice: Choice & { metric: Metric } }[] = [];
  for (const shape of known.values()) {
    const choice = state.choices[shape.key];
    if (choice !== undefined && choice.metric !== null) out.push({ shape, choice: { ...choice, metric: choice.metric } });
  }
  return out;
}

/** The tags the chosen decisions cover, by the shape counts. The Review gives the exact numbers. */
export const coveredTags = (chosen: readonly { shape: Shape }[]): number => chosen.reduce((sum, { shape }) => sum + shape.count, 0);

/** The body of the lines request: only the keys that have a value (the server fills in scale and unit). */
export function decisionBody(chosen: readonly { shape: Shape; choice: Choice & { metric: Metric } }[]): ShapeDecision[] {
  return chosen.map(({ shape, choice }) => ({ shape: shape.key, metric: choice.metric, name_from: choice.nameFrom }));
}

export const tooManyText = (n: number) => `You chose ${grouped(n)} shapes; one review takes at most ${MAX_DECISIONS}. Ignore some of them and map them in a second round.`;

/** The button under the table. */
export const reviewLabel = (tags: number) => (tags === 0 ? "Review mappings..." : `Review ${plural(tags, "mapping")}...`);

/** The rows of the first section (a billing guess), then the rest, each in the server's order. */
export function splitSections(shapes: readonly Shape[]): { billing: Shape[]; rest: Shape[] } {
  return { billing: shapes.filter((shape) => shape.billing !== null), rest: shapes.filter((shape) => shape.billing === null) };
}

/** A text in the box and what the server gets: nothing for fewer than 2 characters, never more than 100. */
export function searchTerm(text: string): string {
  const term = text.trim().slice(0, SEARCH_MAX);
  return term.length >= SEARCH_MIN ? term : "";
}

/** The address of the page with a search and a shape to look at: both optional, both encoded (a shape key holds `#`). `rules` asks for the rows that match a saved rule to be preset. */
export function shapesPageLink(sourceId: number, link: { q?: string; focus?: string; rules?: boolean } = {}): string {
  const params = new URLSearchParams();
  if (link.q) params.set("q", link.q);
  if (link.focus) params.set("focus", link.focus);
  if (link.rules) params.set("rules", "1");
  const query = params.toString();
  return `/sources/${sourceId}/shapes${query === "" ? "" : `?${query}`}`;
}
/** The page was opened to review the new tags that match the saved rules (`?rules=1`, from the Discovery card or panel). */
export const wantsRules = (params: URLSearchParams): boolean => params.get("rules") === "1";
/** What the address of the page asks for. */
export function readLink(params: URLSearchParams): { q: string; focus: string } {
  return { q: (params.get("q") ?? "").slice(0, SEARCH_MAX), focus: params.get("focus") ?? "" };
}

/** The row of a shape: compared as an attribute value in script, never put in a selector (a key holds `#`, and jsdom has no CSS.escape). */
export function rowOf(root: ParentNode, key: string): HTMLElement | null {
  for (const row of root.querySelectorAll<HTMLElement>("[data-shape]")) if (row.dataset.shape === key) return row;
  return null;
}

// What a row says under itself before anything is sent.
export function mixedUnitsWarning(shape: Shape): string | null {
  return shape.mixed_units ? `This shape has the units ${listOf(shape.unit_hints)}, so it can only be mapped as custom.` : null;
}
/** `duplicates` counts the MEMBERS involved (a pair is 2), so the tags that appear twice are half of it, rounded down (never below 1 while the server says there are duplicates). */
export function duplicatesWarning(shape: Shape): string | null {
  if (shape.duplicates <= 0) return null;
  const tags = Math.max(1, Math.floor(shape.duplicates / 2));
  const tail = 'Switch on "Stable tag addresses" for this source and browse again, or decide them on the Points page.';
  return tags === 1
    ? `1 tag of this shape appears twice (the SCADA renumbered it). ${tail.replace("decide them", "decide it")}`
    : `${grouped(tags)} tags of this shape appear twice (the SCADA renumbered them). ${tail}`;
}
/** The chosen asset name needs two parts and the first example has one. */
export function namePartsWarning(shape: Shape, choice: Choice): string | null {
  if (choice.metric === null || choice.nameFrom === "part1") return null;
  const example = shape.examples[0];
  if (example === undefined || derivedAsset(example, choice.nameFrom) !== null) return null;
  return `The example ${exampleText(example)} has only one part, so "${NAME_TEXT[choice.nameFrom]}" does not fit. Choose "part 1".`;
}
export function rowWarnings(shape: Shape, choice: Choice): string[] {
  return [mixedUnitsWarning(shape), duplicatesWarning(shape), namePartsWarning(shape, choice)].filter((text): text is string => text !== null);
}

// The Review dialog.
/**
 * 400 tags on up to 400 assets, 12 already mapped, left as they are. The server's `assets` is an upper bound: it counts a parent and its child asset together for
 * `part 1 / part 2` and counts an asset that exists already as a new one.
 */
export function shapeCountsSentence(row: ShapeLinesByShape): string {
  const parts = [`${plural(row.lines, "tag")} on up to ${plural(row.assets, "asset")}`];
  if (row.skipped_mapped > 0) parts.push(`${grouped(row.skipped_mapped)} already mapped, left as they are`);
  if (row.skipped_twins > 0) parts.push(`${plural(row.skipped_twins, "copy", "copies")} of a mapped tag, left as they are`);
  return parts.join(", ");
}
/** How many of the lines go onto assets that exist already: the lines less the assets the planner would create. Nothing to say when that is not above zero. */
export function onExistingAssets(lines: number, assetsToCreateTotal: number): number {
  return Math.max(0, lines - assetsToCreateTotal);
}
/**
 * The new assets are chosen under a parent by id and written by name, so the assets the server's own planner run planned (`plan_assets`) must be the assets the
 * tag-list dry run now plans. Different (the parent or something above it was renamed, removed or added in between) stops the Map. A `plan_assets` that is null
 * (the server's planner did not run) or absent (an older answer) compares nothing.
 */
export function assetsChanged(planAssets: number | null | undefined, report: TagListReport | null): boolean {
  return typeof planAssets === "number" && report !== null && planAssets !== report.assets_to_create_total;
}
export const ASSETS_CHANGED_TEXT =
  "The assets changed while this list was being checked (something above the new assets was renamed, removed or added). Review again.";
/** Where the new assets go, for the Review's header: the path the server used when its answer has one, else the label the page chose. */
export function parentWords(parentPath: readonly string[] | undefined, parentLabel: string | null): string {
  const path = parentPath === undefined ? parentLabel : parentPath.length > 0 ? parentPath.join(" / ") : null;
  return path === null ? "at the top level" : `under ${path}`;
}
export const hasBlocking = (checks: readonly ShapeCheck[]) => checks.some((check) => check.severity === "blocking");
export const checksOf = (checks: readonly ShapeCheck[], severity: CheckSeverity) => checks.filter((check) => check.severity === severity);
/** The outlier warnings of the Review, repeated in the toast that follows the Map (a missing meter must not be forgotten the moment the dialog closes). */
export const outlierTexts = (checks: readonly ShapeCheck[]) => checks.filter((check) => check.kind === "outlier").map((check) => check.text);
export function mappedSentence(mappings: number, outliers: readonly string[]): string {
  const base = `Created ${plural(mappings, "mapping")}.`;
  return outliers.length === 0 ? base : `${base} Check: ${outliers.map((text) => upperFirst(text.replace(/\.$/, ""))).join(". ")}.`;
}

/** A problem the planner reports about the list, or a report that is not ok, stops the Map. */
export const plannerStops = (report: TagListReport) => !report.ok || report.problems_total > 0;

/** The dry run and the real run of the EXISTING tag-list route (query strings with URLSearchParams, as TagListDialog builds them). */
export const dryRunPath = (sourceId: number, createAssets: boolean) =>
  `/api/sources/${sourceId}/tag-list?${new URLSearchParams({ dry_run: "1", create_assets: createAssets ? "1" : "0" })}`;
export function realRunPath(sourceId: number, createAssets: boolean, report: TagListReport): string {
  const query = new URLSearchParams({
    dry_run: "0", create_assets: createAssets ? "1" : "0",
    expect_points: String(report.points_to_create), expect_assets: String(report.assets_to_create_total), expect_mappings: String(report.mappings_to_create),
    expect_plan: report.plan_digest,
  });
  return `/api/sources/${sourceId}/tag-list?${query}`;
}

// Saved rules (T7b): what a person decided about a shape is remembered under the shape's KEY, and shown on the row; it is never applied by itself.
/** `Saved rule: Map as energy counter, asset name part 1`. The unit, scale and interval of a rule are not worded here: this page never sets them. */
export const ruleSentence = (rule: ShapeRule): string => `Saved rule: Map as ${METRIC_WORDS[rule.metric]}, asset name ${NAME_TEXT[rule.name_from]}`;
/** The row's choice a rule stands for. */
export const ruleChoice = (rule: ShapeRule): Choice => ({ metric: rule.metric, nameFrom: rule.name_from });
/**
 * The rules after these decisions were applied: each decided key now holds its decision (metric and asset name only, never the decision's `shape`: the server
 * refuses an extra key), every other rule stays exactly as it was. `saved` is the set the server has NOW, not what the page was shown.
 */
export function mergeRules(saved: ShapeRules, decisions: readonly ShapeDecision[]): ShapeRules {
  const next: ShapeRules = { ...saved };
  for (const decision of decisions) next[decision.shape] = { metric: decision.metric, name_from: decision.name_from };
  return next;
}
export function withoutRule(saved: ShapeRules, key: string): ShapeRules {
  const next: ShapeRules = { ...saved };
  delete next[key];
  return next;
}
/**
 * `?rules=1`: every row that has a rule AND tags still to decide about (its count less the mapped and the copies of mapped ones) is set to its rule. Still shown,
 * still changeable, still only through Review and Map.
 */
export function presetFromRules(shapes: readonly Shape[]): Decisions {
  const choices: Record<string, Choice> = {};
  for (const shape of shapes) {
    if (shape.rule !== null && shape.count - shape.mapped - shape.twins > 0) choices[shape.key] = ruleChoice(shape.rule);
  }
  return Object.keys(choices).length === 0 ? NO_DECISIONS : { choices, ticks: {} };
}
