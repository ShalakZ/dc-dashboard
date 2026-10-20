import {
  breakdownBlock, breakdownData, compareAsset, compareBlock, compareChange, compareSeriesData, compareSide, compareStatData, seriesData, seriesPoint, valueRow, valuesData,
} from "../test/dashboardFixtures";
import { familyOf, pickScale } from "./figures";
import {
  ageText, cardFigureOrNoData, chartLabels, escapeHtml, figureOrNoData, figureText, flagsOf, formatValue, labelBucket, markerHint, noMetricText, removedText, shortLabel,
  shortLabels, sinceText, skeletonShape, uniqueLabels, unitSuffix,
} from "./widgetFormat";

const none = { estimated: false, partial: false };

describe("figureText is the exact face (w27)", () => {
  it("groups the digits and keeps two decimals, never scaling: 1,234.50 and ~275,430.26", () => {
    expect(figureText(1234.5, none)).toBe("1,234.50");
    expect(figureText(275430.2575, { estimated: true, partial: false })).toBe("~275,430.26");
    expect(figureText(-1234.5, none)).toBe("-1,234.50");
    expect(figureText(1234567.891, { estimated: false, partial: true })).toBe("1,234,567.89*");
  });
  it("prints a zero without a minus and a non-number as the dash", () => {
    expect(figureText(-0.004, none)).toBe("0.00");
    expect(figureText(Number.NaN, none)).toBe("—");
    expect(figureText(Number.POSITIVE_INFINITY, { estimated: true, partial: true })).toBe("—");
  });
});

describe("cardFigureOrNoData is the card face of figureOrNoData (w27)", () => {
  const kwh = (value: number) => pickScale(familyOf("kWh", "energy"), "kWh", [value]);
  it("scales a figure, keeps its marks and puts no unit behind it", () => {
    expect(cardFigureOrNoData(275430.2575, { estimated: true, partial: false }, false, "energy", kwh(275430.2575))).toBe("~275.43");
    expect(cardFigureOrNoData(33051.6309, none, false, "energy", kwh(33051.6309))).toBe("33,052");
    expect(cardFigureOrNoData(275430.26, { estimated: false, partial: true }, false, "cost", pickScale("cost", "QAR", [275430.26]))).toBe("275.43k*");
  });
  it("says 'no data' for a metric that recorded nothing and the dash for any other missing figure, with no scaling", () => {
    expect(cardFigureOrNoData(null, none, true, "metric", kwh(0))).toBe("no data");
    expect(cardFigureOrNoData(null, none, false, "metric", kwh(0))).toBe("—");
    expect(cardFigureOrNoData(null, none, true, "cost", pickScale("cost", "QAR", [0]))).toBe("—");
    expect(cardFigureOrNoData(Number.NaN, none, false, "energy", kwh(0))).toBe("—");
  });
  it("shows a muted zero as a figure, as figureOrNoData does", () => {
    expect(cardFigureOrNoData(0, none, true, "energy", kwh(0))).toBe("0.00");
  });
});

describe("figureText", () => {
  it("shows two decimals, ~ in front of an estimated figure and * behind a partial one", () => {
    expect(figureText(12.3, none)).toBe("12.30");
    expect(figureText(12.3, { estimated: true, partial: false })).toBe("~12.30");
    expect(figureText(12.3, { estimated: false, partial: true })).toBe("12.30*");
    expect(figureText(0, { estimated: true, partial: true })).toBe("~0.00*");
  });
  it("shows a dash for a missing figure, never a zero and never a marker", () => {
    expect(figureText(null, { estimated: true, partial: true })).toBe("—");
    expect(figureText(undefined, none)).toBe("—");
    expect(formatValue(null)).toBe("—");
    expect(formatValue(3)).toBe("3.00");
  });
});

describe("figureOrNoData", () => {
  it("says 'no data' for a metric that recorded nothing, and keeps the dash for everything else that is missing", () => {
    expect(figureOrNoData(null, none, true, "metric")).toBe("no data");
    expect(figureOrNoData(null, none, true, "energy")).toBe("no data");
    expect(figureOrNoData(null, none, false, "metric")).toBe("—");
    expect(figureOrNoData(null, none, true, "cost")).toBe("—"); // a cost without a rate is a dash, recorded or not
    expect(figureOrNoData(null, none, false, "cost")).toBe("—");
  });
  it("shows a figure as figureText does, even when it recorded nothing (a muted zero)", () => {
    expect(figureOrNoData(0, none, true, "energy")).toBe("0.00");
    expect(figureOrNoData(2.5, { estimated: true, partial: true }, false, "cost")).toBe("~2.50*");
  });
});

