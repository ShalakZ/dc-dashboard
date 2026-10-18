import type { WidgetConfig, WidgetData, WidgetPoint, WidgetSeries } from "../api/types";
import { config, seriesData, seriesPoint, valueRow, valuesData } from "../test/dashboardFixtures";
import {
  aggregationWords, assetRows, bucketStartText, chartDescription, figuresText, freshnessLine, isLatestReading, markerMeanings,
  noMetricIds, preciseAge, rangeWords, removedCount, seriesSummary, sourceWords, windowText,
} from "./widgetDetails";
import { figureText } from "./widgetFormat";

const TZ = "Asia/Qatar";
const NOW = Date.parse("2026-10-17T12:04:40+03:00"); // 12:04:40 in Qatar, 09:04:40 UTC
const at = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();

describe("preciseAge", () => {
  it("says just now under five seconds, and for a reading a little ahead of this clock", () => {
    expect(preciseAge(at(0), NOW)).toBe("just now");
    expect(preciseAge(at(4), NOW)).toBe("just now");
    expect(preciseAge(at(-30), NOW)).toBe("just now");
  });
  it("counts seconds under a minute, then minutes under an hour", () => {
    expect(preciseAge(at(5), NOW)).toBe("5 s ago");
    expect(preciseAge(at(59), NOW)).toBe("59 s ago");
    expect(preciseAge(at(60), NOW)).toBe("1 min ago");
    expect(preciseAge(at(3599), NOW)).toBe("59 min ago");
  });
  it("counts hours and minutes under a day (hours alone when the minutes are 0), then days", () => {
    expect(preciseAge(at(3600), NOW)).toBe("1 h ago");
    expect(preciseAge(at(3660), NOW)).toBe("1 h 1 min ago");
    expect(preciseAge(at(86_399), NOW)).toBe("23 h 59 min ago");
    expect(preciseAge(at(86_400), NOW)).toBe("1 d ago");
    expect(preciseAge(at(3 * 86_400 + 5000), NOW)).toBe("3 d ago");
  });
  it("is empty for a time it cannot read", () => {
    expect(preciseAge("not a time", NOW)).toBe("");
    expect(preciseAge("", NOW)).toBe("");
  });
});

describe("freshnessLine", () => {
  it("live: the site clock with the age, no date on the site's own day", () => {
    expect(freshnessLine(at(9), NOW, TZ, false, true)).toBe("Last reading 12:04:31 (9 s ago)");
    expect(freshnessLine(at(2), NOW, TZ, false, true)).toBe("Last reading 12:04:38 (just now)");
  });
  it("live: the date too when the reading is not from the site's today", () => {
    expect(freshnessLine(at(13 * 3600 + 5 * 60), NOW, TZ, false, true)).toBe("Last reading 2026-10-16 22:59:40 (13 h 5 min ago)");
    // 00:30 in Qatar is still the 16th in UTC: the day is the site's, not the browser's
    const justAfterMidnight = Date.parse("2026-10-17T00:30:00+03:00");
    expect(freshnessLine("2026-10-16T23:59:50+03:00", justAfterMidnight, TZ, false, true)).toBe("Last reading 2026-10-16 23:59:50 (30 min ago)");
    expect(freshnessLine("2026-10-17T00:10:00+03:00", justAfterMidnight, TZ, false, true)).toBe("Last reading 00:10:00 (20 min ago)");
  });
  it("live: says so when no reading time was recorded", () => {
    expect(freshnessLine(null, NOW, TZ, false, true)).toBe("No reading time recorded");
    expect(freshnessLine("not a time", NOW, TZ, false, true)).toBe("No reading time recorded");
  });
  it("live and stale: adds the stale sentence", () => {
    expect(freshnessLine(at(47 * 60), NOW, TZ, true, true))
      .toBe("Last reading 11:17:40 (47 min ago) Stale: older than three polling intervals of its meter (and at least a minute).");
  });
  it("not live: the hour the last value belongs to, with no seconds, no age and never stale", () => {
    // the backend gives the START of the hour of the hourly roll-up row
    const line = freshnessLine("2026-10-16T23:00:00+03:00", NOW, TZ, true, false);
    expect(line).toBe("Last value of the hour from 10-16 23:00 (hourly roll-up)");
    expect(line).not.toMatch(/stale|ago|:00:00/i);
  });
  it("not live: the hour carries its date, so a last month's value says which day it is from", () => {
    // Yesterday's last hour, and the last hour of last month (23:00 Qatar is 20:00 UTC: the date is the site's)
    expect(freshnessLine("2026-10-16T23:00:00+03:00", NOW, TZ, false, false)).toBe("Last value of the hour from 10-16 23:00 (hourly roll-up)");
    expect(freshnessLine("2026-09-30T23:00:00+03:00", NOW, TZ, false, false)).toBe("Last value of the hour from 09-30 23:00 (hourly roll-up)");
    expect(freshnessLine("2026-09-12T08:00:00+03:00", NOW, TZ, false, false)).toBe("Last value of the hour from 09-12 08:00 (hourly roll-up)");
  });
  it("not live: no reading time recorded still has its own words", () => {
    expect(freshnessLine(null, NOW, TZ, false, false)).toBe("No reading time recorded");
  });
});

