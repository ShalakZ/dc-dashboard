import type { Asset } from "../api/types";
import {
  FOLD_ROW_LIMIT,
  fixedLevelFold,
  flattenTree,
  foldModel,
  foldedForLevel,
  levelOfFold,
  rowsAtLevel,
  sizeDefaultFold,
  type FoldItem,
  type FoldModel,
} from "./foldLevels";
import { buildTree } from "./tree";

const item = (id: number, parent_id: number | null): FoldItem => ({ id, parent_id });

/** The rows a fold leaves on screen: depth first from the roots, a folded row shows itself and hides what is below. */
function visibleCount(model: FoldModel, folded: ReadonlySet<number>): number {
  let count = 0;
  const stack = [...model.roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    count += 1;
    if (!folded.has(id)) stack.push(...(model.children.get(id) ?? []));
  }
  return count;
}

/** A tree shaped like the pilot-hall seed: 1 site, 3 children (2 halls, electrical), 4 pods + 8 panels, 8 rows, 117 racks, 229 feeds (370 rows). */
function seedShaped(): FoldItem[] {
  const items: FoldItem[] = [];
  let next = 1;
  const add = (parent: number | null) => { items.push(item(next, parent)); return next++; };
  const site = add(null);
  const hall1 = add(site);
  const hall2 = add(site);
  const electrical = add(site);
  const pods = [add(hall1), add(hall1), add(hall2), add(hall2)];
  for (let i = 0; i < 8; i++) add(electrical);
  const rows = pods.flatMap((pod) => [add(pod), add(pod)]); // 8 rows
  const racks: number[] = [];
  for (let i = 0; i < 117; i++) racks.push(add(rows[i % rows.length]));
  for (let i = 0; i < 229; i++) add(racks[i % racks.length]); // 112 racks get two feeds, 5 get one
  return items;
}

