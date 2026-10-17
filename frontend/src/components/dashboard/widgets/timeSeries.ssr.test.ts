// @vitest-environment node
// Real ECharts, no DOM: the option is rendered to an SVG string and what was drawn is looked at. The other widget tests
// replace echarts-for-react by a stub and can only see the option, which is how a bucket-width error that made
// every line of a 24h chart vanish slipped through once.
// W13: the same file proves, on the real library, what the option tests above cannot: the legend switches a line AND its band, the legend keeps
// a choice when a name gains a flag, the dash of a bucket with no rate sits in its own series' slot, and the colours are the theme's.
import * as echarts from "echarts";
import { shortLabel } from "../../../lib/widgetFormat";
import { seriesData, seriesPoint } from "../../../test/dashboardFixtures";
import { barOption } from "./BarWidget";
import { LIGHT_CHART, type ChartTheme } from "./chartTheme";
import { withLegendSelection } from "./legendSelection";
import { timeSeriesOption } from "./TimeSeriesWidget";

vi.mock("echarts-for-react", () => ({ default: () => null }));

interface Drawn { d: string; fill: string | null; fillOpacity: string | null; stroke: string | null; strokeOpacity: string | null; dash: string | null; kind: string | null }
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

function draw(option: unknown): Drawn[] {
  const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 600, height: 300 });
  chart.setOption(option as echarts.EChartsOption);
  const svg = chart.renderToSVGString();
  chart.dispose();
  return (svg.match(/<path\b[^>]*>/g) ?? []).map((tag) => ({
    d: attr(tag, "d") ?? "", fill: attr(tag, "fill"), fillOpacity: attr(tag, "fill-opacity"), stroke: attr(tag, "stroke"), strokeOpacity: attr(tag, "stroke-opacity"),
    dash: attr(tag, "stroke-dasharray"), kind: attr(tag, "ecmeta_ssr_type"),
  }));
}
const colorOf = (option: unknown) => (option as { series: { id?: string; color?: string }[] }).series.find((s) => s.id === "avg-5")!.color!;
/** The average line: the path stroked in the series colour (the band's own lines are stroked in it too, with an opacity of 0), and the dots: arcs filled with it. */
const lineOf = (paths: Drawn[], color: string) => paths.filter((p) => p.stroke === color && p.strokeOpacity !== "0");
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
  const A_COLOR = LIGHT_CHART.palette[0]; // asset 5, the first of two series
  const B_COLOR = LIGHT_CHART.palette[1]; // asset 6
  /** What the hook remembers from a `legendselectchanged` payload: by asset id (5 is the first entry, 6 the second). */
  const byAsset = (selected: Record<string, boolean>, names = ["A", "B"]) => ({ 5: selected[names[0]], 6: selected[names[1]] });
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
      .filter((tag) => attr(tag, "stroke") === color && attr(tag, "stroke-opacity") !== "0" && ((attr(tag, "d") ?? "").match(/L/g) ?? []).length === 2);
    let reported: Record<string, boolean> | null = null;
    chart.on("legendselectchanged", (event) => { reported = (event as unknown as { selected: Record<string, boolean> }).selected; });
    chart.setOption(timeSeriesOption(twoAssets(0), "Asia/Qatar"), { notMerge: true });
    expect(dataLines(B_COLOR)).toHaveLength(1); // both assets are drawn to begin with (B has the second palette colour)
    chart.dispatchAction({ type: "legendToggleSelect", name: "B" });
    expect(reported).toEqual({ A: true, B: false }); // the event and payload the widgets listen to
    expect(shownLegend(chart)).toEqual({ A: true, B: false });
    expect(dataLines(B_COLOR)).toHaveLength(0);

    // what a 30 s refetch did without the fix: a new option, notMerge, and B is back
    chart.setOption(timeSeriesOption(twoAssets(100), "Asia/Qatar"), { notMerge: true });
    expect(shownLegend(chart).B).not.toBe(false); // an empty selection: every entry on
    expect(dataLines(B_COLOR)).toHaveLength(1);

    chart.dispatchAction({ type: "legendToggleSelect", name: "B" });
    chart.setOption(withLegendSelection(timeSeriesOption(twoAssets(200), "Asia/Qatar"), [5, 6], byAsset(reported!)), { notMerge: true });
    expect(shownLegend(chart)).toEqual({ A: true, B: false });
    expect(dataLines(A_COLOR)).toHaveLength(1); // asset A's line
    expect(dataLines(B_COLOR)).toHaveLength(0); // asset B's is not drawn
    chart.dispose();
  });

  it("draws a long name shortened in the legend but still reports and remembers the full name (S7-3)", () => {
    const first = "Main-Switchboard-Feeder-Room-East-Hall-3";
    const second = "Auxiliary-Distribution-Panel-Block-West";
    const named = (base: number) => {
      const data = twoAssets(base);
      data.series[0].name = first;
      data.series[1].name = second;
      return data;
    };
    const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 600, height: 300 });
    let reported: Record<string, boolean> | null = null;
    chart.on("legendselectchanged", (event) => { reported = (event as unknown as { selected: Record<string, boolean> }).selected; });
    chart.setOption(timeSeriesOption(named(0), "Asia/Qatar"), { notMerge: true });
    const svg = chart.renderToSVGString();
    expect(svg).toContain(shortLabel(first, 24));
    expect(svg).not.toContain(`>${first}<`);
    chart.dispatchAction({ type: "legendToggleSelect", name: second });
    expect(reported).toEqual({ [first]: true, [second]: false });
    chart.setOption(withLegendSelection(timeSeriesOption(named(100), "Asia/Qatar"), [5, 6], byAsset(reported!, [first, second])), { notMerge: true });
    expect(shownLegend(chart)).toEqual({ [first]: true, [second]: false });
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

