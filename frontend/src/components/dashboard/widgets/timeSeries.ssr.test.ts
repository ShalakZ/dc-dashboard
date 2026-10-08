// @vitest-environment node
// Real ECharts, no DOM: the option is rendered to an SVG string and what was drawn is looked at. The other widget tests
// replace echarts-for-react by a stub and can only see the option, which is how a bucket-width error that made
// every line of a 24h chart vanish slipped through once.
import * as echarts from "echarts";
import { seriesData, seriesPoint } from "../../../test/dashboardFixtures";
import { withLegendSelection } from "./legendSelection";
import { timeSeriesOption } from "./TimeSeriesWidget";

vi.mock("echarts-for-react", () => ({ default: () => null }));

interface Drawn { d: string; fill: string | null; stroke: string | null }
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

function draw(option: unknown): Drawn[] {
  const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 600, height: 300 });
  chart.setOption(option as echarts.EChartsOption);
  const svg = chart.renderToSVGString();
  chart.dispose();
  return (svg.match(/<path\b[^>]*>/g) ?? []).map((tag) => ({ d: attr(tag, "d") ?? "", fill: attr(tag, "fill"), stroke: attr(tag, "stroke") }));
}
const colorOf = (option: unknown) => (option as { series: { id?: string; color?: string }[] }).series.find((s) => s.id === "avg-5")!.color!;
/** The average line: the path stroked in the series colour, and the dots: arcs filled with it. */
const lineOf = (paths: Drawn[], color: string) => paths.filter((p) => p.stroke === color);
const dotsOf = (paths: Drawn[], color: string) => paths.filter((p) => p.fill === color && p.d.includes("A"));
const segments = (path: Drawn) => (path.d.match(/L/g) ?? []).length;

describe("time series, drawn by the real chart library", () => {
  it("draws the only bucket of a 1h energy window as a dot (a lone point has no line to be drawn as)", () => {
    const hour = seriesData({
      source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null,
      range: { preset: "1h", start: "2026-10-08T10:00:00+03:00", end: "2026-10-08T10:30:00+03:00" },
      series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: [seriesPoint({ ts: "2026-10-08T10:00:00+03:00", value: 1.5 })] }],
    });
    const option = timeSeriesOption(hour, "Asia/Qatar");
    const paths = draw(option);
    expect(dotsOf(paths, colorOf(option))).toHaveLength(1);
    const line = lineOf(paths, colorOf(option));
    expect(line).toHaveLength(1); // `every` over an empty list would pass whatever was drawn
    expect(line.every((p) => segments(p) === 0)).toBe(true); // the line itself is a bare move-to
  });

  it.each<[string, "1m" | "1h", number]>([["24h", "1m", 288], ["30d", "1h", 8640]])(
    "draws a full %s metric series (tier %s, %i s buckets) as a line of 299 segments and not as 300 dots",
    (preset, tier, step) => {
      const start = Date.UTC(2026, 9, 1);
      const points = Array.from({ length: 300 }, (_, i) =>
        seriesPoint({ ts: new Date(start + i * step * 1000).toISOString(), value: 10 + (i % 9), min: 9 + (i % 9), max: 11 + (i % 9) }));
      const range = { preset: preset as "24h", start: points[0].ts, end: new Date(start + 300 * step * 1000).toISOString() };
      const option = timeSeriesOption(seriesData({ tier, range, series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points }] }), "Asia/Qatar");
      const paths = draw(option);
      const line = lineOf(paths, colorOf(option));
      expect(line).toHaveLength(1);
      expect(segments(line[0])).toBe(299);
      expect(dotsOf(paths, colorOf(option))).toHaveLength(0);
    },
  );
});

