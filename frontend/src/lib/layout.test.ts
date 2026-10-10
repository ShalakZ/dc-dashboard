import { verticalCompactor } from "react-grid-layout";
import type { Widget, WidgetConfig, WidgetType } from "../api/types";
import { applyGrid, columnsOf, compactVertical, defaultSize, GRID_COLS, newKey, nextPosition, toDrafts, toGrid, type DraftWidget } from "./layout";

const config: WidgetConfig = {
  assets: [1], source: "energy", metric: null, aggregation: "sum", range: null, bars: "asset", min: 0, max: null,
};
const widget = (id: number, over: Partial<Widget> = {}): Widget => ({
  id, type: "stat", title: `w${id}`, config, x: 0, y: 0, w: 3, h: 2, ...over,
});
const draft = (key: string, over: Partial<DraftWidget> = {}): DraftWidget => ({
  key, type: "stat", title: key, config, x: 0, y: 0, w: 3, h: 2, ...over,
});

describe("toDrafts / toGrid", () => {
  it("keys drafts by the saved id and drops the id", () => {
    const drafts = toDrafts([widget(7, { x: 3, y: 2 })]);
    expect(drafts).toEqual([{ key: "7", type: "stat", title: "w7", config, x: 3, y: 2, w: 3, h: 2 }]);
  });

  it("maps drafts to grid items with per-type minimum sizes", () => {
    const grid = toGrid([draft("7", { x: 3, y: 2, w: 4, h: 3 }), draft("8", { type: "timeseries" })]);
    expect(grid).toEqual([
      { i: "7", x: 3, y: 2, w: 4, h: 3, minW: 2, minH: 2 },
      { i: "8", x: 0, y: 0, w: 3, h: 2, minW: 3, minH: 3 },
    ]);
  });

  it.each<WidgetType>(["timeseries", "bar", "stat", "gauge", "table"])("a new %s fits its own minimum and the grid", (type) => {
    const size = defaultSize(type);
    const item = toGrid([draft("k", { type, ...size })])[0];
    expect(size.w).toBeGreaterThanOrEqual(item.minW ?? 0);
    expect(size.h).toBeGreaterThanOrEqual(item.minH ?? 0);
    expect(size.w).toBeLessThanOrEqual(GRID_COLS);
  });
});

describe("applyGrid", () => {
  it("copies x, y, w, h by key and leaves the rest alone", () => {
    const drafts = [draft("1"), draft("2", { x: 3 })];
    const next = applyGrid(drafts, [{ i: "2", x: 6, y: 4, w: 5, h: 3 }, { i: "1", x: 0, y: 0, w: 3, h: 2 }]);
    expect(next).toEqual([draft("1"), draft("2", { x: 6, y: 4, w: 5, h: 3 })]);
    expect(drafts[1].x).toBe(3); // the input is not mutated
  });

  it("ignores grid items without a draft and keeps drafts missing from the grid", () => {
    const drafts = [draft("1"), draft("2")];
    const next = applyGrid(drafts, [{ i: "1", x: 1, y: 1, w: 3, h: 2 }, { i: "ghost", x: 9, y: 9, w: 1, h: 1 }]);
    expect(next.map((d) => [d.key, d.x, d.y])).toEqual([["1", 1, 1], ["2", 0, 0]]);
  });

  it("returns the same array when nothing moved, so a no-op layout event cannot dirty the editor", () => {
    const drafts = [draft("1"), draft("2", { x: 3 })];
    expect(applyGrid(drafts, toGrid(drafts))).toBe(drafts);
  });
});

describe("nextPosition and newKey", () => {
  it("starts an empty grid at the origin and otherwise the first free row below everything", () => {
    expect(nextPosition([], { w: 6, h: 4 })).toEqual({ x: 0, y: 0 });
    const drafts = [draft("1", { y: 0, h: 2 }), draft("2", { x: 6, y: 2, h: 3 }), draft("3", { y: 1, h: 1 })];
    expect(nextPosition(drafts, { w: 6, h: 4 })).toEqual({ x: 0, y: 5 });
  });

  it("hands out distinct keys that cannot collide with saved ids", () => {
    const a = newKey();
    const b = newKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^new-\d+$/);
  });
});

