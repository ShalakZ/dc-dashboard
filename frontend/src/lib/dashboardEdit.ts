import { ApiError } from "../api/client";
import {
  METRICS, type Dashboard, type DashboardSave, type DataWidgetType, type GraphModel, type Metric, type RangePreset, type TextConfig,
  type TextStyle, type WidgetAggregation, type WidgetBars, type WidgetConfig, type WidgetIn, type WidgetSource, type WidgetType,
} from "../api/types";
import { compactVertical, toDrafts, type DraftWidget } from "./layout";
import { normalizeText } from "./textWidget";

export const MAX_WIDGETS = 24;
export const MAX_ASSETS = 20;
export const MAX_TEXT = 100;

export type Aggregation = WidgetAggregation;
export type WidgetMetric = Exclude<Metric, "custom">;

export const TYPE_LABELS: Record<WidgetType, string> = { timeseries: "Time series", bar: "Bar chart", stat: "Stat", gauge: "Gauge", table: "Table", text: "Text" };
export const SOURCE_LABELS: Record<WidgetSource, string> = { metric: "Metric", energy: "Energy (kWh)", cost: "Cost" };
export const AGGREGATION_LABELS: Record<Aggregation, string> = { avg: "Average", min: "Minimum", max: "Maximum", last: "Latest", sum: "Total" };
/** The API refuses `custom`: an asset can have several custom mappings and a widget names none of them. */
export const WIDGET_METRICS: WidgetMetric[] = METRICS.filter((m): m is WidgetMetric => m !== "custom");

export const isSingleAsset = (type: WidgetType): boolean => type === "stat" || type === "gauge";
export const allowedSources = (type: DataWidgetType): WidgetSource[] => (type === "gauge" ? ["metric"] : ["metric", "energy", "cost"]);

/** The one value `compare` can take besides "none": this month so far against the same days of last month. */
export const COMPARE_MODE = "same_days_last_month" as const;
/** `top` (how many bars a breakdown draws): its default, which is left out of the stored config, and its limits. The form keeps it as text. */
export const DEFAULT_TOP = 10;
export const MIN_TOP = 3;
export const MAX_TOP = 50;
/** The longest kind a breakdown can name (the server's limit, in characters). */
export const MAX_KIND = 100;

/**
 * `energy_kwh` is a cumulative meter reading, so only its latest value means anything (the API refuses the others); the kWh
 * used over a period is the `energy` source. `metric` matters only for the source `metric` and may be left out.
 */
export function allowedAggregations(type: DataWidgetType, source: WidgetSource, metric?: WidgetMetric): Aggregation[] {
  if (source !== "metric") return ["sum"];
  return type === "gauge" || metric === "energy_kwh" ? ["last"] : ["avg", "min", "max", "last"];
}

/** What a time series sends: its chart always draws the average, but the API still wants a valid aggregation for the source. */
export function defaultAggregation(source: WidgetSource, metric: WidgetMetric): Aggregation {
  if (source !== "metric") return "sum";
  return metric === "energy_kwh" ? "last" : "avg";
}

/**
 * What the widget dialog edits. Numbers stay text while typing; `range` "" means "use the dashboard range". The form carries both field
 * sets (the data fields and `style`/`text`), so switching Type back and forth loses neither; only the set of the chosen type is saved.
 */
export interface WidgetForm {
  type: WidgetType;
  title: string;
  style: TextStyle;
  text: string;
  source: WidgetSource;
  metric: WidgetMetric;
  aggregation: Aggregation;
  range: RangePreset | "";
  bars: WidgetBars;
  gaugeMin: string;
  gaugeMax: string;
  assets: number[];
  /** Month to date against the same days of last month: stat and time series, energy or cost, one asset, the range this month (see `withCompare`). */
  compare: boolean;
  /** `bars: "kind"` only: the asset the breakdown looks under (null: the whole site), the kind drawn one bar for, and how many bars (text, like `gaugeMin`). */
  root: number | null;
  kind: string;
  top: string;
}

export function blankForm(): WidgetForm {
  return {
    type: "timeseries", title: "", style: "heading", text: "", source: "metric", metric: "active_power_kw", aggregation: "avg",
    range: "", bars: "asset", gaugeMin: "0", gaugeMax: "", assets: [], compare: false, root: null, kind: "", top: String(DEFAULT_TOP),
  };
}

/** A data widget with a bar per asset of a kind (the Bars choice "kind"). */
export const isKindMode = (form: WidgetForm): boolean => form.type === "bar" && form.bars === "kind";
/** Whether the type and source allow the comparison (stat or time series, energy or cost); not whether the box is ticked. */
export const compareAllowed = (form: Pick<WidgetForm, "type" | "source">): boolean =>
  (form.type === "stat" || form.type === "timeseries") && (form.source === "energy" || form.source === "cost");
