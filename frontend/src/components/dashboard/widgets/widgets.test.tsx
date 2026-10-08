import { render, screen } from "@testing-library/react";
import type { WidgetData } from "../../../api/types";
import { formatSiteDateTime, formatSiteTick } from "../../../lib/siteTime";
import { MUTED_FIGURE } from "../../../lib/widgetFormat";
import { config, seriesData, seriesPoint, valueRow, valuesData } from "../../../test/dashboardFixtures";
import { LiveValuesContext } from "../LiveValuesContext";
import { BarWidget, barOption } from "./BarWidget";
import { GaugeWidget, gaugeOption } from "./GaugeWidget";
import { StatWidget } from "./StatWidget";
import { TableWidget } from "./TableWidget";
import { bucketMs, markIsolated, timeSeriesOption, tooltipFormatter, TimeSeriesWidget, withGaps } from "./TimeSeriesWidget";

vi.mock("echarts-for-react", () => ({
  default: (props: { option: { series?: { type?: string }[] } }) => (
    <pre data-testid="chart" data-kind={props.option.series?.[0]?.type}>{JSON.stringify(props.option)}</pre>
  ),
}));

type Row = [string, number | null];
/** A chart row: a plain [ts, value] pair, or an object carrying a per-item symbol (a point with no neighbour to draw a line to). */
type Cell = Row | { value: Row; symbol: string; symbolSize: number };
const plain = (cell: Cell): Row => (Array.isArray(cell) ? cell : cell.value);
interface LineSeries { id?: string; name: string; type: string; data: Cell[]; connectNulls?: boolean }
interface BarSeries { name: string; type: string; data: (number | null)[]; markPoint?: { data: { coord: [number, number] }[]; label: { show: boolean; formatter: string } } }
interface Opt<S> {
  useUTC?: boolean;
  series: S[];
  xAxis: { axisLabel?: { formatter: (value: number) => string }; data?: string[] };
  tooltip: { formatter: (params: unknown) => string };
}
const asOption = (option: unknown) => option as Opt<LineSeries>;
const asBar = (option: unknown) => option as Opt<BarSeries>;
const barSeries = (option: unknown) => asBar(option).series;
const TZ = "Asia/Qatar";
const stream = (value: number | null, quality = 0, connected = true, ts = "2026-10-08T06:00:00.000Z") => ({
  values: new Map([[7, { ts, value, quality }]]), connected, register: () => {},
});
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe("time series", () => {
  const points = [
    seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 1, min: 0.5, max: 1.5 }),
    seriesPoint({ ts: "2026-10-08T00:01:00+00:00", value: 2, min: 1, max: 3 }),
    seriesPoint({ ts: "2026-10-08T00:02:00+00:00", value: 3, min: 2, max: 4 }),
    seriesPoint({ ts: "2026-10-08T00:10:00+00:00", value: 4, min: 3, max: 5 }),
  ];
  const data = seriesData({ series: [{ asset_id: 5, name: "LV Panel 1", points, estimated: false, partial: false }] });

  it("estimates the bucket width from the bucket size, else from the typical step of the data", () => {
    expect(bucketMs("hour", points)).toBe(3_600_000);
    expect(bucketMs("day", points)).toBe(86_400_000);
    expect(bucketMs(null, points)).toBe(60_000); // steps 60 s, 60 s, 480 s: the typical one
    expect(bucketMs(null, [points[0], points[3]])).toBe(600_000); // a single step is the typical step
    expect(bucketMs(null, points.slice(0, 1))).toBeNull();
    expect(bucketMs(null, [])).toBeNull();
    expect(bucketMs(null, [points[0], points[0]])).toBeNull(); // duplicate timestamps have no step
  });

  // The backend cuts a window into at most 300 buckets whatever the tier (24 h / 300 = 288 s, 30 d / 300 = 8640 s...):
  // the tier only names the table that served them. Every normal step of a series is therefore one bucket width.
  const shaped = (count: number, stepSeconds: number, start = Date.UTC(2026, 9, 1)) =>
    Array.from({ length: count }, (_, i) => seriesPoint({ ts: new Date(start + i * stepSeconds * 1000).toISOString(), value: 1 + (i % 7), min: i % 7, max: 2 + (i % 7) }));
  it.each<[string, "raw" | "1m" | "1h", number]>([
    ["1h", "raw", 12], ["6h", "1m", 72], ["24h", "1m", 288], ["7d", "1m", 2016], ["30d", "1h", 8640],
  ])("draws a full %s metric series (tier %s, %i s buckets) as one joined line, with no filler rows and no dots", (preset, tier, step) => {
    const full = shaped(300, step);
    const range = { preset: preset as "1h", start: full[0].ts, end: new Date(Date.parse(full[299].ts) + step * 1000).toISOString() };
    const option = asOption(timeSeriesOption(seriesData({ tier, range, series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: full }] }), TZ));
    expect(bucketMs(null, full)).toBe(step * 1000);
    for (const id of ["band-min-5", "band-span-5", "avg-5"]) {
      const rows = option.series.find((s) => s.id === id)!.data;
      expect(rows).toHaveLength(300); // a filler row would make it 599
      expect(rows.every((c) => Array.isArray(c))).toBe(true); // an isolated point would be an object
    }
  });

  it("takes the median step, so one close pair of samples does not turn every normal step into a gap", () => {
    const at = (seconds: number[]) => seconds.map((t) => seriesPoint({ ts: new Date(Date.UTC(2026, 9, 8, 0, 0, t)).toISOString(), value: 1, min: 1, max: 1 }));
    const raw = at([0, 10, 20, 21, 31, 41, 51]); // steps 10 10 1 10 10 10
    expect(bucketMs(null, raw)).toBe(10_000);
    const option = asOption(timeSeriesOption(seriesData({ tier: "raw", series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: raw }] }), TZ));
    const avg = option.series.find((s) => s.id === "avg-5")!;
    expect(avg.data).toHaveLength(7); // no filler rows: the line is not broken anywhere
    expect(avg.data.every((c) => Array.isArray(c))).toBe(true); // and no point is isolated
  });

  it("still breaks the line over a hole that is much longer than the usual step, whatever the tier", () => {
    const sparse = [
      seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 1, min: 1, max: 1 }),
      seriesPoint({ ts: "2026-10-08T00:04:48+00:00", value: 1, min: 1, max: 1 }),
      seriesPoint({ ts: "2026-10-08T00:09:36+00:00", value: 1, min: 1, max: 1 }),
      seriesPoint({ ts: "2026-10-08T03:00:00+00:00", value: 1, min: 1, max: 1 }), // a meter that was offline
      seriesPoint({ ts: "2026-10-08T03:04:48+00:00", value: 1, min: 1, max: 1 }),
    ];
    const option = asOption(timeSeriesOption(seriesData({ tier: "1m", series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: sparse }] }), TZ));
    const avg = option.series.find((s) => s.id === "avg-5")!;
    expect(avg.data.map((c) => plain(c)[1])).toEqual([1, 1, 1, null, 1, 1]);
    expect(avg.data.map((c) => (Array.isArray(c) ? "line" : "dot"))).toEqual(["line", "line", "line", "line", "line", "line"]); // each side keeps its line
  });

  it("marks a point that has no neighbour to draw a line to, because a lone point is otherwise invisible", () => {
    const row = (v: number | null): Row => ["2026-10-08T00:00:00.000Z", v];
    const marked = markIsolated([row(1), row(2), row(null), row(3), row(null), row(null), row(4)]);
    expect(marked.map((m) => (Array.isArray(m) ? "line" : "dot"))).toEqual(["line", "line", "line", "dot", "line", "line", "dot"]);
    expect(marked[3]).toMatchObject({ value: row(3), symbol: "circle" });
    expect((marked[3] as { symbolSize: number }).symbolSize).toBeGreaterThan(0);
    expect(markIsolated([row(7)])).toMatchObject([{ value: row(7), symbol: "circle" }]); // the only row
    expect(markIsolated([row(1), row(2)]).every((m) => Array.isArray(m))).toBe(true); // joined, drawn as a line
    expect(markIsolated([])).toEqual([]);
  });

  it("draws a one-bucket energy series (the 1h preset) with a visible point", () => {
    const hour = seriesData({
      source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null,
      range: { preset: "1h", start: "2026-10-08T10:00:00+03:00", end: "2026-10-08T10:30:00+03:00" },
      series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: [seriesPoint({ ts: "2026-10-08T10:00:00+03:00", value: 1.5 })] }],
    });
    const [line] = asOption(timeSeriesOption(hour, TZ)).series;
    expect(line.id).toBe("avg-5");
    expect(line.data).toHaveLength(1);
    expect(line.data[0]).toMatchObject({ value: ["2026-10-08T10:00:00+03:00", 1.5], symbol: "circle" });
  });

  it("draws a priced cost bucket between no-rate buckets with a visible point, and the neighbours without one", () => {
    const cost = seriesData({
      source: "cost", metric: null, unit: "QAR", bucket: "hour", tier: null,
      series: [{ asset_id: 5, name: "A", estimated: false, partial: true, points: [
        seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: null, partial: true }),
        seriesPoint({ ts: "2026-10-08T01:00:00+00:00", value: 0.5 }),
        seriesPoint({ ts: "2026-10-08T02:00:00+00:00", value: null, partial: true }),
      ] }],
    });
    const [line] = asOption(timeSeriesOption(cost, TZ)).series;
    expect(line.data.map((c) => (Array.isArray(c) ? "pair" : "dot"))).toEqual(["pair", "dot", "pair"]);
    expect(line.data[1]).toMatchObject({ symbol: "circle" });
  });

  it("keeps the min/max band helpers free of symbols, so only the average line shows the dot", () => {
    const lone = seriesData({ series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 1, min: 0, max: 2 })] }] });
    const option = asOption(timeSeriesOption(lone, TZ));
    expect(option.series.map((s) => s.id)).toEqual(["band-min-5", "band-span-5", "avg-5"]);
    expect(option.series.find((s) => s.id === "avg-5")!.data[0]).toMatchObject({ symbol: "circle" });
    expect(option.series.find((s) => s.id === "band-min-5")!.data.every((c) => Array.isArray(c))).toBe(true);
    expect(option.series.find((s) => s.id === "band-span-5")!.data.every((c) => Array.isArray(c))).toBe(true);
  });

  it("still reads the isolated point's value in the tooltip", () => {
    const lone = seriesData({ source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null, series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 1.5 })] }] });
    const [line] = asOption(timeSeriesOption(lone, TZ)).series;
    const cell = line.data[0] as { value: Row };
    // ECharts hands the formatter the item's `value` pair as `params.value`.
    expect(tooltipFormatter(lone, TZ)([{ seriesId: "avg-5", seriesName: "A", value: cell.value, marker: "" }])).toContain("A: 1.50 kWh");
  });

  it("breaks the line where buckets are missing and where the value is null", () => {
    const rows = withGaps([...points.slice(0, 2), seriesPoint({ ts: "2026-10-08T00:02:00+00:00", no_data: true }), points[3]], 60_000, (p) => p.value);
    expect(rows.map(([, v]) => v)).toEqual([1, 2, null, null, 4]);
    expect(rows[3][0]).toBe("2026-10-08T00:03:00.000Z");
  });

  it("draws an average line per asset with a min/max band, gaps as gaps", () => {
    const option = asOption(timeSeriesOption(data, TZ));
    expect(option.series.map((s) => s.id)).toEqual(["band-min-5", "band-span-5", "avg-5"]);
    const avg = option.series.find((s) => s.id === "avg-5")!;
    expect(avg.name).toBe("LV Panel 1");
    expect(avg.connectNulls).toBe(false);
    expect(avg.data.map((c) => plain(c)[1])).toEqual([1, 2, 3, null, 4]);
    expect(plain(avg.data[3])[0]).toBe("2026-10-08T00:03:00.000Z");
    expect(option.series.find((s) => s.id === "band-min-5")!.data.map((c) => plain(c)[1])).toEqual([0.5, 1, 2, null, 3]);
    expect(option.series.find((s) => s.id === "band-span-5")!.data.map((c) => plain(c)[1])).toEqual([1, 2, 2, null, 2]);
  });

  it("draws energy as plain hourly lines (no band) and breaks the line over a missing hour", () => {
    const hourly = seriesData({
      source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null,
      series: [{ asset_id: 5, name: "LV Panel 1", estimated: true, partial: false, points: [
        seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 1, estimated: true }),
        seriesPoint({ ts: "2026-10-08T01:00:00+00:00", value: 2, estimated: true }),
        seriesPoint({ ts: "2026-10-08T04:00:00+00:00", value: 3, estimated: true }),
      ] }],
    });
    const option = asOption(timeSeriesOption(hourly, TZ));
    expect(option.series.map((s) => s.id)).toEqual(["avg-5"]);
    expect(option.series[0].name).toBe("LV Panel 1 ~");
    expect(option.series[0].data.map((c) => plain(c)[1])).toEqual([1, 2, null, 3]);
    expect(plain(option.series[0].data[2])[0]).toBe("2026-10-08T02:00:00.000Z");
  });

  it("draws a silent bucket (no_data) and a bucket without a rate both as gaps in the line", () => {
    const cost = seriesData({
      source: "cost", metric: null, unit: "QAR", bucket: "hour", tier: null,
      series: [{ asset_id: 5, name: "LV Panel 1", estimated: false, partial: true, points: [
        seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 0.5 }),
        seriesPoint({ ts: "2026-10-08T01:00:00+00:00", value: null, partial: true }), // consumption, no rate
        seriesPoint({ ts: "2026-10-08T02:00:00+00:00", value: null, no_data: true }), // nothing recorded
        seriesPoint({ ts: "2026-10-08T03:00:00+00:00", value: 0.7 }),
      ] }],
    });
    expect(asOption(timeSeriesOption(cost, TZ)).series[0].data.map((c) => plain(c)[1])).toEqual([0.5, null, null, 0.7]);
  });

  it("tells apart two assets with the same name", () => {
    const twin = (id: number) => ({ asset_id: id, name: "Panel", estimated: false, partial: false, points: points.slice(0, 2) });
    const option = asOption(timeSeriesOption(seriesData({ series: [twin(1), twin(2)] }), TZ));
    expect(option.series.filter((s) => s.id?.startsWith("avg-")).map((s) => s.name)).toEqual(["Panel (#1)", "Panel (#2)"]);
  });

  it("formats axis labels in the site zone and positions ticks in UTC like the asset chart", () => {
    const option = asOption(timeSeriesOption(data, TZ));
    expect(option.useUTC).toBe(true);
    const ms = Date.parse("2026-10-08T00:01:00Z");
    expect(option.xAxis.axisLabel!.formatter(ms)).toBe(formatSiteTick(new Date(ms).toISOString(), TZ, null));
  });

  it("puts the date on the axis and in the tooltip header when the window is longer than a day (metric responses name no bucket)", () => {
    const week = seriesData({ range: { preset: "7d", start: "2026-10-01T06:00:00+00:00", end: "2026-10-08T06:00:00+00:00" } });
    const option = asOption(timeSeriesOption(week, TZ));
    const ms = Date.parse("2026-10-07T10:00:00Z");
    expect(option.xAxis.axisLabel!.formatter(ms)).toBe("10-07 13:00");
    const html = tooltipFormatter(week, TZ)([{ seriesId: "avg-5", seriesName: "LV Panel 1", value: ["2026-10-08T00:04:48+00:00", 2], marker: "" }]);
    expect(html).toContain("2026-10-08 03:04:48");
    // A day or less stays a bare time of day.
    expect(asOption(timeSeriesOption(data, TZ)).xAxis.axisLabel!.formatter(Date.parse("2026-10-08T00:01:00Z"))).toBe("03:01");
  });

  it("builds a tooltip that hides the band helpers, shows min/max, and escapes names", () => {
    const html = tooltipFormatter(data, TZ)([
      { seriesId: "band-min-5", seriesName: "LV Panel 1 min", value: ["2026-10-08T00:01:00+00:00", 1], marker: "<i>m</i>" },
      { seriesId: "avg-5", seriesName: "<b>LV</b> Panel 1", value: ["2026-10-08T00:01:00+00:00", 2], marker: "<i>m</i>" },
    ]);
    expect(html).toContain("&lt;b&gt;LV&lt;/b&gt; Panel 1");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("LV Panel 1 min");
    expect(html).toContain("2.00 kW");
    expect(html).toContain("(min 1.00, max 3.00)");
    expect(html).toContain(formatSiteDateTime("2026-10-08T00:01:00.000Z", TZ));
    expect(tooltipFormatter(data, TZ)([])).toBe("");
  });

  it("shows a dash for a bucket that has no rate, nothing for a silent bucket, and the markers of the bucket's own flags", () => {
    const cost = seriesData({
      source: "cost", metric: null, unit: "QAR", bucket: "hour", tier: null,
      series: [
        { asset_id: 5, name: "A", estimated: false, partial: true, points: [
          seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 0.5, partial: true }),
          seriesPoint({ ts: "2026-10-08T01:00:00+00:00", value: null, partial: true }),
          seriesPoint({ ts: "2026-10-08T02:00:00+00:00", value: null, no_data: true }),
        ] },
        { asset_id: 6, name: "B", estimated: true, partial: false, points: [
          seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 1.25, estimated: true }),
          seriesPoint({ ts: "2026-10-08T01:00:00+00:00", value: 2 }),
          seriesPoint({ ts: "2026-10-08T02:00:00+00:00", value: 3 }),
        ] },
      ],
    });
    const tip = tooltipFormatter(cost, TZ);
    const item = (id: number, name: string, ts: string, value: number | null) => ({ seriesId: `avg-${id}`, seriesName: name, value: [ts, value], marker: "" });
    const at = (ts: string) => tip([item(5, "A", ts, null), item(6, "B", ts, 1)]);
    const first = tip([item(5, "A", "2026-10-08T00:00:00+00:00", 0.5), item(6, "B", "2026-10-08T00:00:00+00:00", 1.25)]);
    expect(first).toContain("A: 0.50* QAR");
    expect(first).toContain("B: ~1.25 QAR");
    const noRate = tip([item(5, "A", "2026-10-08T01:00:00+00:00", null), item(6, "B", "2026-10-08T01:00:00+00:00", 2)]);
    expect(noRate).toContain("A: —");
    expect(noRate).not.toContain("A: — QAR");
    expect(noRate).toContain("B: 2.00 QAR");
    const silent = at("2026-10-08T02:00:00+00:00");
    expect(silent).not.toContain("A:");
    expect(silent).toContain("B:");
    // A hover over a stretch that has only silent buckets or the filler row of a gap shows no tooltip at all.
    expect(tip([item(5, "A", "2026-10-08T02:00:00+00:00", null)])).toBe("");
    expect(tip([item(5, "A", "2026-10-08T05:00:00+00:00", null)])).toBe("");
  });

  it("renders a chart, or says there is nothing to draw", () => {
    const { unmount } = render(<TimeSeriesWidget data={data} timezone={TZ} />);
    expect(screen.getByTestId("chart")).toHaveAttribute("data-kind", "line");
    unmount();
    render(<TimeSeriesWidget data={seriesData({ series: [{ asset_id: 5, name: "A", points: [], estimated: false, partial: false }] })} timezone={TZ} />);
    expect(screen.getByText("No data in this range.")).toBeInTheDocument();
  });

  it("says there is nothing to draw when every bucket is silent, but draws when only some are", () => {
    const silent = (ts: string) => seriesPoint({ ts, no_data: true });
    const energy = (points: ReturnType<typeof silent>[]) => seriesData({
      source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null,
      series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points }],
    });
    const { unmount } = render(<TimeSeriesWidget data={energy([silent("2026-10-08T00:00:00+00:00"), silent("2026-10-08T01:00:00+00:00")])} timezone={TZ} />);
    expect(screen.getByText("No data in this range.")).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    unmount();
    render(<TimeSeriesWidget data={energy([silent("2026-10-08T00:00:00+00:00"), seriesPoint({ ts: "2026-10-08T01:00:00+00:00", value: 0 })])} timezone={TZ} />);
    expect(screen.getByTestId("chart")).toBeInTheDocument();
  });
});

