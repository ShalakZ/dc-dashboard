import { ApiError } from "../api/client";
import type { Metric } from "../api/types";
import { config, dashboard, widget } from "../test/dashboardFixtures";
import { model, point, source } from "../test/graphFixtures";
import {
  allowedAggregations, allowedSources, blankForm, canonical, defaultAggregation, formFromDraft, formIssues, formToFields, isDirty,
  isSingleAsset, isStaleConflict, keepAssetsWithMetric, metricAssetsOf, newest, saveBody, toWidgetBody, WIDGET_METRICS, withMetric,
  withSource, withType, type FormIssues, type WidgetForm,
} from "./dashboardEdit";
import { compactVertical, toDrafts } from "./layout";

const valid = (over: Partial<WidgetForm> = {}): WidgetForm => ({ ...blankForm(), title: "Hall power", assets: [5], ...over });

describe("what each widget may show", () => {
  it("offers the eight non-custom metrics", () => {
    expect(WIDGET_METRICS).toHaveLength(8);
    expect(WIDGET_METRICS).not.toContain("custom");
  });
  it("restricts sources and aggregations by type and source", () => {
    expect(allowedSources("gauge")).toEqual(["metric"]);
    expect(allowedSources("stat")).toEqual(["metric", "energy", "cost"]);
    expect(allowedAggregations("table", "metric")).toEqual(["avg", "min", "max", "last"]);
    expect(allowedAggregations("gauge", "metric")).toEqual(["last"]);
    expect(allowedAggregations("bar", "energy")).toEqual(["sum"]);
    expect(allowedAggregations("stat", "cost")).toEqual(["sum"]);
    expect(isSingleAsset("stat")).toBe(true);
    expect(isSingleAsset("gauge")).toBe(true);
    expect(isSingleAsset("table")).toBe(false);
  });
  it("offers energy_kwh, a cumulative meter reading, only with the latest value", () => {
    expect(allowedAggregations("table", "metric", "energy_kwh")).toEqual(["last"]);
    expect(allowedAggregations("bar", "metric", "energy_kwh")).toEqual(["last"]);
    expect(allowedAggregations("table", "metric", "voltage_v")).toEqual(["avg", "min", "max", "last"]);
    expect(allowedAggregations("table", "energy", "energy_kwh")).toEqual(["sum"]); // the kWh used over a period is the energy source
  });
  it("knows the aggregation to send when the control is hidden", () => {
    expect(defaultAggregation("metric", "active_power_kw")).toBe("avg");
    expect(defaultAggregation("metric", "energy_kwh")).toBe("last");
    expect(defaultAggregation("energy", "active_power_kw")).toBe("sum");
    expect(defaultAggregation("cost", "energy_kwh")).toBe("sum");
  });
});

describe("withType and withSource", () => {
  it("repairs the form when the type changes", () => {
    expect(withType(valid({ assets: [5, 6, 7], source: "energy", aggregation: "sum" }), "gauge"))
      .toMatchObject({ type: "gauge", source: "metric", aggregation: "last", assets: [5] });
    expect(withType(valid({ assets: [5, 6] }), "stat").assets).toEqual([5]);
    expect(withType(valid({ assets: [5, 6] }), "table").assets).toEqual([5, 6]);
    expect(withType(valid({ source: "energy", aggregation: "sum" }), "bar")).toMatchObject({ source: "energy", aggregation: "sum" });
  });
  it("picks a valid aggregation when the source changes", () => {
    expect(withSource(valid({ aggregation: "last" }), "energy")).toMatchObject({ source: "energy", aggregation: "sum" });
    expect(withSource(valid({ source: "cost", aggregation: "sum" }), "metric")).toMatchObject({ source: "metric", aggregation: "avg" });
    expect(withSource(valid({ aggregation: "min" }), "metric").aggregation).toBe("min");
  });
  it("lets a metric source on energy_kwh keep only the latest value", () => {
    expect(withSource(valid({ source: "energy", aggregation: "sum", metric: "energy_kwh" }), "metric")).toMatchObject({ source: "metric", aggregation: "last" });
  });
});

