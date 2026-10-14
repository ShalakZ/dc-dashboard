import type { Asset } from "../api/types";
import { buildTree } from "./tree";
import { EMPTY_PICK, clear, createPickStore, pick, pickRange, prune, toggle, unpick, visibleOrder, type PickState } from "./treeSelect";

const state = (ids: number[], anchor: number | null): PickState => ({ ids: new Set(ids), anchor });
/** The contents of a state, to prove an input was not changed. */
const snap = (s: PickState) => ({ ids: [...s.ids], anchor: s.anchor });

describe("pick", () => {
  it("picks only that row and makes it the anchor", () => {
    const next = pick(state([1, 2], 2), 5);
    expect([...next.ids]).toEqual([5]);
    expect(next.anchor).toBe(5);
  });

  it("starts from nothing", () => {
    expect(snap(pick(EMPTY_PICK, 3))).toEqual({ ids: [3], anchor: 3 });
  });

  it("returns the same state when the row is already the only pick and the anchor", () => {
    const before = state([4], 4);
    expect(pick(before, 4)).toBe(before);
  });

  it("is a new state when the row is the only pick but the anchor is elsewhere", () => {
    const before = state([4], 9);
    const next = pick(before, 4);
    expect(next).not.toBe(before);
    expect(next.anchor).toBe(4);
  });

  it("does not change its input", () => {
    const before = state([1, 2], 2);
    const copy = snap(before);
    pick(before, 7);
    expect(snap(before)).toEqual(copy);
  });
});

describe("toggle", () => {
  it("adds a row that is not picked, and anchors it", () => {
    expect(snap(toggle(state([1], 1), 2))).toEqual({ ids: [1, 2], anchor: 2 });
  });

  it("removes a row that is picked", () => {
    expect(snap(toggle(state([1, 2, 3], 3), 2)).ids).toEqual([1, 3]);
  });

  // Ruling: the last Ctrl-clicked row is the anchor, also when that click un-picked it (a file manager does the same).
  it("moves the anchor to the toggled row also when it takes that row off", () => {
    expect(toggle(state([1, 2], 1), 1).anchor).toBe(1);
    expect(snap(toggle(state([1, 2], 2), 1))).toEqual({ ids: [2], anchor: 1 });
  });

  it("can take the last pick off, leaving the anchor where the click was", () => {
    expect(snap(toggle(state([6], 6), 6))).toEqual({ ids: [], anchor: 6 });
  });

  it("does not change its input", () => {
    const before = state([1, 2], 2);
    const copy = snap(before);
    toggle(before, 1);
    toggle(before, 8);
    expect(snap(before)).toEqual(copy);
  });
});

