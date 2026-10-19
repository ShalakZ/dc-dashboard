import type { Asset } from "../api/types";
import { assetChain, focusTrail } from "./focusTrail";

const a = (id: number, parent_id: number | null, name: string, sort_order = 0): Asset => ({ id, parent_id, name, kind: "generic", sort_order });
const names = (list: Asset[]) => list.map((x) => x.name);

/** One top-level asset (Site) over Hall 1 > Row 2 > Rack 5, and Hall 2 beside Hall 1. */
const single = [a(1, null, "Site"), a(2, 1, "Hall 1"), a(3, 2, "Row 2"), a(4, 3, "Rack 5"), a(5, 1, "Hall 2", 1)];
/** Two top-level assets: Site A over Hall 1 > Row 2, and Site B. */
const forest = [a(1, null, "Site A"), a(2, 1, "Hall 1"), a(3, 2, "Row 2"), a(9, null, "Site B", 1)];

describe("assetChain", () => {
  it("runs from the top-level asset down to the focus, the focus last", () => {
    expect(names(assetChain(single, 4))).toEqual(["Site", "Hall 1", "Row 2", "Rack 5"]);
    expect(names(assetChain(single, 5))).toEqual(["Site", "Hall 2"]);
  });

  it("is the asset alone for a top-level asset, and empty for an id that is not in the list", () => {
    expect(names(assetChain(single, 1))).toEqual(["Site"]);
    expect(assetChain(single, 77)).toEqual([]);
    expect(assetChain([], 1)).toEqual([]);
  });

  it("treats an asset whose parent is missing from the list as a top-level one", () => {
    expect(names(assetChain([a(3, 2, "Row 2"), a(4, 3, "Rack 5")], 4))).toEqual(["Row 2", "Rack 5"]);
  });

  it("stops at a parent loop instead of hanging", () => {
    const loop = [a(1, 2, "One"), a(2, 1, "Two")];
    expect(names(assetChain(loop, 1)).sort()).toEqual(["One", "Two"]);
  });
});

describe("focusTrail", () => {
  it("leaves out the only top-level asset: the dashboard crumb already stands for it (R5)", () => {
    expect(names(focusTrail(single, 4))).toEqual(["Hall 1", "Row 2", "Rack 5"]);
    expect(names(focusTrail(single, 2))).toEqual(["Hall 1"]);
  });

  it("is empty for a focus that IS the only top-level asset, and for an id that is not in the list", () => {
    expect(focusTrail(single, 1)).toEqual([]);
    expect(focusTrail(single, 77)).toEqual([]);
  });

  it("keeps the top-level asset when the site has several", () => {
    expect(names(focusTrail(forest, 3))).toEqual(["Site A", "Hall 1", "Row 2"]);
    expect(names(focusTrail(forest, 9))).toEqual(["Site B"]);
  });

  it("does not change the list it is given", () => {
    const before = JSON.stringify(forest);
    focusTrail(forest, 3);
    expect(JSON.stringify(forest)).toBe(before);
  });
});