describe("isLatestReading", () => {
  const last: Pick<WidgetConfig, "source" | "aggregation"> = { source: "metric", aggregation: "last" };
  const data = (preset: WidgetData["range"]["preset"]) => valuesData({ range: { ...valuesData().range, preset } });
  it("is true for the latest metric reading of a range that ends now, whatever the widget type", () => {
    for (const preset of ["1h", "6h", "24h", "7d", "30d", "today", "this_month"] as const) expect(isLatestReading(data(preset), last)).toBe(true);
  });
  it("is false for a finished range (the backend then answers with the last hourly value), another source or another aggregation", () => {
    expect(isLatestReading(data("yesterday"), last)).toBe(false);
    expect(isLatestReading(data("last_month"), last)).toBe(false);
    expect(isLatestReading(data("24h"), { source: "metric", aggregation: "avg" })).toBe(false);
    expect(isLatestReading({ ...data("24h"), source: "energy" }, { source: "energy", aggregation: "sum" })).toBe(false);
  });
});

describe("windowText and rangeWords", () => {
  it("shows the real start and end to the minute with the site time zone name", () => {
    const range = { preset: "24h", start: "2026-10-17T07:46:00+00:00", end: "2026-10-18T07:46:00+00:00" } as const;
    expect(windowText(range, TZ)).toBe("2026-10-17 10:46 to 2026-10-18 10:46 (Asia/Qatar)");
  });
  it("takes the preset words from the range labels", () => {
    expect(rangeWords("24h")).toBe("Last 24 hours");
    expect(rangeWords("last_month")).toBe("Last month");
  });
});

const timeseries = (over: Partial<WidgetData> = {}): WidgetData => seriesData(over);
const energySeries = (bucket: "hour" | "day", points: WidgetPoint[], series: Partial<WidgetSeries> = {}, over: Partial<WidgetData> = {}): WidgetData =>
  seriesData({
    type: "timeseries", source: "energy", metric: null, unit: "kWh", tier: null, bucket,
    series: [{ asset_id: 5, name: "LV Panel 1", estimated: false, partial: false, points, ...series }], ...over,
  });
const metricBar = (over: Partial<WidgetData> = {}): WidgetData => seriesData({ type: "bar", tier: "1h", bucket: "hour", ...over });
const cfg = (over: Partial<WidgetConfig> = {}): WidgetConfig => config(over);

