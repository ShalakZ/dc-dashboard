import { ApiError } from "../api/client";
import {
  METRICS, type Dashboard, type DashboardSave, type GraphModel, type Metric, type RangePreset, type WidgetAggregation, type WidgetConfig,
  type WidgetIn, type WidgetSource, type WidgetType,
} from "../api/types";
import { toDrafts, type DraftWidget } from "./layout";

export const MAX_WIDGETS = 24;
export const MAX_ASSETS = 20;
export const MAX_TEXT = 100;

export type Aggregation = WidgetAggregation;
export type WidgetMetric = Exclude<Metric, "custom">;

export const TYPE_LABELS: Record<WidgetType, string> = { timeseries: "Time series", bar: "Bar chart", stat: "Stat", gauge: "Gauge", table: "Table" };
export const SOURCE_LABELS: Record<WidgetSource, string> = { metric: "Metric", energy: "Energy (kWh)", cost: "Cost" };
export const AGGREGATION_LABELS: Record<Aggregation, string> = { avg: "Average", min: "Minimum", max: "Maximum", last: "Latest", sum: "Total" };
/** The API refuses `custom`: an asset can have several custom mappings and a widget names none of them. */
export const WIDGET_METRICS: WidgetMetric[] = METRICS.filter((m): m is WidgetMetric => m !== "custom");

export const isSingleAsset = (type: WidgetType): boolean => type === "stat" || type === "gauge";
export const allowedSources = (type: WidgetType): WidgetSource[] => (type === "gauge" ? ["metric"] : ["metric", "energy", "cost"]);

/**
 * `energy_kwh` is a cumulative meter reading, so only its latest value means anything (the API refuses the others); the kWh
 * used over a period is the `energy` source. `metric` matters only for the source `metric` and may be left out.
 */
export function allowedAggregations(type: WidgetType, source: WidgetSource, metric?: WidgetMetric): Aggregation[] {
  if (source !== "metric") return ["sum"];
  return type === "gauge" || metric === "energy_kwh" ? ["last"] : ["avg", "min", "max", "last"];
}

/** What a time series sends: its chart always draws the average, but the API still wants a valid aggregation for the source. */
export function defaultAggregation(source: WidgetSource, metric: WidgetMetric): Aggregation {
  if (source !== "metric") return "sum";
  return metric === "energy_kwh" ? "last" : "avg";
}

/** What the widget dialog edits. Numbers stay text while typing; `range` "" means "use the dashboard range". */
export interface WidgetForm {
  type: WidgetType;
  title: string;
  source: WidgetSource;
  metric: WidgetMetric;
  aggregation: Aggregation;
  range: RangePreset | "";
  bars: "asset" | "time";
  gaugeMin: string;
  gaugeMax: string;
  assets: number[];
}

export function blankForm(): WidgetForm {
  return {
    type: "timeseries", title: "", source: "metric", metric: "active_power_kw", aggregation: "avg",
    range: "", bars: "asset", gaugeMin: "0", gaugeMax: "", assets: [],
  };
}

export function formFromDraft(draft: Pick<DraftWidget, "type" | "title" | "config">): WidgetForm {
  const c = draft.config;
  return {
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
  };
}

/** Change the type and repair what the new type does not allow: source, aggregation, and the asset count. */
export function withType(form: WidgetForm, type: WidgetType): WidgetForm {
  const next: WidgetForm = { ...form, type };
  if (!allowedSources(type).includes(next.source)) next.source = "metric";
  const aggregations = allowedAggregations(type, next.source, next.metric);
  if (!aggregations.includes(next.aggregation)) next.aggregation = aggregations[0];
  if (isSingleAsset(type)) next.assets = next.assets.slice(0, 1);
  return next;
}

export function withSource(form: WidgetForm, source: WidgetSource): WidgetForm {
  const next: WidgetForm = { ...form, source };
  const aggregations = allowedAggregations(form.type, source, form.metric);
  if (!aggregations.includes(next.aggregation)) next.aggregation = aggregations[0];
  return next;
}

/** Choose the metric of a metric source. `energy_kwh` only has its latest value, so that is selected for it. */
export function withMetric(form: WidgetForm, metric: WidgetMetric): WidgetForm {
  const next: WidgetForm = { ...form, metric };
  if (form.source === "metric" && !allowedAggregations(form.type, "metric", metric).includes(next.aggregation)) next.aggregation = "last";
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

export interface FormIssues { title?: string; assets?: string; aggregation?: string; gauge?: string }

const toNumber = (text: string): number => (text.trim() === "" ? NaN : Number(text));

/** Every rule the API enforces on a widget, as a message per field. An empty object means the form can be saved. */
export function formIssues(form: WidgetForm): FormIssues {
  const issues: FormIssues = {};
  const title = form.title.trim();
  if (title === "") issues.title = "Enter a title.";
  else if (title.length > MAX_TEXT) issues.title = `The title can be at most ${MAX_TEXT} characters.`;

  const count = form.assets.length;
  if (count === 0) issues.assets = isSingleAsset(form.type) ? "Choose an asset." : "Choose at least one asset.";
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

/** The widget fields to store. Only meaningful when `formIssues` is empty. */
export function formToFields(form: WidgetForm): { type: WidgetType; title: string; config: WidgetConfig } {
  const gauge = form.type === "gauge";
  return {
    type: form.type,
    title: form.title.trim(),
    config: {
      assets: [...form.assets],
      source: form.source,
      metric: form.source === "metric" ? form.metric : null,
      // A time series draws the average whatever it is told, and the dialog hides the control: always send the plain default.
      aggregation: form.type === "timeseries" ? defaultAggregation(form.source, form.metric) : form.aggregation,
      range: form.range === "" ? null : form.range,
      bars: form.type === "bar" ? form.bars : "asset",
      min: gauge ? toNumber(form.gaugeMin) : 0,
      max: gauge ? toNumber(form.gaugeMax) : null,
    },
  };
}

export type WidgetBody = WidgetIn;
export type SaveBody = DashboardSave;
export interface EditState { name: string; range: RangePreset; drafts: DraftWidget[] }

/** A draft as the API takes it: no editor `key`, no id. */
export const toWidgetBody = (d: DraftWidget): WidgetBody => ({ type: d.type, title: d.title, config: d.config, x: d.x, y: d.y, w: d.w, h: d.h });

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

/** Unsaved changes: the would-be save body differs from what was loaded. */
export function isDirty(baseline: Dashboard, edit: EditState): boolean {
  const loaded = saveBody(baseline, { name: baseline.name, range: baseline.range, drafts: toDrafts(baseline.widgets) });
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