describe("markers and labels", () => {
  it("explains the markers that are present", () => {
    expect(markerHint(none)).toBe("");
    expect(markerHint({ estimated: true, partial: false })).toBe("~ estimated");
    expect(markerHint({ estimated: true, partial: true })).toBe("~ estimated, * partial, some hours have no rate");
  });
  it("explains the dash of a figure that has no rate, last and only when there is one", () => {
    expect(markerHint({ ...none, noRate: false })).toBe("");
    expect(markerHint({ ...none, noRate: true })).toBe("— no rate");
    expect(markerHint({ estimated: true, partial: true, noRate: true })).toBe("~ estimated, * partial, some hours have no rate, — no rate");
  });
  it("words the removed-assets and the no-metric chips with correct plurals", () => {
    expect(removedText(1)).toBe("1 asset removed");
    expect(removedText(2)).toBe("2 assets removed");
    expect(noMetricText(1)).toBe("1 asset without this metric");
    expect(noMetricText(3)).toBe("3 assets without this metric");
  });
  it("appends the unit only when there is one", () => {
    expect(unitSuffix("kW")).toBe(" kW");
    expect(unitSuffix(null)).toBe("");
    expect(unitSuffix("")).toBe(""); // power factor has an empty unit
  });
  it("tells apart assets with the same name by id, and marks estimated and partial series", () => {
    const rows = [
      { asset_id: 1, name: "Panel", estimated: false, partial: false },
      { asset_id: 2, name: "Panel", estimated: true, partial: false },
      { asset_id: 3, name: "Main", estimated: false, partial: true },
    ];
    expect(uniqueLabels(rows)).toEqual(["Panel (#1)", "Panel (#2)", "Main"]);
    expect(chartLabels(rows)).toEqual(["Panel (#1)", "Panel (#2) ~", "Main *"]);
  });
  it("escapes HTML, because asset names are typed by users and ECharts renders tooltip text as HTML", () => {
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe("&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;");
  });
});

describe("flagsOf", () => {
  it("is true for a marker when any series or any value carries it", () => {
    expect(flagsOf(seriesData())).toEqual({ estimated: false, partial: false, noRate: false });
    const series = seriesData().series;
    expect(flagsOf(seriesData({ series: [{ ...series[0], estimated: true }, { ...series[0], asset_id: 6, partial: true }] }))).toEqual({ estimated: true, partial: true, noRate: false });
    expect(flagsOf(valuesData({ values: [valueRow(), valueRow({ asset_id: 6, estimated: true })] }))).toEqual({ estimated: true, partial: false, noRate: false });
  });

  describe("noRate: a cost figure that is null although something was recorded", () => {
    const cost = (points: ReturnType<typeof seriesPoint>[]) => seriesData({
      source: "cost", metric: null, unit: "QAR", bucket: "hour", tier: null,
      series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points }],
    });
    const at = (hour: number) => `2026-10-08T0${hour}:00:00+00:00`;

    it("is set when any bucket of a cost series is null and not silent, even if every other bucket has a figure", () => {
      expect(flagsOf(cost([seriesPoint({ ts: at(0), value: null }), seriesPoint({ ts: at(1), value: null })])).noRate).toBe(true);
      expect(flagsOf(cost([seriesPoint({ ts: at(0), value: 2 }), seriesPoint({ ts: at(1), value: null })])).noRate).toBe(true);
    });

    it("is not set when every cost bucket has a figure, or when the null buckets recorded nothing (no_data)", () => {
      expect(flagsOf(cost([seriesPoint({ ts: at(0), value: 2 }), seriesPoint({ ts: at(1), value: 0 })])).noRate).toBe(false);
      expect(flagsOf(cost([seriesPoint({ ts: at(0), value: 2 }), seriesPoint({ ts: at(1), value: null, no_data: true })])).noRate).toBe(false);
    });

    it("is set by a cost value row without a rate, whether or not it also recorded nothing, and by none of a metric's or energy's missing figures", () => {
      expect(flagsOf(valuesData({ source: "cost", metric: null, values: [valueRow({ value: 3 }), valueRow({ asset_id: 6, value: null })] })).noRate).toBe(true);
      // a value row is drawn as a dash whenever its cost is null (bar per asset, stat, table), so null alone means "no rate"
      expect(flagsOf(valuesData({ source: "cost", metric: null, values: [valueRow({ value: null, no_data: true })] })).noRate).toBe(true);
      expect(flagsOf(valuesData({ source: "cost", metric: null, values: [valueRow({ value: 0, no_data: true })] })).noRate).toBe(false);
      expect(flagsOf(valuesData({ source: "metric", values: [valueRow({ value: null })] })).noRate).toBe(false);
      expect(flagsOf(valuesData({ source: "energy", metric: null, values: [valueRow({ value: null })] })).noRate).toBe(false);
    });
  });
});

