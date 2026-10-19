import type {
  Asset, CompareAsset, CompareChange, CompareSide, Dashboard, DataWidget, DataWidgetType, TextStyle, TextWidget, WidgetBreakdown, WidgetCompare,
  WidgetConfig, WidgetData, WidgetPoint, WidgetValue,
} from "../api/types";
import { userFor } from "./users";

export const SITE = { timezone: "Asia/Qatar", currency: "QAR" };

/** The three requests every page test needs: no setup pending, who is signed in, and the site zone. */
export const authed = (role: string) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor(role) },
  "GET /api/site": { body: SITE },
});

export const assetList: Asset[] = [
  { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
  { id: 2, parent_id: 1, name: "MV2", kind: "panel", sort_order: 0 },
  { id: 5, parent_id: 2, name: "LV Panel 1", kind: "panel", sort_order: 0 },
  { id: 6, parent_id: 2, name: "LV Panel 2", kind: "panel", sort_order: 1 },
];

export const config = (over: Partial<WidgetConfig> = {}): WidgetConfig => ({
  assets: [5], source: "metric", metric: "active_power_kw", aggregation: "avg", range: null, bars: "asset", min: 0, max: null, ...over,
});
/** A data widget (a type that fetches). A text widget is `textWidget`. */
export const widget = (id: number, type: DataWidgetType, over: Partial<DataWidget> = {}): DataWidget => ({
  id, type, title: `Widget ${id}`, config: config(), x: 0, y: 0, w: 4, h: 3, ...over,
});
export const textWidget = (id: number, style: TextStyle, text: string, over: Partial<TextWidget> = {}): TextWidget => ({
  id, type: "text", title: `Text ${id}`, config: { style, text }, x: 0, y: 0, w: 6, h: 2, ...over,
});
export const dashboard = (over: Partial<Dashboard> = {}): Dashboard => ({
  id: 3, name: "Hall A", range: "24h", updated_at: "2026-10-08T06:00:00+00:00", widgets: [], ...over,
});

const RANGE = { preset: "24h", start: "2026-10-07T06:00:00+00:00", end: "2026-10-08T06:00:00+00:00" } as const;

/** One bucket of a series; every flag defaults to false, as the API sends them for a measured metric point. */
export const seriesPoint = (over: Partial<WidgetPoint> & Pick<WidgetPoint, "ts">): WidgetPoint => ({
  value: null, min: null, max: null, estimated: false, partial: false, no_data: false, ...over,
});

/** One row of a values response (asset 5 on point 7 unless overridden). `ts` stays null: a fetched reading time would compete with the stream. */
export const valueRow = (over: Partial<WidgetValue> = {}): WidgetValue => ({
  asset_id: 5, name: "LV Panel 1", value: 10.5, estimated: false, partial: false, point_id: 7, no_data: false, ts: null, stale: false, ...over,
});

/**
 * A metric time series for asset 5: two buckets of the default 24h range. The backend cuts every window into at most 300
 * buckets (24 h / 300 = 288 s, served from the 1m tier), so consecutive buckets are 288 s apart, not 60 s. A tier says which
 * table served the series, never the bucket width; tests that depend on the spacing build their own points.
 */
export const seriesData = (over: Partial<WidgetData> = {}): WidgetData => ({
  type: "timeseries", mode: "series", source: "metric", metric: "active_power_kw", unit: "kW",
  range: { ...RANGE }, tier: "1m", bucket: null,
  series: [{
    asset_id: 5, name: "LV Panel 1", estimated: false, partial: false,
    points: [
      seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 1, min: 0.5, max: 1.5 }),
      seriesPoint({ ts: "2026-10-08T00:04:48+00:00", value: 2, min: 1, max: 3 }),
    ],
  }],
  values: [], missing: [], no_metric: [], ...over,
});

/** One value per asset: asset 5 is mapped to point 7 and reads 10.5. */
export const valuesData = (over: Partial<WidgetData> = {}): WidgetData => ({
  type: "stat", mode: "values", source: "metric", metric: "active_power_kw", unit: "kW",
  range: { ...RANGE }, tier: null, bucket: null, series: [],
  values: [valueRow()],
  missing: [], no_metric: [], ...over,
});

/** What the API answers for each widget type, so a page with one widget of each type can be mocked in one handler. */
export function dataFor(type: DataWidgetType): WidgetData {
  switch (type) {
    case "timeseries": return seriesData();
    case "bar": return valuesData({ type: "bar", source: "energy", metric: null, unit: "kWh" });
    case "stat": return valuesData({ type: "stat" });
    case "gauge": return valuesData({ type: "gauge" });
    case "table":
      return valuesData({
        type: "table",
        values: [valueRow(), valueRow({ asset_id: 6, name: "LV Panel 2", value: 4.25, estimated: true, point_id: 8 })],
      });
  }
}
export const widgetDataRoute = ({ body }: { url: string; body: unknown }) => ({ body: dataFor((body as { type: DataWidgetType }).type) });