describe("foldModel", () => {
  it("is empty for no items", () => {
    const model = foldModel([]);
    expect(model.roots).toEqual([]);
    expect(model.total).toBe(0);
    expect(model.maxDepth).toBe(0);
    expect(model.foldable).toEqual([]);
  });

  it("gives roots, depth, children (list order), below and foldable for a parents-first list", () => {
    const model = foldModel([item(1, null), item(2, 1), item(3, 2), item(4, 1), item(5, null)]);
    expect(model.roots).toEqual([1, 5]);
    expect(model.total).toBe(5);
    expect([1, 2, 3, 4, 5].map((id) => model.depth.get(id))).toEqual([0, 1, 2, 1, 0]);
    expect(model.depth.size).toBe(5);
    expect(model.children.get(1)).toEqual([2, 4]);
    expect(model.children.get(2)).toEqual([3]);
    expect(model.children.get(3) ?? []).toEqual([]);
    expect(model.children.get(5) ?? []).toEqual([]);
    expect(model.below.get(1)).toBe(3);
    expect(model.below.get(2)).toBe(1);
    expect(model.below.get(3)).toBe(0);
    expect(model.below.get(4)).toBe(0);
    expect(model.below.get(5)).toBe(0);
    expect(model.foldable).toEqual([1, 2]);
    expect(model.maxDepth).toBe(2);
  });

  it("does not need parents first: a list with the children before their parents gives the same tree", () => {
    const forward = foldModel([item(1, null), item(2, 1), item(3, 2), item(4, 1), item(5, null)]);
    const backward = foldModel([item(3, 2), item(4, 1), item(2, 1), item(5, null), item(1, null)]);
    for (const id of [1, 2, 3, 4, 5]) {
      expect(backward.depth.get(id)).toBe(forward.depth.get(id));
      expect(backward.below.get(id)).toBe(forward.below.get(id));
    }
    expect(backward.maxDepth).toBe(2);
    expect(backward.roots).toEqual([5, 1]); // list order
    expect(backward.children.get(1)).toEqual([4, 2]); // list order again
    expect(backward.foldable).toEqual([2, 1]);
  });

  it("makes an item whose parent is not in the list a root", () => {
    const model = foldModel([item(2, 99), item(3, 2), item(4, null)]);
    expect(model.roots).toEqual([2, 4]);
    expect(model.depth.get(2)).toBe(0);
    expect(model.depth.get(3)).toBe(1);
    expect(model.below.get(2)).toBe(1);
    expect(model.total).toBe(3);
  });

  it("ends a cycle at its first item in list order, which becomes a root", () => {
    const model = foldModel([item(1, 2), item(2, 1)]);
    expect(model.roots).toEqual([1]);
    expect(model.depth.get(1)).toBe(0);
    expect(model.depth.get(2)).toBe(1);
    expect(model.below.get(1)).toBe(1);
    expect(model.total).toBe(2);
  });

  it("ends a cycle with a tail and a separate tree, and counts every item once", () => {
    // 3 -> 4 -> 5 -> 3 is the cycle; 6 hangs off 4; 10 is a plain root. 3 comes first in list order, so it becomes the root.
    const model = foldModel([item(10, null), item(3, 4), item(4, 5), item(5, 3), item(6, 4)]);
    expect(model.roots).toEqual([10, 3]);
    expect(model.depth.get(3)).toBe(0);
    expect(model.depth.get(5)).toBe(1);
    expect(model.depth.get(4)).toBe(2);
    expect(model.depth.get(6)).toBe(3);
    expect(model.below.get(3)).toBe(3);
    expect(model.maxDepth).toBe(3);
    expect(model.total).toBe(5);
    expect(visibleCount(model, new Set())).toBe(5);
  });

  it("treats an item that is its own parent as a root", () => {
    const model = foldModel([item(7, 7), item(8, 7)]);
    expect(model.roots).toEqual([7]);
    expect(model.depth.get(8)).toBe(1);
  });

  it("keeps the first of a duplicated id", () => {
    const model = foldModel([item(1, null), item(2, 1), item(2, null)]);
    expect(model.total).toBe(2);
    expect(model.roots).toEqual([1]);
    expect(model.depth.get(2)).toBe(1);
  });

  it("has maxDepth 0 for a flat list", () => {
    const model = foldModel([item(1, null), item(2, null), item(3, null)]);
    expect(model.maxDepth).toBe(0);
    expect(model.foldable).toEqual([]);
    expect(model.roots).toEqual([1, 2, 3]);
  });

  it("does not overflow the stack: 2,000 rows 50 deep, and a 30,000 row chain given child first", () => {
    // 40 chains of 50: ids 1..50, 51..100, ... each chain a root at its first id.
    const chains: FoldItem[] = [];
    for (let id = 1; id <= 2000; id++) chains.push(item(id, (id - 1) % 50 === 0 ? null : id - 1));
    const model = foldModel(chains);
    expect(model.total).toBe(2000);
    expect(model.roots.length).toBe(40);
    expect(model.maxDepth).toBe(49);
    expect(model.below.get(1)).toBe(49);

    const long: FoldItem[] = [];
    for (let id = 30000; id >= 1; id--) long.push(item(id, id === 1 ? null : id - 1));
    const deep = foldModel(long);
    expect(deep.maxDepth).toBe(29999);
    expect(deep.below.get(1)).toBe(29999);
    expect(deep.depth.get(30000)).toBe(29999);
  });
});

describe("the seed shaped tree", () => {
  const items = seedShaped();
  const model = foldModel(items);

  it("is the shape the plan describes", () => {
    expect(model.total).toBe(370);
    expect(model.maxDepth).toBe(5);
    expect(model.roots).toHaveLength(1);
    expect(model.below.get(1)).toBe(369);
  });

  it("shows 1, 4, 16, 24, 141 and 370 rows at levels 1 to 6", () => {
    expect([1, 2, 3, 4, 5, 6].map((level) => rowsAtLevel(model, level))).toEqual([1, 4, 16, 24, 141, 370]);
  });

  it("leaves exactly rowsAtLevel rows on screen for foldedForLevel, and every row for an empty fold", () => {
    for (const level of [1, 2, 3, 4, 5]) expect(visibleCount(model, foldedForLevel(model, level))).toBe(rowsAtLevel(model, level));
    expect(visibleCount(model, new Set())).toBe(370);
  });

  it("defaults to level 4 (24 rows) for a model of more than 60 rows", () => {
    expect(sizeDefaultFold(model)).toEqual(foldedForLevel(model, 4));
    expect(visibleCount(model, sizeDefaultFold(model))).toBe(24);
  });

  it("gives level 2 for a fixed level of 2, and the deepest level for a level beyond it", () => {
    expect(fixedLevelFold(model, 2)).toEqual(foldedForLevel(model, 2));
    expect(visibleCount(model, fixedLevelFold(model, 2))).toBe(4);
    expect(fixedLevelFold(model, 99)).toEqual(foldedForLevel(model, 5));
  });
});

