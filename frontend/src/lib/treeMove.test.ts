import type { Asset } from "../api/types";
import { buildTree } from "./tree";
import { ROOT_DROP, dropVerdict, dropZone, indexTree, moveGroup, resolveDrop, toRoots, type DropTarget } from "./treeMove";

const asset = (id: number, parent_id: number | null, name: string, sort_order = 0): Asset => ({ id, parent_id, name, kind: "generic", sort_order });
const indexOf = (assets: Asset[]) => indexTree(buildTree(assets));

// P > A B C D (sort order 0..3), Z > Z1
const SIBLINGS = indexOf([
  asset(1, null, "P"), asset(2, 1, "A", 0), asset(3, 1, "B", 1), asset(4, 1, "C", 2), asset(5, 1, "D", 3),
  asset(6, null, "Z", 1), asset(7, 6, "Z1"),
]);

// Room > (Rack 1 > (Fan, Pump), Rack 2 > PUMP), Yard > (Tank, Pump, pump), "rack  1"
const V = [
  asset(1, null, "Room", 0), asset(2, 1, "Rack 1", 0), asset(3, 2, "Pump", 1), asset(4, 2, "Fan", 0), asset(5, 1, "Rack 2", 1), asset(8, 5, "PUMP"),
  asset(6, null, "Yard", 1), asset(7, 6, "Tank", 0), asset(10, 6, "Pump", 1), asset(9, 6, "pump", 2), asset(11, null, "rack  1", 2),
];
const tree = indexOf(V);

describe("indexTree", () => {
  it("knows parents, children in tree order, names and a pre-order rank", () => {
    expect(tree.has(3)).toBe(true);
    expect(tree.has(99)).toBe(false);
    expect(tree.parentOf(3)).toBe(2);
    expect(tree.parentOf(1)).toBeNull();
    expect(tree.parentOf(99)).toBeUndefined();
    expect(tree.childrenOf(2)).toEqual([4, 3]);
    expect(tree.childrenOf(null)).toEqual([1, 6, 11]);
    expect(tree.childrenOf(8)).toEqual([]);
    expect(tree.childrenOf(99)).toEqual([]);
    expect(tree.nameOf(5)).toBe("Rack 2");
    expect(tree.nameOf(99)).toBeUndefined();
    expect(tree.rankOf(1)).toBeLessThan(tree.rankOf(2));
    expect(tree.rankOf(4)).toBeLessThan(tree.rankOf(3)); // Fan sorts before Pump
    expect(tree.rankOf(3)).toBeLessThan(tree.rankOf(5));
    expect(tree.rankOf(99)).toBe(-1);
  });
});

describe("dropZone", () => {
  // A row 32 px tall at y=100: the top 25% is 100..108, the middle 108..124, the bottom 124..132.
  it.each([
    [100, "before"], [101.5, "before"], [107.99, "before"],
    [108, "inside"], [116, "inside"], [123.99, "inside"],
    [124, "after"], [128, "after"], [132, "after"],
  ] as const)("a row without visible children at y=%s is %s", (y, zone) => {
    expect(dropZone(100, 32, y, false)).toBe(zone);
  });

  it("makes the bottom quarter of an expanded row with children the FIRST child slot", () => {
    expect(dropZone(100, 32, 107, true)).toBe("before");
    expect(dropZone(100, 32, 116, true)).toBe("inside");
    expect(dropZone(100, 32, 123.99, true)).toBe("inside");
    expect(dropZone(100, 32, 124, true)).toBe("first");
    expect(dropZone(100, 32, 132, true)).toBe("first");
  });

  // Ruling: a pointer beyond the row (a fast drag, a rounded rect) is read as the nearest edge, not as "inside".
  it("reads a pointer above the row as before and below it as after (or first)", () => {
    expect(dropZone(100, 32, 40, false)).toBe("before");
    expect(dropZone(100, 32, 500, false)).toBe("after");
    expect(dropZone(100, 32, 500, true)).toBe("first");
  });

  it("is inside for a row with no height or a pointer that is not a number", () => {
    expect(dropZone(100, 0, 100, false)).toBe("inside");
    expect(dropZone(100, -5, 100, true)).toBe("inside");
    expect(dropZone(100, 32, Number.NaN, false)).toBe("inside");
  });

  it("works with a fractional row height and an offset page", () => {
    expect(dropZone(1000.5, 31.5, 1000.5 + 31.5 * 0.2, false)).toBe("before");
    expect(dropZone(1000.5, 31.5, 1000.5 + 31.5 * 0.5, false)).toBe("inside");
    expect(dropZone(1000.5, 31.5, 1000.5 + 31.5 * 0.9, false)).toBe("after");
  });
});