/** One side of a comparison (17 days, none without readings, an exact kWh and cost) unless overridden. */
export const compareSide = (over: Partial<CompareSide> = {}): CompareSide => ({
  kwh: 1500, cost: 300, estimated: false, partial: false, no_data_days: 0, ...over,
});
/** The change of one measure: no figure and no reason unless given. */
export const compareChange = (over: Partial<CompareChange> = {}): CompareChange => ({ abs: null, percent: null, why_none: null, ...over });
/** The comparison of asset 5: 1500 kWh against 1300 kWh (+200, +15.4 %), 300 against 260 (+40, +15.4 %), a plain last month with no notes. */
export const compareAsset = (over: Partial<CompareAsset> = {}): CompareAsset => ({
  asset_id: 5, name: "LV Panel 1", this: compareSide(), last: compareSide({ kwh: 1300, cost: 260 }), last_state: "ok",
  kwh: compareChange({ abs: 200, percent: 15.4 }), cost: compareChange({ abs: 40, percent: 15.4 }), rate_change: null, last_points: [], ...over,
});
/** 17 days of October against the same 17 days of September, nothing left out, the previous month open. */
export const compareBlock = (over: Partial<WidgetCompare> = {}): WidgetCompare => ({
  mode: "same_days_last_month", state: "ok", elapsed_days: 17, days: 17,
  this_window: { from: "2026-10-01", to: "2026-10-17" }, last_window: { from: "2026-09-01", to: "2026-09-17" },
  left_out_days: [], last_month: { month: "2026-09", closed: false }, currency: "QAR", assets: [compareAsset()], ...over,
});
const MONTH_RANGE = { preset: "this_month", start: "2026-10-01T00:00:00+03:00", end: "2026-10-18T00:00:00+03:00" } as const;
/** A compare stat: asset 5's October figure (days 1 to 17) in `values`, and the comparison in `compare`. Energy in kWh unless `source` is overridden. */
export const compareStatData = (over: Partial<WidgetData> = {}): WidgetData => ({
  type: "stat", mode: "values", source: "energy", metric: null, unit: "kWh", range: { ...MONTH_RANGE }, tier: null, bucket: "day", series: [],
  values: [valueRow({ value: 1500, point_id: null })], missing: [], no_metric: [], compare: compareBlock(), breakdown: null, ...over,
});
/** A compare daily chart: `days` points for this month (1 to N) and `last` for last month (1 to D), all valid kWh unless a point is overridden. */
export const compareSeriesData = (n = 3, d = 3, over: Partial<WidgetData> = {}): WidgetData => {
  const day = (month: string, i: number, value: number | null, extra: Partial<WidgetPoint> = {}) =>
    seriesPoint({ ts: `${month}-${String(i + 1).padStart(2, "0")}T00:00:00+03:00`, value, no_data: value === null, ...extra });
  return {
    type: "timeseries", mode: "series", source: "energy", metric: null, unit: "kWh", range: { ...MONTH_RANGE }, tier: null, bucket: "day",
    series: [{ asset_id: 5, name: "LV Panel 1", estimated: false, partial: false, points: Array.from({ length: n }, (_, i) => day("2026-10", i, 100 + i)) }],
    values: [], missing: [], no_metric: [],
    compare: compareBlock({
      elapsed_days: n, days: d, this_window: { from: "2026-10-01", to: `2026-10-${String(d).padStart(2, "0")}` },
      last_window: { from: "2026-09-01", to: `2026-09-${String(d).padStart(2, "0")}` },
      assets: [compareAsset({ last_points: Array.from({ length: d }, (_, i) => day("2026-09", i, 90 + i)) })],
    }),
    breakdown: null, ...over,
  };
};
/** A breakdown by Rack: 117 racks under "Hall 1", 10 shown, 107 more worth 1234.5 kWh. */
export const breakdownBlock = (over: Partial<WidgetBreakdown> = {}): WidgetBreakdown => ({
  kind: "Rack", root: { id: 2, name: "Hall 1" }, count: 117, shown: 10,
  more: { count: 107, with_value: 107, value: 1234.5, estimated: false, partial: false },
  no_data: 0, inside_others: 0, kinds: [{ kind: "Rack", count: 117 }, { kind: "Panel", count: 8 }], ...over,
});
/** A bar widget by kind: `n` bars, highest first, with the breakdown block. */
export const breakdownData = (n = 3, over: Partial<WidgetData> = {}): WidgetData => ({
  type: "bar", mode: "values", source: "energy", metric: null, unit: "kWh", range: { ...MONTH_RANGE }, tier: null, bucket: null, series: [],
  values: Array.from({ length: n }, (_, i) => valueRow({ asset_id: 10 + i, name: `Rack ${i + 1}`, value: 100 - i * 10, point_id: null })),
  missing: [], no_metric: [], compare: null, breakdown: breakdownBlock(), ...over,
});
