import type { Asset } from "../api/types";
import { buildTree } from "./tree";
import { foldableIds, readFolded, saveFolded } from "./treeFold";

const KEY = "dcdash.assetTreeFolded";
const a = (id: number, parent_id: number | null): Asset => ({ id, parent_id, name: `n${id}`, kind: "generic", sort_order: id });

describe("readFolded", () => {
  it("is empty when nothing is stored", () => {
    expect(readFolded().size).toBe(0);
  });

  it("reads a stored array of ids", () => {
    localStorage.setItem(KEY, "[3,1,2]");
    expect([...readFolded()].sort()).toEqual([1, 2, 3]);
  });

  it.each([["not json", "{nope"], ["an object", '{"1":true}'], ["a number", "7"], ["a string", '"1,2"'], ["null", "null"], ["empty text", ""]])(
    "ignores %s",
    (_, text) => {
      localStorage.setItem(KEY, text);
      expect(readFolded().size).toBe(0);
    },
  );

  it("keeps the integers of a mixed array and drops the rest", () => {
    localStorage.setItem(KEY, JSON.stringify([4, "5", 1.5, null, true, [6], 7, { id: 8 }]));
    expect([...readFolded()].sort()).toEqual([4, 7]);
  });

  it("ignores a list of more than 5000 entries, and accepts exactly 5000", () => {
    localStorage.setItem(KEY, JSON.stringify(Array.from({ length: 5001 }, (_, i) => i + 1)));
    expect(readFolded().size).toBe(0);
    localStorage.setItem(KEY, JSON.stringify(Array.from({ length: 5000 }, (_, i) => i + 1)));
    expect(readFolded().size).toBe(5000);
  });

  it("is empty, and does not throw, when reading storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => readFolded()).not.toThrow();
    expect(readFolded().size).toBe(0);
  });
});

describe("saveFolded", () => {
  it("round-trips through readFolded, under dcdash.assetTreeFolded", () => {
    saveFolded(new Set([9, 2, 5]));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([2, 5, 9]);
    expect([...readFolded()].sort()).toEqual([2, 5, 9]);
    saveFolded([]);
    expect(readFolded().size).toBe(0);
  });

  it("takes any iterable, de-duplicated", () => {
    saveFolded([3, 3, 1].values());
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([1, 3]);
  });

  it("does not throw when writing storage throws (full or blocked)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => saveFolded([1, 2])).not.toThrow();
  });
});

describe("foldableIds", () => {
  it("lists the nodes that have at least one child, at any depth", () => {
    const tree = buildTree([a(1, null), a(2, 1), a(3, 2), a(4, 1), a(5, null)]);
    expect(foldableIds(tree).sort()).toEqual([1, 2]);
  });

  it("is empty for no nodes and for a list of leaves", () => {
    expect(foldableIds([])).toEqual([]);
    expect(foldableIds(buildTree([a(1, null), a(2, null)]))).toEqual([]);
  });
});