describe("resolveDrop", () => {
  const none = new Set<number>();

  it("before a row: a sibling placed in front of it", () => {
    expect(resolveDrop("before", 3, new Set([7]), SIBLINGS)).toEqual({ parent_id: 1, before_id: 3 });
  });

  it("after a row: in front of its next sibling", () => {
    expect(resolveDrop("after", 3, new Set([7]), SIBLINGS)).toEqual({ parent_id: 1, before_id: 4 });
  });

  it("after the last sibling: last", () => {
    expect(resolveDrop("after", 5, new Set([7]), SIBLINGS)).toEqual({ parent_id: 1, before_id: null });
  });

  it("inside a row: its last child", () => {
    expect(resolveDrop("inside", 1, new Set([7]), SIBLINGS)).toEqual({ parent_id: 1, before_id: null });
    expect(resolveDrop("inside", 7, new Set([2]), SIBLINGS)).toEqual({ parent_id: 7, before_id: null });
  });

  it("first: the first child of an expanded row", () => {
    expect(resolveDrop("first", 1, new Set([7]), SIBLINGS)).toEqual({ parent_id: 1, before_id: 2 });
  });

  it("first on a row that has no children is just its only slot", () => {
    expect(resolveDrop("first", 7, new Set([2]), SIBLINGS)).toEqual({ parent_id: 7, before_id: null });
  });

  it("at the top level, before and after a root", () => {
    expect(resolveDrop("before", 1, new Set([7]), SIBLINGS)).toEqual({ parent_id: null, before_id: 1 });
    expect(resolveDrop("after", 1, new Set([7]), SIBLINGS)).toEqual({ parent_id: null, before_id: 6 });
    expect(resolveDrop("after", 6, new Set([7]), SIBLINGS)).toEqual({ parent_id: null, before_id: null });
  });

  // Review I4, case 1: siblings A B C D, A and C dragged and dropped after B. The next sibling after B is C, which moves too, so the
  // position is "in front of D" and the result reads B A C D. A before_id of C would name a moved row and be refused.
  it("skips forward past a moved sibling: A B C D with A and C dropped after B gives before_id D", () => {
    expect(resolveDrop("after", 3, new Set([2, 4]), SIBLINGS)).toEqual({ parent_id: 1, before_id: 5 });
  });

  // Review I4, case 2: the first child of an expanded row dragged onto that row's bottom edge ("first"): the first child is itself moving.
  it("skips forward when the first child of the expanded row is the one dragged to its bottom edge", () => {
    expect(resolveDrop("first", 1, new Set([2]), SIBLINGS)).toEqual({ parent_id: 1, before_id: 3 });
  });

  it("skips a run of moved siblings, and gives null when every later sibling moves", () => {
    expect(resolveDrop("after", 2, new Set([3, 4]), SIBLINGS)).toEqual({ parent_id: 1, before_id: 5 });
    expect(resolveDrop("after", 3, new Set([4, 5]), SIBLINGS)).toEqual({ parent_id: 1, before_id: null });
    expect(resolveDrop("first", 1, new Set([2, 3, 4, 5]), SIBLINGS)).toEqual({ parent_id: 1, before_id: null });
  });

  it("before a row that is itself moving: in front of the next sibling that is not", () => {
    expect(resolveDrop("before", 3, new Set([3]), SIBLINGS)).toEqual({ parent_id: 1, before_id: 4 });
    expect(resolveDrop("before", 5, new Set([5]), SIBLINGS)).toEqual({ parent_id: 1, before_id: null });
  });

  it("looks at ALL the siblings: a filter that hides C does not make D the next one", () => {
    // The index holds the whole tree. After B the next sibling is C, shown or not.
    expect(resolveDrop("after", 3, new Set([7]), SIBLINGS)).toEqual({ parent_id: 1, before_id: 4 });
  });

  it("is null for a row that is not in the tree", () => {
    expect(resolveDrop("before", 99, none, SIBLINGS)).toBeNull();
    expect(resolveDrop("inside", 99, none, SIBLINGS)).toBeNull();
  });

  it("has a constant for the area below the last row: the top level, last", () => {
    expect(ROOT_DROP).toEqual({ parent_id: null, before_id: null });
    expect(Object.isFrozen(ROOT_DROP)).toBe(true);
  });
});