const ys = (items: readonly DraftWidget[]) => items.map((d) => d.y);

describe("columnsOf", () => {
  it("is the columns the read-only grid draws: a widget never spills past the last column", () => {
    expect(columnsOf({ x: 0, w: 4 })).toEqual({ start: 0, end: 4 });
    expect(columnsOf({ x: 10, w: 6 })).toEqual({ start: 10, end: 12 });
    expect(columnsOf({ x: 20, w: 3 })).toEqual({ start: 11, end: 12 });
    expect(columnsOf({ x: -2, w: 0 })).toEqual({ start: 0, end: 1 });
  });
});

describe("compactVertical", () => {
  it("closes a gap", () => {
    const next = compactVertical([draft("a", { w: 6 }), draft("b", { y: 5, w: 6 })]);
    expect(ys(next)).toEqual([0, 2]);
  });

  it("lets widgets in different columns both sit at the top", () => {
    const next = compactVertical([draft("a", { w: 6 }), draft("b", { x: 6, y: 4, w: 6 })]);
    expect(ys(next)).toEqual([0, 0]);
  });

  it("puts the later of two widgets on the same place directly below the earlier one, not far down", () => {
    const next = compactVertical([draft("a", { w: 6 }), draft("b", { w: 6 })]);
    expect(ys(next)).toEqual([0, 2]);
    expect(ys(compactVertical([draft("a", { y: 1, w: 6 }), draft("b", { w: 6 })]))).toEqual([2, 0]); // reading order decides, not array order
  });

  it("moves the displaced widget down only as far as needed after a drop on an occupied place", () => {
    // A (0,0,w6), B (6,0,w6) and C (0,2,w12); A was dropped onto B's place.
    const next = compactVertical([
      draft("A", { x: 6, y: 0, w: 6 }), draft("B", { x: 6, y: 0, w: 6 }), draft("C", { x: 0, y: 2, w: 12 }),
    ]);
    expect(next.map(({ key, x, y }) => ({ key, x, y }))).toEqual([{ key: "A", x: 6, y: 0 }, { key: "B", x: 6, y: 2 }, { key: "C", x: 0, y: 4 }]);
  });

  it("keeps the order, changes nothing but y, and is idempotent", () => {
    const input = [draft("a", { y: 6, w: 6 }), draft("b", { x: 6, y: 0, w: 6, h: 3 }), draft("c", { y: 1, w: 12 })];
    const once = compactVertical(input);
    expect(once.map((d) => d.key)).toEqual(["a", "b", "c"]);
    expect(once[1]).toBe(input[1]); // untouched items are the same objects
    once.forEach((d, i) => expect({ ...d, y: 0 }).toEqual({ ...input[i], y: 0 })); // only y differs
    expect(input.map((d) => d.y)).toEqual([6, 0, 1]); // the input is not mutated
    expect(compactVertical(once)).toBe(once); // closed up already: the same array
    expect(compactVertical(once)).toEqual(once);
  });

  it("returns the very same array when nothing moves and a new one when something does", () => {
    const tight = [draft("a", { w: 6 }), draft("b", { x: 6, w: 6 }), draft("c", { y: 2, w: 12 })];
    expect(compactVertical(tight)).toBe(tight);
    expect(compactVertical([])).toEqual([]);
    const gappy = [draft("a"), draft("b", { y: 3 })];
    expect(compactVertical(gappy)).not.toBe(gappy);
  });

  it("collides on the columns the read-only grid draws, and treats h 0 as 1 and a negative y as 0", () => {
    // x 20 is drawn in the last column only, x 10 + w 6 in the last two.
    const clamped = compactVertical([
      draft("a", { x: 20, w: 3 }), draft("b", { x: 11, y: 3, w: 1 }), draft("c", { x: 10, y: 3, w: 1 }),
    ]);
    expect(ys(clamped)).toEqual([0, 2, 0]);
    const wide = compactVertical([draft("a", { x: 10, w: 6 }), draft("b", { x: 11, y: 5, w: 1 }), draft("c", { x: 9, y: 5, w: 1 })]);
    expect(ys(wide)).toEqual([0, 2, 0]);
    expect(ys(compactVertical([draft("a", { h: 0 }), draft("b", { y: 4 })]))).toEqual([0, 1]);
    expect(ys(compactVertical([draft("a", { y: -3 })]))).toEqual([0]);
  });

  it("gives the editor and the viewer one answer: the viewer draws exactly what the editor would hold", () => {
    const drafts = toDrafts([widget(1, { y: 0, w: 6 }), widget(2, { y: 5, w: 6 }), widget(3, { x: 6, y: 9, w: 6, h: 4 })]);
    expect(ys(compactVertical(drafts))).toEqual([0, 2, 0]);
  });
});