describe("bar", () => {
  const byAsset = (rows: ReturnType<typeof valueRow>[], over: Partial<WidgetData> = {}) =>
    valuesData({ type: "bar", source: "energy", metric: null, unit: "kWh", values: rows, ...over });

  it("draws one bar per asset, marking estimated and partial ones, with nothing but a dash label for a missing figure", () => {
    const data = byAsset([
      valueRow({ name: "LV Panel 1", value: 10, point_id: null }),
      valueRow({ asset_id: 6, name: "LV Panel 2", value: null, estimated: true, point_id: null }),
    ]);
    const option = asBar(barOption(data, TZ));
    expect(option.xAxis.data).toEqual(["LV Panel 1", "LV Panel 2 ~"]);
    expect(option.series).toHaveLength(1);
    expect(option.series[0].type).toBe("bar");
    expect(option.series[0].data).toEqual([10, null]);
    // A null bar has no shape to put a label on, so the dash sits on the axis in the empty slot.
    expect(option.series[0].markPoint).toMatchObject({ label: { show: true, formatter: "—" }, data: [{ coord: [1, 0] }] });
  });

  it("adds no dash marks when every bar has a figure", () => {
    expect(barSeries(barOption(byAsset([valueRow({ value: 10 })]), TZ))[0].markPoint).toBeUndefined();
  });

  it("builds a tooltip with the figure, its markers and unit, a dash for a missing one, and escaped names", () => {
    const data = byAsset([
      valueRow({ name: "<b>A</b>", value: 10, point_id: null, estimated: true }),
      valueRow({ asset_id: 6, name: "B", value: null, point_id: null }),
    ]);
    const tip = asBar(barOption(data, TZ)).tooltip.formatter;
    const first = tip([{ name: "<b>A</b> ~", dataIndex: 0, seriesIndex: 0, marker: "" }]);
    expect(first).toContain("&lt;b&gt;A&lt;/b&gt;");
    expect(first).not.toContain("<b>");
    expect(first).toContain("~10.00 kWh");
    expect(tip([{ name: "B", dataIndex: 1, seriesIndex: 0, marker: "" }])).toContain("—");
    expect(tip([])).toBe("");
  });

  it("words a metric with no reading 'no data' and gives it no dash mark: the dash means a missing rate and nothing else", () => {
    const data = valuesData({ type: "bar", source: "metric", metric: "active_power_kw", unit: "kW", values: [
      valueRow({ name: "Live", value: 3, point_id: null }),
      valueRow({ asset_id: 6, name: "Silent", value: null, no_data: true, point_id: null }),
      valueRow({ asset_id: 7, name: "Odd", value: null, point_id: null }), // null without no_data: the dash, as before
    ] });
    const option = asBar(barOption(data, TZ));
    expect(option.series[0].data).toEqual([3, null, null]);
    expect(option.series[0].markPoint?.data).toEqual([expect.objectContaining({ coord: [2, 0] })]); // only the third slot
    const tip = option.tooltip.formatter;
    const line = (dataIndex: number) => tip([{ name: "x", dataIndex, seriesIndex: 0, marker: "" }]);
    expect(line(1)).toContain("no data");
    expect(line(1)).not.toContain("—");
    expect(line(2)).toContain("—");
    expect(line(2)).not.toContain("no data");
  });

  it("marks no dash at all when the only missing figures are metrics that recorded nothing", () => {
    const silent = valuesData({ type: "bar", source: "metric", metric: "active_power_kw", unit: "kW", values: [
      valueRow({ name: "Live", value: 3, point_id: null }),
      valueRow({ asset_id: 6, name: "Quiet", value: null, no_data: true, point_id: null }),
    ] });
    expect(barSeries(barOption(silent, TZ))[0].markPoint).toBeUndefined();
  });

  it("keeps the dash for a cost without a rate even when it also recorded nothing, as stat, table and Billing do", () => {
    const unpriced = valuesData({ type: "bar", source: "cost", metric: null, unit: "QAR", values: [
      valueRow({ name: "Live", value: 3, point_id: null }),
      valueRow({ asset_id: 6, name: "Quiet", value: null, no_data: true, point_id: null }),
    ] });
    const option = asBar(barOption(unpriced, TZ));
    expect(option.series[0].markPoint?.data).toEqual([expect.objectContaining({ coord: [1, 0] })]);
    const text = option.tooltip.formatter([{ name: "Quiet", dataIndex: 1, seriesIndex: 0, marker: "" }]);
    expect(text).toContain("—");
    expect(text).not.toContain("no data");
  });

  it("still notes '(no data)' beside a zero that recorded nothing", () => {
    const data = byAsset([valueRow({ name: "Quiet", value: 0, no_data: true, point_id: null })]);
    const tip = asBar(barOption(data, TZ)).tooltip.formatter;
    expect(tip([{ name: "Quiet", dataIndex: 0, seriesIndex: 0, marker: "" }])).toContain("0.00 kWh (no data)");
  });

  const point = (ts: string, over: Parameters<typeof seriesPoint>[0] extends infer P ? Partial<P> : never = {}) => seriesPoint({ ts, ...over });
  const hourly = (series: WidgetData["series"], over: Partial<WidgetData> = {}) =>
    seriesData({ type: "bar", source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null, series, ...over });

  it("draws one bar per time bucket, grouped by asset", () => {
    const data = hourly([
      { asset_id: 5, name: "A", estimated: false, partial: false, points: [point("2026-10-08T00:00:00+00:00", { value: 1 }), point("2026-10-08T01:00:00+00:00", { value: 2 })] },
      { asset_id: 6, name: "B", estimated: false, partial: false, points: [point("2026-10-08T01:00:00+00:00", { value: 5 }), point("2026-10-08T02:00:00+00:00", { value: 6 })] },
    ]);
    const option = asBar(barOption(data, TZ));
    expect(option.xAxis.data).toEqual(["2026-10-08T00:00:00+00:00", "2026-10-08T01:00:00+00:00", "2026-10-08T02:00:00+00:00"].map((ts) => formatSiteTick(ts, TZ, "hour")));
    expect(option.series.map((s) => s.name)).toEqual(["A", "B"]);
    expect(option.series[0].data).toEqual([1, 2, null]);
    expect(option.series[1].data).toEqual([null, 5, 6]);
    expect(option.series[0].markPoint).toBeUndefined();
  });

  it("labels a bucket with no rate by a dash, but leaves a silent bucket and a bucket another asset lacks empty", () => {
    const data = hourly([
      { asset_id: 5, name: "A", estimated: false, partial: true, points: [
        point("2026-10-08T00:00:00+00:00", { value: 1 }),
        point("2026-10-08T01:00:00+00:00", { value: null, partial: true }), // consumption, no rate
        point("2026-10-08T02:00:00+00:00", { value: null, no_data: true }), // nothing recorded
      ] },
      { asset_id: 6, name: "B", estimated: false, partial: false, points: [point("2026-10-08T02:00:00+00:00", { value: 6 })] },
    ], { source: "cost", unit: "QAR" });
    const option = barSeries(barOption(data, TZ));
    expect(option[0].data).toEqual([1, null, null]);
    expect(option[0].markPoint?.data).toEqual([expect.objectContaining({ coord: [1, 0] })]);
    expect(option[1].data).toEqual([null, null, 6]);
    expect(option[1].markPoint).toBeUndefined();
  });

  it("puts the date on the category labels when a metric response spans more than a day", () => {
    const week = seriesData({
      type: "bar", range: { preset: "7d", start: "2026-10-01T06:00:00+00:00", end: "2026-10-08T06:00:00+00:00" },
      series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: [point("2026-10-07T10:00:00+00:00", { value: 1, min: 1, max: 1 })] }],
    });
    expect(asBar(barOption(week, TZ)).xAxis.data).toEqual(["10-07 13:00"]);
  });

  it("tells the time-bucket tooltip's silent buckets from its no-rate ones", () => {
    const data = hourly([{ asset_id: 5, name: "A", estimated: false, partial: true, points: [
      point("2026-10-08T00:00:00+00:00", { value: 1.5 }),
      point("2026-10-08T01:00:00+00:00", { value: null, partial: true }),
      point("2026-10-08T02:00:00+00:00", { value: null, no_data: true }),
    ] }], { source: "cost", unit: "QAR" });
    const tip = asBar(barOption(data, TZ)).tooltip.formatter;
    const line = (dataIndex: number) => tip([{ name: "x", dataIndex, seriesIndex: 0, seriesName: "A", marker: "" }]);
    expect(line(0)).toContain("A: 1.50 QAR");
    expect(line(1)).toContain("A: —");
    expect(line(2)).toBe("");
  });

  it("renders a bar chart, or says there is nothing to draw", () => {
    const { unmount } = render(<BarWidget data={valuesData({ type: "bar" })} timezone={TZ} />);
    expect(screen.getByTestId("chart")).toHaveAttribute("data-kind", "bar");
    unmount();
    const { unmount: again } = render(<BarWidget data={valuesData({ type: "bar", values: [] })} timezone={TZ} />);
    expect(screen.getByText("No data in this range.")).toBeInTheDocument();
    again();
    const silent = hourly([{ asset_id: 5, name: "A", estimated: false, partial: false, points: [point("2026-10-08T00:00:00+00:00", { no_data: true })] }]);
    render(<BarWidget data={silent} timezone={TZ} />);
    expect(screen.getByText("No data in this range.")).toBeInTheDocument();
  });
});

