// @vitest-environment node
// Real ECharts, no DOM: the gauge is rendered to an SVG string and the positions of its texts are compared. The other
// gauge tests only see the option, which is how a name drawn over the needle went unnoticed.
import * as echarts from "echarts";
import { gaugeOption } from "./GaugeWidget";

vi.mock("echarts-for-react", () => ({ default: () => null }));

interface Label { text: string; x: number; y: number }

function labels(width: number, height: number, name: string): Label[] {
  const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width, height });
  chart.setOption(gaugeOption({ value: 12.5, min: 0, max: 100, unit: "kW", name }));
  const svg = chart.renderToSVGString();
  chart.dispose();
  return [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((m) => ({
    text: m[2],
    x: Number(/\sx="([^"]*)"/.exec(m[1])?.[1]),
    y: Number(/\sy="([^"]*)"/.exec(m[1])?.[1]),
  }));
}

describe.each([[300, 220], [600, 440], [200, 140]])("a %i x %i gauge", (width, height) => {
  const name = "LV Panel 1";
  it("draws the asset name below the value and below every scale number, inside the widget", () => {
    const all = labels(width, height, name);
    const title = all.find((l) => l.text === name);
    const value = all.find((l) => /12\.5/.test(l.text));
    const scale = all.filter((l) => /^\d+$/.test(l.text));
    expect(title, "the name is drawn").toBeDefined();
    expect(value, "the value is drawn").toBeDefined();
    expect(scale.length).toBeGreaterThan(0);
    expect(title!.y).toBeGreaterThan(value!.y);
    expect(title!.y).toBeGreaterThan(Math.max(...scale.map((l) => l.y)));
    expect(title!.y).toBeLessThan(height - 4);
    expect(Math.abs(title!.x - width / 2)).toBeLessThan(width * 0.1); // centred
  });
});
