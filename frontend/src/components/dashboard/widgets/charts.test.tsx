import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WidgetData } from "../../../api/types";
import { formatSiteDateTime, formatSiteTick } from "../../../lib/siteTime";
import { escapeHtml, shortLabel } from "../../../lib/widgetFormat";
import {
  breakdownBlock, breakdownData, compareAsset, compareBlock, compareSeriesData, compareSide, seriesData, seriesPoint, valueRow, valuesData,
} from "../../../test/dashboardFixtures";
import { barAxisLayout, DEFAULT_CHART_WIDTH, GRID_SIDES_PX, LABEL_LINE_PX } from "./barAxis";
import { BarWidget, barOption } from "./BarWidget";
import { LIGHT_CHART, type ChartTheme } from "./chartTheme";
import { TableWidget } from "./TableWidget";
import { bucketMs, compareOption, markIsolated, timeSeriesOption, tooltipFormatter, TimeSeriesWidget, withGaps } from "./TimeSeriesWidget";

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
/** The names of the w13 showcase (e2e/w13Showcase.ts SIX). */
const SIX = ["Rack A01", "Rack A02", "UPS-1 output", "CRAH-3 supply fan", "Chiller plant 2 condenser loop", "PDU B07"];
/** What the legend and the category axis of an option are asked to draw (S7-3). */
interface LegendOpt { show: boolean; type: string; formatter: (name: string) => string; tooltip: { show: boolean } }
const legendOf = (option: unknown) => (option as { legend: LegendOpt }).legend;
interface AxisLabelOpt { interval: number; hideOverlap?: boolean; rotate?: number; width?: number; overflow?: string; ellipsis?: string; lineHeight?: number; formatter: (value: string) => string }
interface AxisOpt { xAxis: { axisLabel: AxisLabelOpt }; grid: { left: number; top: number; bottom: number; containLabel?: boolean } }
const axisLabelOf = (option: unknown) => (option as AxisOpt).xAxis.axisLabel;
/** A tooltip as the viewer reads it: the tags taken away, the name, the value and the state of each row one after the other. */
const tipText = (html: string) => html.replace(/<\/(span|div)>/g, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const LONG = "Main-Switchboard-Feeder-Room-East-Hall-3"; // 40 characters
const LONG_2 = "Auxiliary-Distribution-Panel-Block-West"; // differs from LONG at the start, so the two shorten to different texts

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
    expect(option.series.map((s) => s.id)).toEqual(["avg-5", "band-min-5", "band-span-5"]);
    expect(option.series.find((s) => s.id === "avg-5")!.data[0]).toMatchObject({ symbol: "circle" });
    expect(option.series.find((s) => s.id === "band-min-5")!.data.every((c) => Array.isArray(c))).toBe(true);
    expect(option.series.find((s) => s.id === "band-span-5")!.data.every((c) => Array.isArray(c))).toBe(true);
  });

  it("still reads the isolated point's value in the tooltip", () => {
    const lone = seriesData({ source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null, series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 1.5 })] }] });
    const [line] = asOption(timeSeriesOption(lone, TZ)).series;
    const cell = line.data[0] as { value: Row };
    // ECharts hands the formatter the item's `value` pair as `params.value`.
    expect(tipText(tooltipFormatter(lone, TZ)([{ seriesId: "avg-5", seriesName: "A", value: cell.value, marker: "" }]))).toContain("A 1.50 kWh");
  });

  it("breaks the line where buckets are missing and where the value is null", () => {
    const rows = withGaps([...points.slice(0, 2), seriesPoint({ ts: "2026-10-08T00:02:00+00:00", no_data: true }), points[3]], 60_000, (p) => p.value);
    expect(rows.map(([, v]) => v)).toEqual([1, 2, null, null, 4]);
    expect(rows[3][0]).toBe("2026-10-08T00:03:00.000Z");
  });

  it("draws an average line per asset with a min/max band, gaps as gaps", () => {
    const option = asOption(timeSeriesOption(data, TZ));
    expect(option.series.map((s) => s.id)).toEqual(["avg-5", "band-min-5", "band-span-5"]);
    const avg = option.series.find((s) => s.id === "avg-5")!;
    expect(avg.name).toBe("LV Panel 1");
    expect(avg.connectNulls).toBe(false);
    expect(avg.data.map((c) => plain(c)[1])).toEqual([1, 2, 3, null, 4]);
    expect(plain(avg.data[3])[0]).toBe("2026-10-08T00:03:00.000Z");
    expect(option.series.find((s) => s.id === "band-min-5")!.data.map((c) => plain(c)[1])).toEqual([0.5, 1, 2, null, 3]);
    expect(option.series.find((s) => s.id === "band-span-5")!.data.map((c) => plain(c)[1])).toEqual([1, 2, 2, null, 2]);
  });

  it("shortens long names in the legend to 24 characters, with the full name in the legend's tooltip and as the series name (S7-3)", () => {
    const two = seriesData({
      series: [LONG, LONG_2].map((name, i) => ({ asset_id: 5 + i, name, estimated: false, partial: false, points }) ),
    });
    const option = timeSeriesOption(two, TZ);
    const legend = legendOf(option);
    expect(legend.type).toBe("scroll");
    expect(legend.tooltip).toEqual({ show: true });
    expect(Array.from(legend.formatter(LONG))).toHaveLength(24);
    expect(legend.formatter(LONG)).toBe(shortLabel(LONG, 24));
    expect(legend.formatter(LONG)).not.toBe(legend.formatter(LONG_2));
    expect(legend.formatter("Hall A")).toBe("Hall A");
    // the legend selects by the full name: the series and the legend data keep it
    expect((option as unknown as { legend: { data: string[] } }).legend.data).toEqual([LONG, LONG_2]);
    expect(asOption(option).series.filter((s) => s.id?.startsWith("avg-")).map((s) => s.name)).toEqual([LONG, LONG_2]);
  });

  it("shows the full label of two names that would shorten to the same legend entry", () => {
    const a = "Main-Switchboard-Feeder-01-Room-East-Hall-Annex"; // identical start and end, different middle
    const b = "Main-Switchboard-Feeder-02-Room-East-Hall-Annex";
    expect(shortLabel(a, 24)).toBe(shortLabel(b, 24));
    const legend = legendOf(timeSeriesOption(seriesData({
      series: [a, b].map((name, i) => ({ asset_id: 5 + i, name, estimated: false, partial: false, points })),
    }), TZ));
    expect(legend.formatter(a)).toBe(a);
    expect(legend.formatter(b)).toBe(b);
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
      { seriesId: "band-min-5", seriesName: "LV Panel 1", value: ["2026-10-08T00:01:00+00:00", 1], marker: "<i>m</i>" }, // W13: a band carries its line's name
      { seriesId: "avg-5", seriesName: "<b>LV</b> Panel 1", value: ["2026-10-08T00:01:00+00:00", 2], marker: "<i>m</i>" },
    ]);
    expect(html).toContain("&lt;b&gt;LV&lt;/b&gt; Panel 1");
    expect(html).not.toContain("<b>");
    expect(html.match(/justify-content:space-between/g)).toHaveLength(1); // one row: the band's helper series adds none
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
    // The rows are the name on the left and the value on the right; tipText reads them one after the other. W13 adds the state in words after the value.
    const first = tipText(tip([item(5, "A", "2026-10-08T00:00:00+00:00", 0.5), item(6, "B", "2026-10-08T00:00:00+00:00", 1.25)]));
    expect(first).toContain("A 0.50* QAR partial");
    expect(first).toContain("B ~1.25 QAR estimated");
    const noRate = tipText(tip([item(5, "A", "2026-10-08T01:00:00+00:00", null), item(6, "B", "2026-10-08T01:00:00+00:00", 2)]));
    expect(noRate).toContain("A — partial, no rate"); // the bucket is partial too (it has consumption but no rate)
    expect(noRate).not.toContain("A — QAR");
    expect(noRate).toContain("B 2.00 QAR");
    expect(noRate).not.toContain("B 2.00 QAR estimated"); // a bucket with no marker says nothing about a state
    const silent = tipText(at("2026-10-08T02:00:00+00:00"));
    expect(silent).not.toMatch(/\bA\b/);
    expect(silent).toMatch(/\bB\b/);
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

  it("wraps long asset names on the category axis, with every label drawn and the full name in the tooltip (S7-3, w14 P1)", () => {
    const name = "Main <Switchboard> Feeder 01 Room East Hall"; // 43 characters, and a name that must be escaped
    const option = barOption(byAsset([valueRow({ name, value: 3 }), valueRow({ asset_id: 6, name: "Hall A", value: 4 })]), TZ);
    const axis = axisLabelOf(option);
    expect(axis.interval).toBe(0);
    const wrapped = axis.formatter(name);
    expect(wrapped).toContain("\n"); // wrapped into lines, not cut
    expect(wrapped.split("\n").length).toBeLessThanOrEqual(3);
    expect(wrapped.replace(/\n/g, " ")).toBe(name); // nothing of the name is lost: the breaks fall between words
    expect(axis.formatter("Hall A")).toBe("Hall A");
    expect(asBar(option).xAxis.data).toEqual([name, "Hall A"]); // the data keeps the full names
    const header = asBar(option).tooltip.formatter([{ name, dataIndex: 0, seriesIndex: 0, marker: "" }]);
    expect(header).toContain(escapeHtml(name));
    expect(header).not.toContain("<Switchboard>");
  });

  it("keeps two names that would wrap to the same text apart, each with its whole text, over one more line", () => {
    const a = "Main feeder room A01 east hall";
    const b = "Main feeder room A02 east hall";
    const others = ["H1", "H2", "H3", "H4"].map((name, i) => valueRow({ asset_id: 10 + i, name }));
    const axis = axisLabelOf(barOption(byAsset([valueRow({ name: a }), valueRow({ asset_id: 6, name: b }), ...others]), TZ));
    expect(axis.formatter(a)).not.toBe(axis.formatter(b));
    expect(axis.formatter(a).split("\n").length).toBeLessThanOrEqual(4);
    expect(axis.formatter(a)).toContain("A01");
    expect(axis.formatter(b)).toContain("A02");
  });

  it("draws the six assets of the showcase, one of them with no data, each in its own slot with its label", () => {
    const six = byAsset(SIX.map((name, i) => valueRow({
      asset_id: 20 + i, name, point_id: null,
      ...(i === 4 ? { value: null, no_data: true } : { value: 20 + i * 11.5 }),
      ...(i === 1 ? { estimated: true } : {}),
    })), { source: "metric", metric: "active_power_kw", unit: "kW" });
    const option = asBar(barOption(six, TZ));
    expect(option.xAxis.data).toHaveLength(6);
    expect(option.series[0].data[4]).toBeNull(); // the slot stays, empty, and keeps its label
    const axis = axisLabelOf(option);
    const layout = barAxisLayout(option.xAxis.data!, DEFAULT_CHART_WIDTH);
    expect(layout.mode).toBe("wrap");
    for (const label of option.xAxis.data!) {
      expect(axis.formatter(label)).toBe(layout.labels.get(label));
      expect(axis.formatter(label).trim()).not.toBe("");
    }
    expect(axis.formatter(option.xAxis.data![4])).toContain("Chiller"); // the no-data asset keeps its (wrapped) name
    expect(axis.formatter(option.xAxis.data![1])).toMatch(/~$/); // the estimated one keeps its marker
  });

  it("follows the layout in the value-mode axis: wrapped, every label drawn, truncating only as a net, the room under the plot from the lines", () => {
    const six = byAsset(SIX.map((name, i) => valueRow({ asset_id: 20 + i, name, value: 10 + i })));
    const option = barOption(six, TZ) as unknown as AxisOpt;
    const layout = barAxisLayout(SIX.map((name) => name), DEFAULT_CHART_WIDTH);
    const axis = option.xAxis.axisLabel;
    expect(layout.mode).toBe("wrap");
    expect(axis.interval).toBe(0);
    expect(axis.hideOverlap).toBeUndefined(); // wrapped names never overlap, so nothing is hidden
    expect(axis.rotate).toBeUndefined();
    expect(axis.width).toBeCloseTo((DEFAULT_CHART_WIDTH - GRID_SIDES_PX) / 6 - 4, 5);
    expect(axis.overflow).toBe("truncate");
    expect(axis.ellipsis).toBe("…");
    expect(axis.lineHeight).toBe(LABEL_LINE_PX);
    expect(option.grid.bottom).toBe(layout.bottom);
    expect(option.grid.left).toBe(60); // wrapped: the slots are counted from this edge, and no containLabel (the room under the plot is the lines')
    expect(option.grid.containLabel).toBeUndefined();
  });

  it("rotates the labels of a crowded axis, and then lets the chart hide the ones that overlap and contain the rotated text", () => {
    const names = Array.from({ length: 20 }, (_, i) => `Distribution panel number ${i + 1}`);
    const option = barOption(byAsset(names.map((name, i) => valueRow({ asset_id: 30 + i, name }))), TZ) as unknown as AxisOpt;
    const axis = option.xAxis.axisLabel;
    expect(axis.interval).toBe(0);
    expect(axis.rotate).toBe(40);
    expect(axis.hideOverlap).toBe(true);
    expect(axis.width).toBeUndefined();
    expect(axis.overflow).toBeUndefined();
    // containLabel fits the turned names INSIDE the rectangle that left/bottom describe, so those are only margins (a big bottom would count the
    // names' room twice and leave a third of the card blank, review finding 1).
    expect(option.grid.containLabel).toBe(true);
    expect(option.grid.bottom).toBe(8);
    expect(option.grid.left).toBe(barAxisLayout(names, DEFAULT_CHART_WIDTH).left); // 12 for a short first name, more for a long one (see rotatedLeft)
    expect(option.grid.left).toBeLessThanOrEqual(Math.floor(DEFAULT_CHART_WIDTH * 0.4));
    expect(Array.from(axis.formatter(names[0])).length).toBeLessThanOrEqual(18); // the shortened form of the rotated mode
  });

  it("lays the axis out for the chart width it is given: the same six names wrap in a wider card and rotate in a narrow one", () => {
    const six = byAsset(SIX.map((name, i) => valueRow({ asset_id: 20 + i, name, value: 10 + i })));
    const wide = barOption(six, TZ, LIGHT_CHART, 880) as unknown as AxisOpt;
    const narrow = barOption(six, TZ, LIGHT_CHART, 330) as unknown as AxisOpt;
    expect(wide.xAxis.axisLabel.width).toBeCloseTo((880 - GRID_SIDES_PX) / 6 - 4, 5);
    expect(wide.xAxis.axisLabel.rotate).toBeUndefined();
    expect(narrow.xAxis.axisLabel.rotate).toBe(40);
    expect(wide.grid.bottom).toBeLessThanOrEqual(barAxisLayout(SIX, 480).bottom);
  });

  it("lays the axis out for the chart height too (w27 P1): a minimum-height card keeps its plot, the names are cut or left off, the unit's name keeps its room", () => {
    const names = ["Rack 35 / Feed A", "Rack 14 / Feed A", "Rack 19 / Feed A", "Rack 04 / Feed B (#16)", "Rack 03 / Feed B", "Rack 22 / Feed A", "Rack 12 / Feed B", "Rack 38 / Feed A"];
    const racks = byAsset(names.map((name, i) => valueRow({ asset_id: 40 + i, name, value: 1_000 + i * 500 })));
    type Opt = AxisOpt & { yAxis: { name?: string; nameGap?: number } };
    const roomy = barOption(racks, TZ, LIGHT_CHART, 427) as unknown as Opt;
    const short = barOption(racks, TZ, LIGHT_CHART, 427, undefined, undefined, 124) as unknown as Opt;
    const medium = barOption(racks, TZ, LIGHT_CHART, 427, undefined, undefined, 240) as unknown as Opt;
    expect(roomy.grid.top).toBe(30);
    expect(roomy.yAxis.nameGap).toBeUndefined(); // the library's own gap
    expect(roomy.xAxis.axisLabel.rotate).toBe(40);
    // A 124 px chart cannot hold eight characters of a turned name under a plot of 60 px: no names, the plot takes the room, the y numbers keep theirs (containLabel).
    expect(short.grid.top).toBe(24);
    expect(short.yAxis.nameGap).toBe(6); // the unit's name is not cut at the picture's top
    expect(short.yAxis.name).toBe("kWh");
    expect(short.xAxis.axisLabel).toMatchObject({ show: false });
    expect(short.grid.containLabel).toBe(true);
    expect(short.grid.bottom).toBe(8);
    // Cut names are the same cuts the width-only layout makes, only shorter: the full names stay in the category data (tooltip, clicks, text alternative).
    expect(medium.xAxis.axisLabel.rotate).toBe(40);
    const shownMedium = Array.from(medium.xAxis.axisLabel.formatter(names[3])).length;
    expect(shownMedium).toBeLessThan(Array.from(roomy.xAxis.axisLabel.formatter(names[3])).length + 1);
    expect(asBar(short).xAxis.data).toEqual(names);
    expect(asBar(medium).xAxis.data).toEqual(names);
    expect(asBar(short).tooltip.formatter([{ name: names[3], dataIndex: 3, seriesIndex: 0, marker: "" }])).toContain(escapeHtml(names[3]));
  });

  it("leaves the time-bucket mode alone: its axis shows times, with no wrapping, and its grid is not the label grid", () => {
    const data = seriesData({ type: "bar", source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null, series: [
      { asset_id: 5, name: LONG, estimated: false, partial: false, points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 1 })] },
    ] });
    const option = barOption(data, TZ, LIGHT_CHART, 330) as unknown as AxisOpt;
    expect(option.xAxis.axisLabel.formatter).toBeUndefined();
    expect(option.xAxis.axisLabel.rotate).toBeUndefined();
    expect(option.grid.bottom).toBe(30);
  });

  it("shortens the legend of the bar chart per time bucket to 24 characters, with the full name as the series name", () => {
    const data = hourly([LONG, LONG_2].map((name, i) => ({
      asset_id: 5 + i, name, estimated: false, partial: false, points: [point("2026-10-08T00:00:00+00:00", { value: 1 })],
    })));
    const option = barOption(data, TZ);
    const legend = legendOf(option);
    expect(legend.show).toBe(true);
    expect(legend.type).toBe("scroll");
    expect(legend.tooltip).toEqual({ show: true });
    expect(Array.from(legend.formatter(LONG))).toHaveLength(24);
    expect(legend.formatter(LONG)).not.toBe(legend.formatter(LONG_2));
    expect(asBar(option).series.map((s) => s.name)).toEqual([LONG, LONG_2]);
  });

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
    // W13: the dash is a bar of zero height in that asset's own slot (a point mark would sit at the middle of the group); the other empty buckets stay null.
    expect(option[0].data).toEqual([1, expect.objectContaining({ value: 0, itemStyle: { color: "transparent" }, label: expect.objectContaining({ show: true, formatter: "—" }) }), null]);
    expect(option[0].markPoint).toBeUndefined();
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
    const line = (dataIndex: number) => tipText(tip([{ name: "x", dataIndex, seriesIndex: 0, seriesName: "A", marker: "" }]));
    expect(line(0)).toContain("A 1.50 QAR");
    expect(line(1)).toContain("A — partial, no rate");
    expect(tip([{ name: "x", dataIndex: 2, seriesIndex: 0, seriesName: "A", marker: "" }])).toBe("");
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

  describe("the chart width the axis is laid out for (w14 P1)", () => {
    const SIX_ROWS = valuesData({ type: "bar", source: "energy", metric: null, unit: "kWh", values: SIX.map((name, i) => valueRow({ asset_id: 20 + i, name, value: 10 + i })) });
    const drawn = () => JSON.parse(screen.getByTestId("chart").textContent ?? "{}") as { xAxis: { axisLabel: { width?: number; rotate?: number } } };
    const slotWidth = (chartWidth: number) => (chartWidth - GRID_SIDES_PX) / 6 - 4;
    let boxWidth = 0;
    let fire: (() => void)[] = [];
    const original = globalThis.ResizeObserver;
    class Watcher {
      constructor(private readonly callback: ResizeObserverCallback) { fire.push(() => this.callback([], this as unknown as ResizeObserver)); }
      observe() {}
      unobserve() {}
      disconnect() { fire = []; }
    }
    beforeEach(() => {
      boxWidth = 0;
      fire = [];
      vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(() => boxWidth);
      vi.stubGlobal("ResizeObserver", Watcher);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.stubGlobal("ResizeObserver", original);
    });

    it("keeps the default 480 px when the box has no width yet (jsdom, a server render)", () => {
      render(<BarWidget data={SIX_ROWS} timezone={TZ} />);
      expect(drawn().xAxis.axisLabel.width).toBeCloseTo(slotWidth(DEFAULT_CHART_WIDTH), 5);
    });

    it("measures the chart box in steps of 8 px, and lays the axis out again when the box is resized", () => {
      boxWidth = 885;
      render(<BarWidget data={SIX_ROWS} timezone={TZ} />);
      expect(drawn().xAxis.axisLabel.width).toBeCloseTo(slotWidth(880), 5); // 885 rounded down to 880
      expect(drawn().xAxis.axisLabel.rotate).toBeUndefined();
      boxWidth = 883; // a few pixels either way is the same step: nothing is laid out again
      act(() => fire.forEach((f) => f()));
      expect(drawn().xAxis.axisLabel.width).toBeCloseTo(slotWidth(880), 5);
      boxWidth = 330; // the card was made narrow: six names no longer fit side by side
      act(() => fire.forEach((f) => f()));
      expect(drawn().xAxis.axisLabel.rotate).toBe(40);
    });

    it("follows the chart box when the data arrives after the first render (the box did not exist for an empty chart)", () => {
      boxWidth = 880;
      const nothing = valuesData({ type: "bar", source: "energy", metric: null, unit: "kWh", values: [] });
      const { rerender } = render(<BarWidget data={nothing} timezone={TZ} />);
      expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
      rerender(<BarWidget data={SIX_ROWS} timezone={TZ} />);
      expect(drawn().xAxis.axisLabel.width).toBeCloseTo(slotWidth(880), 5);
    });

    it("draws with the default width when the browser has no ResizeObserver", () => {
      vi.stubGlobal("ResizeObserver", undefined);
      boxWidth = 880;
      render(<BarWidget data={SIX_ROWS} timezone={TZ} />);
      expect(drawn().xAxis.axisLabel.width).toBeCloseTo(slotWidth(DEFAULT_CHART_WIDTH), 5);
    });
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

describe("the charts follow the theme (W13)", () => {
  const dark: ChartTheme = {
    palette: ["#6ea8fe", "#f59a52", "#3ecf8e", "#f38bb8", "#4cc9dc", "#b49bff", "#e9c046", "#a3adbd"],
    accent: "#c9a227", axisText: "#a3adbd", axisLine: "#3a414d", grid: "#262b33", tipBg: "#262b33", tipText: "#e6e9ef", tipBorder: "#4a5261", bandOpacity: 0.22,
  };
  const asset = (id: number, name: string, extra: Partial<WidgetData["series"][number]> = {}) => ({
    asset_id: id, name, estimated: false, partial: false, ...extra,
    points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: id, min: id - 1, max: id + 1 }), seriesPoint({ ts: "2026-10-08T00:04:48+00:00", value: id + 1, min: id, max: id + 2 })],
  });
  interface Axis { axisLabel: { color: string; fontSize: number }; axisLine: { lineStyle: { color: string } }; splitLine: { lineStyle: { color: string; width: number; type: string } }; nameTextStyle: { color: string } }
  interface Themed {
    tooltip: { confine: boolean; backgroundColor: string; borderColor: string; textStyle: { color: string; fontSize: number } };
    legend: { textStyle: { color: string; fontSize: number }; icon: string };
    xAxis: Axis; yAxis: Axis;
    series: { id?: string; name?: string; color?: string; z?: number; lineStyle?: { type?: string; width?: number; opacity?: number }; areaStyle?: { color: string; opacity: number }; data: unknown[] }[];
  }
  const themed = (option: unknown) => option as Themed;

  it("takes the series colours, the axis ink, the grid and the tooltip from the theme it is given", () => {
    const option = themed(timeSeriesOption(seriesData({ series: [asset(5, "A"), asset(6, "B")] }), TZ, dark));
    expect(option.series.filter((s) => s.id?.startsWith("avg-")).map((s) => s.color)).toEqual(["#6ea8fe", "#f59a52"]);
    for (const axis of [option.xAxis, option.yAxis]) {
      expect(axis.axisLabel).toMatchObject({ color: "#a3adbd", fontSize: 12 });
      expect(axis.axisLine.lineStyle.color).toBe("#3a414d");
      expect(axis.splitLine.lineStyle).toEqual({ color: "#262b33", width: 1, type: "solid" });
    }
    expect(option.yAxis.nameTextStyle.color).toBe("#a3adbd");
    expect(option.legend.textStyle).toEqual({ color: "#a3adbd", fontSize: 12 });
    expect(option.tooltip).toMatchObject({ confine: true, backgroundColor: "#262b33", borderColor: "#4a5261", textStyle: { color: "#e6e9ef", fontSize: 13 } });
  });

  it("colours a chart of one series with the accent, and draws 2px lines", () => {
    const one = themed(timeSeriesOption(seriesData(), TZ, dark));
    const line = one.series.find((s) => s.id === "avg-5")!;
    expect(line.color).toBe("#c9a227");
    expect(line.lineStyle).toEqual({ width: 2, type: "solid" });
  });

  it("draws series 6 to 8 dashed and 9 and later dotted in colours 1 to 5", () => {
    const many = themed(timeSeriesOption(seriesData({
      source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null,
      series: Array.from({ length: 10 }, (_, i) => asset(10 + i, `S${i}`)),
    }), TZ, dark));
    expect(many.series.map((s) => s.lineStyle?.type)).toEqual([...Array(5).fill("solid"), "dashed", "dashed", "dashed", "dotted", "dotted"]);
    expect(many.series.map((s) => s.color)).toEqual([...dark.palette, dark.palette[0], dark.palette[1]]);
  });

  it("gives a line's band its name and colour and a lower z, so one legend entry switches both and the line stays on top", () => {
    const option = themed(timeSeriesOption(seriesData({ series: [asset(5, "A"), asset(6, "B", { estimated: true })] }), TZ, dark));
    const byId = (id: string) => option.series.find((s) => s.id === id)!;
    expect(option.series.map((s) => s.id)).toEqual(["avg-5", "band-min-5", "band-span-5", "avg-6", "band-min-6", "band-span-6"]);
    for (const [id, name, color] of [[5, "A", "#6ea8fe"], [6, "B ~", "#f59a52"]] as const) {
      expect(byId(`avg-${id}`)).toMatchObject({ name, color, z: 3 });
      for (const band of ["band-min", "band-span"]) expect(byId(`${band}-${id}`)).toMatchObject({ name, color, z: 2, lineStyle: { opacity: 0 } });
      expect(byId(`band-span-${id}`).areaStyle).toEqual({ color, opacity: 0.22 });
    }
    expect((option as unknown as { legend: { data: string[] } }).legend.data).toEqual(["A", "B ~"]); // the line's name is the entry; the bands add none
  });

  it("draws the marker of a no-rate row in its series' colour: the dash bar is transparent, and so would be the marker ECharts builds from it", () => {
    const cost = seriesData({ type: "bar", source: "cost", unit: "QAR", metric: null, bucket: "hour", tier: null, series: [
      { ...asset(5, "A"), points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 1 })] },
      { ...asset(6, "B"), points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: null, partial: true })] },
    ] });
    const tip = asBar(barOption(cost, TZ, dark)).tooltip.formatter;
    const html = tip([
      { name: "x", dataIndex: 0, seriesIndex: 0, seriesName: "A", marker: "<i>real</i>" },
      { name: "x", dataIndex: 0, seriesIndex: 1, seriesName: "B", marker: "<i>transparent</i>" },
    ]);
    expect(html).toContain("<i>real</i>"); // a row with a bar keeps the marker ECharts gave it
    expect(html).not.toContain("<i>transparent</i>");
    expect(html).toContain("background-color:#f59a52"); // B's own colour, the second of the theme's palette
  });

  it("colours the bars by series (the accent for one), square legend icons, and the dash with the axis ink", () => {
    const grouped = themed(barOption(seriesData({ type: "bar", series: [asset(5, "A"), asset(6, "B")] }), TZ, dark));
    expect(grouped.series.map((s) => s.color)).toEqual(["#6ea8fe", "#f59a52"]);
    expect(grouped.legend.icon).toBe("roundRect");
    expect(themed(barOption(seriesData({ type: "bar" }), TZ, dark)).series[0].color).toBe("#c9a227");
    const byAsset = barOption(valuesData({ type: "bar", source: "cost", metric: null, unit: "QAR", values: [valueRow({ value: null, point_id: null })] }), TZ, dark);
    expect(barSeries(byAsset)[0].markPoint).toMatchObject({ label: { color: "#a3adbd" } });
    expect(themed(byAsset).series[0].color).toBe("#c9a227");
  });

  it("says the state in words beside the marker in a bar's tooltip: estimated, partial, no rate", () => {
    const rows = [
      valueRow({ name: "A", value: 10, estimated: true, point_id: null }),
      valueRow({ asset_id: 6, name: "B", value: 4, partial: true, point_id: null }),
      valueRow({ asset_id: 7, name: "C", value: null, point_id: null }),
      valueRow({ asset_id: 8, name: "D", value: 2, point_id: null }),
    ];
    const tip = asBar(barOption(valuesData({ type: "bar", source: "cost", metric: null, unit: "QAR", values: rows }), TZ)).tooltip.formatter;
    const at = (dataIndex: number) => tipText(tip([{ name: "x", dataIndex, seriesIndex: 0, marker: "" }]));
    expect(at(0)).toContain("~10.00 QAR estimated");
    expect(at(1)).toContain("4.00* QAR partial");
    expect(at(2)).toContain("— no rate");
    expect(at(3)).toContain("2.00 QAR");
    expect(at(3)).not.toMatch(/estimated|partial|no rate/);
  });

  describe("the widgets", () => {
    const ROOT = document.documentElement;
    afterEach(() => {
      ROOT.style.removeProperty("--chart-axis-text");
      ROOT.removeAttribute("data-mode");
    });

    it("wrap the canvas in a picture with a name, so a screen reader hears what the chart is", () => {
      const { unmount } = render(<TimeSeriesWidget data={seriesData({ series: [asset(5, "A"), asset(6, "B")] })} timezone={TZ} />);
      const line = screen.getByRole("img");
      expect(line).toHaveClass("widget-chart");
      expect(line).toHaveAccessibleName(/^Line chart of 2 assets: A, B\. active_power_kw in kW, Last 24 hours\./);
      unmount();
      render(<BarWidget data={valuesData({ type: "bar" })} timezone={TZ} />);
      expect(screen.getByRole("img")).toHaveAccessibleName(/^Bar chart of 1 asset: LV Panel 1\./);
    });

    it("say 'No data in this range.' as a widget empty state, not a picture", () => {
      render(<BarWidget data={valuesData({ type: "bar", values: [] })} timezone={TZ} />);
      expect(screen.getByText("No data in this range.")).toHaveClass("widget-empty");
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("draw again in the new colours when the mode changes, without a reload", async () => {
      render(<TimeSeriesWidget data={seriesData()} timezone={TZ} />);
      const colours = () => JSON.parse(screen.getByTestId("chart").textContent!).yAxis.axisLabel.color as string;
      expect(colours()).toBe(LIGHT_CHART.axisText);
      await act(async () => {
        ROOT.style.setProperty("--chart-axis-text", "#a3adbd");
        ROOT.setAttribute("data-mode", "dark");
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(colours()).toBe("#a3adbd");
    });
  });
});

describe("the daily chart of a comparison (w24)", () => {
  interface CompareSeries { id: string; name: string; type: string; lineStyle: { type: string }; connectNulls: boolean; data: (number | null | { value: number; symbol: string })[] }
  interface CompareOpt { legend: { show: boolean; data: string[] }; xAxis: { type: string; data: string[] }; series: CompareSeries[]; tooltip: { formatter: (params: unknown) => string } }
  const opt = (data = compareSeriesData(3, 3)) => compareOption(data, TZ) as unknown as CompareOpt;
  const tip = (option: CompareOpt, dataIndex: number) =>
    option.tooltip.formatter([{ dataIndex, seriesIndex: 0, marker: "" }, { dataIndex, seriesIndex: 1, marker: "" }]);
  /** The tooltip's rows as "date | figure": a row is a div of two spans, the date on the left and the figure with its state in words on the right. */
  const rows = (html: string) => [...new DOMParser().parseFromString(html, "text/html").body.querySelectorAll(":scope > div")]
    .map((row) => [...row.children].map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()).join(" | "));

  it("is a category axis by day of the month with two lines named by their months, last month dashed", () => {
    const option = opt(compareSeriesData(3, 3));
    expect(option.xAxis).toMatchObject({ type: "category", data: ["1", "2", "3"] });
    expect(option.series.map((s) => [s.name, s.type, s.lineStyle.type])).toEqual([["October", "line", "solid"], ["September", "line", "dashed"]]);
    expect(option.legend).toMatchObject({ show: true, data: ["October", "September"] });
    expect(option.series[0].data).toEqual([100, 101, 102]);
    expect(option.series[1].data).toEqual([90, 91, 92]);
  });

  it("spans the larger of the two windows, with a gap where a side has no day", () => {
    const option = opt(compareSeriesData(31, 28));
    expect(option.xAxis.data).toHaveLength(31);
    expect(option.series[1].data.slice(27, 31)).toEqual([117, null, null, null]);
    const wide = opt(compareSeriesData(2, 5));
    expect(wide.xAxis.data).toHaveLength(5);
    expect(wide.series[0].data.slice(2)).toEqual([null, null, null]);
  });

  it("draws a day with no readings as a gap and never as a zero", () => {
    const data = compareSeriesData(4, 4);
    data.series[0].points[1] = seriesPoint({ ts: "2026-10-02T00:00:00+03:00", value: null, no_data: true });
    data.compare!.assets[0].last_points[2] = seriesPoint({ ts: "2026-09-03T00:00:00+03:00", value: 0, no_data: true });
    const option = opt(data);
    expect(option.series[0].data[1]).toBeNull();
    expect(option.series[1].data[2]).toBeNull();
    expect(option.series.every((s) => s.connectNulls === false)).toBe(true);
  });

  it("gives a lone point a dot of its own (the 2nd of the month has one day on each line)", () => {
    const option = opt(compareSeriesData(1, 1));
    expect(option.series[0].data).toEqual([{ value: 100, symbol: "circle", symbolSize: 6 }]);
    expect(option.series[1].data).toEqual([{ value: 90, symbol: "circle", symbolSize: 6 }]);
    const joined = opt(compareSeriesData(3, 3));
    expect(joined.series[0].data.every((d) => typeof d === "number")).toBe(true);
  });

  it("names both dates of the day in the tooltip, each with its figure", () => {
    expect(rows(tip(opt(), 2))).toEqual(["3 Oct | 102.00 kWh", "3 Sep | 92.00 kWh"]);
  });

  it("marks each side's figure: ~ for an estimate, the state in words, and * for a partial cost", () => {
    const data = compareSeriesData(2, 2, { source: "cost", unit: "QAR" });
    data.series[0].points[1] = seriesPoint({ ts: "2026-10-02T00:00:00+03:00", value: 5, estimated: true, partial: true });
    data.compare!.assets[0].last_points[1] = seriesPoint({ ts: "2026-09-02T00:00:00+03:00", value: 4, estimated: true });
    expect(rows(tip(opt(data), 1))).toEqual(["2 Oct | ~5.00* QAR estimated, partial", "2 Sep | ~4.00 QAR estimated"]);
  });

  it("shows one row only for a day the other month does not have, a dash for a day with no rate, and nothing for a day with no readings", () => {
    const wide = compareSeriesData(3, 2);
    expect(rows(tip(opt(wide), 2))).toEqual(["3 Oct | 102.00 kWh"]);
    const cost = compareSeriesData(2, 2, { source: "cost", unit: "QAR" });
    cost.series[0].points[0] = seriesPoint({ ts: "2026-10-01T00:00:00+03:00", value: null });
    expect(rows(tip(opt(cost), 0))).toEqual(["1 Oct | — no rate", "1 Sep | 90.00 QAR"]);
    const silent = compareSeriesData(2, 2);
    silent.series[0].points[0] = seriesPoint({ ts: "2026-10-01T00:00:00+03:00", value: null, no_data: true });
    silent.compare!.assets[0].last_points[0] = seriesPoint({ ts: "2026-09-01T00:00:00+03:00", value: null, no_data: true });
    expect(tip(opt(silent), 0)).toBe("");
  });

  it("escapes nothing it did not build: the day labels are plain text from the windows", () => {
    expect(tip(opt(), 0)).not.toContain("<script");
  });

  it("names the legend entries with the sides' marks", () => {
    const data = compareSeriesData(2, 2);
    data.compare!.assets[0] = compareAsset({ this: compareSide({ estimated: true }), last: compareSide(), last_points: data.compare!.assets[0].last_points });
    expect(opt(data).legend.data).toEqual(["October ~", "September"]);
  });

  describe("the widget", () => {
    it("draws the comparison chart as a picture with a name, and keeps the existing path for a series without a comparison", () => {
      const { unmount } = render(<TimeSeriesWidget data={compareSeriesData(3, 3)} timezone={TZ} />);
      expect(screen.getByRole("img")).toHaveAccessibleName("Line chart comparing October with September, day by day for LV Panel 1. Energy in kWh. Open Details for the figures.");
      const drawn = JSON.parse(screen.getByTestId("chart").textContent!) as { xAxis: { type: string } };
      expect(drawn.xAxis.type).toBe("category");
      unmount();
      render(<TimeSeriesWidget data={seriesData({ compare: null })} timezone={TZ} />);
      expect(JSON.parse(screen.getByTestId("chart").textContent!).xAxis.type).toBe("time");
    });

    it("still draws when this month has no readings yet but last month has", () => {
      const data = compareSeriesData(3, 3);
      data.series[0].points = data.series[0].points.map((p) => ({ ...p, value: null, no_data: true }));
      render(<TimeSeriesWidget data={data} timezone={TZ} />);
      expect(screen.getByTestId("chart")).toBeInTheDocument();
    });

    it("says there is no data when neither month has any", () => {
      const data = compareSeriesData(2, 2);
      data.series[0].points = data.series[0].points.map((p) => ({ ...p, value: null, no_data: true }));
      data.compare!.assets[0].last_points = data.compare!.assets[0].last_points.map((p) => ({ ...p, value: null, no_data: true }));
      render(<TimeSeriesWidget data={data} timezone={TZ} />);
      expect(screen.getByText("No data in this range.")).toHaveClass("widget-empty");
    });

    it("says 'Nothing to compare yet' in the chart's place on the first of the month", () => {
      render(<TimeSeriesWidget data={compareSeriesData(0, 0, { series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: [] }], compare: compareBlock({ state: "nothing_yet", elapsed_days: 0, days: 0, this_window: null, last_window: null, assets: [] }) })} timezone={TZ} />);
      expect(screen.getByText("Nothing to compare yet")).toHaveClass("widget-empty");
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });
  });
});