/** The comparison is on: the box is ticked AND the type and source still allow it. */
export const isCompareOn = (form: WidgetForm): boolean => form.compare && compareAllowed(form);
/** The asset field takes one asset: a stat, a gauge, or a time series that compares (its chart draws one asset against its own last month). */
export const singleAssetForm = (form: WidgetForm): boolean => isSingleAsset(form.type) || (form.type === "timeseries" && isCompareOn(form));

/** What a widget dialog saves: a data widget (a type that fetches, with its data config) or a text widget (its style and text). */
export type WidgetFields =
  | { type: DataWidgetType; title: string; config: WidgetConfig }
  | { type: "text"; title: string; config: TextConfig };

export function formFromDraft(draft: WidgetFields): WidgetForm {
  // A text draft keeps blankForm()'s data fields and a data draft keeps its blank style and text: each set is filled only by its own kind.
  if (draft.type === "text") return { ...blankForm(), type: "text", title: draft.title, style: draft.config.style, text: draft.config.text };
  const c = draft.config;
  return {
    ...blankForm(),
    type: draft.type,
    title: draft.title,
    source: c.source,
    metric: c.metric && c.metric !== "custom" ? c.metric : "active_power_kw",
    aggregation: c.aggregation,
    range: c.range ?? "",
    bars: c.bars,
    gaugeMin: String(c.min),
    gaugeMax: c.max === null ? "" : String(c.max),
    assets: [...c.assets],
    compare: c.compare === COMPARE_MODE,
    root: c.root ?? null,
    kind: c.kind ?? "",
    top: String(c.top ?? DEFAULT_TOP),
  };
}

/** Put back what the form's modes need after a type or source change: a metric source has no bars of a kind and no comparison, and the comparison needs its type. */
function repaired(form: WidgetForm): WidgetForm {
  const next = { ...form };
  if (next.source === "metric" && next.bars === "kind") next.bars = "asset";
  if (next.compare && !compareAllowed(next)) next.compare = false; // the range stays as it is: only an explicit untick gives the old one back
  if (singleAssetForm(next)) next.assets = next.assets.slice(0, 1);
  return next;
}

/**
 * Change the type and repair what the new type does not allow: source, aggregation, and the asset count. A switch to text changes
 * nothing else, so switching back to a data type finds the data fields as they were.
 */
export function withType(form: WidgetForm, type: WidgetType): WidgetForm {
  if (type === "text") return { ...form, type };
  const next: WidgetForm = { ...form, type };
  if (!allowedSources(type).includes(next.source)) next.source = "metric";
  const aggregations = allowedAggregations(type, next.source, next.metric);
  if (!aggregations.includes(next.aggregation)) next.aggregation = aggregations[0];
  return repaired(next);
}

export function withSource(form: WidgetForm, source: WidgetSource): WidgetForm {
  const next: WidgetForm = { ...form, source };
  if (form.type === "text") return next; // a text widget has no data: the field is only kept for when the type changes back
  const aggregations = allowedAggregations(form.type, source, form.metric);
  if (!aggregations.includes(next.aggregation)) next.aggregation = aggregations[0];
  return repaired(next);
}

/**
 * Choose what a bar chart draws a bar for. "kind" (one bar per asset of a kind) takes energy or cost and no assets: from a metric source it
 * switches to energy and clears the assets. The other choices leave the form as it is (the kind, root and top are kept for when "kind" comes back).
 */
export function withBars(form: WidgetForm, bars: WidgetBars): WidgetForm {
  if (bars !== "kind") return { ...form, bars };
  const next: WidgetForm = { ...form, bars, assets: [] };
  if (next.source === "metric") {
    next.source = "energy";
    const aggregations = allowedAggregations("bar", "energy");
    if (!aggregations.includes(next.aggregation)) next.aggregation = aggregations[0];
  }
  return next;
}

/**
 * Tick or untick the comparison. Ticking (only where `compareAllowed`) sets the widget range to this month and keeps the first asset only;
 * unticking gives `restoreRange` back (the range the form had before the tick, which the editor remembers).
 */
export function withCompare(form: WidgetForm, on: boolean, restoreRange: RangePreset | "" = form.range): WidgetForm {
  if (!on) return { ...form, compare: false, range: restoreRange };
  if (!compareAllowed(form)) return form;
  return { ...form, compare: true, range: "this_month", assets: form.assets.slice(0, 1) };
}

/** Choose the metric of a metric source. `energy_kwh` only has its latest value, so that is selected for it. */
export function withMetric(form: WidgetForm, metric: WidgetMetric): WidgetForm {
  const next: WidgetForm = { ...form, metric };
  if (form.type !== "text" && form.source === "metric" && !allowedAggregations(form.type, "metric", metric).includes(next.aggregation)) next.aggregation = "last";
  return next;
}

