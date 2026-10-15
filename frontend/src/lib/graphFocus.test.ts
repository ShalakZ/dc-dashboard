import { edgeIndex, focusIds, focusSet, pathEdgeIds, pathOf } from "./graphFocus";

const e = (source: string, target: string, id = `${source}>${target}`) => ({ id, source, target });
const sorted = (s: ReadonlySet<string> | null) => (s ? [...s].sort() : null);

// The shape the Discovery graph has: source -> group -> points, points -> assets (mapped), asset -> sub-asset.
const chain = [e("s", "g"), e("g", "p1"), e("g", "p2"), e("p1", "a"), e("a", "sub")];

describe("pathOf", () => {
  it.each([
    ["a point: up to its group and source, down to its asset and sub-asset", "p1", ["a", "g", "p1", "s", "sub"]],
    ["a sibling point: its own way up, nothing of p1's asset", "p2", ["g", "p2", "s"]],
    ["the source: everything below it", "s", ["a", "g", "p1", "p2", "s", "sub"]],
    ["an asset: up through its mapped point, down to its sub-asset", "a", ["a", "g", "p1", "s", "sub"]],
    ["the last node: only the way up", "sub", ["a", "g", "p1", "s", "sub"]],
  ])("%s", (_name, id, want) => {
    expect(sorted(pathOf(edgeIndex(chain), id))).toEqual(want);
  });

  it("follows a diamond up from both points but never across to the sibling", () => {
    // two points mapped to one asset
    const diamond = [e("s", "g"), e("g", "p1"), e("g", "p2"), e("p1", "a"), e("p2", "a")];
    const index = edgeIndex(diamond);
    expect(sorted(pathOf(index, "a"))).toEqual(["a", "g", "p1", "p2", "s"]);
    expect(sorted(pathOf(index, "p1"))).toEqual(["a", "g", "p1", "s"]);
  });

  it("ends on a cycle instead of looping", () => {
    const loop = [e("a", "b"), e("b", "c"), e("c", "a")];
    expect(sorted(pathOf(edgeIndex(loop), "a"))).toEqual(["a", "b", "c"]);
  });

  it("is just the node for an isolated one and for an id the graph does not have", () => {
    const index = edgeIndex(chain);
    expect(sorted(pathOf(index, "nope"))).toEqual(["nope"]);
    expect(sorted(pathOf(edgeIndex([]), "x"))).toEqual(["x"]);
  });

  it("copes with a self edge", () => {
    expect(sorted(pathOf(edgeIndex([e("a", "a")]), "a"))).toEqual(["a"]);
  });
});

describe("focusSet", () => {
  const index = edgeIndex(chain);

  it("is null for no ids", () => {
    expect(focusSet(index, [])).toBeNull();
  });

  it("is null for a lone node with no edge: nothing to dim", () => {
    expect(focusSet(edgeIndex([e("x", "y")]), ["z"])).toBeNull();
    expect(focusSet(index, ["nope"])).toBeNull();
  });

  it("is the union of the paths", () => {
    expect(sorted(focusSet(index, ["p2"]))).toEqual(["g", "p2", "s"]);
    expect(sorted(focusSet(index, ["p1", "p2"]))).toEqual(["a", "g", "p1", "p2", "s", "sub"]);
  });

  it("counts a repeated id once", () => {
    expect(sorted(focusSet(index, ["p2", "p2"]))).toEqual(["g", "p2", "s"]);
    expect(focusSet(edgeIndex([]), ["z", "z"])).toBeNull();
  });

  it("is null for more ids than the cap (20 by default)", () => {
    const many = Array.from({ length: 21 }, (_v, i) => e("s", `n${i}`));
    const idx = edgeIndex(many);
    const ids = Array.from({ length: 21 }, (_v, i) => `n${i}`);
    expect(focusSet(idx, ids.slice(0, 20))).not.toBeNull();
    expect(focusSet(idx, ids)).toBeNull();
    expect(focusSet(idx, ids, { cap: 30 })).not.toBeNull();
  });

  it("is null for a union over maxNodes (400 by default): hovering a huge source lights nothing", () => {
    const big = Array.from({ length: 450 }, (_v, i) => e("s", `n${i}`));
    const idx = edgeIndex(big);
    expect(focusSet(idx, ["s"])).toBeNull(); // 451 nodes
    expect(focusSet(idx, ["n7"])?.size).toBe(2);
    expect(focusSet(idx, ["s"], { maxNodes: 500 })?.size).toBe(451);
    expect(focusSet(edgeIndex(big.slice(0, 399)), ["s"])?.size).toBe(400); // exactly maxNodes still counts
  });

  it("is null when the union is no bigger than the ids", () => {
    // two ids that only reach each other: nothing outside them would be dimmed
    expect(focusSet(edgeIndex([e("a", "b")]), ["a", "b"])).toBeNull();
  });
});

describe("pathEdgeIds", () => {
  it("keeps the edges with both ends in the set", () => {
    const edges = [e("s", "g", "e1"), e("g", "p1", "e2"), e("g", "p2", "e3"), e("p1", "a", "e4")];
    expect(sorted(pathEdgeIds(edges, new Set(["s", "g", "p1"])))).toEqual(["e1", "e2"]);
    expect(sorted(pathEdgeIds(edges, new Set(["s", "g", "p1", "a"])))).toEqual(["e1", "e2", "e4"]);
    expect(pathEdgeIds(edges, new Set()).size).toBe(0);
  });
});

describe("focusIds", () => {
  it.each([
    ["hover wins over keyboard focus and selection", { hover: "h", focused: "f", selected: ["a", "b"] }, ["h"]],
    ["keyboard focus wins over the selection", { hover: null, focused: "f", selected: ["a", "b"] }, ["f"]],
    ["a selection of two or more is used when nothing else is (a box or Ctrl selection is a deliberate show-me-these)", { hover: null, focused: null, selected: ["a", "b"] }, ["a", "b"]],
    ["a click selection (one node) lights nothing: the rest of the canvas would read as disabled", { hover: null, focused: null, selected: ["a"] }, []],
    ["a hover still wins over a one-node selection", { hover: "h", focused: null, selected: ["a"] }, ["h"]],
    ["keyboard focus still wins over a one-node selection", { hover: null, focused: "f", selected: ["a"] }, ["f"]],
    ["nothing at all", { hover: null, focused: null, selected: [] }, []],
  ])("%s", (_name, state, want) => {
    expect(focusIds(state)).toEqual(want);
  });

  it("hands back a copy of the selection", () => {
    const selected = ["a", "b"];
    const out = focusIds({ hover: null, focused: null, selected });
    expect(out).toEqual(["a", "b"]);
    expect(out).not.toBe(selected);
  });
});
