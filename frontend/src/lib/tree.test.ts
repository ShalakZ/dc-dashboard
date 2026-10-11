import type { Asset } from "../api/types";
import { ancestorIds, buildTree, descendantIds } from "./tree";

const a = (id: number, parent_id: number | null, name: string, sort_order = 0): Asset => ({
  id, parent_id, name, kind: "generic", sort_order,
});

describe("buildTree", () => {
  it("nests children under parents and sorts by sort_order then name", () => {
    const tree = buildTree([a(3, 1, "b"), a(1, null, "Site"), a(2, 1, "a"), a(4, 1, "z", -1)]);
    expect(tree.map((n) => n.id)).toEqual([1]);
    expect(tree[0].children.map((n) => n.name)).toEqual(["z", "a", "b"]);
  });

  it("treats an asset with a missing parent as a root", () => {
    const tree = buildTree([a(5, 99, "orphan"), a(1, null, "Site")]);
    expect(tree.map((n) => n.name)).toEqual(["Site", "orphan"]);
  });

  it("returns an empty list for no assets", () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe("descendantIds", () => {
  it("includes the node itself and all descendants", () => {
    const tree = buildTree([a(1, null, "Site"), a(2, 1, "Room"), a(3, 2, "Rack"), a(4, 1, "Other")]);
    expect([...descendantIds(tree, 2)].sort()).toEqual([2, 3]);
    expect([...descendantIds(tree, 9)]).toEqual([]);
  });
});

describe("ancestorIds", () => {
  const tree = buildTree([a(1, null, "Site"), a(2, 1, "Room"), a(3, 2, "Rack"), a(4, 3, "Server"), a(5, 1, "Other"), a(6, null, "Yard")]);

  it("lists the parents from the root down to the direct parent", () => {
    expect(ancestorIds(tree, 4)).toEqual([1, 2, 3]);
    expect(ancestorIds(tree, 3)).toEqual([1, 2]);
    expect(ancestorIds(tree, 5)).toEqual([1]);
  });

  it("is empty for a root, an unknown id and an empty tree", () => {
    expect(ancestorIds(tree, 1)).toEqual([]);
    expect(ancestorIds(tree, 6)).toEqual([]);
    expect(ancestorIds(tree, 99)).toEqual([]);
    expect(ancestorIds([], 1)).toEqual([]);
  });
});