describe("toRoots", () => {
  it("drops an id that has an ancestor in the set", () => {
    expect(toRoots([1, 2], tree)).toEqual([1]);
    expect(toRoots([2, 3, 1], tree)).toEqual([1]);
  });

  it("looks through the levels in between: a grandchild goes with its grandparent", () => {
    expect(toRoots([3, 1], tree)).toEqual([1]);
  });

  it("keeps a child whose parent is not in the set", () => {
    expect(toRoots([3, 4], tree)).toEqual([4, 3]);
  });

  it("keeps two branches that are not inside each other", () => {
    expect(toRoots([7, 5], tree)).toEqual([5, 7]);
  });

  it("returns the roots in tree order, not the order they were sent in", () => {
    expect(toRoots([7, 5, 3], tree)).toEqual([3, 5, 7]);
    expect(toRoots([3, 5, 7], tree)).toEqual([3, 5, 7]);
    expect(toRoots([9, 10, 7], tree)).toEqual([7, 10, 9]);
  });

  it("ignores ids that are not in the tree and counts a repeated id once", () => {
    expect(toRoots([99, 3, 3, 98], tree)).toEqual([3]);
    expect(toRoots([], tree)).toEqual([]);
    expect(toRoots([99], tree)).toEqual([]);
  });

  it("takes any iterable and does not change a set it is given", () => {
    const picked = new Set([2, 3]);
    expect(toRoots(picked, tree)).toEqual([2]);
    expect([...picked]).toEqual([2, 3]);
  });
});

