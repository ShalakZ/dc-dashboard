import type { GraphModel } from "../api/types";
import { UNGROUPED, nodeId, type OpenState } from "./graph";
import { EXPAND_NODE_BUDGET, canCollapse, canExpand, collapseAll, expandAll, expandNote, graphSummary } from "./graphView";
import { model, point, source } from "../test/graphFixtures";

const none: OpenState = { sources: new Set(), clusters: new Set() };
const sorted = (set: ReadonlySet<string | number>) => [...set].sort();

/** A source whose groups hold `sizes[i]` points each (point ids are unique across the test). */
let nextPoint = 1000;
const withGroups = (id: number, sizes: number[]) => source(id, {
  clusters: sizes.map((n, i) => ({ key: `g${i}`, points: Array.from({ length: n }, () => point(nextPoint++, "p")) })),
});
const g = (sid: number, i: number) => nodeId.cluster(sid, `g${i}`);

describe("graphSummary", () => {
  it("the fixture graph: sources, points, mapped points", () => {
    expect(graphSummary(model())).toBe("2 sources, 9 points, 2 mapped");
  });

  it.each([
    ["no sources at all", model({ sources: [], unidentified: [] }), "0 sources, 0 points, 0 mapped"],
    ["a source without points (zero points is plural)", model({ sources: [source(1)] }), "1 source, 0 points, 0 mapped"],
    ["one source, one point", model({ sources: [source(1, { ungrouped: [point(1, "a")] })] }), "1 source, 1 point, 0 mapped"],
    ["one mapped point", model({ sources: [source(1, { ungrouped: [point(1, "a", { asset_id: 10 })] })] }), "1 source, 1 point, 1 mapped"],
    ["points in groups and in the Ungrouped bag count alike", model({ sources: [source(1, {
      clusters: [{ key: "A", points: [point(1, "a", { asset_id: 10 }), point(2, "b")] }], ungrouped: [point(3, "c", { asset_id: 11 })] })] }),
      "1 source, 3 points, 2 mapped"],
    ["the points the graph draws, not the source's point_count", model({ sources: [source(1, { point_count: 99, ungrouped: [point(1, "a")] })] }), "1 source, 1 point, 0 mapped"],
    ["unidentified services are not sources", model({ sources: [source(1)], unidentified: [{ host: "h", port: 1, scan_id: 1 }, { host: "h", port: 2, scan_id: 1 }] }), "1 source, 0 points, 0 mapped"],
  ])("%s", (_name, m, expected) => {
    expect(graphSummary(m as GraphModel)).toBe(expected);
  });

  it.each([
    [0, ""],
    [1, ", 1 needs credentials"],
    [2, ", 2 need credentials"],
    [5, ", 5 need credentials"],
  ])("%i source(s) needing credentials add %j, and only when above zero", (n, tail) => {
    const sources = Array.from({ length: 6 }, (_, i) => source(i + 1, { needs_credentials: i < n }));
    expect(graphSummary(model({ sources }))).toBe(`6 sources, 0 points, 0 mapped${tail}`);
  });

  it("the owner's example", () => {
    const sources = [
      source(1, { needs_credentials: true, clusters: [{ key: "A", points: Array.from({ length: 120 }, (_, i) => point(i + 1, "p", i < 6 ? { asset_id: 10 } : {})) }] }),
      source(2), source(3),
    ];
    expect(graphSummary(model({ sources }))).toBe("3 sources, 120 points, 6 mapped, 1 needs credentials");
  });
});

describe("collapseAll, canCollapse and canExpand", () => {
  const all: OpenState = {
    sources: new Set([1, 2]),
    clusters: new Set([nodeId.cluster(1, "LVP01"), nodeId.cluster(1, "LVP02"), nodeId.cluster(1, UNGROUPED), nodeId.cluster(2, "M")]),
  };

  it("collapseAll is a fresh, empty open state every time", () => {
    const a = collapseAll();
    expect(a.sources.size).toBe(0);
    expect(a.clusters.size).toBe(0);
    expect(collapseAll()).not.toBe(a);
    expect(collapseAll().sources).not.toBe(a.sources);
  });

  it.each([
    ["nothing open", none, false],
    ["a source open", { sources: new Set([1]), clusters: new Set<string>() }, true],
    ["a source that is not in the graph any more", { sources: new Set([99]), clusters: new Set<string>() }, false],
    ["a group marked open under a closed source (nothing is drawn)", { sources: new Set<number>(), clusters: new Set([nodeId.cluster(1, "LVP01")]) }, false],
    ["everything open", all, true],
  ])("canCollapse: %s -> %s", (_name, open, expected) => {
    expect(canCollapse(model(), open)).toBe(expected);
  });

  it.each([
    ["nothing open", none, true],
    ["everything open", all, false],
    ["one group closed", { sources: all.sources, clusters: new Set([...all.clusters].slice(1)) }, true],
    ["one source closed (its groups would open too)", { sources: new Set([1]), clusters: new Set([...all.clusters].slice(0, 3)) }, true],
    ["a source open with every group of it open, the other open and empty-handed", { sources: new Set([1, 2]), clusters: new Set([...all.clusters].slice(0, 3)) }, true],
  ])("canExpand: %s -> %s", (_name, open, expected) => {
    expect(canExpand(model(), open)).toBe(expected);
  });

  it("canExpand: a graph without sources has nothing to open; a source without groups opens once, then is done", () => {
    expect(canExpand(model({ sources: [] }), none)).toBe(false);
    const bare = model({ sources: [source(1)] });
    expect(canExpand(bare, none)).toBe(true);
    expect(canExpand(bare, { sources: new Set([1]), clusters: new Set() })).toBe(false);
  });

  it("canExpand ignores the node budget: a click that cannot open everything still answers, with the note", () => {
    const tooBig = model({ sources: [withGroups(1, [700])] });
    expect(expandAll(tooBig, { sources: new Set([1]), clusters: new Set() }).openedGroups).toBe(0);
    expect(canExpand(tooBig, { sources: new Set([1]), clusters: new Set() })).toBe(true);
  });
});