describe("ageText", () => {
  const now = Date.parse("2026-10-08T10:00:00Z");
  it("says how long ago a reading was taken, from an instant with any offset", () => {
    expect(ageText("2026-10-08T09:59:40Z", now)).toBe("just now");
    expect(ageText("2026-10-08T09:48:00Z", now)).toBe("12 min ago");
    expect(ageText("2026-10-08T12:48:00.000000+03:00", now)).toBe("12 min ago");
    expect(ageText("2026-10-08T07:00:00Z", now)).toBe("3 h ago");
    expect(ageText("2026-10-06T10:00:00Z", now)).toBe("2 d ago");
  });
  it("shows nothing for a time it cannot read, and 'just now' for a reading from the future (clock skew)", () => {
    expect(ageText("nonsense", now)).toBe("");
    expect(ageText("2026-10-08T10:00:30Z", now)).toBe("just now");
  });
});

describe("time labels derived from the range", () => {
  const range = (start: string, end: string) => ({ preset: "24h" as const, start, end });
  it("prints the date once the window is longer than a day and the response gives no bucket", () => {
    expect(labelBucket({ bucket: null, range: range("2026-10-07T06:00:00Z", "2026-10-08T06:00:00Z") })).toBeNull();
    expect(labelBucket({ bucket: null, range: range("2026-10-01T06:00:00Z", "2026-10-08T06:00:00Z") })).toBe("hour");
    expect(labelBucket({ bucket: "day", range: range("2026-10-07T06:00:00Z", "2026-10-08T06:00:00Z") })).toBe("day");
    expect(labelBucket({ bucket: "hour", range: range("2026-10-07T06:00:00Z", "2026-10-08T06:00:00Z") })).toBe("hour");
  });
  it("says since when in the site zone, with the date for a window longer than a day", () => {
    expect(sinceText("2026-10-08T10:00:00+03:00", "2026-10-08T10:30:00+03:00", "Asia/Qatar")).toBe("since 10:00");
    expect(sinceText("2026-10-01T11:00:00+03:00", "2026-10-08T10:30:00+03:00", "Asia/Qatar")).toBe("since 10-01 11:00");
  });
});

describe("series points", () => {
  it("builds a point with every flag defaulted (fixture sanity)", () => {
    expect(seriesPoint({ ts: "2026-10-08T00:00:00Z" })).toMatchObject({ value: null, estimated: false, partial: false, no_data: false });
  });
});

describe("shortLabel", () => {
  const long = "Main-Switchboard-Feeder-Room-East-Hall-3"; // 40 characters
  it("leaves a label that fits unchanged", () => {
    expect(shortLabel("Hall A", 24)).toBe("Hall A");
    expect(shortLabel("x".repeat(24), 24)).toBe("x".repeat(24));
  });
  it("cuts a long name in the middle to exactly max characters, keeping the start and the end", () => {
    expect(long).toHaveLength(40);
    const short = shortLabel(long, 24);
    expect(Array.from(short)).toHaveLength(24);
    expect(short).toBe(`${long.slice(0, 16)}…${long.slice(-7)}`);
    expect(short.startsWith("Main-Switchboard")).toBe(true);
    expect(short).toContain("…");
  });
  it("keeps the (#id) and the ~ and * markers whole, so two names that differ only there stay different (review M5)", () => {
    const a = shortLabel("MV2-R2-LV-Panel-02 (#12) ~ *", 18);
    const b = shortLabel("MV2-R2-LV-Panel-02 (#13) ~ *", 18);
    expect(a).not.toBe(b);
    expect(a.endsWith(" (#12) ~ *")).toBe(true);
    expect(b.endsWith(" (#13) ~ *")).toBe(true);
    expect(Array.from(a)).toHaveLength(18);
    const c = shortLabel("Main-Switchboard-Feeder-Room-East (#112)", 24);
    const d = shortLabel("Main-Switchboard-Feeder-Room-East (#212)", 24);
    expect(c).not.toBe(d);
    expect(c.endsWith(" (#112)")).toBe(true);
  });
  it("keeps a lone ~ or * suffix", () => {
    expect(shortLabel("A-very-long-name-that-goes-on-and-on ~", 24).endsWith(" ~")).toBe(true);
    expect(shortLabel("A-very-long-name-that-goes-on-and-on *", 24).endsWith(" *")).toBe(true);
    expect(shortLabel("A-very-long-name-that-goes-on-and-on ~ *", 24).endsWith(" ~ *")).toBe(true);
  });
  it("shortens the whole label when the suffix leaves too little room for the name", () => {
    const short = shortLabel("Switchboard-East-Wing (#123456) ~ *", 12);
    expect(Array.from(short)).toHaveLength(12);
    expect(short).toContain("…");
  });
  it("does not split an emoji or another surrogate pair", () => {
    const short = shortLabel("😀".repeat(30), 10);
    expect(Array.from(short)).toHaveLength(10);
    expect(Array.from(short).every((c) => c === "…" || c === "😀")).toBe(true);
  });
  it("does not throw for a max below 4", () => {
    for (const max of [3, 2, 1, 0]) expect(typeof shortLabel(long, max)).toBe("string");
  });
});