describe("pickRange", () => {
  const order = [10, 11, 12, 13, 14, 15];

  it("picks the rows from the anchor to the clicked row, both included", () => {
    expect(snap(pickRange(state([11], 11), order, 14))).toEqual({ ids: [11, 12, 13, 14], anchor: 11 });
  });

  it("works upward too, and lists the rows in tree order", () => {
    const next = pickRange(state([14], 14), order, 11);
    expect([...next.ids]).toEqual([11, 12, 13, 14]);
    expect(next.anchor).toBe(14);
  });

  it("replaces what was picked before, also rows outside the range", () => {
    const next = pickRange(state([10, 11, 15], 11), order, 13);
    expect([...next.ids]).toEqual([11, 12, 13]);
  });

  it("keeps the anchor, so the next Shift-click ranges from the same row", () => {
    const first = pickRange(state([11], 11), order, 14);
    const second = pickRange(first, order, 12);
    expect([...second.ids]).toEqual([11, 12]);
    expect(second.anchor).toBe(11);
  });

  it("is the anchor alone when the clicked row is the anchor", () => {
    expect(snap(pickRange(state([10, 12, 13], 12), order, 12))).toEqual({ ids: [12], anchor: 12 });
  });

  it("acts like toggle when there is no anchor", () => {
    expect(snap(pickRange(EMPTY_PICK, order, 13))).toEqual({ ids: [13], anchor: 13 });
    expect(snap(pickRange(state([10], null), order, 13))).toEqual({ ids: [10, 13], anchor: 13 });
  });

  it("acts like toggle when the anchor is not in the order (folded away or filtered out)", () => {
    expect(snap(pickRange(state([99], 99), order, 13))).toEqual({ ids: [99, 13], anchor: 13 });
    expect(snap(pickRange(state([99, 13], 99), order, 13))).toEqual({ ids: [99], anchor: 13 });
  });

  // Ruling: a clicked row is always a shown row, so an id that is not in the order is a stale event: nothing changes.
  it("changes nothing for a row that is not in the order", () => {
    const before = state([11], 11);
    expect(pickRange(before, order, 99)).toBe(before);
  });

  it("returns the same state when the range is what is already picked", () => {
    const before = state([12, 11, 13], 11);
    expect(pickRange(before, order, 13)).toBe(before);
  });

  it("does not change its input or the order it is given", () => {
    const before = state([11, 15], 11);
    const copy = snap(before);
    const orderCopy = [...order];
    pickRange(before, order, 13);
    expect(snap(before)).toEqual(copy);
    expect(order).toEqual(orderCopy);
  });

  // The order comes from visibleOrder, so a branch folded away is not part of the range.
  it("skips the children of a folded branch", () => {
    const assets: Asset[] = [
      { id: 1, parent_id: null, name: "A", kind: "k", sort_order: 0 },
      { id: 2, parent_id: 1, name: "A1", kind: "k", sort_order: 0 },
      { id: 3, parent_id: null, name: "B", kind: "k", sort_order: 1 },
      { id: 4, parent_id: null, name: "C", kind: "k", sort_order: 2 },
    ];
    const nodes = buildTree(assets);
    const folded = visibleOrder(nodes, new Set([1]), null);
    expect([...pickRange(state([1], 1), folded, 4).ids]).toEqual([1, 3, 4]);
    const open = visibleOrder(nodes, new Set(), null);
    expect([...pickRange(state([1], 1), open, 4).ids]).toEqual([1, 2, 3, 4]);
  });
});

describe("clear", () => {
  it("is nothing picked and no anchor", () => {
    expect(snap(clear(state([1, 2], 2)))).toEqual({ ids: [], anchor: null });
  });

  it("returns the same state when there is nothing to clear", () => {
    expect(clear(EMPTY_PICK)).toBe(EMPTY_PICK);
    const none = state([], null);
    expect(clear(none)).toBe(none);
  });

  it("can keep an anchor for the next Shift-click (a plain click opens a row and anchors it)", () => {
    const next = clear(state([1, 2], 2), 7);
    expect(snap(next)).toEqual({ ids: [], anchor: 7 });
    expect(clear(next, 7)).toBe(next);
  });

  it("drops an anchor that is no longer wanted even if nothing is picked", () => {
    expect(snap(clear(state([], 4)))).toEqual({ ids: [], anchor: null });
  });

  it("does not change its input", () => {
    const before = state([1, 2], 2);
    const copy = snap(before);
    clear(before);
    expect(snap(before)).toEqual(copy);
  });
});

describe("prune", () => {
  it("drops the picks that are no longer assets", () => {
    expect(snap(prune(state([1, 2, 3], 1), new Set([1, 3])))).toEqual({ ids: [1, 3], anchor: 1 });
  });

  it("returns the same state when nothing goes", () => {
    const before = state([1, 2], 2);
    expect(prune(before, new Set([1, 2, 3]))).toBe(before);
    expect(prune(EMPTY_PICK, new Set())).toBe(EMPTY_PICK);
  });

  it("forgets an anchor that is gone, even when every pick is still there", () => {
    const next = prune(state([1, 2], 9), new Set([1, 2]));
    expect(snap(next)).toEqual({ ids: [1, 2], anchor: null });
  });

  it("keeps an anchor that still exists although it is not picked", () => {
    expect(prune(state([1], 5), new Set([1, 5])).anchor).toBe(5);
  });

  it("can drop everything", () => {
    expect(snap(prune(state([1, 2], 2), new Set()))).toEqual({ ids: [], anchor: null });
  });

  it("does not change its input", () => {
    const before = state([1, 2, 3], 3);
    const copy = snap(before);
    prune(before, new Set([1]));
    expect(snap(before)).toEqual(copy);
  });
});

