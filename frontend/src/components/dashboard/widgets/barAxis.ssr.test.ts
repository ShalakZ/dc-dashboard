// @vitest-environment node
// P1 (w14), on the real chart library: the option of a bar chart is rendered to an SVG string (no DOM, the pattern of timeSeries.ssr.test.ts) and the
// axis labels are read back from the <text> elements. barAxis.test.ts proves the layout from its own estimates; this file proves that what the library
// finally draws is every asset's label, in its own slot, not touching a neighbour, not cut by the library's own truncation and inside the picture.
import * as echarts from "echarts";
import { chartLabels } from "../../../lib/widgetFormat";
import { valueRow, valuesData } from "../../../test/dashboardFixtures";
import { barAxisLayout, LABEL_LINES } from "./barAxis";
import { barOption } from "./BarWidget";

vi.mock("echarts-for-react", () => ({ default: () => null }));

const HEIGHT = 300;
const LINE_PX = 14;
type Point = [number, number];

/** One <text> element of the drawing: its text, where its anchor is (a translate, or the matrix of a rotated label) and how it hangs from it. */
interface Piece { text: string; anchor: string; transform: string; matrix: number[]; dy: number }

const decode = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

function pieces(svg: string): Piece[] {
  return [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map(([, tag, content]) => {
    const transform = attr(tag, "transform") ?? "";
    const numbers = (/\(([^)]*)\)/.exec(transform)?.[1] ?? "").split(/[\s,]+/).map(Number);
    const matrix = transform.startsWith("matrix") ? numbers : [1, 0, 0, 1, numbers[0] ?? 0, numbers[1] ?? 0];
    return { text: decode(content), anchor: attr(tag, "text-anchor") ?? "start", transform, matrix, dy: Number(attr(tag, "y") ?? 0) };
  });
}

/** What the drawing holds for the category axis: the y axis's numbers (anchored at their end, not turned) and the unit title are left out. */
const axisPieces = (all: Piece[], unit: string) => all.filter((p) => p.text !== unit && !(p.anchor === "end" && !p.transform.startsWith("matrix")));

/** The labels, left to right: the lines of each (top to bottom) and the corners of the box of each line, as drawn (a turned label is a turned box). */
function labelsOf(svg: string) {
  const groups = new Map<string, Piece[]>();
  for (const piece of axisPieces(pieces(svg), "kWh")) groups.set(piece.transform, [...(groups.get(piece.transform) ?? []), piece]);
  return [...groups.values()].sort((a, b) => a[0].matrix[4] - b[0].matrix[4]).map((lines) => {
    const ordered = [...lines].sort((a, b) => a.dy - b.dy);
    const boxes = ordered.map((p) => {
      const width = echarts.format.getTextRect(p.text, "12px sans-serif").width;
      const [x0, x1] = p.anchor === "end" ? [-width, 0] : [-width / 2, width / 2];
      const [a, b, c, d, e, f] = p.matrix;
      return ([[x0, p.dy - LINE_PX / 2], [x1, p.dy - LINE_PX / 2], [x1, p.dy + LINE_PX / 2], [x0, p.dy + LINE_PX / 2]] as Point[]).map(([x, y]): Point => [a * x + c * y + e, b * x + d * y + f]);
    });
    return { lines: ordered.map((p) => p.text), boxes };
  });
}

/** Whether two convex boxes overlap (the separating-axis test; boxes that only touch do not). */
function overlap(p: Point[], q: Point[]): boolean {
  for (const shape of [p, q]) {
    for (let i = 0; i < shape.length; i++) {
      const [x1, y1] = shape[i];
      const [x2, y2] = shape[(i + 1) % shape.length];
      const axis: Point = [y1 - y2, x2 - x1];
      const project = (box: Point[]) => box.map(([x, y]) => x * axis[0] + y * axis[1]);
      const [a, b] = [project(p), project(q)];
      if (Math.max(...a) <= Math.min(...b) + 1e-6 || Math.max(...b) <= Math.min(...a) + 1e-6) return false;
    }
  }
  return true;
}

/**
 * The plot as drawn: the bars' baseline (every bar's path starts at it) and the top of the grid (the highest tick of the y axis, whose numbers are
 * anchored at their end and not turned). The height between them is what the chart shows its values in.
 */