describe("shortLabels", () => {
  it("keeps the FULL label of every label whose short form is shared, and shortens the rest", () => {
    const a = "Main-Switchboard-Feeder-01-Room-East";
    const b = "Main-Switchboard-Feeder-02-Room-East";
    expect(shortLabel(a, 18)).toBe(shortLabel(b, 18)); // the trap this guards against
    const third = "Generator-Hall-Battery-Bank-A";
    const short = shortLabels([a, b, third, "Hall A"], 18);
    expect(short.get(a)).toBe(a);
    expect(short.get(b)).toBe(b);
    expect(short.get(third)).toBe(shortLabel(third, 18));
    expect(Array.from(short.get(third)!)).toHaveLength(18);
    expect(short.get("Hall A")).toBe("Hall A");
  });
});

describe("flagsOf, a comparison and a breakdown (w24)", () => {
  const withSides = (source: "energy" | "cost", this_: Partial<ReturnType<typeof compareSide>>, last: Partial<ReturnType<typeof compareSide>>) =>
    compareStatData({ source, compare: compareBlock({ assets: [compareAsset({ this: compareSide(this_), last: compareSide(last) })] }) });

  it("has no marker for a plain comparison", () => {
    expect(flagsOf(compareStatData())).toEqual({ estimated: false, partial: false, noRate: false });
  });

  it("finds an estimate on either side, so the footer explains the ~ the card draws", () => {
    expect(flagsOf(withSides("energy", { estimated: true }, {})).estimated).toBe(true);
    expect(flagsOf(withSides("energy", {}, { estimated: true })).estimated).toBe(true);
  });

  it("counts a partial side only on a cost widget (an energy card draws no star)", () => {
    expect(flagsOf(withSides("cost", { partial: true }, {})).partial).toBe(true);
    expect(flagsOf(withSides("energy", { partial: true }, { partial: true })).partial).toBe(false);
  });

  it("finds a missing rate on a cost side that had readings, not on one with none", () => {
    expect(flagsOf(withSides("cost", { cost: null }, {})).noRate).toBe(true);
    expect(flagsOf(withSides("cost", { cost: null, no_data_days: 17 }, {})).noRate).toBe(false);
    expect(flagsOf(withSides("energy", { cost: null }, {})).noRate).toBe(false);
  });

  describe("a currency change after a close is not a missing rate (w24 review C-1)", () => {
    const currency = { cost: compareChange({ why_none: "currency" }) };
    const withAsset = (source: "energy" | "cost", over: Parameters<typeof compareAsset>[0]) =>
      compareStatData({ source, compare: compareBlock({ assets: [compareAsset(over)] }) });
    const gone = { last: compareSide({ cost: null }), ...currency };

    it("raises no noRate flag for last month's side that was taken away, and the footer and the markers say nothing of a rate", () => {
      const data = withAsset("cost", gone);
      expect(flagsOf(data)).toEqual({ estimated: false, partial: false, noRate: false });
      expect(markerHint(flagsOf(data))).toBe("");
    });

    it("raises none for last month's daily points that were taken away either (value null, not no_data)", () => {
      const data = compareSeriesData(2, 2, { source: "cost" });
      data.compare!.assets[0] = { ...data.compare!.assets[0], ...gone, last_points: data.compare!.assets[0].last_points.map((p) => ({ ...p, value: null, no_data: false })) };
      expect(flagsOf(data).noRate).toBe(false);
      expect(markerHint(flagsOf(data))).not.toContain("no rate");
    });

    it("leaves the marks of the removed side out too: a dash carries none, and the footer's partial words speak of a rate", () => {
      const data = withAsset("cost", { last: compareSide({ cost: null, estimated: true, partial: true }), ...currency });
      expect(flagsOf(data)).toEqual({ estimated: false, partial: false, noRate: false });
    });

    it("keeps the kWh marks of last month on an energy widget (its kWh are real)", () => {
      expect(flagsOf(withAsset("energy", { last: compareSide({ estimated: true }), ...currency })).estimated).toBe(true);
    });

    it("still raises noRate for a side whose cost lacks a rate (why_none no_cost)", () => {
      const data = withAsset("cost", { last: compareSide({ cost: null }), cost: compareChange({ why_none: "no_cost" }) });
      expect(flagsOf(data).noRate).toBe(true);
      expect(markerHint(flagsOf(data))).toBe("— no rate");
    });

    it("still raises it for last month's points of a cost with no rate (no_cost), and for this month's side or points when the currency changed too", () => {
      const series = compareSeriesData(2, 2, { source: "cost" });
      series.compare!.assets[0] = { ...series.compare!.assets[0], cost: compareChange({ why_none: "no_cost" }) };
      series.compare!.assets[0].last_points[0] = seriesPoint({ ts: "2026-09-01T00:00:00+03:00", value: null });
      expect(flagsOf(series).noRate).toBe(true);

      const both = withAsset("cost", { this: compareSide({ cost: null }), ...gone });
      expect(flagsOf(both).noRate).toBe(true); // this month has readings but no cost: that rate really is missing
      const bothSeries = compareSeriesData(2, 2, { source: "cost" });
      bothSeries.compare!.assets[0] = { ...bothSeries.compare!.assets[0], ...gone, last_points: bothSeries.compare!.assets[0].last_points.map((p) => ({ ...p, value: null, no_data: false })) };
      expect(flagsOf(bothSeries).noRate).toBe(false);
      bothSeries.series[0].points[1] = seriesPoint({ ts: "2026-10-02T00:00:00+03:00", value: null });
      expect(flagsOf(bothSeries).noRate).toBe(true);
    });
  });

  it("reads last month's daily points too", () => {
    const data = compareSeriesData(2, 2);
    data.compare!.assets[0].last_points[1] = seriesPoint({ ts: "2026-09-02T00:00:00+03:00", value: 5, estimated: true });
    expect(flagsOf(data).estimated).toBe(true);
    const cost = compareSeriesData(2, 2, { source: "cost" });
    cost.compare!.assets[0].last_points[0] = seriesPoint({ ts: "2026-09-01T00:00:00+03:00", value: null });
    expect(flagsOf(cost).noRate).toBe(true);
  });

  it("a cost breakdown's bar that recorded nothing is no data, not a missing rate (a plain cost widget keeps its rule)", () => {
    const silent = valueRow({ asset_id: 90, name: "Electrical", value: null, no_data: true, point_id: null });
    const cost = breakdownData(2, { source: "cost", unit: "USD" });
    cost.values.push(silent);
    expect(flagsOf(cost).noRate).toBe(false);
    cost.values.push(valueRow({ asset_id: 91, name: "Unrated", value: null, no_data: false, point_id: null })); // readings, no rate: still a missing rate
    expect(flagsOf(cost).noRate).toBe(true);
    const plain = valuesData({ source: "cost", unit: "USD", values: [silent] });
    expect(flagsOf(plain).noRate).toBe(true); // without a breakdown the existing rule stands
  });

  it("finds the marks of the bars a breakdown left out", () => {
    expect(flagsOf(breakdownData())).toEqual({ estimated: false, partial: false, noRate: false });
    const more = { count: 4, with_value: 4, value: 9, estimated: true, partial: true };
    expect(flagsOf(breakdownData(3, { breakdown: breakdownBlock({ more }) }))).toEqual({ estimated: true, partial: true, noRate: false });
  });
});

describe("skeletonShape", () => {
  it("is a comparing stat, a comparing chart, or a breakdown by kind, and nothing for a plain widget", () => {
    expect(skeletonShape("stat", { compare: "same_days_last_month", bars: "asset" })).toBe("compare-stat");
    expect(skeletonShape("timeseries", { compare: "same_days_last_month", bars: "asset" })).toBe("compare-chart");
    expect(skeletonShape("bar", { bars: "kind" })).toBe("kind-bars");
    expect(skeletonShape("stat", { bars: "asset" })).toBeUndefined();
    expect(skeletonShape("stat", { compare: "none", bars: "asset" })).toBeUndefined();
    expect(skeletonShape("bar", { bars: "asset" })).toBeUndefined();
    expect(skeletonShape("table", { compare: "same_days_last_month", bars: "asset" })).toBeUndefined();
  });
});