describe("unpick", () => {
  it("takes those ids off the picks and leaves the others (a move of some rows must not end the picking of the rest)", () => {
    expect(snap(unpick(state([1, 2, 3], 3), [1, 3]))).toEqual({ ids: [2], anchor: null }); // the anchor went with its row
    expect(snap(unpick(state([1, 2, 3], 2), [1]))).toEqual({ ids: [2, 3], anchor: 2 });
  });

  it("ignores ids that are not picked, and returns the SAME state when nothing changes", () => {
    const before = state([1, 2], 2);
    expect(unpick(before, [7, 8])).toBe(before);
    expect(unpick(before, [])).toBe(before);
    expect(unpick(EMPTY_PICK, [1])).toBe(EMPTY_PICK);
  });

  it("forgets an anchor that is one of the ids even when it was not picked (the row it pointed to has moved)", () => {
    expect(snap(unpick(state([1, 2], 9), [9]))).toEqual({ ids: [1, 2], anchor: null });
  });

  it("can take everything", () => {
    expect(snap(unpick(state([1, 2], 2), [1, 2]))).toEqual({ ids: [], anchor: null });
  });

  it("does not change its input", () => {
    const before = state([1, 2, 3], 3);
    const copy = snap(before);
    unpick(before, [1, 3]);
    expect(snap(before)).toEqual(copy);
  });
});

describe("visibleOrder", () => {
  const a = (id: number, parent_id: number | null, name: string, kind = "generic"): Asset => ({ id, parent_id, name, kind, sort_order: 0 });
  // Room > (Rack 1 > (Pump, Fan), Rack 2), Yard > Tank
  const assets = [a(1, null, "Room"), a(2, 1, "Rack 1"), a(3, 2, "Pump"), a(4, 2, "Fan"), a(5, 1, "Rack 2"), a(6, null, "Yard"), a(7, 6, "Tank")];
  const nodes = buildTree(assets);

  it("lists every row parent first, then its children, in tree order", () => {
    expect(visibleOrder(nodes, new Set(), null)).toEqual([1, 2, 4, 3, 5, 6, 7]);
  });

  it("leaves out the children of a folded branch but keeps the branch", () => {
    expect(visibleOrder(nodes, new Set([2]), null)).toEqual([1, 2, 5, 6, 7]);
    expect(visibleOrder(nodes, new Set([1]), null)).toEqual([1, 6, 7]);
  });

  it("leaves out everything under a folded branch even when a deeper branch is folded too", () => {
    expect(visibleOrder(nodes, new Set([1, 2]), null)).toEqual([1, 6, 7]);
  });

  it("is empty for an empty tree", () => {
    expect(visibleOrder([], new Set(), null)).toEqual([]);
  });

  // The tree's own rule: a filter shows its matches even under a branch the person folded.
  it("lists the rows the filter shows, and ignores folds while a filter is active", () => {
    const visible = new Set([1, 2, 3]); // what matchingIds gives for "pump": the match and its ancestors
    expect(visibleOrder(nodes, new Set(), visible)).toEqual([1, 2, 3]);
    expect(visibleOrder(nodes, new Set([1, 2]), visible)).toEqual([1, 2, 3]);
  });

  it("lists nothing for a filter nothing matches", () => {
    expect(visibleOrder(nodes, new Set(), new Set())).toEqual([]);
  });

  it("does not go below a row the filter hides", () => {
    expect(visibleOrder(nodes, new Set(), new Set([3]))).toEqual([]);
  });

  it("gives the same range with a filter as the rows on screen, for the Shift-click", () => {
    const visible = new Set([1, 2, 3, 4, 5]);
    const order = visibleOrder(nodes, new Set([1]), visible);
    expect(order).toEqual([1, 2, 4, 3, 5]);
    expect([...pickRange(state([3], 3), order, 5).ids]).toEqual([3, 5]);
  });

  it("does not change what it is given", () => {
    const collapsed = new Set([2]);
    const visible = new Set([1, 2]);
    visibleOrder(nodes, collapsed, visible);
    expect([...collapsed]).toEqual([2]);
    expect([...visible]).toEqual([1, 2]);
  });
});