describe("withMetric", () => {
  it("switches to the latest value for energy_kwh and leaves other choices alone", () => {
    expect(withMetric(valid({ type: "table", aggregation: "max" }), "energy_kwh")).toMatchObject({ metric: "energy_kwh", aggregation: "last" });
    expect(withMetric(valid({ type: "table", aggregation: "max" }), "voltage_v")).toMatchObject({ metric: "voltage_v", aggregation: "max" });
    expect(withMetric(valid({ type: "table", metric: "energy_kwh", aggregation: "last" }), "voltage_v")).toMatchObject({ metric: "voltage_v", aggregation: "last" });
  });
});

describe("keepAssetsWithMetric (the asset -> metric map decides what a metric widget may list)", () => {
  const byMetric = new Map<Metric, Set<number>>([["active_power_kw", new Set([5, 6])], ["voltage_v", new Set([6])]]);
  it("drops selected assets that lack the metric of a metric source", () => {
    expect(keepAssetsWithMetric(valid({ type: "table", assets: [5, 6], metric: "voltage_v" }), byMetric).assets).toEqual([6]);
    expect(keepAssetsWithMetric(valid({ assets: [5, 6], metric: "frequency_hz" }), byMetric).assets).toEqual([]);
  });
  it("returns the very same form when nothing is dropped, and never touches energy or cost", () => {
    const form = valid({ assets: [5, 6] });
    expect(keepAssetsWithMetric(form, byMetric)).toBe(form);
    const energy = valid({ source: "energy", aggregation: "sum", assets: [1, 2, 3], metric: "voltage_v" });
    expect(keepAssetsWithMetric(energy, byMetric)).toBe(energy);
  });
});

describe("metricAssetsOf (built from the discovery graph)", () => {
  it("collects the mapped points of every source, clustered or not", () => {
    const graph = model({
      sources: [
        source(1, {
          clusters: [{ key: "A", points: [
            point(1, "p1", { asset_id: 5, mapping_id: 1, mapped_metric: "active_power_kw" }),
            point(2, "p2", { asset_id: 6, mapping_id: 2, mapped_metric: "active_power_kw" }),
            point(3, "p3", { asset_id: null, mapping_id: null, mapped_metric: null }), // not mapped
          ] }],
          ungrouped: [point(4, "p4", { asset_id: 6, mapping_id: 3, mapped_metric: "voltage_v" })],
        }),
        source(2, { ungrouped: [point(5, "p5", { asset_id: 7, mapping_id: 4, mapped_metric: "voltage_v" })] }),
      ],
    });
    const map = metricAssetsOf(graph);
    expect([...map.keys()].sort()).toEqual(["active_power_kw", "voltage_v"]);
    expect([...map.get("active_power_kw")!].sort()).toEqual([5, 6]);
    expect([...map.get("voltage_v")!].sort()).toEqual([6, 7]);
  });
  it("is empty for a graph without mappings", () => {
    expect(metricAssetsOf(model({ sources: [source(1, { ungrouped: [point(1, "p")] })] })).size).toBe(0);
  });
});