/**
 * A metric widget can only show assets that have their own mapping for that metric (the API skips the others). Drop the
 * selected ones that have none; energy and cost take any asset. Returns the same form when nothing is dropped.
 */
export function keepAssetsWithMetric(form: WidgetForm, metricAssets: ReadonlyMap<Metric, ReadonlySet<number>>): WidgetForm {
  if (form.source !== "metric") return form;
  const having = metricAssets.get(form.metric);
  const kept = form.assets.filter((id) => having?.has(id) === true);
  return kept.length === form.assets.length ? form : { ...form, assets: kept };
}

/** Which assets have an own mapping for which metric, from the discovery graph (clustered or ungrouped points that are mapped). */
export function metricAssetsOf(graph: GraphModel): Map<Metric, Set<number>> {
  const byMetric = new Map<Metric, Set<number>>();
  for (const source of graph.sources) {
    for (const p of [...source.clusters.flatMap((c) => c.points), ...source.ungrouped]) {
      if (p.asset_id === null || p.mapped_metric === null) continue;
      const assets = byMetric.get(p.mapped_metric) ?? new Set<number>();
      assets.add(p.asset_id);
      byMetric.set(p.mapped_metric, assets);
    }
  }
  return byMetric;
}

/** `compare`: the comparison's rules (one asset). `bars`: a breakdown by kind without a usable kind. `top`: the number of bars of a breakdown. */
export interface FormIssues { title?: string; text?: string; assets?: string; aggregation?: string; gauge?: string; compare?: string; bars?: string; top?: string }

const toNumber = (text: string): number => (text.trim() === "" ? NaN : Number(text));

/** What the server refuses in a title (api/dashboards.py): a control character other than TAB, or a lone surrogate (with the u flag only an UNPAIRED one matches, so an emoji is fine). */
const TITLE_BAD_CHARACTER = /(?!\t)\p{Cc}|\p{Cs}/u;

/** Every rule the API enforces on a widget, as a message per field. An empty object means the form can be saved. */
export function formIssues(form: WidgetForm): FormIssues {
  const issues: FormIssues = {};
  const title = form.title.trim();
  if (title === "") issues.title = "Enter a title.";
  else if (title.length > MAX_TEXT) issues.title = `The title can be at most ${MAX_TEXT} characters.`;
  else if (TITLE_BAD_CHARACTER.test(title)) issues.title = "The title cannot contain control characters."; // the server's rule: a TAB is fine

  if (form.type === "text") {
    // The text rules are the server's (lib/textWidget). A divider holds no text, so none is checked even if the form still has some; the
    // asset, aggregation and gauge rules do not apply to a widget without data.
    if (form.style !== "divider") {
      const result = normalizeText(form.style, form.text);
      if (!result.ok) issues.text = result.message;
    }
    return issues;
  }

  const count = form.assets.length;
  if (isKindMode(form)) {
    // One bar per asset of a kind has no assets of its own (the form sends none); it asks for the kind and the number of bars instead.
    const kind = form.kind.trim();
    if (kind === "") issues.bars = "Enter the kind of asset to draw one bar for.";
    else if ([...kind].length > MAX_KIND) issues.bars = `The kind can be at most ${MAX_KIND} characters.`;
    const top = toNumber(form.top);
    if (!Number.isInteger(top) || top < MIN_TOP || top > MAX_TOP) issues.top = `Bars to show must be a whole number from ${MIN_TOP} to ${MAX_TOP}.`;
  } else if (isCompareOn(form)) {
    // One message for a missing or extra asset: the comparison is of one asset, whatever the type would say about it. The type and the source
    // cannot be wrong here (isCompareOn), and the editor locks the range to this month; the range rule is the server's, kept for a form built by hand.
    if (count !== 1) issues.compare = "A comparison needs exactly one asset.";
    else if (form.range !== "this_month") issues.compare = "A comparison looks at this month, so the widget range must be This month.";
  } else if (count === 0) issues.assets = isSingleAsset(form.type) ? "Choose an asset." : "Choose at least one asset.";
  else if (isSingleAsset(form.type) && count > 1) issues.assets = `A ${form.type} shows one asset.`;
  else if (count > MAX_ASSETS) issues.assets = `At most ${MAX_ASSETS} assets.`;

  if (form.type === "gauge") {
    const min = toNumber(form.gaugeMin);
    const max = toNumber(form.gaugeMax);
    if (form.source !== "metric") issues.gauge = "A gauge shows a metric, not energy or cost.";
    else if (form.aggregation !== "last") issues.gauge = "A gauge shows the latest value.";
    else if (!Number.isFinite(min) || !Number.isFinite(max)) issues.gauge = "Enter a number for the gauge minimum and maximum.";
    else if (max <= min) issues.gauge = "The gauge maximum must be greater than the minimum.";
  } else if (!allowedAggregations(form.type, form.source, form.metric).includes(form.aggregation)) {
    issues.aggregation = form.source !== "metric"
      ? "Energy and cost are totals; choose total."
      : form.metric === "energy_kwh"
        ? "An energy meter reading is cumulative; choose latest."
        : "Choose average, minimum, maximum or latest for a metric.";
  }
  return issues;
}