describe("the breakdown by kind (w24)", () => {
  const show = (data = breakdownData(3), props: { kind?: string; onKind?: (kind: string) => void; splitDisabled?: boolean } = {}) =>
    render(<BarWidget data={data} timezone={TZ} {...props} />);
  const select = () => screen.getByRole("combobox", { name: "Split by" });
  const none = { count: 0, with_value: 0, value: null, estimated: false, partial: false };

  it("draws the bars it was given, the one line under them, and Split by", () => {
    const { container } = show(breakdownData(3, { breakdown: breakdownBlock({ inside_others: 2 }) }));
    const option = JSON.parse(screen.getByTestId("chart").textContent!) as { series: { data: number[] }[]; xAxis: { data: string[] } };
    expect(option.xAxis.data).toEqual(["Rack 1", "Rack 2", "Rack 3"]);
    expect(option.series[0].data).toEqual([100, 90, 80]);
    expect(screen.getByRole("img")).toHaveAccessibleName(/^Bar chart of 3 of 117 Racks under Hall 1\./);
    expect(container.querySelector(".bars-note")).toHaveTextContent("and 107 more Racks: 1,234.50 kWh in all 2 Racks are inside other Racks and are counted there.");
    expect(container.querySelector(".widget-bars")!.children).toHaveLength(3);
    expect(select()).toBeEnabled();
  });

  it("keeps the line's slot when there is nothing to say", () => {
    const { container } = show(breakdownData(3, { breakdown: breakdownBlock({ more: none }) }));
    const note = container.querySelector(".bars-note");
    expect(note).not.toBeNull();
    expect(note).toBeEmptyDOMElement();
  });

  it("draws a bar with no figure as the dash mark and no bar (energy: the tooltip says no data; cost: no rate), and never as a zero", () => {
    const energy = breakdownData(3, { values: [valueRow({ asset_id: 10, name: "Rack 1", value: 5, point_id: null }), valueRow({ asset_id: 11, name: "Rack 2", value: null, no_data: true, point_id: null })] });
    show(energy);
    const drawn = JSON.parse(screen.getByTestId("chart").textContent!) as { series: { data: (number | null)[] }[] };
    expect(drawn.series[0].data).toEqual([5, null]);
    expect((barOption(energy, TZ) as unknown as { series: { markPoint: { data: { coord: number[] }[] } }[] }).series[0].markPoint.data).toEqual([{ coord: [1, 0] }]);
    const tipOf = (data: typeof energy) => (barOption(data, TZ) as unknown as { tooltip: { formatter: (p: unknown) => string } }).tooltip.formatter([{ dataIndex: 1, seriesIndex: 0 }]);
    expect(tipOf(energy)).toContain("no data");
    const cost = breakdownData(3, { source: "cost", unit: "QAR", values: [valueRow({ asset_id: 10, name: "Rack 1", value: 5, point_id: null }), valueRow({ asset_id: 11, name: "Rack 2", value: null, point_id: null })] });
    const option = barOption(cost, TZ) as unknown as { series: { data: (number | null)[]; markPoint: { data: { coord: number[] }[] } }[] };
    expect(option.series[0].data).toEqual([5, null]);
    expect(option.series[0].markPoint.data).toEqual([{ coord: [1, 0] }]);
  });

  describe("a bar with no data is the dash mark, never an empty slot or a zero-height bar (whole-wave review I-3)", () => {
    type Mark = { series: { data: (number | null)[]; markPoint?: { data: { coord: number[] }[]; label: { formatter: string } } }[] };
    const marks = (data: WidgetData) => barOption(data, TZ) as unknown as Mark;
    const tipOf = (data: WidgetData, index: number) => tipText((barOption(data, TZ) as unknown as { tooltip: { formatter: (p: unknown) => string } }).tooltip.formatter([{ dataIndex: index, seriesIndex: 0 }]));
    const bars = (rows: ReturnType<typeof valueRow>[], over: Partial<WidgetData> = {}) =>
      breakdownData(rows.length, { values: rows.map((r, i) => ({ ...r, asset_id: 10 + i, name: `Rack ${i + 1}`, point_id: null })), ...over });
    const real = valueRow({ value: 5 });
    const silentNull = valueRow({ value: null, no_data: true });
    const silentZero = valueRow({ value: 0, no_data: true });
    const trueZero = valueRow({ value: 0 });

    it("gives every no-data bar of an energy breakdown a dash and the words 'no data', and draws no bar for it; a recorded zero stays a bar", () => {
      const data = bars([real, silentNull, silentZero, trueZero]);
      const option = marks(data);
      expect(option.series[0].data).toEqual([5, null, null, 0]);
      expect(option.series[0].markPoint).toMatchObject({ label: { show: true, formatter: "—" }, data: [{ coord: [1, 0] }, { coord: [2, 0] }] });
      expect(tipOf(data, 1)).toContain("no data");
      expect(tipOf(data, 2)).toContain("no data");
      expect(tipOf(data, 2), "the zero of a silent meter is not shown as a figure").not.toContain("0.00");
      expect(tipOf(data, 3)).toContain("0.00 kWh");
      expect(tipOf(data, 3)).not.toContain("no data");
    });

    it("does the same for a cost breakdown, and keeps 'no rate' for a cost that was recorded without one", () => {
      const data = bars([real, silentNull, silentZero, valueRow({ value: null })], { source: "cost", unit: "QAR" });
      const option = marks(data);
      expect(option.series[0].data).toEqual([5, null, null, null]);
      expect(option.series[0].markPoint?.data).toEqual([{ coord: [1, 0] }, { coord: [2, 0] }, { coord: [3, 0] }]);
      expect(tipOf(data, 1)).toContain("no data");
      expect(tipOf(data, 2)).toContain("no data");
      expect(tipOf(data, 3)).toContain("no rate");
      expect(tipOf(data, 3)).not.toContain("no data");
    });

    it("leaves the plain per-asset bar chart exactly as it was: a silent zero is a zero bar worded '(no data)' and a silent null has no dash", () => {
      const plain = valuesData({ type: "bar", source: "energy", metric: null, unit: "kWh", breakdown: null, values: [
        valueRow({ name: "A", value: 5, point_id: null }),
        valueRow({ asset_id: 6, name: "B", value: 0, no_data: true, point_id: null }),
        valueRow({ asset_id: 7, name: "C", value: null, no_data: true, point_id: null }),
      ] });
      const option = marks(plain);
      expect(option.series[0].data).toEqual([5, 0, null]);
      expect(option.series[0].markPoint).toBeUndefined();
      expect(tipOf(plain, 1)).toContain("0.00 kWh (no data)");
      expect(tipOf(plain, 2)).toContain("no data");
    });

    it("says there is nothing to draw, instead of a chart of dashes, when every bar is a no-data bar", () => {
      show(bars([silentNull, silentZero], { breakdown: breakdownBlock({ count: 2, more: none, no_data: 2 }) }));
      expect(screen.getByText("None of the 2 Racks under Hall 1 has energy readings.")).toHaveClass("widget-empty");
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("draws the chart with its dashes when only some bars have no data", () => {
      show(bars([real, silentNull, silentZero]));
      const drawn = JSON.parse(screen.getByTestId("chart").textContent!) as { series: { data: (number | null)[]; markPoint: { data: unknown[] } }[] };
      expect(drawn.series[0].data).toEqual([5, null, null]);
      expect(drawn.series[0].markPoint.data).toHaveLength(2);
    });
  });

  it("lists the kinds with their counts and shows the current one", () => {
    show(breakdownData(3), { kind: "Panel" });
    expect(within(select()).getAllByRole("option").map((o) => o.textContent)).toEqual(["Rack (117)", "Panel (8)"]);
    expect(select()).toHaveValue("Panel");
  });

  it("adds a current kind the list does not hold, first", () => {
    show(breakdownData(3), { kind: "Row" });
    expect(within(select()).getAllByRole("option").map((o) => o.textContent)).toEqual(["Row (0)", "Rack (117)", "Panel (8)"]);
    expect(select()).toHaveValue("Row");
  });

  it("calls back with the kind picked", async () => {
    const onKind = vi.fn();
    show(breakdownData(3), { kind: "Rack", onKind });
    await userEvent.selectOptions(select(), "Panel");
    expect(onKind).toHaveBeenCalledWith("Panel");
  });

  it("shows Split by but cannot be changed where the card is not a live one", () => {
    show(breakdownData(3), { splitDisabled: true });
    expect(select()).toBeDisabled();
  });

  it("says none of the assets has readings, in the chart's place, and still offers Split by so the viewer can leave", () => {
    const data = breakdownData(2, {
      values: [valueRow({ value: null, no_data: true, point_id: null }), valueRow({ asset_id: 11, value: null, no_data: true, point_id: null })],
      breakdown: breakdownBlock({ kind: "Panel", root: { id: 1, name: "Seeded pilot hall" }, count: 8, more: none, no_data: 8, kinds: [{ kind: "Panel", count: 8 }, { kind: "Rack", count: 117 }] }),
    });
    const { container } = show(data, { kind: "Panel" });
    expect(screen.getByText("None of the 8 Panels under Seeded pilot hall has energy readings.")).toHaveClass("widget-empty");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector(".widget-bars")!.children).toHaveLength(3);
    expect(select()).toBeEnabled();
  });

  it("says there are none of the kind, naming the root, and where to choose another kind (w25)", () => {
    const data = breakdownData(0, { breakdown: breakdownBlock({ kind: "Panel", root: { id: 2, name: "Hall 1" }, count: 0, more: none, kinds: [{ kind: "Rack", count: 117 }] }) });
    show(data, { kind: "Panel" });
    expect(screen.getByText("No Panels under Hall 1. Choose another kind in Split by.")).toHaveClass("widget-empty");
    expect(select()).toBeEnabled();
  });

  it("keeps the same select element when the answer changes from bars to a sentence (it keeps its focus)", async () => {
    const { rerender } = show(breakdownData(3), { kind: "Rack" });
    const before = select();
    before.focus();
    rerender(<BarWidget data={breakdownData(0, { breakdown: breakdownBlock({ count: 0, more: none }) })} timezone={TZ} kind="Panel" />);
    expect(select()).toBe(before);
    expect(before).toHaveFocus();
  });

  it("is the old bar chart for a values answer without a breakdown", () => {
    const { container } = render(<BarWidget data={valuesData({ type: "bar", breakdown: null })} timezone={TZ} />);
    expect(container.querySelector(".widget-bars, .bars-split")).toBeNull();
  });
});

describe("value axes and exact tooltips on large figures (w27, D3)", () => {
  interface Labelled { name?: string; axisLabel: { formatter: (value: number) => string; color: string } }
  const yAxisOf = (option: unknown) => (option as { yAxis: Labelled }).yAxis;
  const tipOf = (option: unknown, params: unknown) => tipText((option as { tooltip: { formatter: (p: unknown) => string } }).tooltip.formatter(params));
  const days = (values: (number | null)[], over: Partial<WidgetData> = {}) =>
    seriesData({
      source: "energy", metric: null, unit: "kWh", bucket: "day",
      series: [{ asset_id: 5, name: "LV Panel 1", estimated: false, partial: false, points: values.map((value, i) => seriesPoint({ ts: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00+03:00`, value, no_data: value === null })) }],
      ...over,
    });

  it("reads 18,000 under kWh on a daily chart, with the data and the tooltip exact", () => {
    const data = days([9_500, 18_000, 12_250.5]);
    const option = timeSeriesOption(data, TZ);
    expect(yAxisOf(option).name).toBe("kWh");
    expect(yAxisOf(option).axisLabel.formatter(18_000)).toBe("18,000");
    expect(yAxisOf(option).axisLabel.formatter(0)).toBe("0");
    expect(asOption(option).series[0].data.map((cell) => plain(cell)[1])).toEqual([9_500, 18_000, 12_250.5]);
    expect(tipOf(option, [{ seriesId: "avg-5", seriesName: "A", value: ["2026-10-02T00:00:00+03:00", 18_000], marker: "" }])).toContain("A 18,000.00 kWh");
  });

  it("reads 250 and 300 under MWh when the largest value is 275,430 kWh, while the tooltip still says 275,430.26 kWh", () => {
    const data = days([120_000, 275_430.2575, 90_000]);
    const option = timeSeriesOption(data, TZ);
    expect(yAxisOf(option).name).toBe("MWh");
    expect(yAxisOf(option).axisLabel.formatter(250_000)).toBe("250");
    expect(yAxisOf(option).axisLabel.formatter(300_000)).toBe("300");
    expect(asOption(option).series[0].data.map((cell) => plain(cell)[1])).toEqual([120_000, 275_430.2575, 90_000]);
    expect(tipOf(option, [{ seriesId: "avg-5", seriesName: "A", value: ["2026-10-02T00:00:00+03:00", 275_430.2575], marker: "" }])).toContain("A 275,430.26 kWh");
  });

  it("goes to MWh at a top value of 99,999.5 kWh and stays in kWh at 99,999.4 (the unit is chosen after rounding)", () => {
    expect(yAxisOf(timeSeriesOption(days([99_999.5, 10]), TZ)).name).toBe("MWh");
    expect(yAxisOf(timeSeriesOption(days([99_999.4, 10]), TZ)).name).toBe("kWh");
  });

  it("names a cost beyond 100,000 in k, with the currency code, and ticks in thousands", () => {
    const option = timeSeriesOption(days([40_000, 150_000], { source: "cost", unit: "QAR" }), TZ);
    expect(yAxisOf(option).name).toBe("k QAR");
    expect(yAxisOf(option).axisLabel.formatter(150_000)).toBe("150");
    expect(yAxisOf(option).axisLabel.formatter(50_000)).toBe("50");
    expect(yAxisOf(timeSeriesOption(days([40_000, 99_000], { source: "cost", unit: "QAR" }), TZ)).name).toBe("QAR");
  });

  it("takes the scale of a metric's band from its largest max, not only from its averages", () => {
    const metric = seriesData({
      unit: "kW",
      series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 90_000, min: 80_000, max: 120_000 })] }],
    });
    const option = timeSeriesOption(metric, TZ);
    expect(yAxisOf(option).name).toBe("MW");
    expect(yAxisOf(option).axisLabel.formatter(100_000)).toBe("100");
    // The tooltip's min and max are on the exact face too, so one tooltip never mixes grouped and ungrouped figures.
    expect(tipOf(option, [{ seriesId: "avg-5", seriesName: "A", value: ["2026-10-08T00:00:00+00:00", 90_000], marker: "" }])).toContain("90,000.00 kW (min 80,000.00, max 120,000.00)");
  });

  it("leaves a unit that never scales as it is", () => {
    const option = timeSeriesOption(seriesData({ unit: "V", series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: [seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 400, min: 390, max: 1_500_000 })] }] }), TZ);
    expect(yAxisOf(option).name).toBe("V");
    expect(yAxisOf(option).axisLabel.formatter(1_000_000)).toBe("1,000,000");
  });

  it("keeps the axis text colour while it formats", () => {
    expect(yAxisOf(timeSeriesOption(days([1, 2]), TZ)).axisLabel.color).toBe(LIGHT_CHART.axisText);
  });

  describe("the bar chart", () => {
    const perAsset = (values: number[], over: Partial<WidgetData> = {}) =>
      valuesData({ type: "bar", source: "energy", metric: null, unit: "kWh", values: values.map((value, i) => valueRow({ asset_id: 10 + i, name: `Hall ${i + 1}`, value, point_id: null })), ...over });

    it("reads MWh for bars per asset when the tallest is 275,430 kWh, and the tooltip stays exact", () => {
      const option = barOption(perAsset([138_130.96, 275_430.2575]), TZ);
      expect(yAxisOf(option).name).toBe("MWh");
      expect(yAxisOf(option).axisLabel.formatter(250_000)).toBe("250");
      expect(barSeries(option)[0].data).toEqual([138_130.96, 275_430.2575]);
      expect(tipOf(option, [{ name: "Hall 2", dataIndex: 1, seriesIndex: 0, marker: "" }])).toContain("275,430.26 kWh");
    });

    it("reads kWh with separators for bars below 100,000 kWh", () => {
      const option = barOption(perAsset([4_000, 18_000]), TZ);
      expect(yAxisOf(option).name).toBe("kWh");
      expect(yAxisOf(option).axisLabel.formatter(18_000)).toBe("18,000");
    });

    it("names a cost beyond 100,000 in k QAR", () => {
      expect(yAxisOf(barOption(perAsset([40_000, 275_430.26], { source: "cost", unit: "QAR" }), TZ)).name).toBe("k QAR");
    });

    it("ignores a bar with no figure when it picks the scale", () => {
      const option = barOption(perAsset([5, 0], { values: [valueRow({ value: 5, point_id: null }), valueRow({ asset_id: 6, name: "B", value: null, no_data: true, point_id: null })] }), TZ);
      expect(yAxisOf(option).name).toBe("kWh");
    });

    it("scales a bar-over-time chart by the largest bar of any asset", () => {
      const series = (id: number, values: number[]) => ({
        asset_id: id, name: `A${id}`, estimated: false, partial: false,
        points: values.map((value, i) => seriesPoint({ ts: `2026-10-0${i + 1}T00:00:00+03:00`, value })),
      });
      const option = barOption(seriesData({ type: "bar", source: "energy", metric: null, unit: "kWh", bucket: "day", series: [series(5, [10, 20]), series(6, [150_000, 30])] }), TZ);
      expect(yAxisOf(option).name).toBe("MWh");
      expect(yAxisOf(option).axisLabel.formatter(100_000)).toBe("100");
    });

    it("scales a breakdown's axis by its bars", () => {
      const data = breakdownData(2, { values: [valueRow({ asset_id: 10, name: "Hall 1", value: 138_130.96, point_id: null }), valueRow({ asset_id: 11, name: "Hall 2", value: 150_503.32, estimated: true, point_id: null })] });
      const option = barOption(data, TZ);
      expect(yAxisOf(option).name).toBe("MWh");
      expect(yAxisOf(option).axisLabel.formatter(150_000)).toBe("150");
    });
  });

  describe("the comparison chart", () => {
    it("draws both months on one axis from the larger of the two", () => {
      const data = compareSeriesData(3, 3);
      data.series[0].points[2] = seriesPoint({ ts: "2026-10-03T00:00:00+03:00", value: 10_000 });
      data.compare!.assets[0].last_points[1] = seriesPoint({ ts: "2026-09-02T00:00:00+03:00", value: 275_430.26 });
      const option = compareOption(data, TZ);
      expect(yAxisOf(option).name).toBe("MWh");
      expect(yAxisOf(option).axisLabel.formatter(250_000)).toBe("250");
      expect(tipOf(option, [{ dataIndex: 1, seriesIndex: 1, marker: "" }])).toContain("2 Sep 275,430.26 kWh");
    });

    it("reads kWh when neither month reaches 100,000", () => {
      const option = compareOption(compareSeriesData(3, 3), TZ);
      expect(yAxisOf(option).name).toBe("kWh");
      expect(yAxisOf(option).axisLabel.formatter(100)).toBe("100");
    });

    it("scales a cost comparison in k QAR and leaves out a currency-changed month that has no figures", () => {
      const data = compareSeriesData(3, 3, { source: "cost", unit: "QAR" });
      data.series[0].points[1] = seriesPoint({ ts: "2026-10-02T00:00:00+03:00", value: 180_000 });
      expect(yAxisOf(compareOption(data, TZ)).name).toBe("k QAR");
    });
  });

  describe("the breakdown line (card face) and its title (exact face)", () => {
    const circuits = breakdownData(2, {
      breakdown: breakdownBlock({ kind: "Circuit", count: 231, shown: 12, more: { count: 219, with_value: 207, value: 262_071.8, estimated: true, partial: false } }),
    });

    it("reads 'and 219 more Circuits: ~262.07 MWh in all (12 with no data)' with the exact figure one hover away", () => {
      const { container } = render(<BarWidget data={circuits} timezone={TZ} />);
      const note = container.querySelector(".bars-note")!;
      expect(note).toHaveTextContent("and 219 more Circuits: ~262.07 MWh in all (12 with no data)");
      expect(note).toHaveAttribute("title", "and 219 more Circuits: ~262,071.80 kWh in all (12 with no data)");
    });

    it("keeps the * of a cost on the card and in the title, with the k and the currency code", () => {
      const cost = breakdownData(2, {
        source: "cost", unit: "QAR",
        breakdown: breakdownBlock({ count: 117, more: { count: 107, with_value: 107, value: 275_430.26, estimated: false, partial: true } }),
      });
      const { container } = render(<BarWidget data={cost} timezone={TZ} />);
      const note = container.querySelector(".bars-note")!;
      expect(note).toHaveTextContent("and 107 more Racks: 275.43k* QAR in all");
      expect(note).toHaveAttribute("title", "and 107 more Racks: 275,430.26* QAR in all");
    });

    it("puts the inside-others sentence in the title too", () => {
      const { container } = render(<BarWidget data={breakdownData(3, { breakdown: breakdownBlock({ inside_others: 2 }) })} timezone={TZ} />);
      expect(container.querySelector(".bars-note")).toHaveAttribute("title", "and 107 more Racks: 1,234.50 kWh in all 2 Racks are inside other Racks and are counted there.");
    });
  });
});

describe("the table keeps the exact face (w27)", () => {
  it("prints a cell with separators and two decimals, with its marks, and never scales it", () => {
    render(<TableWidget data={valuesData({ type: "table", source: "energy", metric: null, unit: "kWh", values: [
      valueRow({ name: "Hall 1", value: 138_130.96, point_id: null }),
      valueRow({ asset_id: 6, name: "Hall 2", value: 275_430.2575, estimated: true, point_id: null }),
      valueRow({ asset_id: 7, name: "Hall 3", value: 4_000, point_id: null }),
    ] })} />);
    const cells = screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[1].textContent);
    expect(cells).toEqual(["138,130.96", "~275,430.26", "4,000.00"]);
  });

  it("keeps a cost's * and a missing rate's dash", () => {
    render(<TableWidget data={valuesData({ type: "table", source: "cost", metric: null, unit: "QAR", values: [
      valueRow({ name: "Hall 1", value: 33_051.6309, partial: true, point_id: null }),
      valueRow({ asset_id: 6, name: "Hall 2", value: null, point_id: null }),
    ] })} />);
    expect(screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[1].textContent)).toEqual(["33,051.63*", "—"]);
  });
});