describe("formIssues (the API's rules, before the API is asked)", () => {
  it("accepts a complete widget", () => expect(formIssues(valid())).toEqual({}));
  it.each<[string, WidgetForm, FormIssues]>([
    ["a blank form", blankForm(), { title: "Enter a title.", assets: "Choose at least one asset." }],
    ["a title that is too long", valid({ title: "x".repeat(101) }), { title: "The title can be at most 100 characters." }],
    ["21 assets", valid({ assets: Array.from({ length: 21 }, (_, i) => i + 1) }), { assets: "At most 20 assets." }],
    ["a stat with no asset", valid({ type: "stat", assets: [] }), { assets: "Choose an asset." }],
    ["a stat with two assets", valid({ type: "stat", assets: [5, 6] }), { assets: "A stat shows one asset." }],
    ["a gauge with two assets", valid({ type: "gauge", aggregation: "last", gaugeMax: "100", assets: [5, 6] }), { assets: "A gauge shows one asset." }],
    ["a gauge on energy", valid({ type: "gauge", source: "energy", aggregation: "sum", gaugeMax: "100" }), { gauge: "A gauge shows a metric, not energy or cost." }],
    ["a gauge that is not the latest value", valid({ type: "gauge", aggregation: "avg", gaugeMax: "100" }), { gauge: "A gauge shows the latest value." }],
    ["a gauge without a maximum", valid({ type: "gauge", aggregation: "last" }), { gauge: "Enter a number for the gauge minimum and maximum." }],
    ["a gauge whose maximum is not above its minimum", valid({ type: "gauge", aggregation: "last", gaugeMin: "50", gaugeMax: "50" }), { gauge: "The gauge maximum must be greater than the minimum." }],
    ["energy averaged", valid({ source: "energy", aggregation: "avg" }), { aggregation: "Energy and cost are totals; choose total." }],
    ["a metric totalled", valid({ aggregation: "sum" }), { aggregation: "Choose average, minimum, maximum or latest for a metric." }],
    ["energy_kwh averaged", valid({ type: "table", metric: "energy_kwh", aggregation: "avg" }), { aggregation: "An energy meter reading is cumulative; choose latest." }],
  ])("rejects %s", (_name, form, expected) => {
    expect(formIssues(form)).toEqual(expected);
  });
  it("accepts energy_kwh with the latest value", () => {
    expect(formIssues(valid({ type: "table", metric: "energy_kwh", aggregation: "last" }))).toEqual({});
  });
});

describe("formToFields", () => {
  it("builds the config the API expects", () => {
    expect(formToFields(valid({ assets: [5, 6], range: "7d" }))).toEqual({
      type: "timeseries", title: "Hall power",
      config: { assets: [5, 6], source: "metric", metric: "active_power_kw", aggregation: "avg", range: "7d", bars: "asset", min: 0, max: null },
    });
    expect(formToFields(valid({ source: "energy", aggregation: "sum", title: "  kWh  " }))).toEqual({
      type: "timeseries", title: "kWh",
      config: { assets: [5], source: "energy", metric: null, aggregation: "sum", range: null, bars: "asset", min: 0, max: null },
    });
  });
  it("keeps bars only for bar widgets and min/max only for gauges", () => {
    expect(formToFields(valid({ type: "bar", bars: "time" })).config.bars).toBe("time");
    expect(formToFields(valid({ type: "gauge", aggregation: "last", gaugeMin: "10", gaugeMax: "250.5" })).config).toMatchObject({ min: 10, max: 250.5, bars: "asset" });
    expect(formToFields(valid({ type: "table", bars: "time", gaugeMax: "9" })).config).toMatchObject({ bars: "asset", min: 0, max: null });
  });
  it("round-trips a saved widget through the form", () => {
    const saved = widget(1, "gauge", { title: "Load", config: config({ aggregation: "last", min: 5, max: 90, range: "6h" }) });
    expect(formToFields(formFromDraft(saved))).toEqual({ type: "gauge", title: "Load", config: saved.config });
  });
  it("sends the default aggregation of a time series, whose chart ignores it and whose control is hidden", () => {
    expect(formToFields(valid({ aggregation: "max" })).config.aggregation).toBe("avg");
    expect(formToFields(valid({ metric: "energy_kwh", aggregation: "last" })).config.aggregation).toBe("last");
    expect(formToFields(valid({ source: "cost", aggregation: "sum" })).config.aggregation).toBe("sum");
    expect(formToFields(valid({ type: "table", aggregation: "max" })).config.aggregation).toBe("max"); // other types send the choice
  });
});

