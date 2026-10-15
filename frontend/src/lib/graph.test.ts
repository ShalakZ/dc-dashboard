import type { RemoveSourcesResult } from "../api/types";
import {
  BLOCK_GAP, MAX_LAYOUT_ID, SOURCE_H, UNGROUPED, buildGraph, childNodeIds, descendantNodeIds, initialView, isRemovable, layoutBatches, nodeId, ownPlaces,
  removalDialogText, removalOutcome, seenLine, shiftedPlaces, type OpenState, type XY,
} from "./graph";
import { model, point, source } from "../test/graphFixtures";

const none: OpenState = { sources: new Set(), clusters: new Set() };
const ids = (nodes: { id: string }[]) => nodes.map((n) => n.id).sort();

describe("buildGraph", () => {
  it("collapsed: one node per source, per asset and per unidentified service, nothing else", () => {
    const { nodes } = buildGraph(model(), none);
    expect(ids(nodes)).toEqual(["asset:10", "asset:11", "src:1", "src:2", "unid:10.0.0.9:8080"]);
  });

  it("node ids follow the documented scheme and every node is draggable", () => {
    expect(nodeId.source(1)).toBe("src:1");
    expect(nodeId.cluster(1, "LVP01")).toBe("cluster:1:LVP01");
    expect(nodeId.point(3)).toBe("point:3");
    expect(nodeId.asset(10)).toBe("asset:10");
    expect(nodeId.unidentified("10.0.0.9", 8080)).toBe("unid:10.0.0.9:8080");
    const open = { sources: new Set([1]), clusters: new Set([nodeId.cluster(1, "LVP01")]) };
    const { nodes } = buildGraph(model(), open);
    // Every node is draggable by the canvas's default, and none carries a `draggable` of its own: React Flow lets a node's own `true` beat `nodesDraggable={false}` (the page's switch while Tidy runs).
    expect(nodes.every((n) => n.draggable === undefined)).toBe(true);
    expect(new Set(nodes.map((n) => n.type))).toEqual(new Set(["source", "cluster", "point", "asset", "unidentified"]));
  });

  it("source nodes start collapsed and report their expanded state", () => {
    const collapsed = buildGraph(model(), none).nodes.find((n) => n.id === "src:1");
    expect(collapsed?.data).toMatchObject({ expanded: false, source: { id: 1 } });
    const open = buildGraph(model(), { sources: new Set([1]), clusters: new Set() }).nodes.find((n) => n.id === "src:1");
    expect(open?.data).toMatchObject({ expanded: true });
  });

  it("expanding a source adds its clusters plus an Ungrouped pseudo-cluster", () => {
    const { nodes, edges } = buildGraph(model(), { sources: new Set([1]), clusters: new Set() });
    expect(ids(nodes.filter((n) => n.type === "cluster"))).toEqual([
      nodeId.cluster(1, "LVP01"), nodeId.cluster(1, "LVP02"), nodeId.cluster(1, UNGROUPED)].sort());
    expect(edges.filter((e) => e.source === "src:1")).toHaveLength(3);
    expect(nodes.find((n) => n.id === nodeId.cluster(1, UNGROUPED))?.data).toMatchObject({ ungrouped: true, count: 1 });
  });

  it("a cluster node reports its size, mapped count and expanded state", () => {
    const open = { sources: new Set([2]), clusters: new Set([nodeId.cluster(2, "M")]) };
    const cluster = buildGraph(model(), open).nodes.find((n) => n.id === nodeId.cluster(2, "M"));
    expect(cluster?.data).toMatchObject({ sourceId: 2, key: "M", label: "M", count: 2, mappedCount: 2, expanded: true, ungrouped: false });
    const closed = buildGraph(model(), { sources: new Set([2]), clusters: new Set() }).nodes.find((n) => n.id === nodeId.cluster(2, "M"));
    expect(closed?.data).toMatchObject({ expanded: false });
  });

  it("no Ungrouped pseudo-cluster when the source has no ungrouped points", () => {
    const { nodes } = buildGraph(model(), { sources: new Set([2]), clusters: new Set() });
    expect(ids(nodes.filter((n) => n.type === "cluster"))).toEqual([nodeId.cluster(2, "M")]);
  });

  it("expanding a cluster adds its point nodes with dashed edges", () => {
    const open = { sources: new Set([1]), clusters: new Set([nodeId.cluster(1, "LVP01")]) };
    const { nodes, edges } = buildGraph(model(), open);
    expect(ids(nodes.filter((n) => n.type === "point"))).toEqual(["point:1", "point:2", "point:3"]);
    expect(edges.find((e) => e.target === "point:1")?.style).toMatchObject({ strokeDasharray: expect.any(String) });
  });

  it("a cluster that is marked open but whose source is collapsed shows nothing", () => {
    const { nodes } = buildGraph(model(), { sources: new Set(), clusters: new Set([nodeId.cluster(1, "LVP01")]) });
    expect(nodes.some((n) => n.type === "cluster" || n.type === "point")).toBe(false);
  });

  it("asset hierarchy becomes solid parent-to-child edges", () => {
    const { edges } = buildGraph(model(), none);
    const edge = edges.find((e) => e.source === "asset:10" && e.target === "asset:11");
    expect(edge).toBeDefined();
    expect(edge?.style?.strokeDasharray).toBeUndefined();
  });

  it("a collapsed source with mapped points links to each asset with a count", () => {
    const { edges } = buildGraph(model(), none);
    expect(edges.find((e) => e.source === "src:2" && e.target === "asset:10")?.label).toBe("2 mapped");
  });

  it("a single mapped point links without a count label", () => {
    const m = model({ sources: [source(1, { clusters: [{ key: "K", points: [point(1, "a", { asset_id: 11, mapping_id: 1 }), point(2, "b")] }] })] });
    const edge = buildGraph(m, none).edges.find((e) => e.source === "src:1" && e.target === "asset:11");
    expect(edge).toBeDefined();
    expect(edge?.label).toBeUndefined();
  });

  it("a collapsed cluster aggregates its mapped points; an expanded one links each point", () => {
    const collapsed = buildGraph(model(), { sources: new Set([2]), clusters: new Set() });
    expect(collapsed.edges.find((e) => e.source === nodeId.cluster(2, "M") && e.target === "asset:10")?.label).toBe("2 mapped");
    const expanded = buildGraph(model(), { sources: new Set([2]), clusters: new Set([nodeId.cluster(2, "M")]) });
    expect(expanded.edges.filter((e) => e.target === "asset:10" && e.source.startsWith("point:"))).toHaveLength(2);
    expect(expanded.edges.some((e) => e.source === nodeId.cluster(2, "M") && e.target === "asset:10")).toBe(false);
  });

  it("edge ids are unique", () => {
    const open = { sources: new Set([1, 2]), clusters: new Set([nodeId.cluster(1, "LVP01"), nodeId.cluster(2, "M")]) };
    const { edges } = buildGraph(model(), open);
    expect(new Set(edges.map((e) => e.id)).size).toBe(edges.length);
  });

  it("never links to an asset that does not exist", () => {
    const m = model({ assets: [] });
    expect(buildGraph(m, none).edges).toHaveLength(0);
  });

  it("saved layout overrides default positions; others get distinct defaults", () => {
    const { nodes } = buildGraph(model({ layout: { "src:1": { x: 5, y: 6 } } }), none);
    expect(nodes.find((n) => n.id === "src:1")?.position).toEqual({ x: 5, y: 6 });
    const positions = nodes.filter((n) => n.id !== "src:1").map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("default positions are distinct with everything expanded", () => {
    const open = { sources: new Set([1, 2]), clusters: new Set([nodeId.cluster(1, "LVP01"), nodeId.cluster(1, "LVP02"), nodeId.cluster(1, UNGROUPED), nodeId.cluster(2, "M")]) };
    const { nodes } = buildGraph(model(), open);
    const positions = nodes.map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("discovered nodes sit left of asset nodes by default", () => {
    const { nodes } = buildGraph(model(), { sources: new Set([1]), clusters: new Set() });
    const maxLeft = Math.max(...nodes.filter((n) => n.type !== "asset").map((n) => n.position.x));
    const minAsset = Math.min(...nodes.filter((n) => n.type === "asset").map((n) => n.position.x));
    expect(maxLeft).toBeLessThan(minAsset);
  });

  it("survives an asset whose parent is missing or that points at itself", () => {
    const m = model({ assets: [{ id: 10, parent_id: 99, name: "Orphan", kind: "generic" }, { id: 11, parent_id: 11, name: "Loop", kind: "generic" }] });
    expect(() => buildGraph(m, none)).not.toThrow();
    expect(buildGraph(m, none).nodes.filter((n) => n.type === "asset")).toHaveLength(2);
  });

  it("survives a parent cycle without dropping or looping over its assets", () => {
    const m = model({ assets: [{ id: 10, parent_id: 11, name: "A", kind: "generic" }, { id: 11, parent_id: 10, name: "B", kind: "generic" }] });
    const { nodes } = buildGraph(m, none);
    expect(ids(nodes.filter((n) => n.type === "asset"))).toEqual(["asset:10", "asset:11"]);
    const positions = nodes.map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("indents child assets one level to the right of their parent", () => {
    const { nodes } = buildGraph(model(), none);
    const x = (id: string) => nodes.find((n) => n.id === id)!.position.x;
    expect(x("asset:11")).toBeGreaterThan(x("asset:10"));
  });

  it("an empty model yields an empty graph", () => {
    expect(buildGraph({ sources: [], unidentified: [], assets: [], layout: {} }, none)).toEqual({ nodes: [], edges: [] });
  });

  it("handles a thousand clusters without quadratic blow-up", () => {
    const clusters = Array.from({ length: 1000 }, (_, i) => ({ key: `D${i}`, points: [point(i * 2 + 1, `D${i} a`), point(i * 2 + 2, `D${i} b`)] }));
    const big = model({ sources: [source(1, { clusters })], unidentified: [] });
    const started = performance.now();
    expect(buildGraph(big, { sources: new Set([1]), clusters: new Set() }).nodes.length).toBe(1000 + 1 + 2);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("buildGraph: room for a source node (W7r)", () => {
  const sourceY = (nodes: { id: string; position: { y: number } }[], id: string) => nodes.find((n) => n.id === id)!.position.y;

  it("the next source starts at least a source node plus the gap below the first, collapsed", () => {
    const { nodes } = buildGraph(model(), none);
    expect(sourceY(nodes, "src:2") - sourceY(nodes, "src:1")).toBeGreaterThanOrEqual(SOURCE_H + BLOCK_GAP);
  });

  it("the first group sits a whole source node below its source, and the next source clears the last group", () => {
    const open = { sources: new Set([1]), clusters: new Set<string>() };
    const { nodes } = buildGraph(model(), open);
    const clusters = nodes.filter((n) => n.type === "cluster").map((n) => n.position.y).sort((a, b) => a - b);
    expect(clusters[0] - sourceY(nodes, "src:1")).toBeGreaterThanOrEqual(SOURCE_H);
    expect(sourceY(nodes, "src:2") - clusters[clusters.length - 1]).toBeGreaterThan(0);
    // a group node is 64 px apart from the next, as before
    expect(clusters[1] - clusters[0]).toBe(64);
  });
});

const at = (nodes: { id: string; position: XY }[], id: string) => nodes.find((n) => n.id === id)!.position;

describe("buildGraph: places that follow their parent (W7t)", () => {
  const LVP01 = nodeId.cluster(1, "LVP01");
  const LVP02 = nodeId.cluster(1, "LVP02");
  const UNG = nodeId.cluster(1, UNGROUPED);
  // Source 1 open with LVP01 open: src:1 (0,0), LVP01 (360,136), its points (720,200/264/328), LVP02 (360,392), Ungrouped (360,456); src:2 (0,560).
  const open: OpenState = { sources: new Set([1]), clusters: new Set([LVP01]) };

  it("without options the places are the defaults and the saved layout, exactly as before", () => {
    const m = model({ layout: { "src:1": { x: 7, y: 8 } } });
    expect(buildGraph(m, open, {})).toEqual(buildGraph(m, open));
    expect(buildGraph(m, open, { moved: new Map(), ignoreSaved: false })).toEqual(buildGraph(m, open));
    expect(at(buildGraph(model(), open).nodes, LVP01)).toEqual({ x: 360, y: 136 });
    expect(at(buildGraph(model(), open).nodes, "point:3")).toEqual({ x: 720, y: 328 });
    expect(at(buildGraph(model(), open).nodes, "src:2")).toEqual({ x: 0, y: 560 });
  });

  it.each([
    ["a session place (moved)", { moved: new Map([["src:1", { x: 100, y: 50 }]]) }, undefined],
    ["a saved place (layout)", {}, { "src:1": { x: 100, y: 50 } }],
  ])("a source with %s takes its open groups and points along, each keeping its offset; other sources stay", (_name, options, layout) => {
    const { nodes } = buildGraph(model(layout ? { layout } : {}), open, options);
    expect(at(nodes, "src:1")).toEqual({ x: 100, y: 50 });
    expect(at(nodes, LVP01)).toEqual({ x: 460, y: 186 });
    expect(at(nodes, "point:1")).toEqual({ x: 820, y: 250 });
    expect(at(nodes, "point:3")).toEqual({ x: 820, y: 378 });
    expect(at(nodes, LVP02)).toEqual({ x: 460, y: 442 });
    expect(at(nodes, UNG)).toEqual({ x: 460, y: 506 });
    expect(at(nodes, "src:2")).toEqual({ x: 0, y: 560 });
    expect(at(nodes, "asset:10")).toEqual({ x: 1200, y: 0 });
  });

  it("closed children are not drawn, and a source that was moved while closed opens its groups beside itself", () => {
    const moved = new Map([["src:1", { x: -300, y: 900 }]]);
    const collapsed = buildGraph(model(), { sources: new Set(), clusters: new Set() }, { moved }).nodes;
    expect(collapsed.some((n) => n.type === "cluster" || n.type === "point")).toBe(false);
    const opened = buildGraph(model(), { sources: new Set([1]), clusters: new Set() }, { moved }).nodes;
    expect(at(opened, LVP01)).toEqual({ x: 60, y: 1036 });
    expect(at(opened, LVP02)).toEqual({ x: 60, y: 1100 });
  });

  it("a child with its own place keeps it, and ITS children follow it, not the source", () => {
    const layout = { "src:1": { x: 100, y: 50 }, [LVP01]: { x: 5, y: 6 } };
    const { nodes } = buildGraph(model({ layout }), open);
    expect(at(nodes, LVP01)).toEqual({ x: 5, y: 6 });
    expect(at(nodes, "point:1")).toEqual({ x: 365, y: 70 }); // 720-355, 200-130: the cluster's shift, not the source's
    expect(at(nodes, LVP02)).toEqual({ x: 460, y: 442 }); // a sibling with no place follows the source
  });

  it("a child with a saved place stays put when its source moves this session (the shift of a saved child is the caller's job)", () => {
    const { nodes } = buildGraph(model({ layout: { "point:2": { x: 900, y: 900 } } }), open, { moved: new Map([["src:1", { x: 100, y: 50 }]]) });
    expect(at(nodes, "point:2")).toEqual({ x: 900, y: 900 });
    expect(at(nodes, "point:1")).toEqual({ x: 820, y: 250 });
  });

  it("a session place beats a saved one", () => {
    const m = model({ layout: { "src:1": { x: 1, y: 1 }, "point:1": { x: 2, y: 2 } } });
    const moved = new Map([["src:1", { x: 100, y: 50 }], ["point:1", { x: 3, y: 3 }]]);
    const { nodes } = buildGraph(m, open, { moved });
    expect(at(nodes, "src:1")).toEqual({ x: 100, y: 50 });
    expect(at(nodes, "point:1")).toEqual({ x: 3, y: 3 });
  });

  it("ignoreSaved drops the shared layout but keeps this session's places", () => {
    const m = model({ layout: { "src:1": { x: 100, y: 50 }, [LVP01]: { x: 5, y: 6 }, "asset:10": { x: 1, y: 1 } } });
    const plain = buildGraph(m, open, { ignoreSaved: true }).nodes;
    expect(at(plain, "src:1")).toEqual({ x: 0, y: 0 });
    expect(at(plain, LVP01)).toEqual({ x: 360, y: 136 });
    expect(at(plain, "asset:10")).toEqual({ x: 1200, y: 0 });
    const withSession = buildGraph(m, open, { ignoreSaved: true, moved: new Map([["src:1", { x: 10, y: 20 }]]) }).nodes;
    expect(at(withSession, LVP01)).toEqual({ x: 370, y: 156 }); // the saved cluster place is ignored, the source's session place counts
  });

  it("the documented limit: a child with a place under a parent WITHOUT one stays put when a block above grows (Tidy puts both right)", () => {
    const m = model({ layout: { [nodeId.cluster(2, "M")]: { x: 360, y: 700 } } });
    const srcOpen: OpenState = { sources: new Set([2]), clusters: new Set() };
    const before = buildGraph(m, srcOpen).nodes;
    expect(at(before, "src:2").y).toBe(SOURCE_H + BLOCK_GAP);
    expect(at(before, nodeId.cluster(2, "M"))).toEqual({ x: 360, y: 700 });
    const grown = buildGraph(m, { sources: new Set([1, 2]), clusters: new Set() }).nodes;
    expect(at(grown, "src:2").y).toBeGreaterThan(at(before, "src:2").y);
    expect(at(grown, nodeId.cluster(2, "M"))).toEqual({ x: 360, y: 700 });
  });

  it("a child with no place follows its parent when other sources open and close (the offset is cursor independent)", () => {
    const moved = new Map([["src:2", { x: 50, y: 1000 }]]);
    const offset = (o: OpenState) => {
      const { nodes } = buildGraph(model(), o, { moved });
      return at(nodes, nodeId.cluster(2, "M")).y - at(nodes, "src:2").y;
    };
    expect(offset({ sources: new Set([2]), clusters: new Set() })).toBe(SOURCE_H);
    expect(offset({ sources: new Set([1, 2]), clusters: new Set([LVP01]) })).toBe(SOURCE_H);
  });

  it("sub-assets follow their asset; an asset with a place of its own keeps it", () => {
    const m = model({ assets: [
      { id: 10, parent_id: null, name: "Site", kind: "generic" }, { id: 11, parent_id: 10, name: "A", kind: "generic" },
      { id: 12, parent_id: 11, name: "B", kind: "generic" }, { id: 13, parent_id: 10, name: "C", kind: "generic" }] });
    const base = buildGraph(m, none).nodes;
    const moved = new Map([["asset:10", { x: 1300, y: 100 }]]);
    const { nodes } = buildGraph(m, none, { moved });
    for (const id of ["asset:11", "asset:12", "asset:13"]) {
      expect(at(nodes, id)).toEqual({ x: at(base, id).x + 100, y: at(base, id).y + 100 });
    }
    const own = buildGraph(model({ assets: m.assets, layout: { "asset:11": { x: 5, y: 5 } } }), none, { moved }).nodes;
    expect(at(own, "asset:11")).toEqual({ x: 5, y: 5 });
    expect(at(own, "asset:12")).toEqual({ x: at(base, "asset:12").x + (5 - at(base, "asset:11").x), y: at(base, "asset:12").y + (5 - at(base, "asset:11").y) });
    expect(at(own, "asset:13")).toEqual({ x: at(base, "asset:13").x + 100, y: at(base, "asset:13").y + 100 });
  });

  it("an orphan, a self-parent and a cycle build without throwing, and only a real walk parent shifts a child", () => {
    const orphan = model({ assets: [{ id: 10, parent_id: 99, name: "Orphan", kind: "generic" }, { id: 11, parent_id: 11, name: "Loop", kind: "generic" }] });
    const baseOrphan = buildGraph(orphan, none).nodes;
    const movedOrphan = buildGraph(orphan, none, { moved: new Map([["asset:10", { x: 5, y: 5 }]]) }).nodes;
    expect(at(movedOrphan, "asset:10")).toEqual({ x: 5, y: 5 });
    expect(at(movedOrphan, "asset:11")).toEqual(at(baseOrphan, "asset:11")); // roots have no parent: nothing follows
    const cycle = model({ assets: [{ id: 10, parent_id: 11, name: "A", kind: "generic" }, { id: 11, parent_id: 10, name: "B", kind: "generic" }] });
    const base = buildGraph(cycle, none).nodes;
    const first = buildGraph(cycle, none, { moved: new Map([["asset:10", { x: 5, y: 5 }]]) }).nodes;
    expect(at(first, "asset:11")).toEqual({ x: at(base, "asset:11").x + (5 - at(base, "asset:10").x), y: at(base, "asset:11").y + (5 - at(base, "asset:10").y) });
    const second = buildGraph(cycle, none, { moved: new Map([["asset:11", { x: 9, y: 9 }]]) }).nodes;
    expect(at(second, "asset:10")).toEqual(at(base, "asset:10")); // the walk root has no parent: dragging its child never moves it
  });

  it("an unidentified service is a root: it has its own place or its default", () => {
    const id = nodeId.unidentified("10.0.0.9", 8080);
    const base = buildGraph(model(), none).nodes;
    expect(at(buildGraph(model(), none, { moved: new Map([[id, { x: 1, y: 2 }]]) }).nodes, id)).toEqual({ x: 1, y: 2 });
    expect(at(buildGraph(model(), none, { moved: new Map([["src:1", { x: 1, y: 2 }]]) }).nodes, id)).toEqual(at(base, id));
  });
});

describe("descendantNodeIds", () => {
  const m = model();

  it.each([
    ["a source: its groups, the Ungrouped bag and every point, open or not", "src:1", [
      "cluster:1:LVP01", "cluster:1:LVP02", "cluster:1:__ungrouped__", "point:1", "point:2", "point:3", "point:4", "point:5", "point:6", "point:7"]],
    ["a source without ungrouped points has no Ungrouped group", "src:2", ["cluster:2:M", "point:8", "point:9"]],
    ["a group: its points", "cluster:1:LVP01", ["point:1", "point:2", "point:3"]],
    ["the Ungrouped group: the ungrouped points", "cluster:1:__ungrouped__", ["point:7"]],
    ["a point has none", "point:1", []],
    ["an unidentified service has none", "unid:10.0.0.9:8080", []],
    ["an asset: its sub-assets", "asset:10", ["asset:11"]],
    ["an asset without children", "asset:11", []],
    ["a source that is not in the model", "src:99", []],
    ["a group that is not in the model", "cluster:1:NOPE", []],
    ["a group of a source that is not in the model", "cluster:9:LVP01", []],
    ["an asset that is not in the model", "asset:99", []],
    ["something that is no node id", "garbage", []],
    ["the empty string", "", []],
  ])("%s", (_name, id, expected) => {
    expect([...descendantNodeIds(m, id)].sort()).toEqual([...expected].sort());
  });

  it("a group key with colons in it is found by its source id, then the rest of the id", () => {
    const colon = model({ sources: [source(1, { clusters: [{ key: "a:b:c", points: [point(1, "p")] }] })] });
    expect(descendantNodeIds(colon, "cluster:1:a:b:c")).toEqual(["point:1"]);
    expect(descendantNodeIds(colon, "src:1")).toEqual(["cluster:1:a:b:c", "point:1"]);
  });

  it("a source with no ungrouped points lists no Ungrouped id, and an empty source lists nothing", () => {
    expect(descendantNodeIds(m, "src:2")).not.toContain("cluster:2:__ungrouped__");
    expect(descendantNodeIds(model({ sources: [source(1)] }), "src:1")).toEqual([]);
  });

  it("an asset lists sub-assets at every depth, in the model's order, never itself", () => {
    const deep = model({ assets: [
      { id: 10, parent_id: null, name: "Site", kind: "generic" }, { id: 11, parent_id: 10, name: "A", kind: "generic" },
      { id: 12, parent_id: 11, name: "B", kind: "generic" }, { id: 13, parent_id: 10, name: "C", kind: "generic" },
      { id: 14, parent_id: null, name: "Other", kind: "generic" }] });
    expect([...descendantNodeIds(deep, "asset:10")].sort()).toEqual(["asset:11", "asset:12", "asset:13"]);
    expect(descendantNodeIds(deep, "asset:11")).toEqual(["asset:12"]);
    expect(descendantNodeIds(deep, "asset:14")).toEqual([]);
  });

  it("is cycle safe: a self-parent has none, a two-asset cycle lists the other one once and never itself", () => {
    const loop = model({ assets: [{ id: 12, parent_id: 12, name: "Loop", kind: "generic" }] });
    expect(descendantNodeIds(loop, "asset:12")).toEqual([]);
    const cycle = model({ assets: [{ id: 10, parent_id: 11, name: "A", kind: "generic" }, { id: 11, parent_id: 10, name: "B", kind: "generic" }] });
    expect(descendantNodeIds(cycle, "asset:10")).toEqual(["asset:11"]);
    expect(descendantNodeIds(cycle, "asset:11")).toEqual(["asset:10"]);
    const three = model({ assets: [
      { id: 1, parent_id: 3, name: "A", kind: "generic" }, { id: 2, parent_id: 1, name: "B", kind: "generic" }, { id: 3, parent_id: 2, name: "C", kind: "generic" }] });
    expect([...descendantNodeIds(three, "asset:1")].sort()).toEqual(["asset:2", "asset:3"]);
  });

  it("does not depend on what is open: hidden children are listed, which is the point", () => {
    const hidden = descendantNodeIds(m, "src:1");
    const shown = buildGraph(m, { sources: new Set([1]), clusters: new Set() }).nodes.map((n) => n.id);
    expect(hidden.filter((id) => !shown.includes(id)).length).toBeGreaterThan(0); // the points of the closed groups
  });
});

describe("ownPlaces and shiftedPlaces", () => {
  const m = model({ layout: { "src:1": { x: 1, y: 1 }, "point:1": { x: 2, y: 2 }, "cluster:1:LVP02": { x: 400, y: 500 } } });

  it("ownPlaces: the saved layout, this session's places over it, a copy that the caller may keep", () => {
    const moved = new Map([["src:1", { x: 9, y: 9 }], ["point:5", { x: 5, y: 5 }]]);
    const all = ownPlaces(m, { moved });
    expect(Object.fromEntries(all)).toEqual({ "src:1": { x: 9, y: 9 }, "point:1": { x: 2, y: 2 }, "cluster:1:LVP02": { x: 400, y: 500 }, "point:5": { x: 5, y: 5 } });
    all.set("src:1", { x: 0, y: 0 });
    expect(moved.get("src:1")).toEqual({ x: 9, y: 9 });
  });

  it("ownPlaces with ignoreSaved holds this session's places only", () => {
    const moved = new Map([["src:1", { x: 9, y: 9 }]]);
    expect(Object.fromEntries(ownPlaces(m, { moved, ignoreSaved: true }))).toEqual({ "src:1": { x: 9, y: 9 } });
    expect(ownPlaces(m, { ignoreSaved: true }).size).toBe(0);
    expect(ownPlaces(m).size).toBe(3);
  });

  it("shiftedPlaces: own + delta for every id that has an own place in the snapshot, nothing invented for the others", () => {
    const snapshot = new Map<string, XY>([["a", { x: 1, y: 2 }], ["b", { x: 3, y: 4 }]]);
    const shifted = shiftedPlaces(snapshot, ["a", "b", "c"], { x: 10, y: -20 });
    expect(Object.fromEntries(shifted)).toEqual({ a: { x: 11, y: -18 }, b: { x: 13, y: -16 } });
    expect(snapshot.get("a")).toEqual({ x: 1, y: 2 }); // the snapshot is never touched
    expect(shiftedPlaces(snapshot, [], { x: 1, y: 1 }).size).toBe(0);
    expect(shiftedPlaces(new Map(), ["a"], { x: 1, y: 1 }).size).toBe(0);
  });

  it("an id listed twice is shifted once", () => {
    const snapshot = new Map<string, XY>([["a", { x: 1, y: 2 }]]);
    expect(shiftedPlaces(snapshot, ["a", "a"], { x: 10, y: 10 }).get("a")).toEqual({ x: 11, y: 12 });
  });

  /** What the page does at drag start: the followers are the union of the dragged nodes' descendants, minus the dragged nodes. */
  const followers = (dragged: string[]) => {
    const all = new Set(dragged.flatMap((id) => descendantNodeIds(m, id)));
    for (const id of dragged) all.delete(id);
    return all;
  };

  it("a source dragged together with its own group shifts the group's points once, and the group itself not at all (it is dragged)", () => {
    const snapshot = ownPlaces(m);
    const shifted = shiftedPlaces(snapshot, followers(["src:1", "cluster:1:LVP01"]), { x: 10, y: 20 });
    expect(shifted.get("point:1")).toEqual({ x: 12, y: 22 }); // saved + delta, once (it is under both dragged nodes)
    expect(shifted.has("cluster:1:LVP01")).toBe(false);
    expect(shifted.has("src:1")).toBe(false);
    expect(shifted.get("cluster:1:LVP02")).toEqual({ x: 410, y: 520 }); // a hidden group of the source with a saved place
    expect(shifted.has("point:2")).toBe(false); // no place of its own: it follows by the rule
  });

  it("the same drag when the group has a place of its own and when it has none comes out the same for the points", () => {
    const withPlace = model({ layout: { "cluster:1:LVP01": { x: 400, y: 150 }, "point:1": { x: 2, y: 2 } } });
    const dragged = ["src:1", "cluster:1:LVP01"];
    const all = new Set(dragged.flatMap((id) => descendantNodeIds(withPlace, id)));
    for (const id of dragged) all.delete(id);
    expect(shiftedPlaces(ownPlaces(withPlace), all, { x: 10, y: 20 }).get("point:1")).toEqual({ x: 12, y: 22 });
    expect(shiftedPlaces(ownPlaces(m), followers(dragged), { x: 10, y: 20 }).get("point:1")).toEqual({ x: 12, y: 22 });
  });

  it("two drags in a row with no re-read: a hidden group stands at saved + d1 + d2, and opens there", () => {
    const fresh = model({ layout: { "point:1": { x: 2, y: 2 }, "cluster:1:LVP02": { x: 400, y: 500 } } }); // src:1 stands at its default (0,0)
    const kids = descendantNodeIds(fresh, "src:1");
    const d1 = { x: 10, y: 20 };
    const d2 = { x: 3, y: 4 };
    const moved = new Map<string, XY>();
    // drag 1: the dragged node goes to (10,20), every hidden place with it
    for (const [id, p] of shiftedPlaces(ownPlaces(fresh, { moved }), kids, d1)) moved.set(id, p);
    moved.set("src:1", { x: d1.x, y: d1.y });
    expect(moved.get("cluster:1:LVP02")).toEqual({ x: 410, y: 520 });
    // drag 2, the graph was not read again: the snapshot sees the session places over the saved ones
    for (const [id, p] of shiftedPlaces(ownPlaces(fresh, { moved }), kids, d2)) moved.set(id, p);
    moved.set("src:1", { x: d1.x + d2.x, y: d1.y + d2.y });
    expect(moved.get("cluster:1:LVP02")).toEqual({ x: 413, y: 524 });
    expect(moved.get("point:1")).toEqual({ x: 15, y: 26 });
    const { nodes } = buildGraph(fresh, { sources: new Set([1]), clusters: new Set() }, { moved });
    expect(at(nodes, "cluster:1:LVP02")).toEqual({ x: 413, y: 524 }); // re-opened where the drags left it
    expect(at(nodes, "cluster:1:LVP01")).toEqual({ x: 373, y: 160 }); // no place of its own: its default 360,136 plus the source's 13,24
  });
});

describe("layoutBatches", () => {
  const entry = (i: number): [string, XY] => [`point:${i}`, { x: i, y: -i }];
  const many = (n: number) => Array.from({ length: n }, (_, i) => entry(i + 1));

  it("one request body per batch, in the shape the route takes", () => {
    expect(layoutBatches([["src:1", { x: 1, y: 2 }], ["src:2", { x: 3, y: 4 }]])).toEqual([
      [{ node_id: "src:1", x: 1, y: 2 }, { node_id: "src:2", x: 3, y: 4 }]]);
  });

  it.each([
    [0, []], [1, [1]], [1999, [1999]], [2000, [2000]], [2001, [2000, 1]], [4000, [2000, 2000]], [4001, [2000, 2000, 1]],
  ])("%i entries make batches of %j", (n, sizes) => {
    expect(layoutBatches(many(n)).map((b) => b.length)).toEqual(sizes);
  });

  it("keeps the order and loses none across the batches", () => {
    const batches = layoutBatches(many(2001));
    expect(batches.flat().map((e) => e.node_id)).toEqual(many(2001).map(([id]) => id));
  });

  it("takes a Map as well as a list of pairs, and a smaller batch size", () => {
    expect(layoutBatches(new Map(many(5))).map((b) => b.length)).toEqual([5]);
    expect(layoutBatches(many(5), 2).map((b) => b.length)).toEqual([2, 2, 1]);
    expect(layoutBatches(many(3), 0).map((b) => b.length)).toEqual([1, 1, 1]); // a size under one still ends
  });

  it("skips an id over 512 characters (the server would refuse the whole request) and does not count it", () => {
    const longest = `cluster:1:${"k".repeat(MAX_LAYOUT_ID - 10)}`;
    const tooLong = `cluster:1:${"k".repeat(MAX_LAYOUT_ID - 9)}`;
    expect(longest).toHaveLength(MAX_LAYOUT_ID);
    expect(tooLong).toHaveLength(MAX_LAYOUT_ID + 1);
    const batches = layoutBatches([[longest, { x: 1, y: 1 }], [tooLong, { x: 2, y: 2 }], ["src:1", { x: 3, y: 3 }]]);
    expect(batches.flat().map((e) => e.node_id)).toEqual([longest, "src:1"]);
    expect(layoutBatches([[tooLong, { x: 2, y: 2 }]])).toEqual([]);
    expect(layoutBatches([...many(2000), [tooLong, { x: 2, y: 2 }]]).map((b) => b.length)).toEqual([2000]);
  });
});

describe("childNodeIds (one level, what an Alt-drag pins)", () => {
  const m = model({ assets: [
    { id: 10, parent_id: null, name: "Site", kind: "generic" }, { id: 11, parent_id: 10, name: "Panel 1", kind: "generic" },
    { id: 12, parent_id: 11, name: "Breaker", kind: "generic" }, { id: 13, parent_id: 13, name: "Self", kind: "generic" },
  ] });

  it.each([
    ["a source: its groups and the Ungrouped bag, not their points", "src:1", ["cluster:1:LVP01", "cluster:1:LVP02", "cluster:1:__ungrouped__"]],
    ["a group: its points", "cluster:1:LVP01", ["point:1", "point:2", "point:3"]],
    ["an asset: its sub-assets, not theirs", "asset:10", ["asset:11"]],
    ["an asset one level down", "asset:11", ["asset:12"]],
    ["a leaf asset", "asset:12", []],
    ["a self-parent asset is not its own child", "asset:13", []],
    ["a point", "point:1", []],
    ["something the model does not hold", "asset:99", []],
    ["something that is no node id", "garbage", []],
  ])("%s", (_name, id, expected) => {
    expect([...childNodeIds(m, id)].sort()).toEqual([...expected].sort());
  });
});

describe("initialView (where the canvas opens)", () => {
  const sources = (n: number) => model({ sources: Array.from({ length: n }, (_, i) => source(i + 1)) });

  it.each([
    [1, ["src:1"]],
    [2, ["src:1", "src:2"]],
    [3, ["src:1", "src:2", "src:3"]],
    [4, ["src:1", "src:2", "src:3"]],
    [12, ["src:1", "src:2", "src:3"]],
  ])("with %i source(s) it frames %j, in the order of the list", (count, framed) => {
    expect(initialView(sources(count))?.nodes).toEqual(framed.map((id) => ({ id })));
  });

  it("holds the zoom between 0.75 and 1 with room around the nodes, so the text stays readable", () => {
    expect(initialView(sources(2))).toMatchObject({ minZoom: 0.75, maxZoom: 1, padding: 0.2 });
  });

  it("uses the ids of the source nodes the graph builds, and names no other node", () => {
    const m = model();
    const built = buildGraph(m, none).nodes.map((n) => n.id);
    for (const { id } of initialView(m)!.nodes!) expect(built).toContain(id);
    expect(initialView(m)!.nodes).toEqual([{ id: "src:1" }, { id: "src:2" }]);
  });

  it("frames only the sources that still lie close together when the shared layout moved some far away (the view must not open on empty space)", () => {
    const apart = model({ sources: [source(12), source(2), source(5)], layout: { "src:12": { x: 0, y: 0 }, "src:2": { x: 3000, y: 2500 } } });
    expect(initialView(apart)?.nodes).toEqual([{ id: "src:12" }]);
    const second = model({ sources: [source(1), source(2), source(3)], layout: { "src:1": { x: 100, y: 100 }, "src:2": { x: 300, y: 400 }, "src:3": { x: 5000, y: 100 } } });
    expect(initialView(second)?.nodes).toEqual([{ id: "src:1" }, { id: "src:2" }]);
  });

  it("frames all three when the saved positions are near each other, wherever on the canvas they are", () => {
    const near = model({ sources: [source(1), source(2), source(3)], layout: { "src:1": { x: -2000, y: 900 }, "src:2": { x: -1900, y: 1000 }, "src:3": { x: -1800, y: 1100 } } });
    expect(initialView(near)?.nodes).toEqual([{ id: "src:1" }, { id: "src:2" }, { id: "src:3" }]);
  });

  it("a source with no saved position counts where the graph puts a collapsed one, and a missing layout entry is not read from the prototype", () => {
    const mixed = model({ sources: [source(1), source(2)], layout: { "src:1": { x: 0, y: 0 }, constructor: { x: 9999, y: 9999 } } });
    expect(initialView(mixed)?.nodes).toEqual([{ id: "src:1" }, { id: "src:2" }]);
  });

  it("frames a second source only while it fits the box that the bar above the canvas left (501 graph pixels tall, was 560)", () => {
    const at = (y: number) => model({ sources: [source(1), source(2)], layout: { "src:1": { x: 0, y: 0 }, "src:2": { x: 0, y } } });
    const room = 501 - SOURCE_H; // the second source's top may lie this far below the first one's
    expect(initialView(at(room))?.nodes).toEqual([{ id: "src:1" }, { id: "src:2" }]);
    expect(initialView(at(room + 1))?.nodes).toEqual([{ id: "src:1" }]);
  });

  it("is undefined with no source at all, so the graph is fitted whole as before", () => {
    expect(initialView(sources(0))).toBeUndefined();
    expect(initialView(model({ sources: [], assets: [] }))).toBeUndefined();
  });
});

describe("isRemovable", () => {
  const mapped = point(9, "M kW", { asset_id: 10, mapping_id: 3, mapped_metric: "active_power_kw" });

  it("a discovered source with nothing mapped can be removed, with or without points", () => {
    expect(isRemovable(source(1, { clusters: [{ key: "A", points: [point(1, "a")] }], ungrouped: [point(2, "b")] }))).toBe(true);
    expect(isRemovable(source(1))).toBe(true);
  });

  it("a mapped point anywhere, in a group or in the Ungrouped bag, keeps the source", () => {
    expect(isRemovable(source(1, { clusters: [{ key: "A", points: [point(1, "a"), mapped] }] }))).toBe(false);
    expect(isRemovable(source(1, { ungrouped: [mapped] }))).toBe(false);
    expect(isRemovable(source(1, { ungrouped: [point(2, "b", { asset_id: 10 })] }))).toBe(false); // an asset without a mapping id is still a mapping
  });

  it("a source added by hand is never offered for removal", () => {
    expect(isRemovable(source(1, { origin: "manual" }))).toBe(false);
  });
});

describe("seenLine", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const found = (at: string, scan_id = 6) => source(1, { last_scan: { scan_id, at } });

  it("says which scan found a discovered source, and how long ago", () => {
    expect(seenLine(found("2026-10-15T11:50:00Z"), now, "UTC")).toBe("Seen in scan #6, 10 min ago");
    expect(seenLine(found("2026-10-14T09:00:00Z", 3), now, "UTC")).toBe("Seen in scan #3, yesterday");
  });

  it("drops the ago part for a time over two weeks old, or one that cannot be read", () => {
    expect(seenLine(found("2026-09-01T09:00:00Z"), now, "UTC")).toBe("Seen in scan #6");
    expect(seenLine(found("not a time"), now, "UTC")).toBe("Seen in scan #6");
  });

  it("a source added by hand says so, whatever its findings", () => {
    expect(seenLine(source(1, { origin: "manual" }), now, "UTC")).toBe("Added by hand");
    expect(seenLine(source(1, { origin: "manual", last_scan: { scan_id: 6, at: "2026-10-15T11:50:00Z" } }), now, "UTC")).toBe("Added by hand");
  });

  it("a discovered source no scan has found yet says so (null, or a server that does not send the field)", () => {
    expect(seenLine(source(1, { last_scan: null }), now, "UTC")).toBe("Not seen in a scan yet");
    expect(seenLine(source(1), now, "UTC")).toBe("Not seen in a scan yet");
  });
});

describe("removalOutcome", () => {
  const result = (removed: number[], skipped: RemoveSourcesResult["skipped"] = []): RemoveSourcesResult => ({
    removed: removed.map((id) => ({ id, name: `s${id}` })), skipped,
  });
  const kept = (id: number, reason: RemoveSourcesResult["skipped"][number]["reason"]) => ({ id, name: reason === "gone" ? null : `s${id}`, reason });

  it("everything removed is a plain success, singular or plural", () => {
    expect(removalOutcome(result([1]))).toEqual({ kind: "done", text: "Removed 1 source" });
    expect(removalOutcome(result([1, 2, 3]))).toEqual({ kind: "done", text: "Removed 3 sources" });
  });

  it("some removed and one kept says why in words", () => {
    expect(removalOutcome(result([1, 2], [kept(3, "mapped")]))).toEqual({ kind: "partial", text: "Removed 2 sources. 1 was kept: it has a mapped point now." });
    expect(removalOutcome(result([1], [kept(3, "manual")]))).toEqual({ kind: "partial", text: "Removed 1 source. 1 was kept: it was added by hand." });
  });

  it("several kept are counted by reason", () => {
    expect(removalOutcome(result([1], [kept(2, "mapped"), kept(3, "mapped"), kept(4, "manual")])).text)
      .toBe("Removed 1 source. 3 were kept: 2 have a mapped point now, 1 was added by hand.");
    expect(removalOutcome(result([1], [kept(2, "mapped"), kept(3, "mapped")])).text).toBe("Removed 1 source. 2 were kept: 2 have a mapped point now.");
  });

  it("a source that was already gone is not a kept one", () => {
    expect(removalOutcome(result([1], [kept(2, "gone")]))).toEqual({ kind: "partial", text: "Removed 1 source. 1 was already gone." });
    expect(removalOutcome(result([1], [kept(2, "gone"), kept(3, "gone")])).text).toBe("Removed 1 source. 2 were already gone.");
  });

  it("nothing removed because something was kept is a refusal (the dialog stays open)", () => {
    expect(removalOutcome(result([], [kept(3, "mapped")]))).toEqual({ kind: "none", text: "Nothing was removed. 1 was kept: it has a mapped point now." });
    expect(removalOutcome(result([], [kept(3, "mapped"), kept(4, "gone")])).text).toBe("Nothing was removed. 1 was kept: it has a mapped point now. 1 was already gone.");
  });

  it("nothing removed because every one was already gone is not a refusal (nothing is left to do)", () => {
    expect(removalOutcome(result([], [kept(3, "gone")]))).toEqual({ kind: "gone", text: "Nothing was removed. 1 was already gone." });
  });
});

describe("removalDialogText", () => {
  it("one source: its name in the title, and what it means for assets, billing and dashboards", () => {
    expect(removalDialogText(["Plant OPC"])).toEqual({
      title: 'Remove "Plant OPC" from Discovery?',
      message: "It has nothing mapped, so no asset, billing figure or dashboard depends on it. A scan can find it again.",
    });
  });

  it.each([
    [["A", "B"], "A and B."],
    [["A", "B", "C"], "A, B and C."],
    [["A", "B", "C", "D", "E"], "A, B, C, D and E."],
    [["A", "B", "C", "D", "E", "F"], "A, B, C, D, E and 1 more."],
    [["A", "B", "C", "D", "E", "F", "G", "H"], "A, B, C, D, E and 3 more."],
  ])("several (%j): the first five names, then a count, then the promise", (names, list) => {
    const { title, message } = removalDialogText(names);
    expect(title).toBe(`Remove ${names.length} unmapped sources?`);
    expect(message).toBe(`${list} Sources with a mapped point are never touched. A scan can find these again.`);
  });
});