function plotOf(svg: string) {
  const baselines = [...svg.matchAll(/<path d="M[\d.]+ ([\d.]+)l[^"]*"[^>]*ecmeta_series_index/g)].map((m) => Number(m[1]));
  const ticks = pieces(svg).filter((p) => p.text !== "kWh" && p.anchor === "end" && !p.transform.startsWith("matrix")).map((p) => p.matrix[5]);
  return { baseline: Math.max(...baselines), top: Math.min(...ticks), bars: baselines.length };
}

function draw(names: readonly string[], width: number, flags: { estimated?: number[]; silent?: number[]; small?: boolean } = {}, height = HEIGHT) {
  const rows = names.map((name, i) => valueRow({
    asset_id: 20 + i, name, point_id: null, estimated: flags.estimated?.includes(i) ?? false,
    ...(flags.silent?.includes(i) ? { value: null, no_data: true } : { value: flags.small ? 1 + (i % 5) : 10 + i * 3 }), // small: an axis of one-digit numbers
  }));
  const data = valuesData({ type: "bar", source: "metric", metric: "active_power_kw", unit: "kWh", values: rows });
  const labels = chartLabels(rows);
  const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width, height });
  chart.setOption(barOption(data, "Asia/Qatar", undefined, width));
  const svg = chart.renderToSVGString();
  chart.dispose();
  return { labels, drawn: labelsOf(svg), layout: barAxisLayout(labels, width), plot: plotOf(svg) };
}

// The names of the w13 showcase: one has no data, one carries the "~" suffix. And the shouting kind, which is the widest text there is.
const SIX = ["Rack A01", "Rack A02", "UPS-1 output", "CRAH-3 supply fan", "Chiller plant 2 condenser loop", "PDU B07"];
const CAPS = ["CRAH-3 SUPPLY FAN", "MV2-R2-LV-PANEL-02", "PDU B07"];
const FLAGS = { estimated: [1], silent: [4] };

describe.each<[string, readonly string[], { estimated?: number[]; silent?: number[] }]>([["the showcase names", SIX, FLAGS], ["all-caps names", CAPS, {}]])(
  "the axis of a bar chart of %s, drawn by the real chart library",
  (_, names, flags) => {
    it.each([330, 540, 880])("at a chart width of %i px draws every asset's label, apart from its neighbours, inside the picture", (width) => {
      const { labels, drawn, layout } = draw(names, width, flags);
      expect(drawn).toHaveLength(names.length); // every asset has a label, the one with no data too
      drawn.forEach((label, k) => {
        expect(label.lines.length).toBeGreaterThanOrEqual(1);
        expect(label.lines.length).toBeLessThanOrEqual(LABEL_LINES);
        // Drawn as the layout decided: the library did not cut a line of it again, and it did not rotate what was to wrap or the reverse.
        expect(label.lines).toEqual((layout.labels.get(labels[k]) ?? "").split("\n"));
        for (const corner of label.boxes.flat()) {
          expect(corner[0]).toBeGreaterThanOrEqual(0);
          expect(corner[0]).toBeLessThanOrEqual(width);
          expect(corner[1]).toBeGreaterThanOrEqual(0);
          expect(corner[1]).toBeLessThanOrEqual(HEIGHT);
        }
      });
      for (let i = 0; i < drawn.length; i++) {
        for (let j = i + 1; j < drawn.length; j++) {
          for (const p of drawn[i].boxes) for (const q of drawn[j].boxes) expect(overlap(p, q), `${labels[i]} and ${labels[j]} at ${width}px`).toBe(false);
        }
      }
    });
  },
);