// ---- W13: a line and its band are one legend entry; the choice follows the asset; the dash has a slot; the colours are the theme's ----

const metricAsset = (id: number, name: string, base: number, over: { estimated?: boolean; partial?: boolean } = {}) => ({
  asset_id: id, name, estimated: false, partial: false, ...over,
  points: [0, 1, 2].map((i) => seriesPoint({ ts: `2026-10-08T0${i}:00:00+00:00`, value: base + i, min: base + i - 1, max: base + i + 1 })),
});
const metricData = (...assets: ReturnType<typeof metricAsset>[]) => seriesData({ series: assets });
const A_COLOR = LIGHT_CHART.palette[0];
const B_COLOR = LIGHT_CHART.palette[1];

/** A chart that stays open, so a legend click can be dispatched and drawn again. */
function openChart(option: unknown) {
  const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 600, height: 300 });
  chart.setOption(option as echarts.EChartsOption, { notMerge: true });
  const reported: { selected: Record<string, boolean> | null } = { selected: null };
  chart.on("legendselectchanged", (event) => { reported.selected = (event as unknown as { selected: Record<string, boolean> }).selected; });
  return { chart, reported, paths: () => (chart.renderToSVGString().match(/<path\b[^>]*>/g) ?? []) };
}
/** The filled areas of the min-max band in `color`: the only paths filled with it at the band's opacity. */
const bandsOf = (tags: string[], color: string, opacity: number) => tags.filter((t) => attr(t, "fill") === color && attr(t, "fill-opacity") === String(opacity));
/** The visible data lines in `color` (the band's helper lines are stroked in it too, at an opacity of 0). */
const visibleLines = (tags: string[], color: string) => tags.filter((t) => attr(t, "stroke") === color && attr(t, "stroke-opacity") !== "0" && (attr(t, "d") ?? "").includes("L") && attr(t, "ecmeta_ssr_type") === null);
/** The legend's icons: the small filled rectangles the legend draws before each entry's text. */
const legendIcons = (tags: string[]) => tags.filter((t) => attr(t, "ecmeta_ssr_type") === "legend" && attr(t, "fill") !== "none" && !(attr(t, "d") ?? "").startsWith("M-5"));