describe("figuresText", () => {
  it("values mode: one figure per asset over the whole window", () => {
    expect(figuresText(valuesData({ type: "bar", source: "energy", metric: null, unit: "kWh" }), cfg({ source: "energy", metric: null, aggregation: "sum" })))
      .toBe("One figure per asset over the whole window");
    expect(figuresText(valuesData({ type: "table" }), cfg({ aggregation: "max" }))).toBe("One figure per asset over the whole window");
  });
  it("values mode: a latest reading of a range that ends now is said to be the latest reading", () => {
    expect(figuresText(valuesData({ type: "stat" }), cfg({ aggregation: "last" }))).toBe("The latest reading of each asset");
    expect(figuresText(valuesData({ type: "table" }), cfg({ aggregation: "last" }))).toBe("The latest reading of each asset");
  });
  it("values mode: a finished range gives the last hourly value, not a latest reading", () => {
    const data = valuesData({ type: "stat", range: { ...valuesData().range, preset: "yesterday" } });
    expect(figuresText(data, cfg({ aggregation: "last" }))).toBe("One figure per asset: the last value in the window (hourly roll-up)");
  });
  it("energy and cost series: one value per hour or per day, never a bucket width", () => {
    expect(figuresText(energySeries("hour", []), cfg({ source: "energy", metric: null, aggregation: "sum" }))).toBe("One value per hour");
    expect(figuresText(energySeries("day", []), cfg({ source: "energy", metric: null, aggregation: "sum" }))).toBe("One value per day");
  });
  it("a metric time series is always averages, from the tier that served it, and never says a bucket width", () => {
    const sum = cfg({ aggregation: "avg" });
    expect(figuresText(timeseries({ tier: "1m" }), sum)).toBe("Averages of the stored readings (the 1-minute roll-up)");
    expect(figuresText(timeseries({ tier: "1h" }), sum)).toBe("Averages of the stored readings (the hourly roll-up)");
    expect(figuresText(timeseries({ tier: "raw" }), sum)).toBe("Averages of the stored readings (the raw readings)");
    expect(figuresText(timeseries({ tier: null }), sum)).toBe("Averages of the stored readings");
    // the tier names a stored table; a width such as "5-minute buckets" or "every 288 s" is never claimed
    for (const tier of ["raw", "1m", "1h", null] as const) {
      expect(figuresText(timeseries({ tier }), sum)).not.toMatch(/per \d|every \d|\d+-?(second|minute|hour)\b(?! roll-up)|bucket/i);
    }
  });
  it("a metric time series ignores the saved aggregation: the editor saves 'last' for some metrics and the answer is still averages", () => {
    expect(figuresText(timeseries({ tier: "1m" }), cfg({ aggregation: "last" }))).toBe("Averages of the stored readings (the 1-minute roll-up)");
    expect(figuresText(timeseries({ tier: "1m" }), cfg({ aggregation: "max" }))).toBe("Averages of the stored readings (the 1-minute roll-up)");
  });
  it("a metric bar over time is one value per hour or day: the saved aggregation inside each, from the hourly roll-up", () => {
    expect(figuresText(metricBar(), cfg({ aggregation: "max", bars: "time" }))).toBe("One value per hour: the highest inside each (the hourly roll-up)");
    expect(figuresText(metricBar({ bucket: "day" }), cfg({ aggregation: "min", bars: "time" }))).toBe("One value per day: the lowest inside each (the hourly roll-up)");
    expect(figuresText(metricBar(), cfg({ aggregation: "avg", bars: "time" }))).toBe("One value per hour: the average inside each (the hourly roll-up)");
    expect(figuresText(metricBar(), cfg({ aggregation: "last", bars: "time" }))).toBe("One value per hour: the last value inside each (the hourly roll-up)");
  });
});

describe("aggregationWords", () => {
  it("a metric time series is always the average of each bucket with a band, whatever the saved aggregation says", () => {
    const words = "Average of each bucket, with the lowest and highest as a band";
    for (const aggregation of ["avg", "min", "max", "last"] as const) expect(aggregationWords("timeseries", timeseries(), cfg({ aggregation }))).toBe(words);
  });
  it("energy and cost series are totals per hour or per day", () => {
    const c = cfg({ source: "energy", metric: null, aggregation: "sum" });
    expect(aggregationWords("timeseries", energySeries("hour", []), c)).toBe("Total per hour");
    expect(aggregationWords("bar", energySeries("day", []), c)).toBe("Total per day");
    expect(aggregationWords("bar", energySeries("hour", [], {}, { source: "cost", unit: "QAR" }), { ...c, source: "cost" })).toBe("Total per hour");
  });
  it("a metric bar over time says which figure of each hour or day it draws", () => {
    expect(aggregationWords("bar", metricBar(), cfg({ aggregation: "last", bars: "time" }))).toBe("Latest per hour");
    expect(aggregationWords("bar", metricBar(), cfg({ aggregation: "avg", bars: "time" }))).toBe("Average per hour");
    expect(aggregationWords("bar", metricBar(), cfg({ aggregation: "min", bars: "time" }))).toBe("Lowest per hour");
    expect(aggregationWords("bar", metricBar({ bucket: "day" }), cfg({ aggregation: "max", bars: "time" }))).toBe("Highest per day");
  });
  it("values mode reads the saved aggregation", () => {
    const stat = valuesData({ type: "stat" });
    expect(aggregationWords("stat", stat, cfg({ aggregation: "last" }))).toBe("Latest reading");
    expect(aggregationWords("stat", stat, cfg({ aggregation: "avg" }))).toBe("Average");
    expect(aggregationWords("table", stat, cfg({ aggregation: "min" }))).toBe("Lowest");
    expect(aggregationWords("table", stat, cfg({ aggregation: "max" }))).toBe("Highest");
    const energy = valuesData({ type: "bar", source: "energy", metric: null, unit: "kWh" });
    expect(aggregationWords("bar", energy, cfg({ source: "energy", metric: null, aggregation: "sum" }))).toBe("Total");
  });
  it("a latest reading of a finished range is the last value in the window, not a reading", () => {
    const data = valuesData({ type: "stat", range: { ...valuesData().range, preset: "last_month" } });
    expect(aggregationWords("stat", data, cfg({ aggregation: "last" }))).toBe("Last value in the window");
  });
});