describe("createPickStore", () => {
  it("starts with nothing picked", () => {
    const store = createPickStore();
    expect(store.getSnapshot()).toBe(EMPTY_PICK);
    expect(store.has(1)).toBe(false);
  });

  it("answers has() from the current picks", () => {
    const store = createPickStore();
    store.pick(4);
    expect(store.has(4)).toBe(true);
    expect(store.has(5)).toBe(false);
    store.toggle(5);
    expect(store.has(5)).toBe(true);
    store.toggle(4);
    expect(store.has(4)).toBe(false);
  });

  it("tells its subscribers once per transition", () => {
    const store = createPickStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.pick(1);
    expect(listener).toHaveBeenCalledTimes(1);
    store.toggle(2);
    expect(listener).toHaveBeenCalledTimes(2);
    store.pickRange([1, 2, 3, 4], 4);
    expect(listener).toHaveBeenCalledTimes(3);
    store.prune(new Set([1, 2]));
    expect(listener).toHaveBeenCalledTimes(4);
    store.unpick([2]);
    expect(listener).toHaveBeenCalledTimes(5);
    store.unpick([2]); // nothing left to take: no news
    expect(listener).toHaveBeenCalledTimes(5);
    store.pick(3);
    expect(listener).toHaveBeenCalledTimes(6);
    store.clear();
    expect(listener).toHaveBeenCalledTimes(7);
  });

  it("replaces the set once for a range, and tells once", () => {
    const store = createPickStore();
    store.pick(1);
    const listener = vi.fn();
    store.subscribe(listener);
    const seen: number[][] = [];
    store.subscribe(() => seen.push([...store.getSnapshot().ids]));
    store.pickRange([1, 2, 3, 4, 5], 5);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([[1, 2, 3, 4, 5]]);
  });

  it("tells nobody when a transition changes nothing", () => {
    const store = createPickStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.clear(); // nothing to clear
    store.prune(new Set([1, 2])); // nothing to drop
    store.pickRange([1, 2], 99); // a row that is not shown
    expect(listener).not.toHaveBeenCalled();
    store.pick(1);
    listener.mockClear();
    store.pick(1); // already the only pick and the anchor
    store.pickRange([1, 2, 3], 1); // the range is the anchor alone: what is picked already
    store.prune(new Set([1, 2]));
    expect(listener).not.toHaveBeenCalled();
  });

  // useSyncExternalStore reads the snapshot on every render and loops forever if two reads differ.
  it("gives the same snapshot object until a transition changes something", () => {
    const store = createPickStore();
    store.pick(1);
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.pick(1);
    expect(store.getSnapshot()).toBe(first);
    store.toggle(2);
    const second = store.getSnapshot();
    expect(second).not.toBe(first);
    expect(store.getSnapshot()).toBe(second);
    expect([...first.ids]).toEqual([1]); // the old snapshot is untouched
  });

  it("stops telling a subscriber that unsubscribed", () => {
    const store = createPickStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.pick(1);
    unsubscribe();
    store.pick(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("copes with a subscriber that unsubscribes another while being told", () => {
    const store = createPickStore();
    const second = vi.fn();
    let unsubscribeSecond = () => {};
    store.subscribe(() => unsubscribeSecond());
    unsubscribeSecond = store.subscribe(second);
    store.pick(1);
    expect(second).not.toHaveBeenCalled(); // removed by the first listener before its turn in the same round
    store.pick(2);
    expect(second).not.toHaveBeenCalled();
  });

  it("can start from a given state", () => {
    const store = createPickStore(state([3, 4], 3));
    expect(store.has(4)).toBe(true);
    expect(store.getSnapshot().anchor).toBe(3);
  });

  it("clear keeps an anchor when asked to", () => {
    const store = createPickStore();
    store.pick(1);
    store.clear(8);
    expect(snap(store.getSnapshot())).toEqual({ ids: [], anchor: 8 });
  });
});