describe("a line and its min-max band are one legend entry", () => {
  const two = (flag: { estimated?: boolean; partial?: boolean } = {}) => metricData(metricAsset(5, "A", 0), metricAsset(6, "B", 10, flag));

  it("draws both bands, each in its line's colour at the theme's band opacity, and a legend icon in each line's colour that is not hidden", () => {
    const { paths } = openChart(timeSeriesOption(two(), "Asia/Qatar"));
    const tags = paths();
    expect(bandsOf(tags, A_COLOR, LIGHT_CHART.bandOpacity)).toHaveLength(1);
    expect(bandsOf(tags, B_COLOR, LIGHT_CHART.bandOpacity)).toHaveLength(1);
    const icons = legendIcons(tags);
    expect(icons.map((t) => attr(t, "fill"))).toEqual([A_COLOR, B_COLOR]); // the icon comes from the first series of the name: the line, never the invisible band
    for (const icon of icons) {
      expect(attr(icon, "opacity")).toBeNull();
      expect(attr(icon, "fill-opacity")).toBeNull();
      expect(attr(icon, "d")).toBe("M0 0l12 0l0 3l-12 0Z"); // a 12 x 3 line, not a symbol
    }
  });

  it("switching an asset off in the legend takes its line and its band, and switching it on brings both back", () => {
    const { chart, reported, paths } = openChart(timeSeriesOption(two(), "Asia/Qatar"));
    expect(visibleLines(paths(), B_COLOR)).toHaveLength(1);
    chart.dispatchAction({ type: "legendToggleSelect", name: "B" });
    expect(reported.selected).toEqual({ A: true, B: false });
    let tags = paths();
    expect(visibleLines(tags, B_COLOR)).toHaveLength(0);
    expect(bandsOf(tags, B_COLOR, LIGHT_CHART.bandOpacity)).toHaveLength(0); // the reported bug: the band stayed
    expect(visibleLines(tags, A_COLOR)).toHaveLength(1);
    expect(bandsOf(tags, A_COLOR, LIGHT_CHART.bandOpacity)).toHaveLength(1);
    chart.dispatchAction({ type: "legendToggleSelect", name: "B" });
    tags = paths();
    expect(visibleLines(tags, B_COLOR)).toHaveLength(1);
    expect(bandsOf(tags, B_COLOR, LIGHT_CHART.bandOpacity)).toHaveLength(1);
    chart.dispose();
  });

  it("keeps an asset switched off when the refetch gives its name a ~ or a *", () => {
    const { chart, reported, paths } = openChart(timeSeriesOption(two(), "Asia/Qatar"));
    chart.dispatchAction({ type: "legendToggleSelect", name: "B" });
    const remembered = { 5: reported.selected!.A, 6: reported.selected!.B };
    // the refetch: B is estimated now, so its legend name is "B ~"; the old code compared names and forgot the choice for good
    const next = withLegendSelection(timeSeriesOption(two({ estimated: true }), "Asia/Qatar"), [5, 6], remembered);
    chart.setOption(next as echarts.EChartsOption, { notMerge: true });
    const shown = (chart.getOption() as { legend: { selected: Record<string, boolean> }[] }).legend[0].selected;
    expect(shown).toEqual({ A: true, "B ~": false });
    const tags = paths();
    expect(visibleLines(tags, B_COLOR)).toHaveLength(0);
    expect(bandsOf(tags, B_COLOR, LIGHT_CHART.bandOpacity)).toHaveLength(0);
    expect(visibleLines(tags, A_COLOR)).toHaveLength(1);
    chart.dispose();
  });

  it("ignores a deleted asset and never leaves every series hidden", () => {
    const three = (...ids: [number, string][]) => metricData(...ids.map(([id, name]) => metricAsset(id, name, id)));
    const remembered = { 5: true, 6: false, 7: false }; // A is the only one on
    const withoutA = timeSeriesOption(three([6, "B"], [7, "C"]), "Asia/Qatar");
    expect(withLegendSelection(withoutA, [6, 7], remembered)).toBe(withoutA); // dropped: B and C would both be hidden
    const { chart, paths } = openChart(withLegendSelection(withoutA, [6, 7], remembered));
    expect(visibleLines(paths(), LIGHT_CHART.palette[0])).toHaveLength(1); // both are drawn (B, C are the first two series now)
    expect(visibleLines(paths(), LIGHT_CHART.palette[1])).toHaveLength(1);
    chart.dispose();
  });

  it("draws series 6 to 8 dashed, and 9 and later dotted in colours 1 to 5", () => {
    const hourly = (count: number) => seriesData({
      source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null,
      series: Array.from({ length: count }, (_, i) => ({
        asset_id: 10 + i, name: `S${i}`, estimated: false, partial: false,
        points: [0, 1, 2].map((k) => seriesPoint({ ts: `2026-10-08T0${k}:00:00+00:00`, value: 100 * i + k })),
      })),
    });
    const { paths, chart } = openChart(timeSeriesOption(hourly(10), "Asia/Qatar"));
    const lines = paths().filter((t) => attr(t, "stroke-width") === "2" && (attr(t, "d") ?? "").includes("L"));
    expect(lines).toHaveLength(10);
    const dashes = lines.map((t) => attr(t, "stroke-dasharray"));
    expect(dashes.slice(0, 5).every((d) => d === null)).toBe(true); // 1 to 5: solid
    const dashed = dashes.slice(5, 8);
    expect(dashed.every((d) => d !== null && d === dashed[0])).toBe(true); // 6 to 8: dashed
    const dotted = dashes.slice(8);
    expect(dotted.every((d) => d !== null && d === dotted[0])).toBe(true); // 9 and 10: dotted
    expect(dotted[0]).not.toBe(dashed[0]); // and not the same as dashed
    expect(lines.slice(8).map((t) => attr(t, "stroke"))).toEqual([LIGHT_CHART.palette[0], LIGHT_CHART.palette[1]]);
    chart.dispose();
  });

  it("takes every colour from the theme it is given: axis ink, grid, band, series (the dark look draws nothing in the light colours)", () => {
    const dark: ChartTheme = {
      palette: ["#6ea8fe", "#f59a52", "#3ecf8e", "#f38bb8", "#4cc9dc", "#b49bff", "#e9c046", "#a3adbd"],
      accent: "#c9a227", axisText: "#a3adbd", axisLine: "#3a414d", grid: "#262b33", tipBg: "#262b33", tipText: "#e6e9ef", tipBorder: "#4a5261", bandOpacity: 0.22,
    };
    const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 600, height: 300 });
    chart.setOption(timeSeriesOption(two(), "Asia/Qatar", dark), { notMerge: true });
    const svg = chart.renderToSVGString();
    chart.dispose();
    const tags = svg.match(/<path\b[^>]*>/g) ?? [];
    const texts = [...svg.matchAll(/<text\b[^>]*fill="([^"]*)"[^>]*>([^<]*)<\/text>/g)].map((m) => ({ fill: m[1], text: m[2] }));
    expect(texts.length).toBeGreaterThan(5);
    expect(texts.every((t) => t.fill === dark.axisText)).toBe(true); // tick labels, unit name and legend text: one ink
    expect(tags.some((t) => attr(t, "stroke") === dark.grid)).toBe(true);
    expect(tags.some((t) => attr(t, "stroke") === dark.axisLine)).toBe(true);
    expect(bandsOf(tags, dark.palette[0], 0.22)).toHaveLength(1);
    expect(bandsOf(tags, dark.palette[1], 0.22)).toHaveLength(1);
    expect(svg).not.toContain(LIGHT_CHART.palette[0]);
    expect(svg).not.toContain("#e1e5ec"); // the light grid
  });
});