describe("bar per asset when no asset has a reading", () => {
  const rows = (...over: Parameters<typeof valueRow>[0][]) => over.map((o, i) => valueRow({ asset_id: 5 + i, name: `Asset ${i}`, point_id: null, ...o }));
  const metric = (values: ReturnType<typeof valueRow>[]) => valuesData({ type: "bar", source: "metric", metric: "active_power_kw", unit: "kW", values });

  it("says there is nothing to draw when every asset is a metric with no reading, instead of empty axes", () => {
    render(<BarWidget data={metric(rows({ value: null, no_data: true }, { value: null, no_data: true }))} timezone={TZ} />);
    expect(screen.getByText("No data in this range.")).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
  });

  it("still draws when one asset has a reading, or when a null is a missing rate or a metric null that was not marked silent", () => {
    const { unmount } = render(<BarWidget data={metric(rows({ value: null, no_data: true }, { value: 2 }))} timezone={TZ} />);
    expect(screen.getByTestId("chart")).toBeInTheDocument();
    unmount();
    const cost = valuesData({ type: "bar", source: "cost", metric: null, unit: "QAR", values: rows({ value: null, no_data: true }, { value: null }) });
    const second = render(<BarWidget data={cost} timezone={TZ} />); // dashes: a missing rate is something to show
    expect(screen.getByTestId("chart")).toBeInTheDocument();
    second.unmount();
    render(<BarWidget data={metric(rows({ value: null }))} timezone={TZ} />); // not marked silent: the dash, as before
    expect(screen.getByTestId("chart")).toBeInTheDocument();
  });
});

