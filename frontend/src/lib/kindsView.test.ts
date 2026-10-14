import type { AssetKind } from "../api/types";
import { addRange, filterCounts, filterKinds, neighbourId, pickAll, pickUnused, type KindFilter } from "./kindsView";
import { EMPTY_PICK, type PickState } from "./treeSelect";

const kind = (id: number, name: string, asset_count = 0, starter = false): AssetKind => ({ id, name, icon: "generic", asset_count, starter });

// Rack (starter, in use), Pump (yours, unused), Sensor (yours, in use), Room (starter, unused), Hall (yours, unused)
const KINDS = [kind(1, "Rack", 12, true), kind(2, "Pump"), kind(3, "Sensor", 1), kind(4, "Room", 0, true), kind(5, "Hall")];
const ids = (list: readonly AssetKind[]) => list.map((k) => k.id);
const picks = (list: number[], anchor: number | null = null): PickState => ({ ids: new Set(list), anchor });
const asArray = (state: PickState) => [...state.ids].sort((a, b) => a - b);

describe("filterKinds", () => {
  it.each<[KindFilter, number[]]>([
    ["all", [1, 2, 3, 4, 5]],
    ["starter", [1, 4]],
    ["yours", [2, 3, 5]],
    ["unused", [2, 4, 5]],
  ])("%s keeps %j, in the list's own order", (filter, expected) => {
    expect(ids(filterKinds(KINDS, filter))).toEqual(expected);
  });

  it("Yours and Starter split the list; a starter kind is Unused or not by its count alone", () => {
    expect(ids(filterKinds(KINDS, "starter")).concat(ids(filterKinds(KINDS, "yours"))).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(ids(filterKinds(KINDS, "unused"))).toContain(4); // Room is a starter kind and unused
  });

  it("an empty list stays empty under every filter", () => {
    for (const filter of ["all", "starter", "yours", "unused"] as const) expect(filterKinds([], filter)).toEqual([]);
  });
});

describe("filterCounts", () => {
  it("counts the whole list under each filter", () => {
    expect(filterCounts(KINDS)).toEqual({ all: 5, starter: 2, yours: 3, unused: 3 });
  });

  it("counts nothing for an empty list", () => {
    expect(filterCounts([])).toEqual({ all: 0, starter: 0, yours: 0, unused: 0 });
  });

  it("agrees with filterKinds for every filter", () => {
    const counts = filterCounts(KINDS);
    for (const filter of ["all", "starter", "yours", "unused"] as const) expect(counts[filter]).toBe(filterKinds(KINDS, filter).length);
  });
});

describe("pickAll", () => {
  it("picks every id of the order and has no anchor", () => {
    const state = pickAll([4, 2, 9]);
    expect(asArray(state)).toEqual([2, 4, 9]);
    expect(state.anchor).toBeNull();
  });

  it("picks nothing from an empty order, and that is the shared empty state", () => {
    expect(pickAll([])).toBe(EMPTY_PICK);
  });
});

describe("pickUnused", () => {
  it("ADDS the unused kinds of the list to what is picked already (a union, never a replacement)", () => {
    const next = pickUnused(picks([1], 1), KINDS);
    expect(asArray(next)).toEqual([1, 2, 4, 5]);
    expect(next.anchor).toBe(1); // the anchor stays
  });

  it("returns the same state when every unused kind is picked already, so a setState skips the render", () => {
    const state = picks([2, 4, 5, 1]);
    expect(pickUnused(state, KINDS)).toBe(state);
  });

  it("returns the same state when the list holds no unused kind", () => {
    const state = picks([1]);
    expect(pickUnused(state, [kind(1, "Rack", 3), kind(2, "Pump", 1)])).toBe(state);
  });

  it("looks only at the kinds it is given (the shown rows), not at the whole registry", () => {
    expect(asArray(pickUnused(EMPTY_PICK, filterKinds(KINDS, "starter")))).toEqual([4]);
  });

  it("does not change its input", () => {
    const state = picks([1], 1);
    pickUnused(state, KINDS);
    expect(asArray(state)).toEqual([1]);
  });
});

describe("addRange", () => {
  const order = [10, 20, 30, 40, 50];

  it.each<[string, PickState, number, number[]]>([
    ["downwards from the anchor", picks([20], 20), 40, [20, 30, 40]],
    ["upwards from the anchor", picks([40], 40), 20, [20, 30, 40]],
    ["one row (anchor and target are the same row)", picks([30], 30), 30, [30]],
  ])("%s", (_name, state, id, expected) => {
    expect(asArray(addRange(state, order, id))).toEqual(expected);
  });

  it("ADDS the range to the picks that are outside it (a checkbox column adds, it does not replace)", () => {
    const next = addRange(picks([10, 40], 40), order, 20);
    expect(asArray(next)).toEqual([10, 20, 30, 40]);
    expect(next.anchor).toBe(40); // the anchor stays, so the next Shift-click ranges from the same row
  });

  it("keeps the picks inside the range and does not un-pick anything", () => {
    expect(asArray(addRange(picks([20, 30], 20), order, 50))).toEqual([20, 30, 40, 50]);
  });

  it("returns the same state when the range adds nothing", () => {
    const state = picks([20, 30, 40], 20);
    expect(addRange(state, order, 40)).toBe(state);
  });

  it("ranges in the order it is given, not in id order (the shown order is the table's)", () => {
    const shown = [30, 10, 50, 20];
    expect(asArray(addRange(picks([30], 30), shown, 50))).toEqual([10, 30, 50]);
  });

  it("without an anchor in the order it toggles the row, and the row becomes the anchor", () => {
    const first = addRange(EMPTY_PICK, order, 30);
    expect(asArray(first)).toEqual([30]);
    expect(first.anchor).toBe(30);
    const off = addRange(picks([30], 99), order, 30); // the anchor is not on screen any more
    expect(asArray(off)).toEqual([]);
    expect(off.anchor).toBe(30);
  });

  it("changes nothing for an id that is not in the order (a stale event)", () => {
    const state = picks([20], 20);
    expect(addRange(state, order, 99)).toBe(state);
  });
});

describe("neighbourId", () => {
  const order = [3, 7, 9];

  it.each<[string, number, number | null]>([
    ["the next row", 3, 7],
    ["the next row of a middle one", 7, 9],
    ["the previous row when it is the last", 9, 7],
  ])("is %s", (_name, id, expected) => {
    expect(neighbourId(order, id)).toBe(expected);
  });

  it("is null for the only row", () => {
    expect(neighbourId([5], 5)).toBeNull();
  });

  it("is null for a row that is not shown, and for an empty list", () => {
    expect(neighbourId(order, 4)).toBeNull();
    expect(neighbourId([], 4)).toBeNull();
  });
});