describe("sourceWords", () => {
  it("names the metric with its unit, energy and cost by their unit", () => {
    expect(sourceWords(valuesData({ metric: "active_power_kw", unit: "kW" }))).toBe("active_power_kw (kW)");
    expect(sourceWords(valuesData({ source: "energy", metric: null, unit: "kWh" }))).toBe("Energy (kWh)");
    expect(sourceWords(valuesData({ source: "cost", metric: null, unit: "QAR" }))).toBe("Cost (QAR)");
  });
  it("leaves the parentheses out when there is no unit (power factor)", () => {
    expect(sourceWords(valuesData({ metric: "power_factor", unit: null }))).toBe("power_factor");
    expect(sourceWords(valuesData({ metric: "power_factor", unit: "" }))).toBe("power_factor");
    expect(sourceWords(valuesData({ source: "cost", metric: null, unit: null }))).toBe("Cost");
  });
});

describe("markerMeanings", () => {
  it("says nothing for a response with no marker", () => {
    expect(markerMeanings(valuesData())).toEqual([]);
    expect(markerMeanings(timeseries())).toEqual([]);
  });
  it("explains each marker the response uses, and only that one", () => {
    expect(markerMeanings(valuesData({ values: [valueRow({ estimated: true })] }))).toEqual(["~ estimated from power, not measured"]);
    expect(markerMeanings(valuesData({ source: "cost", metric: null, unit: "QAR", values: [valueRow({ partial: true })] })))
      .toEqual(["* partial: some energy in the period had no rate, so the cost is incomplete"]);
  });
  it("explains the dash of a cost with no rate, from a value row or from a series bucket", () => {
    const dash = "— no rate: no tariff applies to this figure";
    expect(markerMeanings(valuesData({ source: "cost", metric: null, unit: "QAR", values: [valueRow({ value: null })] }))).toContain(dash);
    const cost = energySeries("hour", [seriesPoint({ ts: at(7200), value: 3 }), seriesPoint({ ts: at(3600), value: null })], {}, { source: "cost", unit: "QAR" });
    expect(markerMeanings(cost)).toEqual([dash]);
  });
  it("a silent bucket in a cost series is a gap, not a missing rate", () => {
    const cost = energySeries("hour", [seriesPoint({ ts: at(7200), value: 3 }), seriesPoint({ ts: at(3600), value: null, no_data: true })], {}, { source: "cost", unit: "QAR" });
    expect(markerMeanings(cost)).toEqual([]);
  });
  it("explains no data when a row or a whole series recorded nothing", () => {
    const words = "no data: nothing was recorded in the window";
    expect(markerMeanings(valuesData({ values: [valueRow({ value: null, no_data: true })] }))).toEqual([words]);
    const empty = energySeries("hour", [seriesPoint({ ts: at(7200), value: null, no_data: true })]);
    expect(markerMeanings(empty)).toEqual([words]);
    expect(markerMeanings(energySeries("hour", []))).toEqual([words]);
  });
  it("a series with some data and a gap does not claim that nothing was recorded", () => {
    const gappy = energySeries("hour", [seriesPoint({ ts: at(7200), value: 2 }), seriesPoint({ ts: at(3600), value: null, no_data: true })]);
    expect(markerMeanings(gappy)).toEqual([]);
  });
  it("lists the meanings in a fixed order", () => {
    const data = valuesData({
      source: "cost", metric: null, unit: "QAR",
      values: [valueRow({ estimated: true, partial: true }), valueRow({ asset_id: 6, value: null, no_data: true })],
    });
    expect(markerMeanings(data).map((s) => s.split(" ")[0])).toEqual(["~", "*", "—", "no"]);
  });
});