/**
 * The widget fields to store. Only meaningful when `formIssues` is empty. A text widget stores the NORMALIZED text ("" for a divider);
 * the form itself keeps whatever was typed, so switching Style back to Heading brings it back. (With a text the rules refuse, the
 * text as typed is returned, for a preview that wants something to draw.)
 */
export function formToFields(form: WidgetForm): WidgetFields {
  if (form.type === "text") {
    const result = form.style === "divider" ? null : normalizeText(form.style, form.text);
    return { type: "text", title: form.title.trim(), config: { style: form.style, text: result === null ? "" : result.ok ? result.text : form.text } };
  }
  const gauge = form.type === "gauge";
  const kindMode = isKindMode(form);
  const top = toNumber(form.top);
  return {
    type: form.type,
    title: form.title.trim(),
    config: {
      assets: kindMode ? [] : [...form.assets],
      source: form.source,
      metric: form.source === "metric" ? form.metric : null,
      // A time series draws the average whatever it is told, and the dialog hides the control: always send the plain default.
      aggregation: form.type === "timeseries" ? defaultAggregation(form.source, form.metric) : form.aggregation,
      range: form.range === "" ? null : form.range,
      bars: form.type === "bar" ? form.bars : "asset",
      min: gauge ? toNumber(form.gaugeMin) : 0,
      max: gauge ? toNumber(form.gaugeMax) : null,
      // The keys of w24 are written only where the widget uses them AND they are not their default, so the stored config of every other
      // widget stays exactly as it was (the server leaves the same keys out of its own dump).
      ...(isCompareOn(form) ? { compare: COMPARE_MODE } : {}),
      ...(kindMode ? { kind: form.kind.trim() } : {}),
      ...(kindMode && form.root !== null ? { root: form.root } : {}),
      ...(kindMode && Number.isInteger(top) && top !== DEFAULT_TOP ? { top } : {}),
    },
  };
}

export type WidgetBody = WidgetIn;
export type SaveBody = DashboardSave;
export interface EditState { name: string; range: RangePreset; drafts: DraftWidget[] }

/** A draft as the API takes it: no editor `key`, no id. */
export const toWidgetBody = (d: DraftWidget): WidgetBody => {
  const { key: _key, ...body } = d; // the rest of a union keeps the union (type and config stay together)
  return body;
};

/**
 * The PUT body: the edited state with the `updated_at` that was loaded, so the API can refuse a stale save. `updated_at`
 * is copied as the server wrote it (microseconds): a round trip through a JS Date would cut it to milliseconds and every save would 409.
 */
export function saveBody(baseline: Pick<Dashboard, "updated_at">, edit: EditState): SaveBody {
  return { name: edit.name.trim(), range: edit.range, updated_at: baseline.updated_at, widgets: edit.drafts.map(toWidgetBody) };
}

/** JSON with sorted object keys, so two values that differ only in key order are equal. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v);
}

/**
 * Unsaved changes: the would-be save body differs from what was loaded. The loaded side is the compacted layout, because that
 * is what the editor starts from: a dashboard saved with gaps is not changed until the user changes something.
 */
export function isDirty(baseline: Dashboard, edit: EditState): boolean {
  const loaded = saveBody(baseline, { name: baseline.name, range: baseline.range, drafts: compactVertical(toDrafts(baseline.widgets)) });
  return canonical(saveBody(baseline, edit)) !== canonical(loaded);
}

/** The copy with the later `updated_at` (either may be missing). */
export function newest(a: Dashboard | null | undefined, b: Dashboard | null | undefined): Dashboard | undefined {
  if (!a) return b ?? undefined;
  if (!b) return a;
  return Date.parse(a.updated_at) >= Date.parse(b.updated_at) ? a : b;
}

/**
 * A 409 whose message says the dashboard changed since it was loaded: someone else saved first, so offer Reload. The API
 * also answers 409 when the name is taken (`a dashboard with this name already exists`); that one is fixed by renaming,
 * and Reload would throw the edits away, so it is shown as the server's message instead.
 */
export function isStaleConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && /changed since you loaded/i.test(error.message);
}