describe("dropVerdict", () => {
  const ok = { ok: true };
  const target = (parent_id: number | null, before_id: number | null = null): DropTarget => ({ parent_id, before_id });
  const reasonOf = (verdict: ReturnType<typeof dropVerdict>) => (verdict.ok ? null : verdict.reason);

  it("accepts a move into another place", () => {
    expect(dropVerdict({ ids: [4], target: target(5), index: tree })).toEqual(ok);
    expect(dropVerdict({ ids: [7], target: target(1), index: tree })).toEqual(ok);
  });

  it("accepts a move to the top level", () => {
    expect(dropVerdict({ ids: [5], target: ROOT_DROP, index: tree })).toEqual(ok);
  });

  describe("an asset into itself or below itself", () => {
    it("refuses a drop inside itself", () => {
      expect(reasonOf(dropVerdict({ ids: [2], target: target(2), index: tree }))).toBe('"Rack 1" cannot be moved into itself.');
    });

    // The marker for "before my own child" resolves to parent = the moved asset itself: a cycle, not "ok".
    it("refuses a drop before its own child, which resolves to a place inside itself", () => {
      const resolved = resolveDrop("before", 3, new Set([2]), tree);
      expect(resolved).toEqual({ parent_id: 2, before_id: 3 });
      expect(reasonOf(dropVerdict({ ids: [2], target: resolved!, index: tree }))).toBe('"Rack 1" cannot be moved into itself.');
    });

    it("refuses a drop inside a descendant, also several levels down", () => {
      expect(reasonOf(dropVerdict({ ids: [2], target: target(3), index: tree }))).toBe('"Rack 1" cannot be moved into "Pump", which is inside it.');
      expect(reasonOf(dropVerdict({ ids: [1], target: target(3), index: tree }))).toBe('"Room" cannot be moved into "Pump", which is inside it.');
    });

    it("names the root of the pick that is the problem, not a child that travels inside it", () => {
      expect(reasonOf(dropVerdict({ ids: [3, 1], target: target(3), index: tree }))).toBe('"Room" cannot be moved into "Pump", which is inside it.');
    });

    it("refuses when only one of several picks is the problem", () => {
      const verdict = dropVerdict({ ids: [7, 2], target: target(3), index: tree });
      expect(reasonOf(verdict)).toBe('"Rack 1" cannot be moved into "Pump", which is inside it.');
    });
  });

  describe("already there", () => {
    // P > A B C D
    const same = (ids: number[], t: DropTarget) => dropVerdict({ ids, target: t, index: SIBLINGS });

    it("refuses 'after my previous sibling' and 'before my next sibling': nothing would change", () => {
      expect(reasonOf(same([3], target(1, 4)))).toBe('"B" is already there.');
      const before = resolveDrop("after", 2, new Set([3]), SIBLINGS)!;
      expect(reasonOf(same([3], before))).toBe('"B" is already there.');
      const next = resolveDrop("before", 4, new Set([3]), SIBLINGS)!;
      expect(reasonOf(same([3], next))).toBe('"B" is already there.');
    });

    it("refuses a drop on the row's own edges", () => {
      expect(reasonOf(same([3], resolveDrop("before", 3, new Set([3]), SIBLINGS)!))).toBe('"B" is already there.');
      expect(reasonOf(same([3], resolveDrop("after", 3, new Set([3]), SIBLINGS)!))).toBe('"B" is already there.');
    });

    it("refuses the last child dropped inside its own parent (last stays last)", () => {
      expect(reasonOf(same([5], target(1)))).toBe('"D" is already there.');
    });

    it("refuses several picks that stay as they are", () => {
      expect(reasonOf(same([4, 5], target(1)))).toBe("These assets are already there.");
    });

    it("accepts a real reorder in the same parent", () => {
      expect(same([4], target(1, 2))).toEqual(ok); // C in front of A
      expect(same([2], target(1))).toEqual(ok); // A to the end
      expect(same([2], target(1, 5))).toEqual(ok); // A in front of D: B C A D
    });

    it("accepts picks that are already in this parent when another pick comes from elsewhere", () => {
      expect(same([2, 7], target(1))).toEqual(ok);
    });

    it("accepts an asset that comes from another parent, whatever the position", () => {
      expect(same([7], target(1, 2))).toEqual(ok);
    });
  });

  describe("a name that is already taken (a hint: the server decides)", () => {
    it("refuses a name that matches a child of the target, ignoring case", () => {
      expect(reasonOf(dropVerdict({ ids: [3], target: target(5), index: tree }))).toBe('"Rack 2" would have two assets named "Pump".');
    });

    it("compares the way the server does: trimmed, runs of spaces collapsed, case ignored", () => {
      // "rack  1" (two spaces) is at the top level; Rack 1 would be a second "rack 1" there
      expect(reasonOf(dropVerdict({ ids: [2], target: ROOT_DROP, index: tree }))).toBe('The top level would have two assets named "Rack 1".');
    });

    it("refuses a clash with any of several children of the target", () => {
      expect(reasonOf(dropVerdict({ ids: [3], target: target(6), index: tree }))).toBe('"Yard" would have two assets named "Pump".');
    });

    it("refuses two picks with the same name going to one place", () => {
      expect(reasonOf(dropVerdict({ ids: [3, 8], target: target(1), index: tree }))).toBe('"Room" would have two assets named "Pump".');
    });

    it("counts a pick that is already in the target as one of its names", () => {
      // 9 ("pump") and 10 ("Pump") are in Yard and 9 is picked too; 3 is Rack 1's Pump and still clashes with 10 and 9.
      expect(reasonOf(dropVerdict({ ids: [3, 9], target: target(6), index: tree }))).toBe('"Yard" would have two assets named "Pump".');
    });

    it("accepts a name nobody in that place has", () => {
      expect(dropVerdict({ ids: [4], target: target(5), index: tree })).toEqual(ok);
    });

    // Ruling: a pure reorder inside the parent skips the clash check, as the server does, so old twins stay reorderable.
    it("lets assets that already share a name be reordered inside their parent", () => {
      expect(dropVerdict({ ids: [10], target: target(6, 7), index: tree })).toEqual(ok); // "Pump" in front of Tank, with "pump" next to it
      expect(dropVerdict({ ids: [9], target: target(6, 10), index: tree })).toEqual(ok);
    });

    it("still checks the picks that change parent when others only reorder", () => {
      // 10 stays in Yard (twin of 9), 3 comes in from Rack 1
      expect(reasonOf(dropVerdict({ ids: [10, 3], target: target(6, 7), index: tree }))).toBe('"Yard" would have two assets named "Pump".');
    });
  });

  describe("a target that is not there", () => {
    it("refuses nothing to move", () => {
      expect(reasonOf(dropVerdict({ ids: [], target: target(5), index: tree }))).toBe("Nothing to move.");
      expect(reasonOf(dropVerdict({ ids: [99], target: target(5), index: tree }))).toBe("Nothing to move.");
    });

    it("refuses a place that is no longer in the tree", () => {
      expect(reasonOf(dropVerdict({ ids: [3], target: target(99), index: tree }))).toBe("That place is no longer there.");
    });

    it("refuses a position next to an asset that is not in that place", () => {
      expect(reasonOf(dropVerdict({ ids: [3], target: target(5, 4), index: tree }))).toBe("That position is no longer there.");
    });
  });

  it("does not change what it is given", () => {
    const ids = [3, 1];
    dropVerdict({ ids, target: target(5), index: tree });
    expect(ids).toEqual([3, 1]);
  });
});

describe("moveGroup", () => {
  it("is the group the move API takes: the ids and where they go", () => {
    expect(moveGroup([4, 3], { parent_id: 5, before_id: 8 })).toEqual({ ids: [4, 3], parent_id: 5, before_id: 8 });
    expect(moveGroup([4], ROOT_DROP)).toEqual({ ids: [4], parent_id: null, before_id: null });
  });

  it("copies the ids, so a later change to the caller's array does not reach a request", () => {
    const ids = [1, 2];
    const group = moveGroup(ids, ROOT_DROP);
    ids.push(3);
    expect(group.ids).toEqual([1, 2]);
  });

  it("takes an iterable of ids", () => {
    expect(moveGroup(new Set([6, 7]), { parent_id: 1, before_id: null }).ids).toEqual([6, 7]);
  });
});