describe("legend selection, kept by the real chart library", () => {
  const twoAssets = (base: number) => seriesData({
    series: [5, 6].map((id) => ({
      asset_id: id, name: id === 5 ? "A" : "B", estimated: false, partial: false,
      points: [0, 1, 2].map((i) => seriesPoint({ ts: `2026-10-08T0${i}:00:00+00:00`, value: base + id + i, min: base + id + i - 1, max: base + id + i + 1 })),
    })),
  });
  const shownLegend = (chart: echarts.ECharts) => (chart.getOption() as { legend: { selected: Record<string, boolean> }[] }).legend[0].selected;

  it("shows a switched-off entry again after a plain setOption with notMerge, and keeps it off with the remembered selection", () => {
    const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 600, height: 300 });
    /** The stroked paths of a data line of three points (two segments) in `color`. */
    const dataLines = (color: string) => (chart.renderToSVGString().match(/<path\b[^>]*>/g) ?? [])
      .filter((tag) => attr(tag, "stroke") === color && ((attr(tag, "d") ?? "").match(/L/g) ?? []).length === 2);
    let reported: Record<string, boolean> | null = null;
    chart.on("legendselectchanged", (event) => { reported = (event as unknown as { selected: Record<string, boolean> }).selected; });
    chart.setOption(timeSeriesOption(twoAssets(0), "Asia/Qatar"), { notMerge: true });
    expect(dataLines("#cf222e")).toHaveLength(1); // both assets are drawn to begin with (B has the second palette colour)
    chart.dispatchAction({ type: "legendToggleSelect", name: "B" });
    expect(reported).toEqual({ A: true, B: false }); // the event and payload the widgets listen to
    expect(shownLegend(chart)).toEqual({ A: true, B: false });
    expect(dataLines("#cf222e")).toHaveLength(0);

    // what a 30 s refetch did without the fix: a new option, notMerge, and B is back
    chart.setOption(timeSeriesOption(twoAssets(100), "Asia/Qatar"), { notMerge: true });
    expect(shownLegend(chart).B).not.toBe(false); // an empty selection: every entry on
    expect(dataLines("#cf222e")).toHaveLength(1);

    chart.dispatchAction({ type: "legendToggleSelect", name: "B" });
    chart.setOption(withLegendSelection(timeSeriesOption(twoAssets(200), "Asia/Qatar"), reported!), { notMerge: true });
    expect(shownLegend(chart)).toEqual({ A: true, B: false });
    expect(dataLines("#1f6feb")).toHaveLength(1); // asset A's line
    expect(dataLines("#cf222e")).toHaveLength(0); // asset B's is not drawn
    chart.dispose();
  });
});