describe("assetRows, removedCount and noMetricIds", () => {
  it("lists the assets of a values response with their states in words", () => {
    const data = valuesData({
      type: "table", source: "cost", metric: null, unit: "QAR",
      values: [
        valueRow({ asset_id: 5, name: "Rack A01", value: 1, estimated: true, partial: true }),
        valueRow({ asset_id: 6, name: "Rack A02", value: null }),
        valueRow({ asset_id: 7, name: "Rack A03", value: 3 }),
      ],
    });
    expect(assetRows(data)).toEqual([
      { assetId: 5, name: "Rack A01", states: ["estimated", "partial"] },
      { assetId: 6, name: "Rack A02", states: ["no rate"] },
      { assetId: 7, name: "Rack A03", states: [] },
    ]);
  });
  it("says no data for a metric row that recorded nothing and stale for a stale reading", () => {
    const data = valuesData({
      type: "table",
      values: [
        valueRow({ asset_id: 5, name: "A", value: null, no_data: true }),
        valueRow({ asset_id: 6, name: "B", value: 4, stale: true, ts: at(7200) }),
      ],
    });
    expect(assetRows(data).map((r) => r.states)).toEqual([["no data"], ["stale"]]);
  });
  it("a cost with a dash is a no rate, whether or not it also recorded nothing: the card shows the same dash", () => {
    const data = valuesData({ source: "cost", metric: null, unit: "QAR", values: [valueRow({ value: null, no_data: true })] });
    expect(assetRows(data)[0].states).toEqual(["no rate"]);
  });
  it("lists a series by asset: its flags, a cost bucket with no rate, and no data when it has no bucket with data", () => {
    const cost = (points: WidgetPoint[], over: Partial<WidgetSeries> = {}) => ({ asset_id: 5, name: "A", estimated: false, partial: false, points, ...over });
    const data = energySeries("hour", [], {}, {
      source: "cost", unit: "QAR",
      series: [
        cost([seriesPoint({ ts: at(7200), value: 2, estimated: true }), seriesPoint({ ts: at(3600), value: null })], { estimated: true }),
        cost([seriesPoint({ ts: at(3600), value: null, no_data: true })], { asset_id: 6, name: "B" }),
        cost([], { asset_id: 7, name: "C" }),
        cost([seriesPoint({ ts: at(3600), value: 1, partial: true })], { asset_id: 8, name: "D", partial: true }),
      ],
    });
    expect(assetRows(data)).toEqual([
      { assetId: 5, name: "A", states: ["estimated", "no rate"] },
      { assetId: 6, name: "B", states: ["no data"] },
      { assetId: 7, name: "C", states: ["no data"] },
      { assetId: 8, name: "D", states: ["partial"] },
    ]);
  });
  it("tells apart two assets with one name by their id", () => {
    const data = valuesData({ values: [valueRow({ asset_id: 5, name: "Feed" }), valueRow({ asset_id: 6, name: "Feed" })] });
    expect(assetRows(data).map((r) => r.name)).toEqual(["Feed (#5)", "Feed (#6)"]);
  });
  it("counts the removed assets and lists the assets without the metric", () => {
    const data = valuesData({ missing: [11, 12], no_metric: [8] });
    expect(removedCount(data)).toBe(2);
    expect(noMetricIds(data)).toEqual([8]);
    expect(removedCount(valuesData())).toBe(0);
    expect(noMetricIds(valuesData())).toEqual([]);
  });
});

const pts = (...rows: Array<Partial<WidgetPoint> & { h: number }>): WidgetPoint[] =>
  rows.map(({ h, ...rest }) => seriesPoint({ ts: `2026-10-17T${String(h).padStart(2, "0")}:00:00+03:00`, ...rest }));

