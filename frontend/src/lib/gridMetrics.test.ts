import { cellStyle, readingOrder } from "./gridMetrics";

describe("cellStyle", () => {
  it("places a widget on the 12-column grid (1-based lines)", () => {
    expect(cellStyle({ x: 0, y: 0, w: 4, h: 3 })).toEqual({ gridColumn: "1 / span 4", gridRow: "1 / span 3" });
    expect(cellStyle({ x: 3, y: 2, w: 6, h: 2 })).toEqual({ gridColumn: "4 / span 6", gridRow: "3 / span 2" });
  });
  it("never lets a widget spill past the last column", () => {
    expect(cellStyle({ x: 10, y: 0, w: 6, h: 1 })).toEqual({ gridColumn: "11 / span 2", gridRow: "1 / span 1" });
    expect(cellStyle({ x: 20, y: 0, w: 3, h: 1 })).toEqual({ gridColumn: "12 / span 1", gridRow: "1 / span 1" });
  });
});

describe("readingOrder", () => {
  it("sorts top to bottom, then left to right, without touching the input", () => {
    const items = [{ x: 6, y: 0, id: "b" }, { x: 0, y: 3, id: "c" }, { x: 0, y: 0, id: "a" }];
    expect(readingOrder(items).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(items.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });
});