describe("the time axis of an energy or cost series, drawn by the real chart library", () => {
  // The chart is 600 wide with the grid at left 60 and right 20 (timeSeriesOption), so the plot spans x = 60 to 580.
  const PLOT_LEFT = 60;
  const PLOT_RIGHT = 580;
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  type XAxis = { min?: number; max?: number; axisLabel: { hideOverlap?: boolean } };
  const xAxisOf = (option: unknown) => (option as { xAxis: XAxis }).xAxis;

  /** The text of the x axis tick labels the chart drew: the texts below the plot (its bottom edge is y = 300 - 30). */
  function tickLabels(option: unknown): string[] {
    const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 600, height: 300 });
    chart.setOption(option as echarts.EChartsOption);
    const svg = chart.renderToSVGString();
    chart.dispose();
    return [...svg.matchAll(/<text\b[^>]*transform="translate\([\d.]+ ([\d.]+)\)"[^>]*>([^<]*)<\/text>/g)]
      .filter((m) => Number(m[1]) > 270)
      .map((m) => m[2]);
  }
  /** x of every dot (a filled arc, drawn as a matrix scaled by its radius) in the SVG. */
  function dotXs(option: unknown, color: string): number[] {
    const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 600, height: 300 });
    chart.setOption(option as echarts.EChartsOption);
    const svg = chart.renderToSVGString();
    chart.dispose();
    return (svg.match(/<path\b[^>]*>/g) ?? [])
      .filter((tag) => attr(tag, "fill") === color && (attr(tag, "d") ?? "").includes("A"))
      .map((tag) => Number(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,([\d.]+),/.exec(attr(tag, "transform") ?? "")?.[1]));
  }

  const oneHour = seriesData({
    source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null,
    range: { preset: "1h", start: "2026-10-08T10:00:00+03:00", end: "2026-10-08T10:30:00+03:00" },
    series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: [seriesPoint({ ts: "2026-10-08T10:00:00+03:00", value: 1.5 })] }],
  });

  it("bounds the axis of a one-bucket 1h energy series to its hour, so it is not stretched over about 42 hours", () => {
    const option = timeSeriesOption(oneHour, "Asia/Qatar");
    const { min, max } = xAxisOf(option);
    const start = Date.parse("2026-10-08T10:00:00+03:00");
    expect(min).toBeLessThanOrEqual(start);
    expect(max).toBeGreaterThanOrEqual(start + HOUR); // the bucket's whole hour is on the axis
    expect(max! - min!).toBeLessThanOrEqual(1.2 * HOUR); // the hour, plus room for the dot
    const labels = tickLabels(option);
    expect(labels.length).toBeGreaterThanOrEqual(2); // there are ticks to look at
    for (const label of labels) expect(label).toMatch(/^10-08 (10:\d\d|11:00)$/); // all inside 10:00 to 11:00, none a day away
  });

  it("keeps the only dot of that series inside the plot, not half-clipped on its edge", () => {
    const option = timeSeriesOption(oneHour, "Asia/Qatar");
    const xs = dotXs(option, (option as { series: { color?: string }[] }).series[0].color!);
    expect(xs).toHaveLength(1);
    expect(xs[0] - PLOT_LEFT).toBeGreaterThanOrEqual(3); // the symbol's radius is 3
    expect(PLOT_RIGHT - xs[0]).toBeGreaterThanOrEqual(3);
  });

  it("keeps the first day bucket of a rolling 7d series, which is labelled before range.start, and the last bucket's whole day, on the axis", () => {
    const days = Array.from({ length: 8 }, (_, i) => `2026-10-0${i + 1}T00:00:00+03:00`);
    const week = seriesData({
      source: "energy", metric: null, unit: "kWh", bucket: "day", tier: null,
      range: { preset: "7d", start: "2026-10-01T10:00:00+03:00", end: "2026-10-08T10:30:00+03:00" },
      series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points: days.map((ts, i) => seriesPoint({ ts, value: 10 + i })) }],
    });
    const option = timeSeriesOption(week, "Asia/Qatar");
    const { min, max } = xAxisOf(option);
    expect(Date.parse(days[0])).toBeLessThan(Date.parse("2026-10-01T10:00:00+03:00")); // the premise: the first bucket is before the range
    expect(min).toBeLessThanOrEqual(Date.parse(days[0]));
    expect(max).toBeGreaterThanOrEqual(Date.parse(days[7]) + DAY);
    // and the first and last points are drawn inside the plot
    const color = (option as { series: { id?: string; color?: string }[] }).series.find((s) => s.id === "avg-5")!.color!;
    const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 600, height: 300 });
    chart.setOption(option as echarts.EChartsOption);
    const [line] = (chart.renderToSVGString().match(/<path\b[^>]*>/g) ?? []).filter((tag) => attr(tag, "stroke") === color && (attr(tag, "d") ?? "").includes("L"));
    chart.dispose();
    const coords = [...attr(line, "d")!.matchAll(/[ML]([\d.]+) /g)].map((m) => Number(m[1]));
    expect(coords).toHaveLength(8);
    expect(coords[0]).toBeGreaterThan(PLOT_LEFT);
    expect(coords[7]).toBeLessThan(PLOT_RIGHT);
    const labels = tickLabels(option);
    expect(labels.length).toBeGreaterThanOrEqual(2);
    for (const label of labels) expect(label).toMatch(/^\d\d-\d\d$/); // day labels
  });

  it("leaves the axis of a metric series to the chart (no min or max), and never lets labels overlap on any time series", () => {
    const start = Date.UTC(2026, 9, 1);
    const points = Array.from({ length: 300 }, (_, i) => seriesPoint({ ts: new Date(start + i * 288_000).toISOString(), value: 10 + (i % 9), min: 9, max: 12 }));
    const metric = timeSeriesOption(seriesData({ tier: "1m", series: [{ asset_id: 5, name: "A", estimated: false, partial: false, points }] }), "Asia/Qatar");
    expect(xAxisOf(metric)).not.toHaveProperty("min");
    expect(xAxisOf(metric)).not.toHaveProperty("max");
    expect(xAxisOf(metric).axisLabel.hideOverlap).toBe(true);
    expect(xAxisOf(timeSeriesOption(oneHour, "Asia/Qatar")).axisLabel.hideOverlap).toBe(true);
  });
});
