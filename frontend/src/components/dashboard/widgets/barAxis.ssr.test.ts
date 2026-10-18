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

function draw(names: readonly string[], width: number, flags: { estimated?: number[]; silent?: number[] } = {}) {
  const rows = names.map((name, i) => valueRow({
    asset_id: 20 + i, name, point_id: null, estimated: flags.estimated?.includes(i) ?? false,
    ...(flags.silent?.includes(i) ? { value: null, no_data: true } : { value: 10 + i * 3 }),
  }));
  const data = valuesData({ type: "bar", source: "metric", metric: "active_power_kw", unit: "kWh", values: rows });
  const labels = chartLabels(rows);
  const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width, height: HEIGHT });
  chart.setOption(barOption(data, "Asia/Qatar", undefined, width));
  const svg = chart.renderToSVGString();
  chart.dispose();
  return { labels, drawn: labelsOf(svg), layout: barAxisLayout(labels, width) };
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