describe("expandAll", () => {
  it("the budget is 600 new nodes", () => {
    expect(EXPAND_NODE_BUDGET).toBe(600);
  });

  it("everything fits: every source and every group opens, nothing is left closed", () => {
    const r = expandAll(model(), none);
    expect(sorted(r.open.sources)).toEqual([1, 2]);
    expect(sorted(r.open.clusters)).toEqual(["cluster:1:LVP01", "cluster:1:LVP02", "cluster:1:__ungrouped__", "cluster:2:M"]);
    expect(r).toMatchObject({ openedSources: 2, openedGroups: 4, keptSources: 0, keptGroups: 0 });
  });

  it("the sources open in the model's order while their groups fit; whatever does not fit stays closed, and a later smaller one may still fit", () => {
    // budget 10: S1 (2 groups) 2, S2 (1 group) 3, S3 (12 groups) would make 15: closed, S4 (3 groups) 6.
    // then groups: S1 g0 has 5 points (6 + 5 > 10: closed), S1 g1 has 4 (10: fits), the rest no longer fit.
    const m = model({ sources: [withGroups(1, [5, 4]), withGroups(2, [30]), withGroups(3, Array(12).fill(1)), withGroups(4, [1, 1, 1])] });
    const r = expandAll(m, none, 10);
    expect(sorted(r.open.sources)).toEqual([1, 2, 4]);
    expect(sorted(r.open.clusters)).toEqual([g(1, 1)]);
    expect(r).toMatchObject({ openedSources: 3, openedGroups: 1, keptSources: 1, keptGroups: 5 });
  });

  it("with the real budget, 50 sources of 40 groups open 15 sources and no group (600 group nodes are all the budget there is)", () => {
    const m = model({ sources: Array.from({ length: 50 }, (_, i) => withGroups(i + 1, Array(40).fill(2))) });
    const r = expandAll(m, none);
    expect(r.open.sources.size).toBe(15);
    expect(sorted(r.open.sources)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1).sort());
    expect(r.open.clusters.size).toBe(0);
    expect(r).toMatchObject({ openedSources: 15, openedGroups: 0, keptSources: 35, keptGroups: 600 });
  });

  it("only the NEW nodes count: what is already open costs nothing, and it stays open", () => {
    const open = { sources: new Set([1]), clusters: new Set([nodeId.cluster(1, "LVP01")]) };
    // budget 3: S2 costs 1 (its group), then LVP02 (3 points) would make 4: closed; Ungrouped (1 point) fits (2); M (2 points) would make 4: closed.
    const r = expandAll(model(), open, 3);
    expect(sorted(r.open.sources)).toEqual([1, 2]);
    expect(sorted(r.open.clusters)).toEqual(["cluster:1:LVP01", "cluster:1:__ungrouped__"]);
    expect(r).toMatchObject({ openedSources: 1, openedGroups: 1, keptSources: 0, keptGroups: 2 });
  });

  it("a closed source whose group is already open costs its groups AND that group's points: it stays closed when they would not fit, and is counted in keptSources", () => {
    // S1 was closed with its big group left open (the page keeps open groups when a source closes). Opening S1 would draw the 700 points.
    const m = model({ sources: [withGroups(1, [700, 1]), withGroups(2, [2])] });
    const open = { sources: new Set<number>(), clusters: new Set([g(1, 0)]) };
    const r = expandAll(m, open);
    expect(sorted(r.open.sources)).toEqual([2]);
    expect(r.open.clusters.has(g(2, 0))).toBe(true);
    expect(r.open.clusters.has(g(1, 0))).toBe(true);
    expect(r).toMatchObject({ openedSources: 1, openedGroups: 1, keptSources: 1, keptGroups: 0 });
    expect(expandNote(r)).toContain("1 source stays closed");
  });

  it("a closed source with a small open group opens when both fit, and the open group's points are charged before the later groups", () => {
    // S1 costs 2 groups + 3 points of its open group = 5 of 6; S2 then costs 1 group = 6; S2's group (2 points) would make 8: closed.
    const m = model({ sources: [withGroups(1, [3, 1]), withGroups(2, [2])] });
    const open = { sources: new Set<number>(), clusters: new Set([g(1, 0)]) };
    const r = expandAll(m, open, 6);
    expect(sorted(r.open.sources)).toEqual([1, 2]);
    expect(r.open.clusters.has(g(2, 0))).toBe(false);
    expect(r).toMatchObject({ openedSources: 2, openedGroups: 0, keptSources: 0, keptGroups: 2 });
  });

  it("a source that is already open charges nothing for its open groups (they are on the canvas already)", () => {
    const m = model({ sources: [withGroups(1, [700, 1])] });
    const open = { sources: new Set([1]), clusters: new Set([g(1, 0)]) };
    const r = expandAll(m, open);
    expect(r).toMatchObject({ openedSources: 0, openedGroups: 1, keptSources: 0, keptGroups: 0 });
  });

  it("a source without groups opens at no cost, even with nothing left of the budget", () => {
    const r = expandAll(model({ sources: [source(1), withGroups(2, [3])] }), none, 0);
    expect(sorted(r.open.sources)).toEqual([1]);
    expect(r).toMatchObject({ openedSources: 1, keptSources: 1 });
  });

  it("groups of a source that stays closed are neither opened nor counted", () => {
    const r = expandAll(model({ sources: [withGroups(1, [1, 1, 1])] }), none, 2);
    expect(r.open.sources.size).toBe(0);
    expect(r.open.clusters.size).toBe(0);
    expect(r).toMatchObject({ openedSources: 0, openedGroups: 0, keptSources: 1, keptGroups: 0 });
  });

  it("what the person already opened is never closed, nor are open ids the model does not know any more", () => {
    const open = { sources: new Set([77]), clusters: new Set([nodeId.cluster(77, "x"), nodeId.cluster(2, "M")]) };
    const r = expandAll(model(), open, 0);
    expect(r.open.sources.has(77)).toBe(true);
    expect(r.open.clusters.has(nodeId.cluster(77, "x"))).toBe(true);
    expect(r.open.clusters.has(nodeId.cluster(2, "M"))).toBe(true);
  });

  it("does not touch the sets it is given", () => {
    const open = { sources: new Set([1]), clusters: new Set<string>() };
    const r = expandAll(model(), open);
    expect(open.sources.size).toBe(1);
    expect(open.clusters.size).toBe(0);
    expect(r.open.sources).not.toBe(open.sources);
  });

  it("nothing to open: the same open ids, nothing counted", () => {
    const r = expandAll(model({ sources: [] }), none);
    expect(r).toMatchObject({ openedSources: 0, openedGroups: 0, keptSources: 0, keptGroups: 0 });
    expect(expandNote(r)).toBeNull();
  });
});