describe("foldedForLevel", () => {
  const model = foldModel(seedShaped());

  it("folds every foldable row at level 1 and nothing below depth L - 1 stays open", () => {
    expect(foldedForLevel(model, 1)).toEqual(new Set(model.foldable));
    const level3 = foldedForLevel(model, 3);
    for (const id of model.foldable) expect(level3.has(id)).toBe((model.depth.get(id) ?? 0) >= 2);
  });

  it("gives strictly nested sets: a deeper level folds fewer rows and each is inside the one before", () => {
    const sets = [1, 2, 3, 4, 5].map((level) => foldedForLevel(model, level));
    for (let i = 1; i < sets.length; i++) {
      expect(sets[i].size).toBeLessThan(sets[i - 1].size);
      for (const id of sets[i]) expect(sets[i - 1].has(id)).toBe(true);
    }
  });

  it("clamps: below 1 is level 1, above the deepest level folds nothing", () => {
    expect(foldedForLevel(model, 0)).toEqual(foldedForLevel(model, 1));
    expect(foldedForLevel(model, -4)).toEqual(foldedForLevel(model, 1));
    expect(foldedForLevel(model, 6).size).toBe(0);
    expect(foldedForLevel(model, 500).size).toBe(0);
  });

  it("folds nothing for a flat list or an empty list", () => {
    expect(foldedForLevel(foldModel([item(1, null), item(2, null)]), 1).size).toBe(0);
    expect(foldedForLevel(foldModel([]), 1).size).toBe(0);
  });
});

describe("rowsAtLevel", () => {
  it("counts rows with depth below the level, and every row for a flat list", () => {
    const flat = foldModel([item(1, null), item(2, null), item(3, null)]);
    expect(rowsAtLevel(flat, 1)).toBe(3);
    expect(rowsAtLevel(flat, 5)).toBe(3);
    expect(rowsAtLevel(foldModel([]), 1)).toBe(0);
  });

  it("treats a level below 1 as level 1", () => {
    const model = foldModel([item(1, null), item(2, 1)]);
    expect(rowsAtLevel(model, 0)).toBe(1);
    expect(rowsAtLevel(model, 1)).toBe(1);
    expect(rowsAtLevel(model, 2)).toBe(2);
  });
});

describe("levelOfFold", () => {
  const model = foldModel(seedShaped());

  it("names each level", () => {
    for (const level of [1, 2, 3, 4, 5]) expect(levelOfFold(model, foldedForLevel(model, level))).toBe(level);
  });

  it("is all for an empty fold", () => {
    expect(levelOfFold(model, new Set())).toBe("all");
  });

  it("is null for a custom fold", () => {
    expect(levelOfFold(model, new Set([2]))).toBeNull(); // Hall 1 alone
    const level3 = foldedForLevel(model, 3);
    const custom = new Set(level3);
    custom.delete([...level3][0]);
    expect(levelOfFold(model, custom)).toBeNull();
    const extra = new Set(foldedForLevel(model, 4));
    extra.add(1); // the site as well: not a level
    expect(levelOfFold(model, extra)).toBeNull();
  });

  it("ignores ids that are not in the model, and ids that cannot fold", () => {
    const level2 = new Set(foldedForLevel(model, 2));
    level2.add(99999);
    const leaf = items(model).find((id) => !model.foldable.includes(id))!;
    level2.add(leaf);
    expect(levelOfFold(model, level2)).toBe(2);
    expect(levelOfFold(model, new Set([99999, leaf]))).toBe("all");
  });

  it("is all for a flat list, whatever the set holds", () => {
    const flat = foldModel([item(1, null), item(2, null)]);
    expect(levelOfFold(flat, new Set())).toBe("all");
    expect(levelOfFold(flat, new Set([1, 2]))).toBe("all");
  });
});

function items(model: FoldModel): number[] {
  return [...model.depth.keys()];
}