describe("save body and unsaved changes", () => {
  const base = dashboard({ widgets: [widget(1, "stat", { title: "Now", config: config({ aggregation: "last" }), x: 0, y: 0, w: 3, h: 2 })] });
  const unchanged = () => ({ name: base.name, range: base.range, drafts: toDrafts(base.widgets) });

  it("builds the exact save body: no keys or ids, the loaded updated_at, a trimmed name", () => {
    expect(saveBody(base, { ...unchanged(), name: "  Hall A2 " })).toEqual({
      name: "Hall A2", range: "24h", updated_at: "2026-10-08T06:00:00+00:00",
      widgets: [{ type: "stat", title: "Now", config: base.widgets[0].config, x: 0, y: 0, w: 3, h: 2 }],
    });
    expect(Object.keys(toWidgetBody(toDrafts(base.widgets)[0])).sort()).toEqual(["config", "h", "title", "type", "w", "x", "y"]);
  });

  it("sends updated_at exactly as the server wrote it, microseconds included", () => {
    const precise = dashboard({ updated_at: "2026-10-08T06:00:00.481233Z" });
    expect(saveBody(precise, { name: precise.name, range: precise.range, drafts: [] }).updated_at).toBe("2026-10-08T06:00:00.481233Z");
  });

  it("is not dirty until something changed", () => {
    expect(isDirty(base, unchanged())).toBe(false);
    expect(isDirty(base, { ...unchanged(), name: "Other" })).toBe(true);
    expect(isDirty(base, { ...unchanged(), range: "7d" })).toBe(true);
    const [draft] = unchanged().drafts;
    expect(isDirty(base, { ...unchanged(), drafts: [{ ...draft, x: 4 }] })).toBe(true);
    expect(isDirty(base, { ...unchanged(), drafts: [] })).toBe(true);
  });

  it("compares with the compacted layout: a dashboard saved with a gap is not dirty until something changes", () => {
    const gappy = dashboard({ widgets: [widget(1, "stat", { x: 0, y: 0, w: 3, h: 2 }), widget(2, "stat", { x: 0, y: 5, w: 3, h: 2 })] });
    const closed = () => ({ name: gappy.name, range: gappy.range, drafts: compactVertical(toDrafts(gappy.widgets)) });
    expect(closed().drafts.map((d) => d.y)).toEqual([0, 2]);
    expect(isDirty(gappy, closed())).toBe(false);
    expect(isDirty(gappy, { ...closed(), drafts: toDrafts(gappy.widgets) })).toBe(true); // the old, gappy positions would be a change
    const [first, second] = closed().drafts;
    expect(isDirty(gappy, { ...closed(), drafts: [first, { ...second, h: 3 }] })).toBe(true);
  });

  it("ignores key order inside a config and spaces around the name", () => {
    const [draft] = unchanged().drafts;
    const reordered = { ...draft, config: Object.fromEntries(Object.entries(draft.config).reverse()) as typeof draft.config };
    expect(isDirty(base, { ...unchanged(), name: " Hall A ", drafts: [reordered] })).toBe(false);
    expect(canonical({ b: 1, a: { d: 1, c: 2 } })).toBe(canonical({ a: { c: 2, d: 1 }, b: 1 }));
  });

  it("picks the most recently updated copy of a dashboard", () => {
    const old = dashboard({ updated_at: "2026-10-08T06:00:00+00:00" });
    const later = dashboard({ updated_at: "2026-10-08T07:00:00+00:00", name: "later" });
    expect(newest(old, later)).toBe(later);
    expect(newest(later, old)).toBe(later);
    expect(newest(null, old)).toBe(old);
    expect(newest(old, undefined)).toBe(old);
    expect(newest(null, undefined)).toBeUndefined();
  });

  it("tells a lost race (409) from a taken name (409) and from other errors", () => {
    expect(isStaleConflict(new ApiError(409, "dashboard changed since you loaded it"))).toBe(true);
    expect(isStaleConflict(new ApiError(409, "a dashboard with this name already exists"))).toBe(false);
    expect(isStaleConflict(new ApiError(409, "something else"))).toBe(false);
    expect(isStaleConflict(new ApiError(422, "dashboard changed since you loaded it"))).toBe(false);
    expect(isStaleConflict(new Error("x"))).toBe(false);
  });
});
