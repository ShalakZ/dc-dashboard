import type { Widget, WidgetConfig, WidgetType } from "../api/types";
import { applyGrid, defaultSize, GRID_COLS, newKey, nextPosition, toDrafts, toGrid, type DraftWidget } from "./layout";

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