describe("the bar chart, drawn by the real chart library", () => {
  const costBars = (over: Partial<ReturnType<typeof seriesData>> = {}) => seriesData({
    type: "bar", source: "cost", unit: "QAR", metric: null, bucket: "hour", tier: null, ...over,
    series: [
      { asset_id: 5, name: "A", estimated: false, partial: true, points: [
        seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: 4 }), seriesPoint({ ts: "2026-10-08T01:00:00+00:00", value: null, partial: true }),
      ] },
      { asset_id: 6, name: "B", estimated: false, partial: true, points: [
        seriesPoint({ ts: "2026-10-08T00:00:00+00:00", value: null, partial: true }), seriesPoint({ ts: "2026-10-08T01:00:00+00:00", value: 6 }),
      ] },
    ],
  });
  const draw2 = (option: unknown) => {
    const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 600, height: 300 });
    chart.setOption(option as echarts.EChartsOption, { notMerge: true });
    const svg = chart.renderToSVGString();
    chart.dispose();
    return svg;
  };
  /** x of the centre of every bar the chart drew in `color` (a bar is a filled rectangle path "M x y l w 0 l 0 -h l -w 0Z"). */
  const barCentres = (svg: string, color: string) => (svg.match(/<path\b[^>]*>/g) ?? [])
    .filter((t) => attr(t, "fill") === color && attr(t, "ecmeta_ssr_type") === "chart")
    .map((t) => /^M([\d.]+) [\d.]+l([\d.]+) /.exec(attr(t, "d") ?? "")) // the dash's invisible point mark is a path too: only rectangles are bars
    .flatMap((m) => (m ? [Number(m[1]) + Number(m[2]) / 2] : []));
  /** x of every dash label (a text "—"). */
  const dashXs = (svg: string) => [...svg.matchAll(/<text\b[^>]*transform="translate\(([\d.]+) [\d.]+\)"[^>]*>—<\/text>/g)].map((m) => Number(m[1]));
  // Two categories, 520 px of plot from x = 60: the first is 60 to 320, the second 320 to 580.
  const FIRST_START = 60;
  const SECOND_START = 320;

  it("puts the dash of a bucket with no rate in that asset's own slot, not at the middle of the group", () => {
    const svg = draw2(barOption(costBars(), "Asia/Qatar"));
    const b = barCentres(svg, LIGHT_CHART.palette[1]); // B has a bar in the second category only
    const a = barCentres(svg, LIGHT_CHART.palette[0]); // A in the first only
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    const dashes = dashXs(svg);
    expect(dashes).toHaveLength(2); // B has no rate in the first category, A in the second
    const [inFirst, inSecond] = [...dashes].sort((x, y) => x - y);
    // B's slot in a category is where B's real bar is in the other one, measured from the start of its category
    expect(inFirst - FIRST_START).toBeCloseTo(b[0] - SECOND_START, 0);
    expect(inSecond - SECOND_START).toBeCloseTo(a[0] - FIRST_START, 0);
    // and that is not the middle of the category, where the old point mark put every dash
    expect(Math.abs(inFirst - (FIRST_START + SECOND_START) / 2)).toBeGreaterThan(20);
    expect(Math.abs(inSecond - (SECOND_START + 580) / 2)).toBeGreaterThan(20);
  });

  it("draws nothing for that bucket but the dash: no bar, no fill", () => {
    const svg = draw2(barOption(costBars(), "Asia/Qatar"));
    const chartPaths = (svg.match(/<path\b[^>]*>/g) ?? []).filter((t) => attr(t, "ecmeta_ssr_type") === "chart");
    const filled = chartPaths.filter((t) => attr(t, "fill") !== "none");
    expect(filled).toHaveLength(2); // A's 4 and B's 6
    expect(chartPaths).toHaveLength(4); // and the two zero-height items, drawn with no fill
  });

  it("draws the legend of a bar chart as a 10 x 10 rounded square in each series' colour", () => {
    const svg = draw2(barOption(costBars(), "Asia/Qatar"));
    const icons = (svg.match(/<path\b[^>]*>/g) ?? []).filter((t) => attr(t, "ecmeta_ssr_type") === "legend" && attr(t, "fill") !== "none" && (attr(t, "d") ?? "").startsWith("M2.5 0L7.5 0"));
    expect(icons.map((t) => attr(t, "fill"))).toEqual([LIGHT_CHART.palette[0], LIGHT_CHART.palette[1]]);
  });

  it("colours a bar chart of one value per asset with the accent, and its dash label with the axis ink", () => {
    const values = seriesData({
      type: "bar", mode: "values", source: "cost", unit: "QAR", metric: null, bucket: null, tier: null, series: [],
      values: [
        { asset_id: 5, name: "A", value: 4, estimated: false, partial: false, point_id: null, no_data: false, ts: null, stale: false },
        { asset_id: 6, name: "B", value: null, estimated: false, partial: false, point_id: null, no_data: false, ts: null, stale: false },
      ],
    });
    const theme: ChartTheme = { ...LIGHT_CHART, accent: "#c9a227", axisText: "#a3adbd" };
    const svg = draw2(barOption(values, "Asia/Qatar", theme));
    expect(barCentres(svg, "#c9a227")).toHaveLength(1);
    expect(svg).not.toContain(LIGHT_CHART.palette[0]);
    const dash = [...svg.matchAll(/<text\b[^>]*fill="([^"]*)"[^>]*>—<\/text>/g)];
    expect(dash).toHaveLength(1);
    expect(dash[0][1]).toBe("#a3adbd");
  });
});