describe("seriesSummary: a metric series", () => {
  const data = timeseries({
    series: [{
      asset_id: 5, name: "Rack A01", estimated: false, partial: false,
      points: pts(
        { h: 1, value: 10, min: 8, max: 12 },
        { h: 2, value: 14, min: 9, max: 19 },
        { h: 3, value: null, min: null, max: null, no_data: true },
        { h: 4, value: 11, min: 7.5, max: 15 },
        { h: 5, value: null, min: null, max: null, no_data: true },
      ),
    }],
  });
  it("is the least bucket minimum, the greatest bucket maximum and the start of that bucket, null buckets skipped", () => {
    const summary = seriesSummary(data, cfg());
    expect(summary?.rows).toHaveLength(1);
    const row = summary!.rows[0];
    expect(row.assetId).toBe(5);
    expect(row.name).toBe("Rack A01");
    expect(row.lowest).toEqual({ value: 7.5, estimated: false, partial: false });
    expect(row.highest).toEqual({ value: 19, estimated: false, partial: false });
    expect(row.highestFrom).toBe("2026-10-17T02:00:00+03:00");
  });
  it("takes the last bucket that has a value, and says which bucket that is", () => {
    const row = seriesSummary(data, cfg())!.rows[0];
    expect(row.last).toEqual({ value: 11, estimated: false, partial: false });
    expect(row.lastFrom).toBe("2026-10-17T04:00:00+03:00");
  });
  it("has no total and no average, ever", () => {
    const summary = seriesSummary(data, cfg())!;
    expect(summary.rows[0].total).toBeNull();
    expect(Object.keys(summary.rows[0]).join(" ")).not.toMatch(/avg|average|mean/i);
    expect(summary.columns.map((c) => c.key)).toEqual(["lowest", "highest", "last"]);
  });
  it("names its columns, the last one by what its figure is (an average for a time series)", () => {
    expect(seriesSummary(data, cfg())!.columns.map((c) => c.heading))
      .toEqual(["Lowest", "Highest", "Last bucket (average)"]);
  });
  it("on a tie the earlier bucket is the one named", () => {
    const tie = timeseries({ series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: pts({ h: 1, value: 5, min: 4, max: 9 }, { h: 2, value: 5, min: 4, max: 9 }) }] });
    expect(seriesSummary(tie, cfg())!.rows[0].highestFrom).toBe("2026-10-17T01:00:00+03:00");
  });
  it("gives nothing (not a zero) for a series with no bucket that has data", () => {
    const none = timeseries({ series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: pts({ h: 1, value: null, no_data: true }) }] });
    const row = seriesSummary(none, cfg())!.rows[0];
    expect([row.lowest, row.highest, row.highestFrom, row.last, row.lastFrom, row.total]).toEqual([null, null, null, null, null, null]);
    const empty = timeseries({ series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: [] }] });
    expect(seriesSummary(empty, cfg())!.rows[0].highest).toBeNull();
  });
  it("carries the flags of its own bucket: a partial bucket gives 12.30*", () => {
    const flagged = timeseries({
      series: [{ asset_id: 5, name: "A", estimated: true, partial: true, points: pts(
        { h: 1, value: 9, min: 8, max: 12.3, partial: true },
        { h: 2, value: 7, min: 6, max: 10, estimated: true },
      ) }],
    });
    const row = seriesSummary(flagged, cfg())!.rows[0];
    expect(figureText(row.highest!.value, row.highest!)).toBe("12.30*");
    expect(figureText(row.lowest!.value, row.lowest!)).toBe("~6.00"); // from the second, estimated bucket
    expect(figureText(row.last!.value, row.last!)).toBe("~7.00");
  });
  it("a metric bar over time is summarised the same way, its last column named by the saved aggregation", () => {
    const bar = metricBar({ series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: pts({ h: 1, value: 14, min: 10, max: 16 }, { h: 2, value: 20, min: 12, max: 25 }) }] });
    const summary = seriesSummary(bar, cfg({ aggregation: "max", bars: "time" }))!;
    expect(summary.rows[0].lowest!.value).toBe(10);
    expect(summary.rows[0].highest!.value).toBe(25);
    expect(summary.rows[0].last!.value).toBe(20);
    expect(summary.columns[2].heading).toBe("Last bucket (highest per hour)");
  });
  it("one row per asset, with unique names", () => {
    const two = timeseries({
      series: [
        { asset_id: 5, name: "Feed", estimated: false, partial: false, points: pts({ h: 1, value: 1, min: 1, max: 1 }) },
        { asset_id: 6, name: "Feed", estimated: false, partial: false, points: pts({ h: 1, value: 2, min: 2, max: 2 }) },
      ],
    });
    expect(seriesSummary(two, cfg())!.rows.map((r) => r.name)).toEqual(["Feed (#5)", "Feed (#6)"]);
  });
});

