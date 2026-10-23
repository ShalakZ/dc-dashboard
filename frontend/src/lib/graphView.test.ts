import type { GraphModel } from "../api/types";
import { NO_VIEW, PAGE_SIZE, UNGROUPED, nodeId, type GraphView, type OpenState } from "./graph";
import {
  EXPAND_NODE_BUDGET, canCollapse, canExpand, changeNote, collapseAll, collapseTargets, expandAll, expandNote, expandTargets, graphCounts, graphSummary,
  selectionStates, targetsOf, type Change,
} from "./graphView";
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

describe("graphCounts (the figures behind the summary and the bar's chips)", () => {
  it("the fixture graph: sources, points, mapped, the ones the filter leaves and the sources needing credentials", () => {
    expect(graphCounts(model())).toEqual({ sources: 2, points: 9, mapped: 2, needing: 0, unmapped: 7 });
  });

  it("counts the points the graph draws in groups and in the Ungrouped bag alike, and the sources needing credentials", () => {
    const sources = [
      source(1, { needs_credentials: true, clusters: [{ key: "A", points: [point(1, "a", { asset_id: 10 }), point(2, "b")] }], ungrouped: [point(3, "c", { asset_id: 11 })] }),
      source(2, { needs_credentials: true, point_count: 99 }),
      source(3),
    ];
    expect(graphCounts(model({ sources }))).toEqual({ sources: 3, points: 3, mapped: 2, needing: 2, unmapped: 1 });
  });

  it("an empty graph is all zeros", () => {
    expect(graphCounts(model({ sources: [], unidentified: [] }))).toEqual({ sources: 0, points: 0, mapped: 0, needing: 0, unmapped: 0 });
  });

  it("the figures stay the whole graph's whatever the view: the filter changes the words of the summary, not the counts", () => {
    expect(graphCounts(model(), view({ unmappedOnly: true }))).toEqual(graphCounts(model()));
    expect(graphCounts(model(), NO_VIEW)).toEqual(graphCounts(model()));
  });

  it("graphSummary says the same words it always did, built from the same figures", () => {
    const counts = graphCounts(model());
    expect(graphSummary(model())).toBe(`${counts.sources} sources, ${counts.points} points, ${counts.mapped} mapped`);
    expect(graphSummary(model(), view({ unmappedOnly: true }))).toBe(`Showing ${counts.unmapped} of ${counts.points} points, ${counts.sources} sources, ${counts.mapped} mapped`);
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

/* ---------------------------------------------------------------------------------------------------------------------------- W12b: the view */

const view = (over: Partial<GraphView> = {}): GraphView => ({ ...NO_VIEW, ...over });
/** A view that pages at the real page size (the page passes this; `NO_VIEW` never pages). */
const paged = (over: Partial<GraphView> = {}): GraphView => view({ pageSize: PAGE_SIZE, ...over });
const asset = (id: number, parent: number | null = null) => ({ id, parent_id: parent, name: `A${id}`, kind: "generic" });
/** 10 -> 11, 12; 11 -> 13; 20 stands alone. */
const tree = () => [asset(10), asset(11, 10), asset(12, 10), asset(13, 11), asset(20)];
/** A source whose single group holds `n` points, `mapped` of them mapped. */
const withMapped = (id: number, n: number, mapped: number) => source(id, {
  clusters: [{ key: "g0", points: Array.from({ length: n }, (_, i) => point(nextPoint++, "p", i < mapped ? { asset_id: 10 } : {})) }],
});
const ids = (change: { open: OpenState }) => [[...change.open.sources].sort(), [...change.open.clusters].sort()];

describe("graphSummary with the Unmapped only filter", () => {
  it("leads with how many unmapped points are shown, then the same facts as ever", () => {
    expect(graphSummary(model(), view({ unmappedOnly: true }))).toBe("Showing 7 of 9 points, 2 sources, 2 mapped");
  });

  it("counts over every source, hidden or not, and keeps the credentials tail", () => {
    const m = model({ sources: [withMapped(1, 4, 4), withMapped(2, 5, 1), source(3, { needs_credentials: true })] });
    expect(graphSummary(m, view({ unmappedOnly: true }))).toBe("Showing 4 of 9 points, 3 sources, 5 mapped, 1 needs credentials");
  });

  it.each([
    ["one source, one unmapped point", model({ sources: [source(1, { ungrouped: [point(1, "a")] })] }), "Showing 1 of 1 point, 1 source, 0 mapped"],
    ["everything mapped", model({ sources: [withMapped(1, 2, 2)] }), "Showing 0 of 2 points, 1 source, 2 mapped"],
    ["no points at all", model({ sources: [source(1)] }), "Showing 0 of 0 points, 1 source, 0 mapped"],
    ["no sources", model({ sources: [] }), "Showing 0 of 0 points, 0 sources, 0 mapped"],
  ])("%s", (_name, m, expected) => {
    expect(graphSummary(m as GraphModel, view({ unmappedOnly: true }))).toBe(expected);
  });

  it("without the filter the line is the old one, whatever else the view holds", () => {
    expect(graphSummary(model(), NO_VIEW)).toBe(graphSummary(model()));
    expect(graphSummary(model(), paged({ assetsClosed: new Set([10]), shown: new Map([["cluster:1:LVP01", 100]]) }))).toBe("2 sources, 9 points, 2 mapped");
  });
});

describe("canCollapse and canExpand with a view", () => {
  const m = model({ sources: [withMapped(1, 3, 3), withGroups(2, [2, 2])] });
  const filtered = view({ unmappedOnly: true });

  it("a source the filter hides is not there to collapse", () => {
    expect(canCollapse(m, { sources: new Set([1]), clusters: new Set() })).toBe(true);
    expect(canCollapse(m, { sources: new Set([1]), clusters: new Set() }, filtered)).toBe(false);
    expect(canCollapse(m, { sources: new Set([1, 2]), clusters: new Set() }, filtered)).toBe(true);
  });

  it("a source or group the filter hides is not there to expand", () => {
    const open = { sources: new Set([2]), clusters: new Set([g(2, 0), g(2, 1)]) };
    expect(canExpand(m, open)).toBe(true); // source 1 is closed
    expect(canExpand(m, open, filtered)).toBe(false); // ... and hidden
    const withHiddenGroup = model({ sources: [source(1, { clusters: [
      { key: "done", points: [point(nextPoint++, "p", { asset_id: 10 })] }, { key: "todo", points: [point(nextPoint++, "p")] }] })] });
    const one = { sources: new Set([1]), clusters: new Set([nodeId.cluster(1, "todo")]) };
    expect(canExpand(withHiddenGroup, one)).toBe(true);
    expect(canExpand(withHiddenGroup, one, filtered)).toBe(false);
  });

  it("an old call and NO_VIEW agree", () => {
    for (const open of [none, { sources: new Set([1, 2]), clusters: new Set([g(2, 0)]) }]) {
      expect(canCollapse(m, open, NO_VIEW)).toBe(canCollapse(m, open));
      expect(canExpand(m, open, NO_VIEW)).toBe(canExpand(m, open));
    }
  });
});

describe("expandAll with a view", () => {
  it("an old call and NO_VIEW agree", () => {
    const m = model({ sources: [withGroups(1, [5, 4]), withGroups(2, [30]), withGroups(3, Array(12).fill(1))] });
    expect(expandAll(m, none, 10, NO_VIEW)).toEqual(expandAll(m, none, 10));
  });

  it("a group over a page costs the page plus the `more` node, so 11 of 12 big groups fit the real budget", () => {
    const m = model({ sources: [withGroups(1, Array(12).fill(700))] });
    // the source costs its 12 groups, then 51 each: 12 + 11 x 51 = 573; a 12th would make 624
    const r = expandAll(m, none, EXPAND_NODE_BUDGET, paged());
    expect(r).toMatchObject({ openedSources: 1, openedGroups: 11, keptSources: 0, keptGroups: 1 });
    expect(expandAll(m, none).openedGroups).toBe(0); // unpaged, a 700-point group never fits
  });

  it("the boundary: 50 points cost 50, 51 points cost 51 (50 and the `more` node)", () => {
    const fifty = model({ sources: [withGroups(1, [50])] });
    const fiftyOne = model({ sources: [withGroups(1, [51])] });
    expect(expandAll(fifty, none, 51, paged())).toMatchObject({ openedGroups: 1, keptGroups: 0 });
    expect(expandAll(fifty, none, 50, paged())).toMatchObject({ openedGroups: 0, keptGroups: 1 });
    expect(expandAll(fiftyOne, none, 52, paged())).toMatchObject({ openedGroups: 1, keptGroups: 0 });
    expect(expandAll(fiftyOne, none, 51, paged())).toMatchObject({ openedGroups: 0, keptGroups: 1 });
  });

  it("a group whose page was extended costs its extent plus one, and just its points when the page reaches the end", () => {
    const m = model({ sources: [withGroups(1, [700])] });
    const cid = g(1, 0);
    expect(expandAll(m, none, 152, paged({ shown: new Map([[cid, 150]]) })).openedGroups).toBe(1);
    expect(expandAll(m, none, 151, paged({ shown: new Map([[cid, 150]]) })).openedGroups).toBe(0);
    expect(expandAll(m, none, 701, paged({ shown: new Map([[cid, 700]]) })).openedGroups).toBe(1);
    expect(expandAll(m, none, 700, paged({ shown: new Map([[cid, 700]]) })).openedGroups).toBe(0);
  });

  it("a closed source charges its already-open groups at their paged cost too", () => {
    const m = model({ sources: [withGroups(1, [700])] });
    const open = { sources: new Set<number>(), clusters: new Set([g(1, 0)]) };
    expect(expandAll(m, open, 52, paged())).toMatchObject({ openedSources: 1, keptSources: 0 }); // 1 group + 51
    expect(expandAll(m, open, 51, paged())).toMatchObject({ openedSources: 0, keptSources: 1 });
    expect(expandAll(m, open, 51)).toMatchObject({ openedSources: 0, keptSources: 1 }); // unpaged: 1 + 700
  });

  it("under the filter only the unmapped points are charged", () => {
    const m = model({ sources: [withMapped(1, 100, 95)] });
    expect(expandAll(m, none, 6, view({ unmappedOnly: true })).openedGroups).toBe(1); // 1 group + 5 points
    expect(expandAll(m, none, 5, view({ unmappedOnly: true })).openedGroups).toBe(0);
    expect(expandAll(m, none, 6).openedGroups).toBe(0); // 1 + 100 without it
  });

  it("a source or group the filter hides is neither opened nor counted as kept", () => {
    const m = model({ sources: [withMapped(1, 3, 3), source(2, { clusters: [
      { key: "done", points: [point(nextPoint++, "p", { asset_id: 10 })] }, { key: "todo", points: [point(nextPoint++, "p")] }] })] });
    const r = expandAll(m, none, 0, view({ unmappedOnly: true }));
    expect(r).toMatchObject({ openedSources: 0, keptSources: 1, keptGroups: 0 }); // source 2 costs 1 > 0; source 1 is hidden
    const roomy = expandAll(m, none, 600, view({ unmappedOnly: true }));
    expect(ids(roomy)).toEqual([[2], [nodeId.cluster(2, "todo")]]);
    expect(roomy).toMatchObject({ openedSources: 1, openedGroups: 1, keptSources: 0, keptGroups: 0 });
  });
});

describe("targetsOf", () => {
  const m = model({ assets: tree() });

  it("keeps the ids that can open or close, once each, in model order", () => {
    const list = [nodeId.asset(10), "cluster:2:M", nodeId.source(2), nodeId.source(1), nodeId.source(1), "cluster:1:LVP02"];
    expect(targetsOf(m, list, false)).toEqual(["src:1", "cluster:1:LVP02", "src:2", "cluster:2:M", "asset:10"]);
  });

  it("ignores points, `more` nodes, unidentified services, leaf assets, unknown ids and junk", () => {
    const list = ["point:1", nodeId.more("cluster:1:LVP01"), "unid:10.0.0.9:8080", "src:99", "cluster:1:nope", "asset:99", "asset:12", "asset:20", "", "junk"];
    expect(targetsOf(m, list, false)).toEqual([]);
    expect(targetsOf(m, list, true)).toEqual([]);
    expect(targetsOf(m, [], true)).toEqual([]);
  });

  it("a group with no points still opens and closes", () => {
    const empty = model({ sources: [source(1, { clusters: [{ key: "E", points: [] }] })] });
    expect(targetsOf(empty, ["cluster:1:E"], false)).toEqual(["cluster:1:E"]);
  });

  it("a branch adds the groups of a source (the Ungrouped one too)", () => {
    expect(targetsOf(m, [nodeId.source(1)], true)).toEqual(["src:1", "cluster:1:LVP01", "cluster:1:LVP02", `cluster:1:${UNGROUPED}`]);
    expect(targetsOf(m, [nodeId.source(1)], false)).toEqual(["src:1"]);
  });

  it("a branch of a group is the group", () => {
    expect(targetsOf(m, ["cluster:2:M"], true)).toEqual(["cluster:2:M"]);
  });

  it("a branch adds the sub-assets that have sub-assets of their own, at every depth, and not the leaves", () => {
    expect(targetsOf(m, [nodeId.asset(10)], true)).toEqual(["asset:10", "asset:11"]);
    expect(targetsOf(m, [nodeId.asset(11)], true)).toEqual(["asset:11"]);
    expect(targetsOf(m, [nodeId.asset(12)], true)).toEqual([]);
    const deep = model({ assets: [asset(1), asset(2, 1), asset(3, 2), asset(4, 3), asset(5, 4)] });
    expect(targetsOf(deep, [nodeId.asset(1)], true)).toEqual(["asset:1", "asset:2", "asset:3", "asset:4"]);
  });

  it("is safe on a cycle, a self-parent and an orphan", () => {
    const cycle = model({ assets: [asset(10, 11), asset(11, 10)] });
    expect(targetsOf(cycle, [nodeId.asset(10)], true)).toEqual(["asset:10", "asset:11"]);
    expect(targetsOf(cycle, [nodeId.asset(10)], false)).toEqual(["asset:10"]);
    const odd = model({ assets: [asset(10, 10), asset(11, 99)] });
    expect(targetsOf(odd, [nodeId.asset(10), nodeId.asset(11)], true)).toEqual([]);
  });

  it("a branch over several ids lists each node once", () => {
    const list = [nodeId.source(1), "cluster:1:LVP01", nodeId.asset(10), nodeId.asset(11)];
    expect(targetsOf(m, list, true)).toEqual(["src:1", "cluster:1:LVP01", "cluster:1:LVP02", `cluster:1:${UNGROUPED}`, "asset:10", "asset:11"]);
  });
});

describe("expandTargets", () => {
  const m = model({ sources: [withGroups(1, [5, 4]), withGroups(2, [3])], assets: tree() });

  it("opens a closed source and leaves its groups alone; a branch opens them too", () => {
    const plain = expandTargets(m, none, NO_VIEW, [nodeId.source(1)], false);
    expect(ids(plain)).toEqual([[1], []]);
    expect(plain.opened).toEqual({ sources: 1, groups: 0, assets: 0 });
    const branch = expandTargets(m, none, NO_VIEW, [nodeId.source(1)], true);
    expect(ids(branch)).toEqual([[1], [g(1, 0), g(1, 1)]]);
    expect(branch.opened).toEqual({ sources: 1, groups: 2, assets: 0 });
    expect(branch.closed).toEqual({ sources: 0, groups: 0, assets: 0 });
    expect(branch.kept).toEqual({ sources: 0, groups: 0 });
  });

  it("opens one group of an open source", () => {
    const r = expandTargets(m, { sources: new Set([1]), clusters: new Set() }, NO_VIEW, [g(1, 1)], false);
    expect(ids(r)).toEqual([[1], [g(1, 1)]]);
    expect(r.opened).toEqual({ sources: 0, groups: 1, assets: 0 });
  });

  it("a group of a source that is closed (and not chosen) is left alone: nothing could draw it", () => {
    const r = expandTargets(m, none, NO_VIEW, [g(1, 0)], false);
    expect(r.open).toBe(none);
    expect(r.opened).toEqual({ sources: 0, groups: 0, assets: 0 });
  });

  it("works inside the budget like Expand all: sources first, then groups, what does not fit is kept", () => {
    // budget 10: the source costs its 2 groups, g0 (5 points) makes 7, g1 (4 points) would make 11
    const r = expandTargets(m, none, NO_VIEW, [nodeId.source(1)], true, 10);
    expect(ids(r)).toEqual([[1], [g(1, 0)]]);
    expect(r.opened).toEqual({ sources: 1, groups: 1, assets: 0 });
    expect(r.kept).toEqual({ sources: 0, groups: 1 });
  });

  it("a source that does not fit stays closed, its groups are not counted, and nothing changed means the same open state", () => {
    const r = expandTargets(m, none, NO_VIEW, [nodeId.source(1)], true, 1);
    expect(r.open).toBe(none);
    expect(r.kept).toEqual({ sources: 1, groups: 0 });
    expect(r.opened).toEqual({ sources: 0, groups: 0, assets: 0 });
  });

  it("only the chosen nodes open: the rest of the graph is not touched", () => {
    const r = expandTargets(m, none, NO_VIEW, [nodeId.source(1)], true);
    expect(r.open.sources.has(2)).toBe(false);
  });

  it("a target that is already open changes nothing and is not counted; the very objects come back", () => {
    const open = { sources: new Set([1]), clusters: new Set([g(1, 0)]) };
    const closedAssets = new Set([11]);
    const r = expandTargets(m, open, view({ assetsClosed: closedAssets }), [nodeId.source(1), g(1, 0)], false);
    expect(r.open).toBe(open);
    expect(r.assetsClosed).toBe(closedAssets);
    expect(r.opened).toEqual({ sources: 0, groups: 0, assets: 0 });
    expect(r.kept).toEqual({ sources: 0, groups: 0 });
  });

  it("never changes the sets it is given", () => {
    const open = { sources: new Set([1]), clusters: new Set<string>() };
    const closedAssets = new Set([10, 11]);
    const r = expandTargets(m, open, view({ assetsClosed: closedAssets }), [nodeId.source(1), nodeId.asset(10)], true);
    expect([...open.sources, ...open.clusters]).toEqual([1]);
    expect([...closedAssets]).toEqual([10, 11]);
    expect(r.open.clusters).not.toBe(open.clusters);
    expect(r.assetsClosed).not.toBe(closedAssets);
  });

  it("an asset opens for free: no budget, never kept; a branch opens the folded descendants too", () => {
    const folded = view({ assetsClosed: new Set([10, 11, 20]) });
    const one = expandTargets(m, none, folded, [nodeId.asset(10)], false, 0);
    expect([...one.assetsClosed].sort()).toEqual([11, 20]);
    expect(one.opened).toEqual({ sources: 0, groups: 0, assets: 1 });
    expect(one.kept).toEqual({ sources: 0, groups: 0 });
    const branch = expandTargets(m, none, folded, [nodeId.asset(10)], true, 0);
    expect([...branch.assetsClosed]).toEqual([20]);
    expect(branch.opened.assets).toBe(2);
    expect(branch.open).toBe(none);
  });

  it("an asset that is not folded changes nothing", () => {
    const folded = view({ assetsClosed: new Set([11]) });
    const r = expandTargets(m, none, folded, [nodeId.asset(10)], false);
    expect(r.assetsClosed).toBe(folded.assetsClosed);
    expect(r.opened.assets).toBe(0);
  });

  it("pages and the filter count: a 700-point group costs 51, hidden sources and groups are ignored", () => {
    const big = model({ sources: [withGroups(1, [700])] });
    const fits = expandTargets(big, none, paged(), [nodeId.source(1)], true, 52);
    expect(fits.opened).toEqual({ sources: 1, groups: 1, assets: 0 });
    const tight = expandTargets(big, none, paged(), [nodeId.source(1)], true, 51);
    expect(tight.opened).toEqual({ sources: 1, groups: 0, assets: 0 });
    expect(tight.kept).toEqual({ sources: 0, groups: 1 });
    const hidden = model({ sources: [withMapped(1, 3, 3), source(2, { clusters: [
      { key: "done", points: [point(nextPoint++, "p", { asset_id: 10 })] }, { key: "todo", points: [point(nextPoint++, "p")] }] })] });
    const r = expandTargets(hidden, none, view({ unmappedOnly: true }), [nodeId.source(1), nodeId.source(2)], true);
    expect(ids(r)).toEqual([[2], [nodeId.cluster(2, "todo")]]);
    expect(r.opened).toEqual({ sources: 1, groups: 1, assets: 0 });
  });
});

describe("collapseTargets", () => {
  const m = model({ sources: [withGroups(1, [5, 4]), withGroups(2, [3])], assets: tree() });
  const open = { sources: new Set([1, 2]), clusters: new Set([g(1, 0), g(1, 1), g(2, 0)]) };

  it("closes a source and remembers its open groups; a branch forgets them", () => {
    const plain = collapseTargets(m, open, NO_VIEW, [nodeId.source(1)], false);
    expect(ids(plain)).toEqual([[2], [g(1, 0), g(1, 1), g(2, 0)]]);
    expect(plain.closed).toEqual({ sources: 1, groups: 0, assets: 0 });
    const branch = collapseTargets(m, open, NO_VIEW, [nodeId.source(1)], true);
    expect(ids(branch)).toEqual([[2], [g(2, 0)]]);
    expect(branch.closed).toEqual({ sources: 1, groups: 2, assets: 0 });
    expect(branch.opened).toEqual({ sources: 0, groups: 0, assets: 0 });
  });

  it("closes one group", () => {
    const r = collapseTargets(m, open, NO_VIEW, [g(1, 1)], false);
    expect(ids(r)).toEqual([[1, 2], [g(1, 0), g(2, 0)]]);
    expect(r.closed).toEqual({ sources: 0, groups: 1, assets: 0 });
  });

  it("counts real changes only: what is closed already is not counted, and the very object comes back when nothing changed", () => {
    const shut = { sources: new Set([2]), clusters: new Set<string>() };
    const r = collapseTargets(m, shut, NO_VIEW, [nodeId.source(1), g(1, 0)], true);
    expect(r.open).toBe(shut);
    expect(r.closed).toEqual({ sources: 0, groups: 0, assets: 0 });
  });

  it("folds an asset; a branch folds the sub-assets that have sub-assets as well", () => {
    const one = collapseTargets(m, open, NO_VIEW, [nodeId.asset(10)], false);
    expect([...one.assetsClosed]).toEqual([10]);
    expect(one.closed).toEqual({ sources: 0, groups: 0, assets: 1 });
    expect(one.open).toBe(open);
    const branch = collapseTargets(m, open, NO_VIEW, [nodeId.asset(10)], true);
    expect([...branch.assetsClosed].sort()).toEqual([10, 11]);
    expect(branch.closed.assets).toBe(2);
  });

  it("an asset that is folded already is not counted; the same set comes back", () => {
    const folded = view({ assetsClosed: new Set([10]) });
    const r = collapseTargets(m, open, folded, [nodeId.asset(10)], false);
    expect(r.assetsClosed).toBe(folded.assetsClosed);
    expect(r.closed.assets).toBe(0);
    const more = collapseTargets(m, open, folded, [nodeId.asset(10)], true);
    expect([...more.assetsClosed].sort()).toEqual([10, 11]);
    expect(more.closed.assets).toBe(1);
  });

  it("never changes the sets it is given", () => {
    const closedAssets = new Set([20]);
    const before = JSON.stringify([[...open.sources], [...open.clusters]]);
    const r = collapseTargets(m, open, view({ assetsClosed: closedAssets }), [nodeId.source(1), nodeId.asset(10)], true);
    expect(JSON.stringify([[...open.sources], [...open.clusters]])).toBe(before);
    expect([...closedAssets]).toEqual([20]);
    expect(r.assetsClosed).not.toBe(closedAssets);
  });

  it("a branch forgets a group the filter hides too, but does not count it", () => {
    const hid = model({ sources: [source(1, { clusters: [
      { key: "done", points: [point(nextPoint++, "p", { asset_id: 10 })] }, { key: "todo", points: [point(nextPoint++, "p")] }] })] });
    const both = { sources: new Set([1]), clusters: new Set([nodeId.cluster(1, "done"), nodeId.cluster(1, "todo")]) };
    const r = collapseTargets(hid, both, view({ unmappedOnly: true }), [nodeId.source(1)], true);
    expect(ids(r)).toEqual([[], []]);
    expect(r.closed).toEqual({ sources: 1, groups: 1, assets: 0 });
  });

  it("opens nothing and keeps nothing", () => {
    const r = collapseTargets(m, open, NO_VIEW, [nodeId.source(1)], true);
    expect(r.opened).toEqual({ sources: 0, groups: 0, assets: 0 });
    expect(r.kept).toEqual({ sources: 0, groups: 0 });
  });
});

describe("changeNote", () => {
  const change = (opened: Partial<Change["opened"]> = {}, closed: Partial<Change["closed"]> = {}, kept: Partial<Change["kept"]> = {}): Change => ({
    open: none, assetsClosed: new Set(), opened: { sources: 0, groups: 0, assets: 0, ...opened }, closed: { sources: 0, groups: 0, assets: 0, ...closed },
    kept: { sources: 0, groups: 0, ...kept },
  });

  it.each([
    [change({ sources: 1, groups: 3 }), "Opened 1 source and 3 groups."],
    [change({ groups: 2, assets: 3 }), "Opened 2 groups and 3 assets."],
    [change({ sources: 2 }), "Opened 2 sources."],
    [change({ groups: 1 }), "Opened 1 group."],
    [change({ assets: 1 }), "Opened 1 asset."],
    [change({ sources: 1, groups: 1, assets: 1 }), "Opened 1 source, 1 group and 1 asset."],
    [change({ sources: 3, groups: 12, assets: 2 }), "Opened 3 sources, 12 groups and 2 assets."],
  ])("expand: opened %j", (c, text) => {
    expect(changeNote(c, "expand")).toBe(text);
  });

  it.each([
    [change({ groups: 3 }, {}, { groups: 2 }), "Opened 3 groups. 2 groups stay closed: opening them would draw more than 600 nodes."],
    [change({ sources: 1, groups: 1 }, {}, { groups: 1 }), "Opened 1 source and 1 group. 1 group stays closed: opening it would draw more than 600 nodes."],
    [change({ sources: 2 }, {}, { sources: 1, groups: 4 }), "Opened 2 sources. 1 source and 4 groups stay closed: opening them would draw more than 600 nodes."],
    [change({}, {}, { sources: 1 }), "Opened nothing. 1 source stays closed: opening it would draw more than 600 nodes."],
    [change({ assets: 2 }, {}, { groups: 1 }), "Opened 2 assets. 1 group stays closed: opening it would draw more than 600 nodes."],
  ])("expand: what did not fit is said in the Expand all words (%j)", (c, text) => {
    expect(changeNote(c, "expand")).toBe(text);
  });

  it("names the budget it is given", () => {
    expect(changeNote(change({ groups: 1 }, {}, { groups: 1 }), "expand", 10)).toBe("Opened 1 group. 1 group stays closed: opening it would draw more than 10 nodes.");
  });

  it.each([
    [change({}, { groups: 2 }), "Closed 2 groups."],
    [change({}, { sources: 1, groups: 1 }), "Closed 1 source and 1 group."],
    [change({}, { assets: 1 }), "Closed 1 asset."],
    [change({}, { sources: 2, groups: 3, assets: 4 }), "Closed 2 sources, 3 groups and 4 assets."],
  ])("collapse: closed %j", (c, text) => {
    expect(changeNote(c, "collapse")).toBe(text);
  });

  it("is null when nothing changed and nothing was kept", () => {
    expect(changeNote(change(), "expand")).toBeNull();
    expect(changeNote(change(), "collapse")).toBeNull();
    expect(changeNote(change({}, { groups: 2 }), "expand")).toBeNull(); // a collapse count says nothing on an expand
    expect(changeNote(change({ groups: 2 }), "collapse")).toBeNull();
  });

  it("a collapse has no budget sentence", () => {
    expect(changeNote(change({}, { groups: 1 }, { groups: 5 }), "collapse")).toBe("Closed 1 group.");
  });
});

describe("selectionStates", () => {
  const m = model({ sources: [withGroups(1, [5, 4]), withGroups(2, [3]), withMapped(3, 2, 2)], assets: tree() });
  const states = (open: OpenState, selected: string[], v: GraphView = NO_VIEW) => selectionStates(m, open, v, selected);
  const allOpen: OpenState = { sources: new Set([1, 2]), clusters: new Set([g(1, 0), g(1, 1), g(2, 0)]) };
  const SELECT_FIRST = "Select a source, group or asset first.";

  it("nothing selected: all four are off, with the reason to select something", () => {
    const s = states(none, []);
    for (const key of ["expandSelection", "collapseSelection", "expandBranch", "collapseBranch"] as const) {
      expect(s[key]).toEqual({ enabled: false, reason: SELECT_FIRST });
    }
  });

  it("something is selected but nothing in it opens or closes", () => {
    const s = states(allOpen, ["point:1", nodeId.asset(12), nodeId.more(g(1, 0))]);
    for (const key of ["expandSelection", "collapseSelection", "expandBranch", "collapseBranch"] as const) {
      expect(s[key]).toEqual({ enabled: false, reason: "Nothing selected opens or closes." });
    }
  });

  it("a closed source: expand is on, collapse says it is already closed", () => {
    const s = states(none, [nodeId.source(1)]);
    expect(s.expandSelection).toEqual({ enabled: true });
    expect(s.collapseSelection).toEqual({ enabled: false, reason: "Everything selected is already closed." });
    expect(s.expandBranch).toEqual({ enabled: true });
    expect(s.collapseBranch).toEqual({ enabled: false, reason: "Everything selected is already closed." });
  });

  it("an open source: collapse is on, expand says it is already open", () => {
    const s = states({ sources: new Set([1]), clusters: new Set([g(1, 0), g(1, 1)]) }, [g(1, 0)]);
    expect(s.expandSelection).toEqual({ enabled: false, reason: "Everything selected is already open." });
    expect(s.collapseSelection).toEqual({ enabled: true });
  });

  it("the selection and its branch can differ: an open source whose groups are shut", () => {
    const s = states({ sources: new Set([1]), clusters: new Set() }, [nodeId.source(1)]);
    expect(s.expandSelection).toEqual({ enabled: false, reason: "Everything selected is already open." });
    expect(s.expandBranch).toEqual({ enabled: true }); // its groups are closed
    expect(s.collapseSelection).toEqual({ enabled: true });
    expect(s.collapseBranch).toEqual({ enabled: true });
    const full = states({ sources: new Set([1]), clusters: new Set([g(1, 0), g(1, 1)]) }, [nodeId.source(1)]);
    expect(full.expandBranch).toEqual({ enabled: false, reason: "Everything selected is already open." });
  });

  it("a mix of open and closed is on both ways", () => {
    const s = states({ sources: new Set([1]), clusters: new Set() }, [nodeId.source(1), nodeId.source(2)]);
    expect(s.expandSelection.enabled).toBe(true);
    expect(s.collapseSelection.enabled).toBe(true);
  });

  it("an asset with sub-assets is open until it is folded", () => {
    const open = states(none, [nodeId.asset(10)]);
    expect(open.expandSelection).toEqual({ enabled: false, reason: "Everything selected is already open." });
    expect(open.collapseSelection).toEqual({ enabled: true });
    const folded = states(none, [nodeId.asset(10)], view({ assetsClosed: new Set([10]) }));
    expect(folded.expandSelection).toEqual({ enabled: true });
    expect(folded.collapseSelection).toEqual({ enabled: false, reason: "Everything selected is already closed." });
  });

  it("an asset branch counts the folded sub-assets under it", () => {
    const s = states(none, [nodeId.asset(10)], view({ assetsClosed: new Set([11]) }));
    expect(s.expandSelection.enabled).toBe(false);
    expect(s.expandBranch.enabled).toBe(true);
  });

  it("a source the filter hides does not count as open or closed", () => {
    const filtered = view({ unmappedOnly: true });
    const s = states(none, [nodeId.source(3)], filtered);
    expect(s.expandSelection).toEqual({ enabled: false, reason: "Nothing selected opens or closes." });
    expect(s.collapseSelection).toEqual({ enabled: false, reason: "Nothing selected opens or closes." });
    const plain = states(none, [nodeId.source(3)]);
    expect(plain.expandSelection.enabled).toBe(true);
  });

  it("returns the same answers for the same input", () => {
    expect(states(allOpen, [nodeId.source(1)])).toEqual(states(allOpen, [nodeId.source(1)]));
  });

  // A node's own menu acts on THAT node whatever is selected, so its reasons speak of the node and never of "everything selected".
  describe("for a node's own menu (subject 'node')", () => {
    const own = (open: OpenState, id: string, v: GraphView = NO_VIEW) => selectionStates(m, open, v, [id], "node");

    it("a closed source: the branch can be opened, and is already closed", () => {
      const s = own(none, nodeId.source(1));
      expect(s.expandBranch).toEqual({ enabled: true });
      expect(s.collapseBranch).toEqual({ enabled: false, reason: "This branch is already closed." });
    });

    it("a source that is open with every group open: the branch is already open", () => {
      const s = own(allOpen, nodeId.source(1));
      expect(s.expandBranch).toEqual({ enabled: false, reason: "This branch is already open." });
      expect(s.collapseBranch).toEqual({ enabled: true });
    });

    it("a folded asset: the branch can be opened, and is already closed", () => {
      const s = own(none, nodeId.asset(10), view({ assetsClosed: new Set([10, 11]) }));
      expect(s.expandBranch).toEqual({ enabled: true });
      expect(s.collapseBranch).toEqual({ enabled: false, reason: "This branch is already closed." });
    });

    it("a node with nothing under it that opens or closes", () => {
      const s = own(allOpen, "point:1");
      expect(s.expandBranch).toEqual({ enabled: false, reason: "Nothing under it opens or closes." });
      expect(s.collapseBranch).toEqual({ enabled: false, reason: "Nothing under it opens or closes." });
    });

    it("a source the filter hides", () => {
      const s = own(none, nodeId.source(3), view({ unmappedOnly: true }));
      expect(s.expandBranch).toEqual({ enabled: false, reason: "Nothing under it opens or closes." });
    });

    it("no reason of the node's words says 'selected'", () => {
      const reasons = [none, allOpen].flatMap((o) => [nodeId.source(1), "point:1", nodeId.asset(10)].flatMap((id) => {
        const s = own(o, id);
        return [s.expandBranch.reason, s.collapseBranch.reason];
      }));
      for (const reason of reasons) expect(reason ?? "").not.toMatch(/selected/i);
    });
  });
});

describe("graphCounts with a point that is the same tag as a mapped point (w34)", () => {
  it("the twin is a point, it is not mapped, and it is not among the unmapped points the filter leaves", () => {
    const sources = [source(1, { clusters: [{ key: "G", points: [point(1, "a", { asset_id: 10, mapping_id: 1 }), point(2, "b", { same_tag_as: 1 }), point(3, "c")] }] })];
    expect(graphCounts(model({ sources }))).toEqual({ sources: 1, points: 3, mapped: 1, needing: 0, unmapped: 1 });
  });
});