describe("expandNote", () => {
  const result = (openedSources: number, openedGroups: number, keptSources: number, keptGroups: number) => ({
    open: { sources: new Set<number>(), clusters: new Set<string>() }, openedSources, openedGroups, keptSources, keptGroups,
  });

  it.each([
    [result(3, 12, 0, 4), "Opened 3 sources and 12 groups. 4 groups stay closed: opening them would draw more than 600 nodes."],
    [result(1, 1, 0, 1), "Opened 1 source and 1 group. 1 group stays closed: opening it would draw more than 600 nodes."],
    [result(2, 0, 1, 4), "Opened 2 sources. 1 source and 4 groups stay closed: opening them would draw more than 600 nodes."],
    [result(0, 3, 0, 2), "Opened 3 groups. 2 groups stay closed: opening them would draw more than 600 nodes."],
    [result(0, 0, 2, 0), "Opened nothing. 2 sources stay closed: opening them would draw more than 600 nodes."],
    [result(0, 0, 1, 0), "Opened nothing. 1 source stays closed: opening it would draw more than 600 nodes."],
    [result(4, 6, 0, 0), null],
    [result(0, 0, 0, 0), null],
  ])("the toast for %j", (r, text) => {
    expect(expandNote(r)).toBe(text);
  });

  it("names the budget it was given", () => {
    expect(expandNote(result(1, 0, 0, 1), 10)).toBe("Opened 1 source. 1 group stays closed: opening it would draw more than 10 nodes.");
  });
});