describe("sizeDefaultFold", () => {
  const chainOf = (count: number): FoldItem[] => Array.from({ length: count }, (_, i) => item(i + 1, i === 0 ? null : 1)); // one root, the rest its children

  it("limits to 60 rows by default", () => {
    expect(FOLD_ROW_LIMIT).toBe(60);
  });

  it("leaves a model of 60 rows alone and folds one of 61", () => {
    expect(sizeDefaultFold(foldModel(chainOf(60))).size).toBe(0);
    const folded = sizeDefaultFold(foldModel(chainOf(61)));
    expect(folded).toEqual(new Set([1])); // level 1: only the root shows (the deepest level with at most 60 rows)
  });

  it("takes the deepest level that keeps at most the limit", () => {
    const model = foldModel(seedShaped());
    expect(sizeDefaultFold(model, 141)).toEqual(foldedForLevel(model, 5));
    expect(sizeDefaultFold(model, 140)).toEqual(foldedForLevel(model, 4));
    expect(sizeDefaultFold(model, 16)).toEqual(foldedForLevel(model, 3));
    expect(sizeDefaultFold(model, 24)).toEqual(foldedForLevel(model, 4));
    expect(sizeDefaultFold(model, 369)).toEqual(foldedForLevel(model, 5));
    expect(sizeDefaultFold(model, 370).size).toBe(0);
  });

  it("gives an empty set for a flat list of 100: there is nothing to fold", () => {
    const flat = foldModel(Array.from({ length: 100 }, (_, i) => item(i + 1, null)));
    expect(sizeDefaultFold(flat).size).toBe(0);
  });

  it("folds 100 roots with one child each (200 rows) to level 1, never less", () => {
    const rows: FoldItem[] = [];
    for (let i = 1; i <= 100; i++) rows.push(item(i, null), item(100 + i, i));
    const model = foldModel(rows);
    expect(model.total).toBe(200);
    expect(sizeDefaultFold(model)).toEqual(foldedForLevel(model, 1));
    expect(sizeDefaultFold(model).size).toBe(100);
  });
});

describe("fixedLevelFold", () => {
  it("leaves a model of at most the limit alone", () => {
    const small = foldModel([item(1, null), item(2, 1), item(3, 2)]);
    expect(fixedLevelFold(small, 1).size).toBe(0);
    expect(fixedLevelFold(small, 1, 3).size).toBe(0);
  });

  it("folds to the level for a larger model, and uses the limit it is given", () => {
    const small = foldModel([item(1, null), item(2, 1), item(3, 2)]);
    expect(fixedLevelFold(small, 1, 2)).toEqual(foldedForLevel(small, 1));
    expect(fixedLevelFold(small, 2, 2)).toEqual(foldedForLevel(small, 2));
    expect(fixedLevelFold(small, 9, 2)).toEqual(foldedForLevel(small, 2)); // capped at the deepest level
  });

  it("gives an empty set for a flat list", () => {
    const flat = foldModel(Array.from({ length: 100 }, (_, i) => item(i + 1, null)));
    expect(fixedLevelFold(flat, 2).size).toBe(0);
  });
});

describe("flattenTree", () => {
  const a = (id: number, parent_id: number | null, sort_order = id): Asset => ({ id, parent_id, name: `n${id}`, kind: "generic", sort_order });

  it("lists the nodes in the order the tree shows them (pre-order), each with its parent", () => {
    const tree = buildTree([a(1, null), a(2, 1), a(3, 2), a(4, 1), a(5, null)]);
    expect(flattenTree(tree)).toEqual([item(1, null), item(2, 1), item(3, 2), item(4, 1), item(5, null)]);
  });

  it("follows the tree's order, not the ids", () => {
    const tree = buildTree([a(1, null, 2), a(2, 1, 9), a(3, 1, 1), a(4, null, 1), a(5, 4, 1)]);
    expect(flattenTree(tree).map((x) => x.id)).toEqual([4, 5, 1, 3, 2]);
  });

  it("is empty for no nodes, and feeds foldModel", () => {
    expect(flattenTree([])).toEqual([]);
    const model = foldModel(flattenTree(buildTree([a(1, null), a(2, 1), a(3, 2)])));
    expect(model.maxDepth).toBe(2);
    expect(model.foldable).toEqual([1, 2]);
  });

  it("makes a node whose parent is missing from the list a root, as the tree does", () => {
    const tree = buildTree([a(2, 99), a(3, 2)]);
    expect(flattenTree(tree)).toEqual([item(2, null), item(3, 2)]);
  });
});