// Review finding 1: a turned axis used containLabel AND a big grid.bottom (and left), so the room of the names was counted twice and the plot kept a
// third of a narrow card. The real library draws the bars here, so what is measured is what a card shows.
describe("the plot of a bar chart with a turned axis (the normal mode of a narrow card)", () => {
  const TWENTY = Array.from({ length: 20 }, (_, i) => `Distribution panel number ${i + 1}`);

  // The first name is the one that can stick out at the left: a long one, a shouting one and one of the widest letters are the worst cases.
  const SHOUTING = ["MV2-R2-LV-PANEL-02 EAST", "CRAH-3 SUPPLY FAN", "PDU B07", "DB-1", "DB-2", "DB-3", "DB-4"];
  const WIDEST = ["WWWWWWWWWWWW", ...SIX];
  const CASES: [string, number, number, readonly string[]][] = [
    ["six names", 266, 266, SIX], ["six names", 341, 266, SIX], ["six names", 341, 300, SIX], ["twenty names", 480, 300, TWENTY], ["twenty names", 880, 300, TWENTY],
    ["shouting names", 330, 300, SHOUTING], ["shouting names", 400, 300, SHOUTING],
  ];

  /** Every corner of every turned name is inside the picture: nothing is cut at the left edge, the right or the bottom. */
  function expectInside(drawn: ReturnType<typeof draw>["drawn"], width: number, height: number) {
    expect(drawn.length).toBeGreaterThanOrEqual(1);
    for (const label of drawn) {
      for (const corner of label.boxes.flat()) {
        expect(corner[0], `${label.lines.join(" ")} on the left`).toBeGreaterThanOrEqual(0);
        expect(corner[0]).toBeLessThanOrEqual(width);
        expect(corner[1]).toBeGreaterThanOrEqual(0);
        expect(corner[1], `${label.lines.join(" ")} at the bottom`).toBeLessThanOrEqual(height);
      }
    }
  }

  it.each(CASES)("%s in a chart of %i x %i px keep at least half of the height for the plot, and no turned name leaves the picture", (_, width, height, names) => {
    const { drawn, layout, plot } = draw(names, width, {}, height);
    expect(layout.mode).toBe("rotate");
    expect(plot.bars, "every bar is drawn").toBe(names.length);
    expect(plot.baseline - plot.top).toBeGreaterThanOrEqual(height / 2);
    expectInside(drawn, width, height);
  });

  // The y axis's numbers take room left of the plot too, and the least of it is one digit: the margin must hold the first name on that axis as well.
  it.each([[480, 300, TWENTY], [341, 266, SIX], [330, 300, SHOUTING]] as const)("a chart of %i x %i px whose y axis has one-digit numbers does not cut its first name", (width, height, names) => {
    const { drawn, layout } = draw(names, width, { small: true }, height);
    expect(layout.mode).toBe("rotate");
    expectInside(drawn, width, height);
  });

  // Eighteen of the widest letter turned are 130 px tall by themselves, which no card of this height can also give half to: only the edges are claimed.
  it.each([[300, 266], [341, 300]])("a first name of the widest letters in a chart of %i x %i px is not cut either", (width, height) => {
    const { drawn, layout } = draw(WIDEST, width, {}, height);
    expect(layout.mode).toBe("rotate");
    expectInside(drawn, width, height);
  });
});

describe("the axis when two names wrap to the same text", () => {
  const COLLIDING = ["Main feeder room A01 east hall", "Main feeder room A02 east hall", "H1", "H2", "H3", "H4"];

  it.each([480, 540])("at %i px keeps them apart with up to four lines, none touching another", (width) => {
    const { labels, drawn, layout } = draw(COLLIDING, width);
    expect(layout.mode).toBe("wrap");
    expect(drawn).toHaveLength(COLLIDING.length);
    expect(drawn[0].lines.join(" ")).not.toBe(drawn[1].lines.join(" "));
    expect(Math.max(...drawn.map((label) => label.lines.length))).toBeLessThanOrEqual(LABEL_LINES + 1);
    drawn.forEach((label, k) => expect(label.lines).toEqual((layout.labels.get(labels[k]) ?? "").split("\n")));
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) for (const p of drawn[i].boxes) for (const q of drawn[j].boxes) expect(overlap(p, q)).toBe(false);
    }
  });

  it("reaches the fourth line in at least one of those widths (the case is really exercised)", () => {
    const most = [480, 540].map((width) => Math.max(...draw(COLLIDING, width).drawn.map((label) => label.lines.length)));
    expect(Math.max(...most)).toBe(LABEL_LINES + 1);
  });
});

describe("the boxes of the test itself", () => {
  it("tell overlapping boxes from boxes that touch or stand apart, turned or not", () => {
    const box = (x: number, y: number, w = 10, h = 10): Point[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    expect(overlap(box(0, 0), box(5, 5))).toBe(true);
    expect(overlap(box(0, 0), box(10, 0))).toBe(false); // touching
    expect(overlap(box(0, 0), box(20, 0))).toBe(false);
    const turned: Point[] = [[5, -4], [14, 5], [5, 14], [-4, 5]]; // a diamond around (5, 5)
    expect(overlap(turned, box(0, 0))).toBe(true);
    expect(overlap(turned, box(12, -2, 4, 4))).toBe(false); // inside the corner of the square's bounding box, outside the diamond
  });
});
