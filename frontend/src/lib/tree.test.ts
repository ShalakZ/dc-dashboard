import type { Asset } from "../api/types";
import { ancestorIds, assetTrail, buildTree, descendantIds, parseAssetId } from "./tree";

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

describe("assetTrail", () => {
  const list = [a(4, 3, "Server"), a(1, null, "Site"), a(2, 1, "Room"), a(3, 2, "Rack"), a(5, 1, "Other"), a(6, null, "Yard")];

  it("lists the asset's ancestors from the root down, ending with the asset itself, however the list is ordered", () => {
    expect(assetTrail(list, 4).map((x) => x.name)).toEqual(["Site", "Room", "Rack", "Server"]);
    expect(assetTrail(list, 5).map((x) => x.id)).toEqual([1, 5]);
  });

  it("is the asset alone for a root", () => {
    expect(assetTrail(list, 6).map((x) => x.id)).toEqual([6]);
  });

  it("is empty for an unknown id and for an empty list", () => {
    expect(assetTrail(list, 99)).toEqual([]);
    expect(assetTrail([], 1)).toEqual([]);
  });

  it("stops at a parent that is not in the list, as buildTree makes an orphan a root", () => {
    expect(assetTrail([a(5, 99, "orphan"), a(6, 5, "child")], 6).map((x) => x.id)).toEqual([5, 6]);
  });

  it("ends on a cycle instead of looping, and still ends with the asset itself", () => {
    const looped = [a(1, 2, "A"), a(2, 1, "B"), a(3, 3, "Self")];
    expect(assetTrail(looped, 1).map((x) => x.id)).toEqual([2, 1]);
    expect(assetTrail(looped, 3).map((x) => x.id)).toEqual([3]);
  });
});

describe("parseAssetId", () => {
  it("takes a plain positive integer that fits the API's int32 id", () => {
    expect(parseAssetId("1")).toBe(1);
    expect(parseAssetId("42")).toBe(42);
    expect(parseAssetId("2147483647")).toBe(2147483647);
  });

  it.each(["12abc", "abc", "0", "-1", "007", "+5", "1.5", "1e3", "0x10", " 1", "1 ", "2147483648", "99999999999", ""])("rejects %j", (raw) => {
    expect(parseAssetId(raw)).toBeNull();
  });

  it("rejects a missing parameter", () => {
    expect(parseAssetId(undefined)).toBeNull();
  });
});