describe("gauge", () => {
  type GaugeOpt = { series: { type: string; min: number; max: number; pointer: { show: boolean }; progress: { show: boolean }; data: { value: number }[]; detail: { formatter: () => string; color?: string } }[] };
  const gauge = (args: Partial<Parameters<typeof gaugeOption>[0]> = {}) =>
    gaugeOption({ value: 12.5, min: 0, max: 100, unit: "kW", name: "LV Panel 1", ...args }) as unknown as GaugeOpt;

  it("uses the configured range, the unit and the markers of the figure", () => {
    const option = gauge();
    expect(option.series[0]).toMatchObject({ type: "gauge", min: 0, max: 100, data: [{ value: 12.5 }], pointer: { show: true }, progress: { show: true } });
    expect(option.series[0].detail.formatter()).toBe("12.50 kW");
    expect(gauge({ estimated: true, partial: true }).series[0].detail.formatter()).toBe("~12.50* kW");
  });

  it("draws no needle and no progress for a missing figure, only a dash, never a zero", () => {
    const empty = gauge({ value: null, min: 10, max: 20 });
    expect(empty.series[0].pointer.show).toBe(false);
    expect(empty.series[0].progress.show).toBe(false);
    expect(empty.series[0].detail.formatter()).toBe("—");
    expect(gauge({ value: null, noData: true }).series[0].detail.formatter()).toBe("no data");
    expect(empty.series[0].data[0].value).toBe(10); // parked at the scale's start so the dash still has a place to show
  });

  it("dims the figure when it is stale or recorded nothing", () => {
    expect(gauge().series[0].detail.color).toBeUndefined();
    expect(gauge({ muted: true }).series[0].detail.color).toBe(MUTED_FIGURE); // the stat's muted colour, which reads at 4.5:1
  });

  it("renders the fetched value, a live value for a live gauge, and ignores the stream when not live", () => {
    const cfg = config({ aggregation: "last", min: 0, max: 200 });
    const data = valuesData({ type: "gauge" });
    const { unmount } = render(<GaugeWidget data={data} config={cfg} live={false} />);
    expect(screen.getByTestId("chart").textContent).toContain('"value":10.5');
    unmount();
    render(<LiveValuesContext.Provider value={stream(33.5)}><GaugeWidget data={data} config={cfg} live /></LiveValuesContext.Provider>);
    expect(screen.getByTestId("chart").textContent).toContain('"value":33.5');
    expect(screen.getByTestId("chart").textContent).toContain('"max":200');
  });

  it("goes back to the fetched value when the stream has dropped, and draws no needle when the live reading went bad", () => {
    const cfg = config({ aggregation: "last", min: 0, max: 200 });
    const data = valuesData({ type: "gauge" });
    const { unmount } = render(<LiveValuesContext.Provider value={stream(33.5, 0, false)}><GaugeWidget data={data} config={cfg} live /></LiveValuesContext.Provider>);
    expect(screen.getByTestId("chart").textContent).toContain('"value":10.5');
    unmount();
    render(<LiveValuesContext.Provider value={stream(7, 1)}><GaugeWidget data={data} config={cfg} live /></LiveValuesContext.Provider>);
    expect(screen.getByTestId("chart").textContent).toContain('"pointer":{"show":false}');
  });

  it("says how old a stale reading is", () => {
    const cfg = config({ aggregation: "last" });
    render(<GaugeWidget data={valuesData({ type: "gauge", values: [valueRow({ ts: minutesAgo(12), stale: true })] })} config={cfg} live={false} />);
    expect(screen.getByText("12 min ago")).toBeInTheDocument();
  });
});

