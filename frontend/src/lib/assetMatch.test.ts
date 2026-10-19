import type { Asset } from "../api/types";
import { matchingIds, nameOrKindMatches } from "./assetMatch";
import { buildTree } from "./tree";

const asset = (id: number, parent_id: number | null, name: string, kind: string, sort_order = id): Asset => ({ id, parent_id, name, kind, sort_order });

describe("nameOrKindMatches", () => {
  const node = { name: "Hall A", kind: "room" };

  it("matches on the name", () => {
    expect(nameOrKindMatches(node, "hall")).toBe(true);
  });

  it("matches on the kind", () => {
    expect(nameOrKindMatches(node, "room")).toBe(true);
  });

  it("ignores the case of the name and the kind (the needle arrives lower-cased)", () => {
    expect(nameOrKindMatches({ name: "HALL A", kind: "ROOM" }, "hall a")).toBe(true);
    expect(nameOrKindMatches({ name: "HALL A", kind: "ROOM" }, "room")).toBe(true);
  });

  it("does not match when neither the name nor the kind contains the needle", () => {
    expect(nameOrKindMatches(node, "rack")).toBe(false);
  });

  it("matches a needle that is only part of a word", () => {
    expect(nameOrKindMatches(node, "al")).toBe(true);
    expect(nameOrKindMatches(node, "oo")).toBe(true);
  });
});

describe("matchingIds", () => {
  // 1 Site > (2 Hall A > (4 Rack 1, 5 Rack 2), 3 Hall B > 6 Rack 3)
  const assets: Asset[] = [
    asset(1, null, "Site", "site"),
    asset(2, 1, "Hall A", "room"),
    asset(3, 1, "Hall B", "room"),
    asset(4, 2, "Rack 1", "rack"),
    asset(5, 2, "Rack 2", "rack"),
    asset(6, 3, "Rack 3", "rack"),
  ];

  it("keeps the ancestors of a match", () => {
    expect([...matchingIds(buildTree(assets), "rack 3")].sort()).toEqual([1, 3, 6]);
  });

  it("leaves out a match's children unless they match too", () => {
    const ids = matchingIds(buildTree(assets), "hall a");
    expect([...ids].sort()).toEqual([1, 2]);
    expect(ids.has(4)).toBe(false);
    expect(ids.has(5)).toBe(false);
  });

  it("matches by kind", () => {
    expect([...matchingIds(buildTree(assets), "room")].sort()).toEqual([1, 2, 3]);
  });

  it("gives an empty set when nothing matches", () => {
    expect(matchingIds(buildTree(assets), "zzz").size).toBe(0);
  });

  it("keeps both branches when two branches match", () => {
    expect([...matchingIds(buildTree(assets), "rack 1")].sort()).toEqual([1, 2, 4]);
    expect([...matchingIds(buildTree(assets), "hall")].sort()).toEqual([1, 2, 3]);
    expect([...matchingIds(buildTree(assets), "rack")].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("does not change the tree it is given", () => {
    const tree = buildTree(assets);
    const before = JSON.stringify(tree);
    matchingIds(tree, "rack");
    expect(JSON.stringify(tree)).toBe(before);
  });
});