describe("seriesSummary: energy and cost", () => {
  const energy = cfg({ source: "energy", metric: null, aggregation: "sum" });
  it("has a total only when no bucket is missing, and it is the sum of the bucket values", () => {
    const data = energySeries("hour", pts({ h: 1, value: 10 }, { h: 2, value: 12.5 }, { h: 3, value: 7.25 }));
    const row = seriesSummary(data, energy)!.rows[0];
    expect(row.total).toEqual({ value: 29.75, estimated: false, partial: false });
    expect(row.highest!.value).toBe(12.5);
    expect(row.highestFrom).toBe("2026-10-17T02:00:00+03:00");
    expect(row.last!.value).toBe(7.25);
    expect(row.lowest).toBeNull();
    expect(seriesSummary(data, energy)!.columns.map((c) => c.key)).toEqual(["highest", "last", "total"]);
    expect(seriesSummary(data, energy)!.columns.map((c) => c.heading))
      .toEqual(["Highest", "Last bucket (total per hour)", "Total of the buckets shown"]);
  });
  it("has no total when a bucket recorded nothing", () => {
    const data = energySeries("hour", pts({ h: 1, value: 10 }, { h: 2, value: null, no_data: true }, { h: 3, value: 7 }));
    const row = seriesSummary(data, energy)!.rows[0];
    expect(row.total).toBeNull();
    expect(row.highest!.value).toBe(10); // a gap holds no energy that could be higher
    expect(row.last!.value).toBe(7);
  });
  it("has no total for a series with no bucket at all", () => {
    expect(seriesSummary(energySeries("hour", []), energy)!.rows[0].total).toBeNull();
  });
  it("a total is estimated or partial when any bucket is, and a bucket carries its own flags", () => {
    const data = energySeries("hour", pts({ h: 1, value: 10, estimated: true }, { h: 2, value: 12.3, partial: true }, { h: 3, value: 7 }));
    const row = seriesSummary(data, energy)!.rows[0];
    expect(row.total).toEqual({ value: 29.3, estimated: true, partial: true });
    expect(figureText(row.total!.value, row.total!)).toBe("~29.30*");
    expect(figureText(row.highest!.value, row.highest!)).toBe("12.30*");
    expect(row.last).toEqual({ value: 7, estimated: false, partial: false });
  });
  it("a total also takes the flag of the series, as the chart's legend does", () => {
    const data = energySeries("hour", pts({ h: 1, value: 10 }), { estimated: true });
    expect(seriesSummary(data, energy)!.rows[0].total).toEqual({ value: 10, estimated: true, partial: false });
  });
  it("a cost bucket with no rate is not a gap: no total, and no highest either (it could have been the highest)", () => {
    const data = energySeries("hour", pts({ h: 1, value: 4 }, { h: 2, value: null }, { h: 3, value: 2 }), {}, { source: "cost", unit: "QAR" });
    const row = seriesSummary(data, { ...energy, source: "cost" })!.rows[0];
    expect(row.total).toBeNull();
    expect(row.highest).toBeNull();
    expect(row.highestFrom).toBeNull();
    expect(row.last).toEqual({ value: 2, estimated: false, partial: false });
  });
  it("a day series says per day", () => {
    const data = energySeries("day", pts({ h: 1, value: 10 }));
    expect(seriesSummary(data, energy)!.columns[1].heading).toBe("Last bucket (total per day)");
  });
  it("is null for a values response", () => {
    expect(seriesSummary(valuesData(), cfg())).toBeNull();
    expect(seriesSummary(valuesData({ type: "bar", source: "energy", metric: null, unit: "kWh" }), energy)).toBeNull();
  });
});

describe("bucketStartText", () => {
  it("is to the second for a metric time series, whose buckets start between minutes", () => {
    expect(bucketStartText("2026-10-17T00:04:48+03:00", TZ, timeseries())).toBe("2026-10-17 00:04:48");
  });
  it("is to the minute for an hour bucket and the date for a day bucket", () => {
    expect(bucketStartText("2026-10-17T13:00:00+03:00", TZ, energySeries("hour", []))).toBe("2026-10-17 13:00");
    expect(bucketStartText("2026-10-17T00:00:00+03:00", TZ, energySeries("day", []))).toBe("2026-10-17");
  });
});

