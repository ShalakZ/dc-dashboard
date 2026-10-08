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
    expect(lineOf(paths, colorOf(option)).every((p) => segments(p) === 0)).toBe(true); // the line itself is a bare move-to
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