describe("toDrafts normalises rows the grid would draw differently", () => {
  it("clamps x and w to the 12 columns and h and y to at least 1 and 0, and leaves valid rows alone", () => {
    const [wide, flat, above, fine] = toDrafts([
      widget(1, { x: 10, w: 6 }), widget(2, { h: 0 }), widget(3, { y: -3 }), widget(4, { x: 3, y: 2, w: 4, h: 5 }),
    ]);
    expect(wide).toMatchObject({ x: 10, w: 2 });
    expect(flat.h).toBe(1);
    expect(above.y).toBe(0);
    expect(fine).toMatchObject({ x: 3, y: 2, w: 4, h: 5 });
  });
});

describe("compactVertical against react-grid-layout's verticalCompactor", () => {
  type Box = { i: string; x: number; y: number; w: number; h: number };
  // A small seeded generator (mulberry32), so a failure is reproducible.
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const clone = (layout: readonly Box[]): Box[] => layout.map((b) => ({ ...b })); // the library mutates its input
  const between = (next: () => number, low: number, high: number) => low + Math.floor(next() * (high - low + 1));
  const layoutOf = (next: () => number): Box[] =>
    Array.from({ length: between(next, 1, 10) }, (_, i) => {
      const x = between(next, 0, 11);
      return { i: String(i), x, y: between(next, 0, 8), w: between(next, 1, GRID_COLS - x), h: between(next, 1, 4) };
    });
  const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const overlapping = (layout: readonly Box[]) => layout.some((a, i) => layout.slice(i + 1).some((b) => overlap(a, b)));
  const collect = (want: boolean, count: number, next: () => number): Box[][] => {
    const found: Box[][] = [];
    for (let tries = 0; found.length < count && tries < 200_000; tries += 1) {
      const layout = layoutOf(next);
      if (overlapping(layout) === want) found.push(layout);
    }
    return found;
  };
  const yById = (layout: readonly Box[]) => Object.fromEntries(layout.map((b) => [b.i, b.y]));

  it("gives the same y for every item of a layout without overlaps", () => {
    const layouts = collect(false, 200, random(1));
    expect(layouts).toHaveLength(200);
    for (const layout of layouts) {
      expect(yById(compactVertical(clone(layout)))).toEqual(yById(verticalCompactor.compact(clone(layout), GRID_COLS)));
    }
  });

  it("agrees with the library about its own output, and leaves no two rectangles overlapping, for layouts WITH overlaps", () => {
    const layouts = collect(true, 200, random(2));
    expect(layouts).toHaveLength(200);
    for (const layout of layouts) {
      const ours = compactVertical(clone(layout));
      expect(overlapping(ours)).toBe(false);
      expect(yById(verticalCompactor.compact(clone(ours), GRID_COLS))).toEqual(yById(ours)); // the library leaves our result alone
      const theirs = verticalCompactor.compact(clone(layout), GRID_COLS);
      expect(yById(compactVertical(clone(theirs)))).toEqual(yById(theirs)); // and we leave the library's alone
    }
  });
});
