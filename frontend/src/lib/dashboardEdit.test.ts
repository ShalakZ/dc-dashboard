import { ApiError } from "../api/client";
import type { Metric } from "../api/types";
import { config, dashboard, textWidget, widget } from "../test/dashboardFixtures";
import { model, point, source } from "../test/graphFixtures";
import {
  allowedAggregations, allowedSources, blankForm, canonical, compareAllowed, defaultAggregation, formFromDraft, formIssues, formToFields, isCompareOn,
  isDirty, isKindMode, isSingleAsset, isStaleConflict, keepAssetsWithMetric, metricAssetsOf, newest, saveBody, scopeAllowed, singleAssetForm, toWidgetBody,
  WIDGET_METRICS, withBars, withCompare, withMetric, withRoot, withScope, withSource, withType, type FormIssues, type WidgetForm,
} from "./dashboardEdit";
import { compactVertical, toDrafts } from "./layout";

const valid = (over: Partial<WidgetForm> = {}): WidgetForm => ({ ...blankForm(), title: "Hall power", assets: [5], ...over });
/** `formToFields` of a form that must be a data widget, narrowed so its data config can be read. */
function dataFields(form: WidgetForm) {
  const fields = formToFields(form);
  if (fields.type === "text") throw new Error("expected a data widget");
  return fields;
}

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

  describe("the characters of a title (the server's rule, review W1)", () => {
    const REFUSED = { title: "The title cannot contain control characters." };
    const withChar = (char: string) => valid({ title: `Hall${char}A` });

    it("accepts a TAB inside the title, and a valid emoji pair", () => {
      expect(formIssues(withChar(String.fromCharCode(9)))).toEqual({});
      expect(formIssues(withChar(String.fromCodePoint(0x1f600)))).toEqual({});
      expect(formIssues(withChar(String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)))).toEqual({});
    });

    it("refuses NUL, BEL, a line feed, DEL, a C1 control and a lone surrogate, with one sentence", () => {
      for (const code of [0x00, 0x07, 0x0a, 0x7f, 0x85, 0x9f]) expect(formIssues(withChar(String.fromCharCode(code))), `U+${code.toString(16)}`).toEqual(REFUSED);
      expect(formIssues(withChar(String.fromCharCode(0xd83d))), "a high surrogate alone").toEqual(REFUSED);
      expect(formIssues(withChar(String.fromCharCode(0xde00))), "a low surrogate alone").toEqual(REFUSED);
    });

    it("keeps the empty and the length messages first, and checks a text widget's title the same way", () => {
      expect(formIssues(valid({ title: "" }))).toEqual({ title: "Enter a title." });
      expect(formIssues(valid({ title: `${String.fromCharCode(7)}${"x".repeat(100)}` }))).toEqual({ title: "The title can be at most 100 characters." });
      expect(formIssues({ ...blankForm(), type: "text", title: `Hall${String.fromCharCode(9)}A`, style: "heading", text: "Hall A" })).toEqual({});
      expect(formIssues({ ...blankForm(), type: "text", title: `Hall${String.fromCharCode(7)}A`, style: "heading", text: "Hall A" })).toEqual(REFUSED);
    });
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
    expect(dataFields(valid({ type: "bar", bars: "time" })).config.bars).toBe("time");
    expect(formToFields(valid({ type: "gauge", aggregation: "last", gaugeMin: "10", gaugeMax: "250.5" })).config).toMatchObject({ min: 10, max: 250.5, bars: "asset" });
    expect(dataFields(valid({ type: "table", bars: "time", gaugeMax: "9" })).config).toMatchObject({ bars: "asset", min: 0, max: null });
  });
  it("round-trips a saved widget through the form", () => {
    const saved = widget(1, "gauge", { title: "Load", config: config({ aggregation: "last", min: 5, max: 90, range: "6h" }) });
    expect(formToFields(formFromDraft(saved))).toEqual({ type: "gauge", title: "Load", config: saved.config });
  });
  it("sends the default aggregation of a time series, whose chart ignores it and whose control is hidden", () => {
    expect(dataFields(valid({ aggregation: "max" })).config.aggregation).toBe("avg");
    expect(dataFields(valid({ metric: "energy_kwh", aggregation: "last" })).config.aggregation).toBe("last");
    expect(dataFields(valid({ source: "cost", aggregation: "sum" })).config.aggregation).toBe("sum");
    expect(dataFields(valid({ type: "table", aggregation: "max" })).config.aggregation).toBe("max"); // other types send the choice
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
    if (draft.type === "text") throw new Error("expected a data draft");
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

// The text widget (w22): the form carries both field sets, the rules are lib/textWidget's (the server's, pinned by the shared sample file).
describe("a text widget in the form", () => {
  const NUL = String.fromCharCode(0);
  const LONE_SURROGATE = String.fromCharCode(0xd800);
  const EMOJI = String.fromCodePoint(0x1f600);
  const text = (over: Partial<WidgetForm> = {}): WidgetForm => valid({ type: "text", style: "paragraph", text: "Hello", assets: [], ...over });
  const draftOf = (style: "heading" | "paragraph" | "divider", body: string, title = "Notes") => toDrafts([textWidget(1, style, body, { title })])[0];

  describe("formFromDraft and formToFields", () => {
    it("round-trips a text draft", () => {
      const form = formFromDraft(draftOf("paragraph", "one\ntwo"));
      expect(form).toMatchObject({ type: "text", title: "Notes", style: "paragraph", text: "one\ntwo" });
      expect(formToFields(form)).toEqual({ type: "text", title: "Notes", config: { style: "paragraph", text: "one\ntwo" } });
      expect(formToFields(formFromDraft(draftOf("divider", "")))).toEqual({ type: "text", title: "Notes", config: { style: "divider", text: "" } });
    });

    it("gives a text draft the blank data fields and a data draft a blank style and text", () => {
      expect(formFromDraft(draftOf("heading", "Hall A"))).toEqual({ ...blankForm(), type: "text", title: "Notes", style: "heading", text: "Hall A" });
      const gauge = toDrafts([widget(1, "gauge", { title: "Load", config: config({ aggregation: "last", max: 100 }) })])[0];
      expect(formFromDraft(gauge)).toMatchObject({ type: "gauge", title: "Load", style: "heading", text: "", gaugeMax: "100" });
    });

    it("stores the normalized text: trimmed, with CRLF as LF", () => {
      expect(formToFields(text({ text: "  one\r\ntwo  \n", title: "  Notes " }))).toEqual({
        type: "text", title: "Notes", config: { style: "paragraph", text: "one\ntwo" },
      });
    });

    it("sends no text for a divider while the form keeps what was typed, so switching Style back restores it", () => {
      const divider = text({ style: "divider", text: "kept" });
      expect(formToFields(divider)).toEqual({ type: "text", title: "Hall power", config: { style: "divider", text: "" } });
      expect(divider.text).toBe("kept");
      expect(formToFields({ ...divider, style: "heading" }).config).toEqual({ style: "heading", text: "kept" });
    });

    it("sends only a style and a text, never a data field", () => {
      expect(Object.keys(formToFields(text({ source: "energy", assets: [5], range: "7d" })).config).sort()).toEqual(["style", "text"]);
    });

    it("saves what the text rules refuse as typed, for a preview that wants something to draw (formIssues blocks the Save)", () => {
      expect(formToFields(text({ style: "heading", text: "a\nb" })).config).toEqual({ style: "heading", text: "a\nb" });
    });
  });

  describe("withType", () => {
    it("changes only the type when it switches to text, so switching back finds the data fields as they were", () => {
      const gauge = valid({ type: "gauge", aggregation: "last", gaugeMin: "5", gaugeMax: "90", range: "6h", assets: [5] });
      const asText = withType(gauge, "text");
      expect(asText).toEqual({ ...gauge, type: "text" });
      expect(withType(asText, "gauge")).toEqual(gauge);
      expect(withType(withType(valid({ source: "energy", aggregation: "sum", assets: [5, 6] }), "text"), "stat"))
        .toMatchObject({ type: "stat", source: "energy", aggregation: "sum", assets: [5] }); // the new type still repairs what it does not allow
    });

    it("switching a text draft's form to a data type starts from the blank data fields and keeps the style and text", () => {
      const next = withType(formFromDraft(draftOf("heading", "Hall A")), "table");
      expect(next).toMatchObject({
        type: "table", source: "metric", metric: "active_power_kw", aggregation: "avg", range: "", gaugeMin: "0", gaugeMax: "", assets: [],
        style: "heading", text: "Hall A",
      });
    });

    it("leaves a text form alone when only its source or metric field changes", () => {
      expect(withSource(text(), "energy")).toMatchObject({ type: "text", source: "energy", aggregation: "avg" });
      expect(withMetric(text(), "energy_kwh")).toMatchObject({ type: "text", metric: "energy_kwh", aggregation: "avg" });
    });
  });

  describe("formIssues", () => {
    it("accepts a text widget with no assets, and ignores the asset, aggregation and gauge rules", () => {
      expect(formIssues(text())).toEqual({});
      expect(formIssues(text({ source: "energy", aggregation: "avg", gaugeMin: "x", gaugeMax: "", assets: Array.from({ length: 30 }, (_, i) => i + 1) }))).toEqual({});
      expect(formIssues(text({ style: "heading", text: "Hall A" }))).toEqual({});
    });

    it.each<[string, WidgetForm, FormIssues]>([
      ["an empty paragraph", text({ text: "" }), { text: "Enter the text." }],
      ["a heading of spaces", text({ style: "heading", text: "  \n " }), { text: "Enter the text." }],
      ["a heading of two lines", text({ style: "heading", text: "a\nb" }), { text: "A heading is one line." }],
      ["a heading of 201 characters", text({ style: "heading", text: "a".repeat(201) }), { text: "The text can be at most 200 characters." }],
      ["a paragraph of 2001 characters", text({ text: "a".repeat(2001) }), { text: "The text can be at most 2,000 characters." }],
      ["a control character", text({ text: `a${NUL}b` }), { text: "The text has a control character that cannot be saved." }],
      ["a lone surrogate", text({ text: `a${LONE_SURROGATE}b` }), { text: "The text has a character that cannot be saved." }],
    ])("refuses %s", (_name, form, expected) => {
      expect(formIssues(form)).toEqual(expected);
    });

    it("counts code points: 200 emoji are a full heading and 2000 a full paragraph", () => {
      expect(formIssues(text({ style: "heading", text: EMOJI.repeat(200) }))).toEqual({});
      expect(formIssues(text({ style: "heading", text: EMOJI.repeat(201) }))).toHaveProperty("text");
      expect(formIssues(text({ text: EMOJI.repeat(2000) }))).toEqual({});
      expect(formIssues(text({ text: EMOJI.repeat(2001) }))).toHaveProperty("text");
    });

    it("needs no text for a divider and checks none, even if the form still holds some", () => {
      expect(formIssues(text({ style: "divider", text: "" }))).toEqual({});
      expect(formIssues(text({ style: "divider", text: "left over" }))).toEqual({});
      expect(formIssues(text({ style: "divider", text: `left${NUL}over` }))).toEqual({});
    });

    it("still requires a title, and reports it next to a text problem", () => {
      expect(formIssues(text({ title: "  " }))).toEqual({ title: "Enter a title." });
      expect(formIssues(text({ style: "divider", title: "" }))).toEqual({ title: "Enter a title." });
      expect(formIssues(text({ title: "x".repeat(101), text: "" }))).toEqual({ title: "The title can be at most 100 characters.", text: "Enter the text." });
    });
  });

  describe("the save body", () => {
    const base = dashboard({ widgets: [textWidget(1, "heading", "Hall A", { title: "Title", x: 0, y: 0, w: 6, h: 2 })] });
    const unchanged = () => ({ name: base.name, range: base.range, drafts: toDrafts(base.widgets) });

    it("sends a text widget with exactly the keys of any other", () => {
      expect(saveBody(base, unchanged()).widgets).toEqual([{ type: "text", title: "Title", config: { style: "heading", text: "Hall A" }, x: 0, y: 0, w: 6, h: 2 }]);
      expect(Object.keys(toWidgetBody(unchanged().drafts[0])).sort()).toEqual(["config", "h", "title", "type", "w", "x", "y"]);
    });

    it("is not dirty until the text changes", () => {
      expect(isDirty(base, unchanged())).toBe(false);
      const [draft] = unchanged().drafts;
      if (draft.type !== "text") throw new Error("expected a text draft");
      expect(isDirty(base, { ...unchanged(), drafts: [{ ...draft, config: { style: "heading", text: "Hall B" } }] })).toBe(true);
      expect(isDirty(base, { ...unchanged(), drafts: [{ ...draft, config: { style: "paragraph", text: "Hall A" } }] })).toBe(true);
    });
  });
});

// The comparison and the breakdown by kind (w24): new keys that are written only where the widget uses them and not at their default.
describe("the comparison (w24)", () => {
  const stat = (over: Partial<WidgetForm> = {}): WidgetForm => valid({ type: "stat", source: "energy", aggregation: "sum", ...over });
  const series = (over: Partial<WidgetForm> = {}): WidgetForm => valid({ type: "timeseries", source: "cost", aggregation: "sum", ...over });

  it("is allowed for a stat or a time series on energy or cost, and for nothing else", () => {
    expect(compareAllowed(stat())).toBe(true);
    expect(compareAllowed(series())).toBe(true);
    expect(compareAllowed(stat({ source: "metric" }))).toBe(false);
    for (const type of ["bar", "gauge", "table", "text"] as const) expect(compareAllowed(valid({ type, source: "energy" })), type).toBe(false);
  });

  it("ticks to this month and the first asset, and gives the old range back when it is unticked", () => {
    const ticked = withCompare(series({ assets: [5, 6, 7], range: "7d" }), true);
    expect(ticked).toMatchObject({ compare: true, range: "this_month", assets: [5] });
    expect(withCompare(ticked, false, "7d")).toMatchObject({ compare: false, range: "7d", assets: [5] });
    expect(withCompare(ticked, false, "")).toMatchObject({ compare: false, range: "" });
    expect(withCompare(stat({ range: "" }), true).range).toBe("this_month");
  });

  it("refuses to tick where it is not allowed", () => {
    const form = valid({ type: "gauge", aggregation: "last", gaugeMax: "100" });
    expect(withCompare(form, true)).toBe(form);
  });

  it("makes a time series that compares a single-asset picker, and a stat or a gauge always one", () => {
    expect(singleAssetForm(series())).toBe(false);
    expect(singleAssetForm(series({ compare: true, range: "this_month" }))).toBe(true);
    expect(singleAssetForm(stat())).toBe(true);
    expect(singleAssetForm(valid({ type: "gauge" }))).toBe(true);
    expect(singleAssetForm(valid({ type: "table" }))).toBe(false);
    expect(isCompareOn(series({ compare: true }))).toBe(true);
    expect(isCompareOn(valid({ type: "table", compare: true }))).toBe(false); // a stray tick on a type that cannot compare is not a comparison
  });

  it("is unticked by a type or a source that cannot compare, and the range stays as it was", () => {
    const on = series({ compare: true, range: "this_month" });
    expect(withType(on, "stat")).toMatchObject({ compare: true, range: "this_month" }); // a stat compares too
    expect(withType(on, "stat").assets).toEqual([5]);
    for (const type of ["bar", "gauge", "table"] as const) expect(withType(on, type), type).toMatchObject({ compare: false, range: "this_month" });
    expect(withSource(on, "energy")).toMatchObject({ compare: true, source: "energy" });
    expect(withSource(on, "metric")).toMatchObject({ compare: false, range: "this_month", source: "metric" });
  });

  it("keeps the tick through a text widget and drops it when the type that comes back cannot compare", () => {
    const on = stat({ compare: true, range: "this_month" });
    const text = withType(on, "text");
    expect(text.compare).toBe(true);
    expect(withType(text, "stat").compare).toBe(true);
    expect(withType(text, "timeseries").compare).toBe(true);
    expect(withType(text, "bar").compare).toBe(false);
  });

  it("is written as 'same_days_last_month' only for a comparing widget, and the key is absent otherwise", () => {
    const on = stat({ compare: true, range: "this_month" });
    expect(formToFields(on)).toEqual({
      type: "stat", title: "Hall power",
      config: { assets: [5], source: "energy", metric: null, aggregation: "sum", range: "this_month", bars: "asset", min: 0, max: null, compare: "same_days_last_month" },
    });
    expect(Object.keys(dataFields(stat()).config)).not.toContain("compare");
    expect(Object.keys(dataFields(stat({ range: "this_month" })).config)).not.toContain("compare"); // this month alone is not a comparison
    // a stray tick the type or source cannot honour is not sent
    expect(Object.keys(dataFields(valid({ type: "table", compare: true })).config)).not.toContain("compare");
    expect(Object.keys(dataFields(stat({ source: "metric", aggregation: "last", compare: true })).config)).not.toContain("compare");
  });

  it("round-trips a saved comparison through the form, and reads an absent key as no comparison", () => {
    const saved = widget(1, "timeseries", { title: "MTD", config: config({ assets: [5], source: "cost", metric: null, aggregation: "sum", range: "this_month", compare: "same_days_last_month" }) });
    expect(formFromDraft(toDrafts([saved])[0])).toMatchObject({ compare: true, range: "this_month" });
    expect(formToFields(formFromDraft(toDrafts([saved])[0]))).toEqual({ type: "timeseries", title: "MTD", config: saved.config });
    expect(formFromDraft(toDrafts([widget(2, "stat")])[0]).compare).toBe(false);
  });

  it("asks for exactly one asset, in one sentence, and does not also say 'choose an asset'", () => {
    expect(formIssues(stat({ compare: true, range: "this_month" }))).toEqual({});
    expect(formIssues(stat({ compare: true, range: "this_month", assets: [] }))).toEqual({ compare: "A comparison needs exactly one asset." });
    expect(formIssues(series({ compare: true, range: "this_month", assets: [5, 6] }))).toEqual({ compare: "A comparison needs exactly one asset." });
    expect(formIssues(stat({ assets: [] }))).toEqual({ assets: "Choose an asset." }); // without the tick the old sentence stays
  });

  it("mirrors the server's range rule for a form built by hand", () => {
    expect(formIssues(stat({ compare: true, range: "7d" }))).toEqual({ compare: "A comparison looks at this month, so the widget range must be This month." });
  });
});

describe("one bar per asset of a kind (w24)", () => {
  const kindBars = (over: Partial<WidgetForm> = {}): WidgetForm =>
    valid({ type: "bar", bars: "kind", source: "energy", aggregation: "sum", assets: [], kind: "Rack", ...over });

  it("is a bar chart on energy or cost only", () => {
    expect(isKindMode(kindBars())).toBe(true);
    expect(isKindMode(kindBars({ type: "table" }))).toBe(false);
    expect(isKindMode(valid({ type: "bar", bars: "asset" }))).toBe(false);
  });

  it("switches a metric source to energy (a total) and clears the assets when chosen", () => {
    const from = valid({ type: "bar", assets: [5, 6], metric: "voltage_v", aggregation: "max" });
    expect(withBars(from, "kind")).toMatchObject({ bars: "kind", source: "energy", aggregation: "sum", assets: [] });
    const cost = withBars(valid({ type: "bar", source: "cost", aggregation: "sum", assets: [5] }), "kind");
    expect(cost).toMatchObject({ bars: "kind", source: "cost", aggregation: "sum", assets: [] });
  });

  it("goes back to one bar per asset when the source becomes a metric again, and keeps the kind, root and top for later", () => {
    const form = kindBars({ root: 2, kind: "Panel", top: "20" });
    expect(withSource(form, "metric")).toMatchObject({ bars: "asset", root: 2, kind: "Panel", top: "20" });
    expect(withSource(form, "cost")).toMatchObject({ bars: "kind", source: "cost" });
    expect(withBars(form, "time")).toMatchObject({ bars: "time", root: 2, kind: "Panel", top: "20" });
  });

  it("does not come back with a metric source after a gauge (the gauge forces the source without going through withSource)", () => {
    const gauge = withType(kindBars(), "gauge");
    expect(gauge).toMatchObject({ type: "gauge", source: "metric", bars: "asset" });
    expect(isKindMode(withType(gauge, "bar"))).toBe(false);
    expect(withType(kindBars(), "stat")).toMatchObject({ bars: "kind", source: "energy" }); // a stat keeps energy; the mode only counts for a bar chart
  });

  it("sends no assets and the kind, trimmed; root and top only when they are not the defaults", () => {
    expect(formToFields(kindBars({ kind: "  Rack " }))).toEqual({
      type: "bar", title: "Hall power",
      config: { assets: [], source: "energy", metric: null, aggregation: "sum", range: null, bars: "kind", min: 0, max: null, kind: "Rack" },
    });
    expect(dataFields(kindBars({ root: 2, top: "25" })).config).toMatchObject({ kind: "Rack", root: 2, top: 25 });
    expect(Object.keys(dataFields(kindBars({ top: "10" })).config)).not.toContain("top");
    expect(Object.keys(dataFields(kindBars({ root: null })).config)).not.toContain("root");
    expect(dataFields(kindBars({ source: "cost", assets: [5, 6] })).config).toMatchObject({ source: "cost", assets: [] }); // stale assets never travel
  });

  it("sends none of the three keys for any other widget, even when the form still holds them", () => {
    const stale = { kind: "Rack", root: 2, top: "25" };
    for (const form of [valid(stale), valid({ type: "bar", bars: "asset", ...stale }), valid({ type: "bar", bars: "time", ...stale }), valid({ type: "stat", ...stale })]) {
      const keys = Object.keys(dataFields(form).config);
      for (const key of ["kind", "root", "top"]) expect(keys, `${form.type}/${form.bars}`).not.toContain(key);
    }
  });

  it("round-trips a saved breakdown, and reads absent keys as the defaults", () => {
    const saved = widget(1, "bar", {
      title: "Racks", config: config({ assets: [], source: "energy", metric: null, aggregation: "sum", range: "this_month", bars: "kind", kind: "Rack", root: 2, top: 25 }),
    });
    expect(formFromDraft(toDrafts([saved])[0])).toMatchObject({ bars: "kind", kind: "Rack", root: 2, top: "25", assets: [] });
    expect(formToFields(formFromDraft(toDrafts([saved])[0]))).toEqual({ type: "bar", title: "Racks", config: saved.config });
    const bare = widget(2, "bar", { config: config({ assets: [], source: "energy", metric: null, aggregation: "sum", bars: "kind", kind: "Rack" }) });
    expect(formFromDraft(toDrafts([bare])[0])).toMatchObject({ root: null, top: "10", kind: "Rack" });
    expect(formFromDraft(toDrafts([widget(3, "bar")])[0])).toMatchObject({ root: null, kind: "", top: "10", compare: false });
  });

  it("asks for the kind instead of assets, and checks its length and the number of bars", () => {
    expect(formIssues(kindBars())).toEqual({});
    expect(formIssues(kindBars({ kind: "" }))).toEqual({ bars: "Enter the kind of asset to draw one bar for." });
    expect(formIssues(kindBars({ kind: "   " }))).toEqual({ bars: "Enter the kind of asset to draw one bar for." });
    expect(formIssues(kindBars({ kind: "x".repeat(100) }))).toEqual({});
    expect(formIssues(kindBars({ kind: "x".repeat(101) }))).toEqual({ bars: "The kind can be at most 100 characters." });
    expect(formIssues(kindBars({ kind: `  ${"x".repeat(100)}  ` }))).toEqual({}); // the trimmed kind counts
    expect(formIssues(kindBars({ kind: "😀".repeat(100) }))).toEqual({}); // characters, not UTF-16 units
  });

  it.each(["2", "51", "", "abc", "7.5", "-3"])("refuses %j bars to show", (top) => {
    expect(formIssues(kindBars({ top }))).toEqual({ top: "Bars to show must be a whole number from 3 to 50." });
  });
  it.each(["3", "10", "50", " 12 "])("accepts %j bars to show", (top) => {
    expect(formIssues(kindBars({ top }))).toEqual({});
  });

  it("reports the kind and the number together, and never asks for assets in this mode", () => {
    expect(formIssues(kindBars({ kind: "", top: "1", assets: [] }))).toEqual({
      bars: "Enter the kind of asset to draw one bar for.", top: "Bars to show must be a whole number from 3 to 50.",
    });
    expect(formIssues(kindBars({ assets: [5, 6, 7] }))).toEqual({}); // stale picks are not sent
  });
});

// w25: what a widget follows. `scope` is "fixed" (its own assets, the default), "focus" (the dashboard's focus asset) or "children" (that asset's children).
describe("what a widget follows (w25)", () => {
  const follows = (scope: "focus" | "children", over: Partial<WidgetForm> = {}): WidgetForm => valid({ scope, assets: [], ...over });
  const energyStat = (over: Partial<WidgetForm> = {}): WidgetForm => valid({ type: "stat", source: "energy", aggregation: "sum", ...over });
  const kindBars = (over: Partial<WidgetForm> = {}): WidgetForm =>
    valid({ type: "bar", bars: "kind", source: "energy", aggregation: "sum", assets: [], kind: "Rack", ...over });

  it("starts fixed, and reads an absent key as fixed", () => {
    expect(blankForm().scope).toBe("fixed");
    expect(formFromDraft(toDrafts([widget(1, "stat")])[0]).scope).toBe("fixed");
    expect(formFromDraft(toDrafts([widget(2, "table", { config: config({ assets: [], scope: "children" }) })])[0]).scope).toBe("children");
  });

  describe("scopeAllowed", () => {
    it.each<[string, WidgetForm, boolean]>([
      ["a time series", valid({ type: "timeseries" }), true],
      ["a table", valid({ type: "table" }), true],
      ["a bar chart with a bar per asset", valid({ type: "bar", bars: "asset" }), true],
      ["a bar chart with a bar per time bucket", valid({ type: "bar", bars: "time" }), true],
      ["a bar chart with a bar per asset of a kind", kindBars(), false],
      ["a stat", valid({ type: "stat" }), false],
      ["a gauge", valid({ type: "gauge" }), false],
      ["a time series that compares", valid({ type: "timeseries", source: "energy", aggregation: "sum", compare: true, range: "this_month" }), false],
      ["a time series with the tick left over from a metric source (not a comparison)", valid({ type: "timeseries", source: "metric", compare: true }), true],
      ["a table with a stray tick", valid({ type: "table", source: "energy", aggregation: "sum", compare: true }), true],
      ["a table with the bars choice left over from a bar chart", valid({ type: "table", bars: "kind" }), true],
    ])("children: %s", (_name, form, expected) => {
      expect(scopeAllowed(form, "children")).toBe(expected);
    });
    it("always allows the chosen assets and the focus asset", () => {
      for (const form of [valid({ type: "stat" }), valid({ type: "gauge" }), valid({ type: "table" }), kindBars(), energyStat({ compare: true })]) {
        expect(scopeAllowed(form, "fixed")).toBe(true);
        expect(scopeAllowed(form, "focus")).toBe(true);
      }
    });
    it("never lets the children of a text widget in", () => {
      expect(scopeAllowed(valid({ type: "text" }), "children")).toBe(false);
    });
  });

  describe("the repair when a change makes the scope invalid", () => {
    it("turns children into focus when the type becomes a stat or a gauge, and keeps it for a table and a bar chart", () => {
      const children = follows("children");
      expect(withType(children, "stat").scope).toBe("focus");
      expect(withType(children, "gauge").scope).toBe("focus");
      expect(withType(children, "table").scope).toBe("children");
      expect(withType(children, "bar").scope).toBe("children");
      expect(withType(children, "timeseries").scope).toBe("children");
    });
    it("leaves focus and fixed alone when the type changes", () => {
      for (const type of ["stat", "gauge", "table", "bar"] as const) {
        expect(withType(follows("focus"), type).scope, type).toBe("focus");
        expect(withType(valid(), type).scope, type).toBe("fixed");
      }
    });
    it("turns children into focus when a bar chart gets one bar per asset of a kind, and not for the other choices", () => {
      const children = follows("children", { type: "bar", source: "energy", aggregation: "sum" });
      expect(withBars(children, "kind")).toMatchObject({ bars: "kind", scope: "focus", assets: [] });
      expect(withBars(children, "time").scope).toBe("children");
      expect(withBars(children, "asset").scope).toBe("children");
    });
    it("turns children into focus when the comparison is ticked, and does not turn it back when it is unticked", () => {
      const children = follows("children", { source: "energy", aggregation: "sum" });
      const ticked = withCompare(children, true);
      expect(ticked).toMatchObject({ compare: true, range: "this_month", scope: "focus" });
      expect(withCompare(ticked, false, "7d")).toMatchObject({ compare: false, range: "7d", scope: "focus" });
    });
    it("keeps the scope when the comparison cannot be ticked", () => {
      const children = follows("children");
      expect(withCompare(children, true)).toBe(children); // a metric source: refused as before
    });
    it("keeps focus when a source change drops the comparison or the breakdown", () => {
      const on = follows("focus", { source: "energy", aggregation: "sum", compare: true, range: "this_month" });
      expect(withSource(on, "metric")).toMatchObject({ compare: false, scope: "focus" });
      // a bar chart by kind went back to one bar per asset: the scope focus is still valid
      expect(withSource(follows("focus", { type: "bar", bars: "kind", source: "energy", aggregation: "sum" }), "metric")).toMatchObject({ bars: "asset", scope: "focus" });
    });
    it("keeps the assets picked for the chosen-here scope while the widget follows, and finds them again", () => {
      const own = valid({ assets: [5, 6] });
      const away = withScope(own, "focus");
      expect(away).toMatchObject({ scope: "focus", assets: [5, 6] });
      expect(withScope(withScope(away, "children"), "fixed")).toMatchObject({ scope: "fixed", assets: [5, 6] });
    });
    it("refuses a scope the form cannot have, and returns the same form", () => {
      const stat = valid({ type: "stat", assets: [5] });
      expect(withScope(stat, "children")).toBe(stat);
      const bars = kindBars();
      expect(withScope(bars, "children")).toBe(bars);
    });
    it("looks under the focus (no root) once a breakdown by kind follows it, and a pick or Whole site brings the root back to a fixed widget", () => {
      const picked = kindBars({ root: 2 });
      expect(withScope(picked, "focus")).toMatchObject({ scope: "focus", root: null });
      expect(withRoot(withScope(picked, "focus"), 5)).toMatchObject({ scope: "fixed", root: 5 });
      expect(withRoot(withScope(picked, "focus"), null)).toMatchObject({ scope: "fixed", root: null });
      expect(withRoot(picked, null)).toMatchObject({ scope: "fixed", root: null });
    });
  });

  describe("formToFields", () => {
    it("leaves the key out of a fixed widget, whose config stays exactly what it was", () => {
      expect(formToFields(valid({ assets: [5, 6], range: "7d" }))).toEqual({
        type: "timeseries", title: "Hall power",
        config: { assets: [5, 6], source: "metric", metric: "active_power_kw", aggregation: "avg", range: "7d", bars: "asset", min: 0, max: null },
      });
      for (const form of [valid(), valid({ type: "stat" }), valid({ type: "table" }), kindBars(), energyStat({ compare: true, range: "this_month" })]) {
        expect(Object.keys(dataFields(form).config), form.type).not.toContain("scope");
      }
    });
    it("writes the scope and no assets for a widget that follows, even when the form still holds some", () => {
      expect(formToFields(valid({ scope: "focus", assets: [5, 6] }))).toEqual({
        type: "timeseries", title: "Hall power",
        config: { assets: [], source: "metric", metric: "active_power_kw", aggregation: "avg", range: null, bars: "asset", min: 0, max: null, scope: "focus" },
      });
      expect(dataFields(valid({ type: "table", scope: "children", assets: [5] })).config).toMatchObject({ assets: [], scope: "children" });
      expect(dataFields(valid({ type: "stat", scope: "focus", assets: [5] })).config).toMatchObject({ assets: [], scope: "focus" });
    });
    it("sends no root for a breakdown that looks under the focus, and keeps kind and top", () => {
      const config = dataFields(kindBars({ scope: "focus", root: 2, top: "25" })).config;
      expect(config).toMatchObject({ assets: [], bars: "kind", kind: "Rack", top: 25, scope: "focus" });
      expect(Object.keys(config)).not.toContain("root");
      expect(dataFields(kindBars({ scope: "fixed", root: 2 })).config).toMatchObject({ root: 2 });
    });
    it("writes the scope with the comparison", () => {
      expect(formToFields(energyStat({ scope: "focus", assets: [], compare: true, range: "this_month" }))).toEqual({
        type: "stat", title: "Hall power",
        config: { assets: [], source: "energy", metric: null, aggregation: "sum", range: "this_month", bars: "asset", min: 0, max: null, compare: "same_days_last_month", scope: "focus" },
      });
    });
    it("writes no scope for a text widget, whatever the form holds", () => {
      const fields = formToFields({ ...valid({ type: "text", style: "heading", text: "Power" }), scope: "focus" });
      expect(fields).toEqual({ type: "text", title: "Hall power", config: { style: "heading", text: "Power" } });
    });
    it("round-trips a saved widget of every type and scope, byte for byte", () => {
      const own = { assets: [] as number[], range: null, min: 0, max: null, bars: "asset" as const };
      const saved = [
        widget(1, "stat", { title: "Energy", config: config({ ...own, source: "energy", metric: null, aggregation: "sum", range: "this_month", compare: "same_days_last_month", scope: "focus" }) }),
        widget(2, "timeseries", { title: "Per child", config: config({ ...own, scope: "children" }) }),
        widget(3, "table", { title: "Table", config: config({ ...own, aggregation: "max", scope: "children" }) }),
        widget(4, "bar", { title: "Bars", config: config({ ...own, source: "cost", metric: null, aggregation: "sum", bars: "time", scope: "children" }) }),
        widget(5, "bar", { title: "Racks", config: config({ ...own, source: "energy", metric: null, aggregation: "sum", bars: "kind", kind: "Rack", top: 5, scope: "focus" }) }),
        widget(6, "gauge", { title: "Gauge", config: config({ ...own, aggregation: "last", min: 0, max: 100, scope: "focus" }) }),
        widget(7, "timeseries", { title: "Series", config: config({ ...own, scope: "focus" }) }),
      ];
      for (const w of saved) {
        expect(formToFields(formFromDraft(toDrafts([w])[0])), w.title).toEqual({ type: w.type, title: w.title, config: w.config });
      }
    });
    it("keeps the stored config of a fixed widget, whatever the scope key does around it", () => {
      const fixed = widget(1, "timeseries", { title: "Own", config: config({ assets: [5, 6] }) });
      const again = formToFields(formFromDraft(toDrafts([fixed])[0]));
      expect(again).toEqual({ type: "timeseries", title: "Own", config: fixed.config });
      expect(canonical(again.config)).toBe(canonical(fixed.config));
    });
  });

  describe("formIssues", () => {
    it("asks for no asset of a widget that follows", () => {
      expect(formIssues(follows("focus"))).toEqual({});
      expect(formIssues(follows("focus", { type: "stat" }))).toEqual({});
      expect(formIssues(follows("focus", { type: "gauge", aggregation: "last", gaugeMax: "100" }))).toEqual({});
      expect(formIssues(follows("children", { type: "table" }))).toEqual({});
      expect(formIssues(follows("children", { type: "bar" }))).toEqual({});
    });
    it("does not count the assets a following widget keeps for later", () => {
      expect(formIssues(follows("focus", { type: "stat", assets: [5, 6] }))).toEqual({});
      expect(formIssues(follows("children", { assets: Array.from({ length: 21 }, (_, i) => i + 1) }))).toEqual({});
    });
    it("keeps the fixed messages exactly", () => {
      expect(formIssues(valid({ assets: [] }))).toEqual({ assets: "Choose at least one asset." });
      expect(formIssues(valid({ type: "stat", assets: [] }))).toEqual({ assets: "Choose an asset." });
      expect(formIssues(valid({ type: "stat", assets: [5, 6] }))).toEqual({ assets: "A stat shows one asset." });
      expect(formIssues(valid({ scope: "fixed", assets: Array.from({ length: 21 }, (_, i) => i + 1) }))).toEqual({ assets: "At most 20 assets." });
      expect(formIssues(energyStat({ compare: true, range: "this_month", assets: [] }))).toEqual({ compare: "A comparison needs exactly one asset." });
    });
    it("keeps the title and the other rules for a widget that follows", () => {
      expect(formIssues(follows("focus", { title: "" }))).toEqual({ title: "Enter a title." });
      expect(formIssues(follows("focus", { type: "gauge", aggregation: "last", gaugeMax: "" }))).toEqual({ gauge: "Enter a number for the gauge minimum and maximum." });
      expect(formIssues(follows("focus", { source: "energy", aggregation: "avg" }))).toEqual({ aggregation: "Energy and cost are totals; choose total." });
    });
    it("keeps the comparison's range rule but not its asset count for a widget that follows", () => {
      expect(formIssues(follows("focus", { type: "stat", source: "energy", aggregation: "sum", compare: true, range: "this_month" }))).toEqual({});
      expect(formIssues(follows("focus", { type: "stat", source: "energy", aggregation: "sum", compare: true, range: "7d" })))
        .toEqual({ compare: "A comparison looks at this month, so the widget range must be This month." });
      expect(formIssues(follows("focus", { type: "timeseries", source: "cost", aggregation: "sum", compare: true, range: "" })))
        .toEqual({ compare: "A comparison looks at this month, so the widget range must be This month." });
    });
    it("needs no root for a breakdown under the focus, and still asks for the kind and the number of bars", () => {
      expect(formIssues(kindBars({ scope: "focus", root: null }))).toEqual({});
      expect(formIssues(kindBars({ scope: "focus", kind: "" }))).toEqual({ bars: "Enter the kind of asset to draw one bar for." });
      expect(formIssues(kindBars({ scope: "focus", top: "2" }))).toEqual({ top: "Bars to show must be a whole number from 3 to 50." });
    });
    it("refuses the children where they are not shown, for a form built by hand", () => {
      const message = "Only a time series, a table or a bar chart per asset or per time bucket can show the children of the focus asset, and not with the comparison.";
      expect(formIssues(follows("children", { type: "stat" }))).toEqual({ scope: message });
      expect(formIssues(follows("children", { type: "gauge", aggregation: "last", gaugeMax: "100" }))).toEqual({ scope: message });
      expect(formIssues(kindBars({ scope: "children" }))).toEqual({ scope: message });
      expect(formIssues(follows("children", { source: "energy", aggregation: "sum", compare: true, range: "this_month" }))).toEqual({ scope: message });
    });
  });
});
