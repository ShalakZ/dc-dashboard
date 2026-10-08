import type { Asset, Dashboard, Role, Widget, WidgetConfig, WidgetData, WidgetPoint, WidgetType, WidgetValue } from "../api/types";

export const SITE = { timezone: "Asia/Qatar", currency: "QAR" };

/** The three requests every page test needs: no setup pending, who is signed in, and the site zone. */
export const authed = (role: Role) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role } },
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
export const widget = (id: number, type: WidgetType, over: Partial<Widget> = {}): Widget => ({
  id, type, title: `Widget ${id}`, config: config(), x: 0, y: 0, w: 4, h: 3, ...over,
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

/** A metric time series for asset 5 (two one-minute buckets). */
export const seriesData = (over: Partial<WidgetData> = {}): WidgetData => ({
  type: "timeseries", mode: "series", source: "metric", metric: "active_power_kw", unit: "kW",
  range: { ...RANGE }, tier: "1m", bucket: null,
  series: [{
    asset_id: 5, name: "LV Panel 1", estimated: false, partial: false,
    points: [
      seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 1, min: 0.5, max: 1.5 }),
      seriesPoint({ ts: "2026-10-08T00:01:00+00:00", value: 2, min: 1, max: 3 }),
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
export function dataFor(type: WidgetType): WidgetData {
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
export const widgetDataRoute = ({ body }: { url: string; body: unknown }) => ({ body: dataFor((body as { type: WidgetType }).type) });