describe("stat", () => {
  it("shows the figure, its unit and the asset", () => {
    render(<StatWidget data={valuesData()} live={false} />);
    expect(screen.getByText("10.50")).toBeInTheDocument();
    expect(screen.getByText("kW")).toBeInTheDocument();
    expect(screen.getByText("LV Panel 1")).toBeInTheDocument();
    expect(screen.getByText("10.50")).not.toHaveClass("muted");
  });

  it("marks estimated (~) and partial (*) figures and says what the markers mean", () => {
    const row = valueRow({ value: 12.3, estimated: true, partial: true, point_id: null });
    render(<StatWidget data={valuesData({ source: "cost", unit: "QAR", values: [row] })} live={false} />);
    expect(screen.getByText("~12.30*")).toBeInTheDocument();
    expect(screen.getByText("QAR")).toBeInTheDocument();
    expect(screen.getByText("~ estimated, * partial, some hours have no rate")).toBeInTheDocument();
  });

  it("shows a dash when there is no figure or no asset", () => {
    const row = valueRow({ value: null, estimated: true, point_id: null });
    const { unmount } = render(<StatWidget data={valuesData({ values: [row] })} live={false} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    unmount();
    render(<StatWidget data={valuesData({ values: [] })} live={false} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("mutes a figure that recorded nothing, and says so in its title", () => {
    render(<StatWidget data={valuesData({ source: "energy", metric: null, unit: "kWh", values: [valueRow({ value: 0, no_data: true, point_id: null })] })} live={false} />);
    expect(screen.getByText("0.00")).toHaveClass("muted");
    expect(screen.getByText("0.00")).toHaveAttribute("title", "no data");
  });

  it("says 'no data' for a metric with no reading, not the dash that means a missing rate", () => {
    render(<StatWidget data={valuesData({ values: [valueRow({ value: null, no_data: true, point_id: null })] })} live={false} />);
    const big = screen.getByTitle("no data");
    expect(big).toHaveClass("muted");
    expect(big).toHaveTextContent(/^no data$/);
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("keeps the muted dash for a cost without a rate that also recorded nothing, as Billing does, and titles it", () => {
    render(<StatWidget data={valuesData({ source: "cost", metric: null, unit: "QAR", values: [valueRow({ value: null, no_data: true, point_id: null })] })} live={false} />);
    const big = screen.getByTitle("no data");
    expect(big).toHaveClass("muted");
    expect(big).toHaveTextContent("—");
  });

  it("gives a measured figure no title", () => {
    render(<StatWidget data={valuesData()} live={false} />);
    expect(screen.getByText("10.50")).not.toHaveAttribute("title");
  });

  it("dims a stale reading and says how old it is", () => {
    render(<StatWidget data={valuesData({ values: [valueRow({ ts: minutesAgo(12), stale: true })] })} live={false} />);
    expect(screen.getByText("10.50")).toHaveClass("muted");
    expect(screen.getByText("12 min ago")).toBeInTheDocument();
  });

  it("shows no age for a fresh reading", () => {
    render(<StatWidget data={valuesData({ values: [valueRow({ ts: minutesAgo(0), stale: false })] })} live={false} />);
    expect(screen.queryByText(/ago|just now/)).not.toBeInTheDocument();
  });

  it("follows the stream only when live", () => {
    const { unmount } = render(<LiveValuesContext.Provider value={stream(11.25)}><StatWidget data={valuesData()} live /></LiveValuesContext.Provider>);
    expect(screen.getByText("11.25")).toBeInTheDocument();
    unmount();
    render(<LiveValuesContext.Provider value={stream(11.25)}><StatWidget data={valuesData()} live={false} /></LiveValuesContext.Provider>);
    expect(screen.getByText("10.50")).toBeInTheDocument();
  });

  it("says 'no data' when the live reading is bad, exactly as for a fetched row that recorded nothing", () => {
    const silent = valuesData({ values: [valueRow({ value: null, no_data: true })] });
    const fetched = render(<StatWidget data={silent} live={false} />);
    const before = screen.getByTitle("no data");
    const shown = { text: before.textContent, muted: before.classList.contains("muted") };
    fetched.unmount();
    // a good fetch, then a bad stream sample: the meter's reads are failing
    render(<LiveValuesContext.Provider value={stream(7, 1)}><StatWidget data={valuesData()} live /></LiveValuesContext.Provider>);
    const after = screen.getByTitle("no data");
    expect(after.textContent).toBe("no data");
    expect({ text: after.textContent, muted: after.classList.contains("muted") }).toEqual(shown);
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("goes back to the fetched figure when the stream has dropped", () => {
    render(<LiveValuesContext.Provider value={stream(11.25, 0, false)}><StatWidget data={valuesData()} live /></LiveValuesContext.Provider>);
    expect(screen.getByText("10.50")).toBeInTheDocument();
  });

  it("treats a streamed value as fresh and takes its age from the stream, whatever the fetched row says", () => {
    const row = valueRow({ ts: "2026-10-08T10:20:00.000000+03:00", stale: true, no_data: false });
    render(<LiveValuesContext.Provider value={stream(11.25, 0, true, "2026-10-08T07:30:00.000Z")}><StatWidget data={valuesData({ values: [row] })} live /></LiveValuesContext.Provider>);
    expect(screen.getByText("11.25")).not.toHaveClass("muted");
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
  });

  it("keeps the fetched, newer reading and its staleness when the stream entry is older", () => {
    const row = valueRow({ ts: "2026-10-08T10:20:00.000000+03:00", stale: true });
    render(<LiveValuesContext.Provider value={stream(11.25, 0, true, "2026-10-08T07:10:00.000Z")}><StatWidget data={valuesData({ values: [row] })} live /></LiveValuesContext.Provider>);
    expect(screen.getByText("10.50")).toHaveClass("muted");
    expect(screen.getByText(/ago/)).toBeInTheDocument();
  });
});

describe("table", () => {
  it("lists one row per asset with markers and dashes", () => {
    const data = valuesData({ type: "table", unit: "kWh", source: "energy", metric: null, values: [
      valueRow({ name: "LV Panel 1", value: 10.5, point_id: null }),
      valueRow({ asset_id: 6, name: "LV Panel 2", value: 4.25, estimated: true, point_id: null }),
      valueRow({ asset_id: 7, name: "LV Panel 3", value: null, point_id: null }),
    ] });
    render(<TableWidget data={data} />);
    expect(screen.getByRole("columnheader", { name: "Value (kWh)" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /LV Panel 1/ })).toHaveTextContent("10.50");
    expect(screen.getByRole("row", { name: /LV Panel 2/ })).toHaveTextContent("~4.25");
    expect(screen.getByRole("row", { name: /LV Panel 3/ })).toHaveTextContent("—");
    expect(screen.getByText("~ estimated")).toBeInTheDocument();
  });

  it("mutes the figure of an asset that recorded nothing and dims a stale reading with its age", () => {
    const data = valuesData({ type: "table", values: [
      valueRow({ name: "Quiet", value: 0, no_data: true, point_id: null }),
      valueRow({ asset_id: 6, name: "Old", value: 3, ts: minutesAgo(12), stale: true }),
      valueRow({ asset_id: 7, name: "Fresh", value: 4 }),
    ] });
    render(<TableWidget data={data} />);
    expect(screen.getByRole("row", { name: /Quiet/ }).lastElementChild).toHaveClass("muted");
    expect(screen.getByRole("row", { name: /Old/ }).lastElementChild).toHaveClass("muted");
    expect(screen.getByRole("row", { name: /Old/ })).toHaveTextContent("12 min ago");
    expect(screen.getByRole("row", { name: /Fresh/ }).lastElementChild).not.toHaveClass("muted");
  });

  it("says 'no data' with a title for a metric with no reading, and titles a muted zero", () => {
    const rows = [
      valueRow({ name: "Silent", value: null, no_data: true, point_id: null }),
      valueRow({ asset_id: 6, name: "Zero", value: 0, no_data: true, point_id: null }),
      valueRow({ asset_id: 7, name: "Fine", value: 4, point_id: null }),
    ];
    render(<TableWidget data={valuesData({ type: "table", values: rows })} />);
    const cell = (name: RegExp) => screen.getByRole("row", { name }).lastElementChild!;
    expect(cell(/Silent/)).toHaveTextContent(/^no data$/);
    expect(cell(/Silent/)).toHaveClass("muted");
    expect(cell(/Silent/)).toHaveAttribute("title", "no data");
    expect(cell(/Zero/)).toHaveTextContent("0.00");
    expect(cell(/Zero/)).toHaveAttribute("title", "no data");
    expect(cell(/Fine/)).not.toHaveAttribute("title");
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("keeps the muted dash, titled, for a cost without a rate that also recorded nothing", () => {
    const rows = [valueRow({ name: "Unpriced", value: null, no_data: true, point_id: null })];
    render(<TableWidget data={valuesData({ type: "table", source: "cost", metric: null, unit: "QAR", values: rows })} />);
    const cell = screen.getByRole("row", { name: /Unpriced/ }).lastElementChild!;
    expect(cell).toHaveTextContent("—");
    expect(cell).toHaveClass("muted");
    expect(cell).toHaveAttribute("title", "no data");
  });

  it("says so when there are no assets", () => {
    render(<TableWidget data={valuesData({ type: "table", values: [] })} />);
    expect(screen.getByText("No assets.")).toBeInTheDocument();
  });
});