describe("chartDescription", () => {
  const three = timeseries({
    range: { preset: "24h", start: "2026-10-16T09:00:00+00:00", end: "2026-10-17T09:00:00+00:00" },
    series: ["Rack A01", "Rack A02", "UPS-1 output"].map((name, i) => ({ asset_id: 5 + i, name, estimated: false, partial: false, points: [] })),
  });
  it("names the chart, its assets, the metric with its unit and the window, and points to Details", () => {
    expect(chartDescription("timeseries", three))
      .toBe("Line chart of 3 assets: Rack A01, Rack A02, UPS-1 output. active_power_kw in kW, Last 24 hours. Open Details for the figures.");
  });
  it("is a bar chart for a bar, and names energy and cost by their unit", () => {
    const bars = valuesData({ type: "bar", source: "energy", metric: null, unit: "kWh", values: [valueRow({ asset_id: 5, name: "Hall A" })] });
    expect(chartDescription("bar", bars)).toBe("Bar chart of 1 asset: Hall A. Energy in kWh, Last 24 hours. Open Details for the figures.");
    const cost = valuesData({ type: "bar", source: "cost", metric: null, unit: "QAR", values: [valueRow({ asset_id: 5, name: "Hall A" }), valueRow({ asset_id: 6, name: "Hall B" })] });
    expect(chartDescription("bar", cost)).toBe("Bar chart of 2 assets: Hall A, Hall B. Cost in QAR, Last 24 hours. Open Details for the figures.");
  });
  it("names three assets and counts the rest", () => {
    const many = timeseries({ series: ["A", "B", "C", "D", "E"].map((name, i) => ({ asset_id: 5 + i, name, estimated: false, partial: false, points: [] })) });
    expect(chartDescription("timeseries", many)).toContain("Line chart of 5 assets: A, B, C and 2 more.");
    const four = timeseries({ series: ["A", "B", "C", "D"].map((name, i) => ({ asset_id: 5 + i, name, estimated: false, partial: false, points: [] })) });
    expect(chartDescription("timeseries", four)).toContain("Line chart of 4 assets: A, B, C and 1 more.");
  });
  it("leaves the unit out when there is none, and says so when there is no data", () => {
    const pf = valuesData({ type: "bar", metric: "power_factor", unit: null });
    expect(chartDescription("bar", pf)).toContain("power_factor, Last 24 hours.");
    expect(chartDescription("timeseries", timeseries({ series: [] }))).toBe("Line chart with no data. Open Details for the figures.");
  });
  it("is empty for a type that is not a chart", () => {
    expect(chartDescription("gauge", valuesData({ type: "gauge" }))).toBe("");
    expect(chartDescription("stat", valuesData())).toBe("");
    expect(chartDescription("table", valuesData())).toBe("");
  });
});

describe("no helper calls a series total or a mean of buckets an average", () => {
  it("energy and cost series never say average or mean, in any helper", () => {
    const rows = pts({ h: 1, value: 10, estimated: true }, { h: 2, value: 12 }, { h: 3, value: null, no_data: true });
    for (const source of ["energy", "cost"] as const) {
      const c = cfg({ source, metric: null, aggregation: "sum" });
      for (const bucket of ["hour", "day"] as const) {
        const data = energySeries(bucket, rows, {}, { source, unit: source === "cost" ? "QAR" : "kWh" });
        const summary = seriesSummary(data, c)!;
        const words = [
          figuresText(data, c), aggregationWords("timeseries", data, c), aggregationWords("bar", data, c), sourceWords(data),
          chartDescription("timeseries", data), chartDescription("bar", data), ...markerMeanings(data),
          ...assetRows(data).flatMap((r) => [r.name, ...r.states]), ...summary.columns.map((col) => col.heading),
        ].join("\n");
        expect(words).not.toMatch(/average|mean/i);
        expect(Object.keys(summary.rows[0]).join(" ")).not.toMatch(/avg|average|mean/i);
      }
    }
  });
  it("a metric series says average only for what the backend averaged: the bucket's own value, never a figure over buckets", () => {
    const summary = seriesSummary(timeseries(), cfg())!;
    expect(summary.columns.filter((col) => /average|mean/i.test(col.heading)).map((col) => col.key)).toEqual(["last"]);
    expect(summary.columns.map((col) => col.key).join(" ")).not.toMatch(/avg|average|mean/i);
  });
});
