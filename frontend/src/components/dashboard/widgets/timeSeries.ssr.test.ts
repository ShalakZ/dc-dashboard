// @vitest-environment node
// Real ECharts, no DOM: the option is rendered to an SVG string and what was drawn is looked at. The other widget tests
// replace echarts-for-react by a stub and can only see the option, which is how a bucket-width error that made
// every line of a 24h chart vanish slipped through once.
import * as echarts from "echarts";
import { seriesData, seriesPoint } from "../../../test/dashboardFixtures";
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
