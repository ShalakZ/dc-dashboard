import type { Edge, Node } from "@xyflow/react";
import type { GraphModel, RemoveSourcesResult } from "../api/types";
import {
  BLOCK_GAP, DIFFERENT_SERVER, FAN_DASH_LIMIT, LIVE_EDGE_LIMIT, MAPPED_NOT_SEEN, MAX_LAYOUT_ID, NO_VIEW, PAGE_SIZE, SOURCE_H, UNGROUPED, buildGraph, certificateLine, childNodeIds, descendantNodeIds,
  initialView, isDifferentServer, isMappedNotSeen, isNotSeen, isRemovable, layoutBatches, looksLikeLine, looksLikeSentence, moreNodeIds, moveOfferFor, nodeId, notSeenCount, notSeenSentence, ownPlaces,
  removableNotSeen, removalDialogText, removalOutcome, seenCard, seenLine,
  serverLine, shiftedPlaces, sourceIdOfNode, sourceVisible, twoServers, type GraphView, type OpenState, type XY,
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

  it("no edge names a handle: every one starts at the node's default source handle, so the \"+\" of an asset node (handle id add, drawn after the defaults) never takes an edge (W12a)", () => {
    const { edges } = buildGraph(model(), { sources: new Set([1, 2]), clusters: new Set([nodeId.cluster(1, "LVP01"), nodeId.cluster(2, "M")]) });
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.sourceHandle ?? null, `source handle of ${e.id}`).toBeNull();
      expect(e.targetHandle ?? null, `target handle of ${e.id}`).toBeNull();
    }
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

describe("buildGraph: live edges (W7u)", () => {
  const live = (id: number, over: object = {}) => source(id, { enabled: true, status: "online", ...over });
  const mapped = (id: number, name: string) => point(id, name, { asset_id: 10, mapping_id: id, mapped_metric: "voltage_v" });
  const edgeOf = (edges: Edge[], id: string) => edges.find((e) => e.id === id)!;
  const A = nodeId.cluster(1, "A");
  const everything = (m: ReturnType<typeof model>): OpenState => ({
    sources: new Set(m.sources.map((s) => s.id)),
    clusters: new Set(m.sources.flatMap((s) => s.clusters.map((c) => nodeId.cluster(s.id, c.key)))),
  });
  // Source 1 is live, 2 is offline, 3 is online but disabled; all three map a point to asset 10, which has the sub-asset 11.
  const three = () => model({ sources: [
    live(1, { clusters: [{ key: "A", points: [mapped(1, "p1"), point(2, "p2")] }] }),
    source(2, { enabled: true, status: "offline", clusters: [{ key: "B", points: [mapped(3, "p3")] }] }),
    source(3, { enabled: false, status: "online", clusters: [{ key: "C", points: [mapped(4, "p4")] }] }),
  ] });

  it("without the option nothing is animated, a live source included (old calls are unchanged)", () => {
    const m = three();
    const open = everything(m);
    expect(buildGraph(m, open).edges.some((e) => e.animated !== undefined)).toBe(false);
    expect(buildGraph(m, open, { animate: false })).toEqual(buildGraph(m, open));
  });

  it("a live source: its source to group edges flow and keep the 6 4 dashes (period 10, the library's loop is seamless)", () => {
    const m = three();
    const { edges } = buildGraph(m, everything(m), { animate: true });
    expect(edgeOf(edges, "e:src:1>cluster:1:A")).toMatchObject({ animated: true, style: { strokeDasharray: "6 4" } });
  });

  it("a live source: its group to point edges do not flow (hundreds of them, little alive signal) and stay dashed", () => {
    const m = three();
    const { edges } = buildGraph(m, everything(m), { animate: true });
    for (const id of ["e:cluster:1:A>point:1", "e:cluster:1:A>point:2"]) {
      expect(edgeOf(edges, id).animated, id).toBeUndefined();
      expect(edgeOf(edges, id).style, id).toEqual({ strokeDasharray: "6 4" });
    }
  });

  it("a live source: the solid links from its nodes to assets flow with 8 2 dashes, whatever node they leave from", () => {
    const m = three();
    const open = everything(m);
    // from a point (everything open), from a collapsed group, from a collapsed source
    expect(edgeOf(buildGraph(m, open, { animate: true }).edges, "m:point:1>asset:10")).toMatchObject({ animated: true, style: { strokeDasharray: "8 2" } });
    const group = buildGraph(m, { sources: open.sources, clusters: new Set() }, { animate: true }).edges;
    expect(edgeOf(group, `m:${A}>asset:10`)).toMatchObject({ animated: true, style: { strokeDasharray: "8 2" } });
    const collapsed = buildGraph(m, { sources: new Set(), clusters: new Set() }, { animate: true }).edges;
    expect(edgeOf(collapsed, "m:src:1>asset:10")).toMatchObject({ animated: true, style: { strokeDasharray: "8 2" } });
  });

  it("the count label of a collapsed live source's link stays", () => {
    const m = model({ sources: [live(1, { clusters: [{ key: "A", points: [mapped(1, "p1"), mapped(2, "p2")] }] })] });
    const edge = edgeOf(buildGraph(m, { sources: new Set(), clusters: new Set() }, { animate: true }).edges, "m:src:1>asset:10");
    expect(edge).toMatchObject({ animated: true, label: "2 mapped" });
  });

  it("an offline source and a disabled one keep every edge as it was, and so does a live source's neighbour onto the same asset", () => {
    const m = three();
    const open = everything(m);
    const plain = buildGraph(m, open).edges;
    const animated = buildGraph(m, open, { animate: true }).edges;
    for (const id of ["e:src:2>cluster:2:B", "e:cluster:2:B>point:3", "m:point:3>asset:10", "e:src:3>cluster:3:C", "e:cluster:3:C>point:4", "m:point:4>asset:10"]) {
      expect(edgeOf(animated, id), id).toEqual(edgeOf(plain, id));
      expect(edgeOf(animated, id).animated, id).toBeUndefined();
    }
    // the live source's link into the same asset flows all the same
    expect(edgeOf(animated, "m:point:1>asset:10").animated).toBe(true);
  });

  it("asset to sub-asset edges never flow, and stay solid", () => {
    const m = three();
    const edge = edgeOf(buildGraph(m, everything(m), { animate: true }).edges, "a:10>11");
    expect(edge.animated).toBeUndefined();
    expect(edge.style).toBeUndefined();
  });

  it("a live source with no point mapped has only its source to group edges flowing", () => {
    const m = model({ assets: [{ id: 10, parent_id: null, name: "Site", kind: "generic" }], sources: [live(1, { clusters: [{ key: "A", points: [point(1, "p1")] }] })] });
    const { edges } = buildGraph(m, everything(m), { animate: true });
    expect(edges.map((e) => e.id).sort()).toEqual(["e:cluster:1:A>point:1", "e:src:1>cluster:1:A"]);
    expect(edges.filter((e) => e.animated === true).map((e) => e.id)).toEqual(["e:src:1>cluster:1:A"]);
  });

  describe("the limit (LIVE_EDGE_LIMIT, counted over the animated edges)", () => {
    // One live source with `groups` groups of one point each; the first `mappedN` points are mapped to asset 10. Everything open, so the animated
    // edges are the `groups` source to group edges plus the `mappedN` links (the group to point edges never flow).
    const wide = (groups: number, mappedN: number) => model({ sources: [live(1, { clusters: Array.from({ length: groups }, (_, i) => ({ key: `G${i}`, points: [i < mappedN ? mapped(i + 1, `p${i}`) : point(i + 1, `p${i}`)] })) })] });
    // One live source with one open group of `n` points, none mapped.
    const tall = (n: number) => model({ sources: [live(1, { clusters: [{ key: "A", points: Array.from({ length: n }, (_, i) => point(i + 1, `p${i}`)) }] })] });
    const animatedCount = (m: ReturnType<typeof model>) => buildGraph(m, everything(m), { animate: true }).edges.filter((e) => e.animated).length;

    it("is 100", () => {
      expect(LIVE_EDGE_LIMIT).toBe(100);
    });

    it("exactly 100 animated edges all flow", () => {
      expect(animatedCount(wide(LIVE_EDGE_LIMIT, 0))).toBe(LIVE_EDGE_LIMIT);
    });

    it("one more and none flows: the edges go back to what they were without the option, solid links included", () => {
      const m = wide(LIVE_EDGE_LIMIT - 1, 2); // 99 + 2 = 101
      const { edges } = buildGraph(m, everything(m), { animate: true });
      expect(edges.filter((e) => e.animated)).toHaveLength(0);
      expect(edges).toEqual(buildGraph(m, everything(m)).edges);
      const link = edgeOf(edges, "m:point:1>asset:10");
      expect(link.style).toBeUndefined(); // no 8 2 dashes left on a link that no longer flows
      expect(edgeOf(edges, "e:src:1>cluster:1:G0")).toMatchObject({ style: { strokeDasharray: "6 4" } });
    });

    it("the limit counts mapped links too, not just the dashed ones", () => {
      expect(animatedCount(wide(LIVE_EDGE_LIMIT - 10, 0))).toBe(LIVE_EDGE_LIMIT - 10);
      expect(animatedCount(wide(LIVE_EDGE_LIMIT - 10, 10))).toBe(LIVE_EDGE_LIMIT); // 90 + 10, exactly the limit
      expect(animatedCount(wide(LIVE_EDGE_LIMIT - 10, 11))).toBe(0); // 90 + 11 = 101
    });

    it("the points of one open group do not count: hundreds of group to point edges never flow, so only the source to group edge does", () => {
      const m = tall(LIVE_EDGE_LIMIT * 3);
      const { edges } = buildGraph(m, everything(m), { animate: true });
      expect(edges.filter((e) => e.animated).map((e) => e.id)).toEqual(["e:src:1>cluster:1:A"]);
      expect(edges.filter((e) => e.id.startsWith("e:cluster:")).every((e) => e.animated === undefined)).toBe(true);
    });

    it("an offline source's edges are not counted (only animated edges are)", () => {
      const m = model({ sources: [live(1, { clusters: [{ key: "A", points: [point(1, "p1")] }] }), source(2, { enabled: true, status: "offline", clusters: Array.from({ length: 400 }, (_, i) => ({ key: `Q${i}`, points: [point(i + 10, `q${i}`)] })) })] });
      const { edges } = buildGraph(m, everything(m), { animate: true });
      expect(edges.filter((e) => e.animated).map((e) => e.id)).toEqual(["e:src:1>cluster:1:A"]);
    });

    it("never changes the shared dashed style for the edges that stay dashed", () => {
      const m = wide(LIVE_EDGE_LIMIT - 1, 2);
      buildGraph(m, everything(m), { animate: true });
      expect(buildGraph(three(), everything(three())).edges.find((e) => e.id.startsWith("e:"))!.style).toEqual({ strokeDasharray: "6 4" });
    });
  });
});

describe("buildGraph: the default places lie on the 8 px grid (W7u)", () => {
  // Sources of every shape (collapsed, open, open groups, an Ungrouped bag), unidentified services and assets four levels deep with siblings.
  const deep = () => model({
    sources: [model().sources[0], model().sources[1], source(3, { clusters: [{ key: "Z", points: [point(20, "z")] }] })],
    unidentified: [{ host: "10.0.0.9", port: 8080, scan_id: 4 }, { host: "10.0.0.10", port: 502, scan_id: 4 }],
    assets: [
      { id: 10, parent_id: null, name: "Site", kind: "generic" }, { id: 11, parent_id: 10, name: "Hall", kind: "generic" },
      { id: 12, parent_id: 11, name: "Row", kind: "generic" }, { id: 13, parent_id: 12, name: "Rack", kind: "generic" },
      { id: 14, parent_id: 13, name: "PDU", kind: "generic" }, { id: 15, parent_id: 10, name: "Hall 2", kind: "generic" },
      { id: 16, parent_id: null, name: "Other site", kind: "generic" },
    ],
  });
  const opens: [string, OpenState][] = [
    ["all collapsed", none],
    ["a source open", { sources: new Set([1]), clusters: new Set() }],
    ["everything open", { sources: new Set([1, 2, 3]), clusters: new Set([nodeId.cluster(1, "LVP01"), nodeId.cluster(1, "LVP02"), nodeId.cluster(1, UNGROUPED), nodeId.cluster(2, "M"), nodeId.cluster(3, "Z")]) }],
  ];

  it.each(opens)("%s: every node's x and y is a multiple of 8", (_name, open) => {
    const { nodes } = buildGraph(deep(), open);
    expect(nodes.length).toBeGreaterThan(8);
    for (const n of nodes) {
      expect(n.position.x % 8, `${n.id} x ${n.position.x}`).toBe(0);
      expect(n.position.y % 8, `${n.id} y ${n.position.y}`).toBe(0);
    }
  });

  it("the sizes it is made of are multiples of 8 too, so a block of any height keeps the next block on the grid", () => {
    expect(SOURCE_H % 8).toBe(0);
    expect(BLOCK_GAP % 8).toBe(0);
  });

  it("a sub-asset stands 224 px (28 cells) right of its parent, one level at a time", () => {
    const { nodes } = buildGraph(deep(), none);
    const x = (id: string) => nodes.find((n) => n.id === id)!.position.x;
    expect(x("asset:11") - x("asset:10")).toBe(224);
    expect(x("asset:12") - x("asset:11")).toBe(224);
    expect(x("asset:14") - x("asset:10")).toBe(4 * 224);
    expect(x("asset:10")).toBe(1200);
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

// (w33) Not seen: a discovered source the newest done scan of the SAME range did not find (the server decides; the page only words it and offers to remove the unmapped ones).
describe("seenLine of a source that is not seen (w33)", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const gone = (over: object = {}) => source(1, {
    last_scan: { scan_id: 5, at: "2026-10-11T09:00:00Z" },
    not_seen: { scan_id: 7, at: "2026-10-15T11:00:00Z", last_seen_scan_id: 5, last_seen_at: "2026-10-11T09:00:00Z" },
    ...over,
  });

  it("names the scan that did not find it, the one that last did, and how long ago that was (counted from the last time it was seen)", () => {
    expect(seenLine(gone(), now, "UTC")).toBe("Not seen in scan #7 (last seen in #5, 4 days ago)");
    expect(seenLine(gone({ not_seen: { scan_id: 7, at: "2026-10-15T11:00:00Z", last_seen_scan_id: 6, last_seen_at: "2026-10-14T09:00:00Z" } }), now, "UTC"))
      .toBe("Not seen in scan #7 (last seen in #6, yesterday)");
    expect(seenLine(gone({ not_seen: { scan_id: 8, at: "2026-10-15T11:00:00Z", last_seen_scan_id: 7, last_seen_at: "2026-10-15T11:50:00Z" } }), now, "UTC"))
      .toBe("Not seen in scan #8 (last seen in #7, 10 min ago)");
  });

  it("drops the ago part for a time over two weeks old or one that cannot be read, as the Seen line does", () => {
    expect(seenLine(gone({ not_seen: { scan_id: 7, at: "x", last_seen_scan_id: 5, last_seen_at: "2026-09-01T09:00:00Z" } }), now, "UTC")).toBe("Not seen in scan #7 (last seen in #5)");
    expect(seenLine(gone({ not_seen: { scan_id: 7, at: "x", last_seen_scan_id: 5, last_seen_at: "not a time" } }), now, "UTC")).toBe("Not seen in scan #7 (last seen in #5)");
  });

  it("comes before the Seen line, and a source added by hand still says Added by hand (the server never marks one)", () => {
    expect(seenLine(gone(), now, "UTC")).not.toMatch(/^Seen/);
    expect(seenLine(gone({ origin: "manual" }), now, "UTC")).toBe("Added by hand");
  });

  it("a null not_seen (the server's answer for a source it did see, or an older server) keeps every old sentence", () => {
    expect(seenLine(gone({ not_seen: null }), now, "UTC")).toBe("Seen in scan #5, 4 days ago");
    expect(seenLine(source(1, { last_scan: { scan_id: 6, at: "2026-10-15T11:50:00Z" } }), now, "UTC")).toBe("Seen in scan #6, 10 min ago");
  });
});

describe("not seen: isNotSeen, removableNotSeen, notSeenCount (w33)", () => {
  const miss = { scan_id: 7, at: "2026-10-15T11:00:00Z", last_seen_scan_id: 5, last_seen_at: "2026-10-11T09:00:00Z" };
  const mapped = point(9, "M kW", { asset_id: 10, mapping_id: 3, mapped_metric: "active_power_kw" });
  const unmappedMissing = source(1, { not_seen: miss, clusters: [{ key: "A", points: [point(1, "a")] }] });
  const mappedMissing = source(2, { not_seen: miss, clusters: [{ key: "A", points: [point(2, "a"), mapped] }] });
  const handMissing = source(3, { origin: "manual", not_seen: miss }); // the server never sends this; the page still never lists one
  const seenAgain = source(4, { not_seen: null });
  const oldServer = source(5);

  it("isNotSeen: discovered and marked by the server, nothing else", () => {
    expect(isNotSeen(unmappedMissing)).toBe(true);
    expect(isNotSeen(mappedMissing)).toBe(true);
    expect(isNotSeen(handMissing)).toBe(false);
    expect(isNotSeen(seenAgain)).toBe(false);
    expect(isNotSeen(oldServer)).toBe(false);
  });

  it("removableNotSeen: not seen AND nothing mapped (the same rule as Remove and Clear unmapped); a mapped or hand-added source is never in it", () => {
    const all = [unmappedMissing, mappedMissing, handMissing, seenAgain, oldServer, source(6, { not_seen: miss })];
    expect(removableNotSeen(all).map((s) => s.id)).toEqual([1, 6]);
    expect(removableNotSeen([mappedMissing, handMissing, seenAgain])).toEqual([]);
    expect(removableNotSeen([])).toEqual([]);
  });

  it("an asset without a mapping id still counts as mapped", () => {
    expect(removableNotSeen([source(7, { not_seen: miss, ungrouped: [point(9, "b", { asset_id: 10 })] })])).toEqual([]);
  });

  it("notSeenCount counts every marked source, mapped or not", () => {
    expect(notSeenCount([unmappedMissing, mappedMissing, handMissing, seenAgain, oldServer])).toBe(2);
    expect(notSeenCount([])).toBe(0);
  });
});

describe("what the card and the panel say about a source that is not seen (w33)", () => {
  const miss = { scan_id: 7, at: "2026-10-15T11:00:00Z", last_seen_scan_id: 5, last_seen_at: "2026-10-11T09:00:00Z" };
  const LINE = "Not seen in scan #7 (last seen in #5, 4 days ago)";
  const mapped = point(9, "M kW", { asset_id: 10, mapping_id: 3, mapped_metric: "active_power_kw" });

  it("notSeenSentence: the whole sentence of the panel", () => {
    expect(notSeenSentence(source(1, { not_seen: miss }), LINE)).toBe(`${LINE}. A later scan of the same range did not find it.`);
    expect(notSeenSentence(source(1), "Seen in scan #6, 10 min ago")).toBe("Seen in scan #6, 10 min ago");
  });

  it("seenCard: an unmapped one keeps its line and tooltip; a mapped one says what to do instead, with both sentences in the tooltip", () => {
    expect(seenCard(source(1, { not_seen: miss }), LINE)).toEqual({ line: LINE, title: LINE });
    expect(seenCard(source(1, { not_seen: miss, ungrouped: [mapped], status: "offline" }), LINE)).toEqual({ line: MAPPED_NOT_SEEN, title: `${LINE}. ${MAPPED_NOT_SEEN}` });
    expect(MAPPED_NOT_SEEN).toBe("Mapped: move it or delete it on Sources");
    expect(seenCard(source(1, { ungrouped: [mapped] }), "Seen in scan #6")).toEqual({ line: "Seen in scan #6", title: "Seen in scan #6" }); // seen sources are left alone
  });

  it("a mapped source that is not seen but polls fine (online, or never polled) keeps its seen line: nothing is wrong that moving or deleting would fix", () => {
    for (const status of ["online", "unknown", "error"]) {
      expect(seenCard(source(1, { not_seen: miss, ungrouped: [mapped], status }), LINE)).toEqual({ line: LINE, title: LINE });
    }
    expect(isMappedNotSeen(source(1, { not_seen: miss, ungrouped: [mapped], status: "offline" }))).toBe(true);
    expect(isMappedNotSeen(source(1, { not_seen: miss, ungrouped: [mapped], status: "online" }))).toBe(false);
    expect(isMappedNotSeen(source(1, { not_seen: miss, status: "offline" }))).toBe(false); // nothing mapped: Remove not seen takes it
    expect(isMappedNotSeen(source(1, { ungrouped: [mapped], status: "offline" }))).toBe(false); // seen
  });

  it("serverLine: the application URI, else the simulator's instance id, else the application name; nothing for no identity", () => {
    const id = { application_uri: null, application_name: null, product_uri: null, thumbprint: null, instance: null, usable: true, different: false };
    expect(serverLine({ ...id, application_uri: "urn:dcdash:simulator:dev", instance: "dev", application_name: "Sim" })).toBe("Server: urn:dcdash:simulator:dev");
    expect(serverLine({ ...id, instance: "dev", application_name: "Sim" })).toBe("Simulator instance dev");
    expect(serverLine({ ...id, application_name: "Sim" })).toBe("Server: Sim");
    expect(serverLine(id)).toBeNull();
    expect(serverLine(null)).toBeNull();
    expect(serverLine(undefined)).toBeNull();
  });

  it("certificateLine: the first 5 and the last 2 characters of the thumbprint, the whole value for the tooltip", () => {
    const id = { application_uri: null, application_name: null, product_uri: null, thumbprint: "3A:5F:C1:0D:22:98:7B:44:E0:AB:12:34:56:78:9A:BC:DE:F0:11:91", instance: null, usable: true, different: false };
    expect(certificateLine(id)).toEqual({ text: "certificate 3A:5F:...:91", title: "3A:5F:C1:0D:22:98:7B:44:E0:AB:12:34:56:78:9A:BC:DE:F0:11:91" });
    expect(certificateLine({ ...id, thumbprint: "3A:5F" })).toEqual({ text: "certificate 3A:5F", title: "3A:5F" }); // too short to cut
    expect(certificateLine({ ...id, thumbprint: null })).toBeNull();
    expect(certificateLine(null)).toBeNull();
  });

  it("removalDialogText for not seen: says the latest scan did not find them and that mapped and hand-added sources are never removed", () => {
    expect(removalDialogText(["Plant OPC"], "notSeen")).toEqual({
      title: 'Remove "Plant OPC", which the latest scan did not find?',
      message: "The latest scan of the same range did not find it. Mapped sources and sources added by hand are never removed. A scan can find it again.",
    });
    const several = removalDialogText(["A", "B", "C", "D", "E", "F", "G"], "notSeen");
    expect(several.title).toBe("Remove 7 sources the latest scan did not find?");
    expect(several.message).toBe("A, B, C, D, E and 2 more. The latest scan of the same range did not find them. Mapped sources and sources added by hand are never removed. A scan can find these again.");
    // the old callers (no kind) get today's words
    expect(removalDialogText(["A", "B"]).title).toBe("Remove 2 unmapped sources?");
  });
});

describe("the Not seen lately filter (w33)", () => {
  const miss = { scan_id: 7, at: "2026-10-15T11:00:00Z", last_seen_scan_id: 5, last_seen_at: "2026-10-11T09:00:00Z" };
  const withMissing = () => model({
    sources: [
      source(1, { not_seen: miss, clusters: [{ key: "A", points: [point(1, "a")] }] }),
      source(2, { clusters: [{ key: "B", points: [point(2, "b")] }] }),
      source(3, { origin: "manual", clusters: [{ key: "C", points: [point(3, "c")] }] }),
    ],
  });
  const view = (over: Partial<GraphView> = {}): GraphView => ({ ...NO_VIEW, ...over });

  it("is off by default: NO_VIEW and a view without the field draw every source", () => {
    expect(NO_VIEW.notSeenOnly ?? false).toBe(false);
    expect(withMissing().sources.every((s) => sourceVisible(s, NO_VIEW))).toBe(true);
    expect(ids(buildGraph(withMissing(), none).nodes.filter((n) => n.type === "source"))).toEqual(["src:1", "src:2", "src:3"]);
  });

  it("on: only the sources marked not seen are on the canvas, with their edges, and the others take no room", () => {
    const { nodes, edges } = buildGraph(withMissing(), { sources: new Set([1, 2]), clusters: new Set() }, { view: view({ notSeenOnly: true }) });
    expect(ids(nodes.filter((n) => n.type === "source"))).toEqual(["src:1"]);
    expect(ids(nodes.filter((n) => n.type === "cluster"))).toEqual([nodeId.cluster(1, "A")]);
    expect(edges.every((e) => e.source !== "src:2" && e.source !== "src:3")).toBe(true);
    expect(nodes.find((n) => n.id === "src:1")?.position.y).toBe(0); // the first row: a hidden source before it left no gap
  });

  it("combines with Unmapped only: a not-seen source whose points are all mapped is hidden by that filter", () => {
    const m = model({ sources: [source(1, { not_seen: miss, clusters: [{ key: "A", points: [point(1, "a", { asset_id: 10, mapping_id: 1, mapped_metric: "voltage_v" })] }] })] });
    expect(sourceVisible(m.sources[0], view({ notSeenOnly: true }))).toBe(true);
    expect(sourceVisible(m.sources[0], view({ notSeenOnly: true, unmappedOnly: true }))).toBe(false);
  });

  it("sourceIdOfNode: the source behind a source, group or point node; none for an asset or an unidentified service", () => {
    const m = model();
    expect(sourceIdOfNode(m, "src:2")).toBe(2);
    expect(sourceIdOfNode(m, nodeId.cluster(1, "LVP01"))).toBe(1);
    expect(sourceIdOfNode(m, "point:8")).toBe(2); // a point of the manual source
    expect(sourceIdOfNode(m, "point:7")).toBe(1); // an ungrouped point
    expect(sourceIdOfNode(m, "point:999")).toBeNull();
    expect(sourceIdOfNode(m, "asset:10")).toBeNull();
    expect(sourceIdOfNode(m, "unid:10.0.0.9:8080")).toBeNull();
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

describe("buildGraph with a view (W12b)", () => {
  type TestAsset = GraphModel["assets"][number];
  const asset = (id: number, parent_id: number | null, name = `Asset ${id}`): TestAsset => ({ id, parent_id, name, kind: "generic" });
  const mappedTo = (id: number, assetId: number) => point(id, `p${id}`, { asset_id: assetId, mapping_id: id, mapped_metric: "voltage_v" });
  /** `n` points p1..pn; `mapTo(i)` (i counts from 1) is the asset point i is mapped to, or null. */
  const pts = (n: number, mapTo: (i: number) => number | null = () => null) =>
    Array.from({ length: n }, (_, i) => { const a = mapTo(i + 1); return a === null ? point(i + 1, `p${i + 1}`) : mappedTo(i + 1, a); });
  /** Source 1 with ONE group "G" of `n` points. */
  const oneGroup = (n: number, mapTo?: (i: number) => number | null, extra: Partial<GraphModel> = {}) =>
    model({ sources: [source(1, { clusters: [{ key: "G", points: pts(n, mapTo) }] })], unidentified: [], ...extra });
  const G = nodeId.cluster(1, "G");
  const openG: OpenState = { sources: new Set([1]), clusters: new Set([G]) };
  const srcOnly: OpenState = { sources: new Set([1]), clusters: new Set() };
  const paged: GraphView = { ...NO_VIEW, pageSize: PAGE_SIZE };
  const filtered: GraphView = { ...NO_VIEW, unmappedOnly: true };
  const closed = (...assetIds: number[]): GraphView => ({ ...NO_VIEW, assetsClosed: new Set(assetIds) });
  const byType = (nodes: Node[], type: string) => nodes.filter((n) => n.type === type);
  const mapEdges = (edges: Edge[]) => edges.filter((e) => e.id.startsWith("m:"));
  const everythingOpen = (m: GraphModel): OpenState => ({
    sources: new Set(m.sources.map((s) => s.id)),
    clusters: new Set(m.sources.flatMap((s) => [...s.clusters.map((c) => c.key), ...(s.ungrouped.length > 0 ? [UNGROUPED] : [])].map((k) => nodeId.cluster(s.id, k)))),
  });

  describe("the Unmapped only filter", () => {
    const A = nodeId.cluster(1, "A");
    const B = nodeId.cluster(1, "B");
    // Source 1: group A (p1 unmapped, p2 mapped), group B (every point mapped). Source 2: every point mapped. Source 3: no points at all.
    const filterModel = () => model({
      sources: [
        source(1, { clusters: [{ key: "A", points: [point(1, "p1"), mappedTo(2, 10)] }, { key: "B", points: [mappedTo(3, 10), mappedTo(4, 11)] }] }),
        source(2, { clusters: [{ key: "C", points: [mappedTo(5, 10)] }] }),
        source(3),
      ],
    });
    const everything: OpenState = { sources: new Set([1, 2, 3]), clusters: new Set([A, B, nodeId.cluster(2, "C")]) };

    it("draws no mapped point, no group with every point mapped, and no source with every point mapped", () => {
      const { nodes } = buildGraph(filterModel(), everything, { view: filtered });
      expect(ids(nodes)).toEqual(["asset:10", "asset:11", A, "point:1", "src:1", "src:3", "unid:10.0.0.9:8080"].sort());
    });

    it("a source with no points stays, and so do the unidentified services and every asset", () => {
      const { nodes } = buildGraph(filterModel(), none, { view: filtered });
      expect(ids(nodes)).toEqual(["asset:10", "asset:11", "src:1", "src:3", "unid:10.0.0.9:8080"]);
    });

    it("draws no m: edge of any kind: not from a point, a group or a source", () => {
      const m = filterModel();
      for (const open of [everything, none, { sources: new Set([1, 2, 3]), clusters: new Set<string>() }]) {
        expect(mapEdges(buildGraph(m, open, { view: filtered }).edges)).toEqual([]);
      }
      // the same graphs without the filter do draw them (a source, a group and a point each)
      expect(mapEdges(buildGraph(m, none).edges).length).toBeGreaterThan(0);
      expect(mapEdges(buildGraph(m, { sources: new Set([1]), clusters: new Set() }).edges).some((e) => e.source === A)).toBe(true);
      expect(mapEdges(buildGraph(m, everything).edges).some((e) => e.source === "point:2")).toBe(true);
    });

    it("the group keeps the TOTAL as count and mapped count, and says how many points are visible and drawn", () => {
      const cluster = buildGraph(filterModel(), everything, { view: filtered }).nodes.find((n) => n.id === A);
      expect(cluster?.data).toMatchObject({ count: 2, mappedCount: 1, visibleCount: 1, shownCount: 1, expanded: true });
    });

    it("an open group draws only its unmapped points", () => {
      const m = oneGroup(6, (i) => (i % 2 === 0 ? 10 : null), { assets: [asset(10, null)] });
      const { nodes } = buildGraph(m, openG, { view: filtered });
      expect(ids(byType(nodes, "point"))).toEqual(["point:1", "point:3", "point:5"]);
    });

    it("hidden sources and groups take no row: the next source stands where it would without them", () => {
      const { nodes } = buildGraph(filterModel(), everything, { view: filtered });
      // src:1 at 0, its one group at SOURCE_H, its one point a row below, then the block gap: 136 + 2 rows of 64 + 40
      expect(at(nodes, "src:3")).toEqual({ x: 0, y: SOURCE_H + 2 * 64 + BLOCK_GAP });
      expect(at(nodes, A)).toEqual({ x: 360, y: SOURCE_H });
      expect(at(nodes, "point:1")).toEqual({ x: 720, y: SOURCE_H + 64 });
    });

    it("off (or NO_VIEW, or no view at all) is the graph it always was", () => {
      const m = filterModel();
      expect(buildGraph(m, everything, { view: NO_VIEW })).toEqual(buildGraph(m, everything));
      expect(mapEdges(buildGraph(m, everything, { view: NO_VIEW }).edges).length).toBeGreaterThan(0);
    });
  });

  describe("paging", () => {
    // [points, the page extent in `view.shown` (undefined = none), points drawn, points left]
    it.each([
      [50, undefined, 50, 0], [51, undefined, 50, 1], [100, undefined, 50, 50], [101, undefined, 50, 51],
      [100, 100, 100, 0], [101, 100, 100, 1], [101, 150, 101, 0], [200, 120, 120, 80], [60, 10, 10, 50],
    ])("%i visible points, extent %j: %i drawn, %i left", (total, shown, drawn, left) => {
      const view: GraphView = shown === undefined ? paged : { ...paged, shown: new Map([[G, shown]]) };
      const { nodes, edges } = buildGraph(oneGroup(total), openG, { view });
      expect(byType(nodes, "point")).toHaveLength(drawn);
      expect(nodes.find((n) => n.id === G)?.data).toMatchObject({ count: total, visibleCount: total, shownCount: drawn });
      const more = byType(nodes, "more");
      if (left === 0) {
        expect(more).toHaveLength(0);
        return;
      }
      expect(more).toHaveLength(1);
      expect(more[0]).toMatchObject({
        id: nodeId.more(G), type: "more", draggable: false, selectable: false, focusable: false,
        data: { clusterId: G, label: "G", left, step: Math.min(PAGE_SIZE, left) },
      });
      expect(more[0].ariaLabel).toBeUndefined();
      expect(edges.some((e) => e.source === nodeId.more(G) || e.target === nodeId.more(G))).toBe(false);
    });

    it("without a page size (NO_VIEW, or no view) every point is drawn and there is no more node", () => {
      for (const options of [{}, { view: NO_VIEW }]) {
        const { nodes } = buildGraph(oneGroup(120), openG, options);
        expect(byType(nodes, "point")).toHaveLength(120);
        expect(byType(nodes, "more")).toHaveLength(0);
      }
      expect(NO_VIEW.pageSize).toBe(Infinity);
    });

    it("draws the first points of the list, in order", () => {
      const { nodes } = buildGraph(oneGroup(70), openG, { view: paged });
      expect(byType(nodes, "point").map((n) => n.id)).toEqual(Array.from({ length: 50 }, (_, i) => `point:${i + 1}`));
    });

    it("the more node stands one row below the last drawn point in the point column, and takes a row like a point", () => {
      const m = model({ sources: [source(1, { clusters: [{ key: "G", points: pts(60) }, { key: "H", points: [point(100, "h")] }] })], unidentified: [] });
      const { nodes } = buildGraph(m, openG, { view: paged });
      const last = at(nodes, "point:50");
      const more = at(nodes, nodeId.more(G));
      expect(more).toEqual({ x: 720, y: last.y + 64 });
      expect(at(nodes, nodeId.cluster(1, "H")).y - more.y).toBe(64);
    });

    it("the more node follows its group and its source like a point, and never has a place of its own", () => {
      const m = oneGroup(60);
      const base = at(buildGraph(m, openG, { view: paged }).nodes, nodeId.more(G));
      // G stands at (360, 136) by default: a session place for it shifts the more node by the same
      const viaGroup = buildGraph(m, openG, { view: paged, moved: new Map([[G, { x: 400, y: 300 }]]) }).nodes;
      expect(at(viaGroup, nodeId.more(G))).toEqual({ x: base.x + 40, y: base.y + 164 });
      const viaSource = buildGraph(m, openG, { view: paged, moved: new Map([["src:1", { x: 100, y: 50 }]]) }).nodes;
      expect(at(viaSource, nodeId.more(G))).toEqual({ x: base.x + 100, y: base.y + 50 });
      // a place stored (or dragged) under its id is ignored
      const stored = buildGraph(oneGroup(60, undefined, { layout: { [nodeId.more(G)]: { x: 1, y: 2 } } }), openG, { view: paged, moved: new Map([[nodeId.more(G), { x: 3, y: 4 }]]) }).nodes;
      expect(at(stored, nodeId.more(G))).toEqual(base);
    });

    it("mapped points that are not drawn keep one edge per asset from the group, labelled with the count", () => {
      // p3 is drawn; p51 and p52 (not drawn) are mapped to asset 10 and p53 to asset 11
      const m = oneGroup(60, (i) => (i === 3 || i === 51 || i === 52 ? 10 : i === 53 ? 11 : null), { assets: [asset(10, null), asset(11, null)] });
      const edges = mapEdges(buildGraph(m, openG, { view: paged }).edges);
      expect(edges.map((e) => e.id).sort()).toEqual([`m:${G}>asset:10`, `m:${G}>asset:11`, "m:point:3>asset:10"]);
      expect(edges.find((e) => e.id === `m:${G}>asset:10`)?.label).toBe("2 mapped");
      expect(edges.find((e) => e.id === `m:${G}>asset:11`)?.label).toBeUndefined();
      // once the page is extended over them, the aggregate is gone and the points carry their own edges
      const all = mapEdges(buildGraph(m, openG, { view: { ...paged, shown: new Map([[G, 60]]) } }).edges);
      expect(all.map((e) => e.id).sort()).toEqual(["m:point:3>asset:10", "m:point:51>asset:10", "m:point:52>asset:10", "m:point:53>asset:11"]);
    });

    it("under the filter no aggregated edge is drawn for the points that are not drawn", () => {
      const m = oneGroup(70, (i) => (i > 60 ? 10 : null), { assets: [asset(10, null)] });
      const { nodes, edges } = buildGraph(m, openG, { view: { ...paged, unmappedOnly: true } });
      expect(byType(nodes, "point")).toHaveLength(50);
      expect(nodes.find((n) => n.id === nodeId.more(G))?.data).toMatchObject({ left: 10 });
      expect(nodes.find((n) => n.id === G)?.data).toMatchObject({ count: 70, visibleCount: 60, shownCount: 50, mappedCount: 10 });
      expect(mapEdges(edges)).toEqual([]);
    });

    it("the aggregated edge of a live source flows like a collapsed group's, and counts toward the limit", () => {
      const m = model({ sources: [source(1, { enabled: true, status: "online", clusters: [{ key: "G", points: pts(60, (i) => (i > 55 ? 10 : null)) }] })], unidentified: [] });
      const { edges } = buildGraph(m, openG, { view: paged, animate: true });
      expect(edges.find((e) => e.id === `m:${G}>asset:10`)).toMatchObject({ animated: true, label: "5 mapped", style: { strokeDasharray: "8 2" } });
    });

    it("a collapsed group is unchanged by paging: one aggregated edge per asset from the group", () => {
      const m = oneGroup(60, (i) => (i > 55 ? 10 : null), { assets: [asset(10, null)] });
      const { nodes, edges } = buildGraph(m, srcOnly, { view: paged });
      expect(byType(nodes, "point")).toHaveLength(0);
      expect(edges.find((e) => e.id === `m:${G}>asset:10`)?.label).toBe("5 mapped");
    });
  });

  describe("fan-out edges (FAN_DASH_LIMIT)", () => {
    const fan = (edges: Edge[]) => edges.filter((e) => e.target.startsWith("point:"));

    it("the limit is 150", () => {
      expect(FAN_DASH_LIMIT).toBe(150);
    });

    it("a group that draws 150 points keeps the dashes on its point edges; at 151 they are solid", () => {
      const at150 = fan(buildGraph(oneGroup(150), openG).edges);
      expect(at150).toHaveLength(150);
      for (const e of at150) expect(e.style, e.id).toEqual({ strokeDasharray: "6 4" });
      const at151 = fan(buildGraph(oneGroup(151), openG).edges);
      expect(at151).toHaveLength(151);
      for (const e of at151) {
        expect(e.style, e.id).toEqual({});
        expect(e.style?.strokeDasharray, e.id).toBeUndefined();
      }
    });

    it("the source to group edge stays dashed whatever the size", () => {
      const edge = buildGraph(oneGroup(151), openG).edges.find((e) => e.id === `e:src:1>${G}`);
      expect(edge?.style).toEqual({ strokeDasharray: "6 4" });
    });

    it("counts the points DRAWN: 400 visible points on a page of 50 stay dashed, a page extended to 200 goes solid", () => {
      const first = fan(buildGraph(oneGroup(400), openG, { view: paged }).edges);
      expect(first).toHaveLength(50);
      for (const e of first) expect(e.style).toEqual({ strokeDasharray: "6 4" });
      const wide = fan(buildGraph(oneGroup(400), openG, { view: { ...paged, shown: new Map([[G, 200]]) } }).edges);
      expect(wide).toHaveLength(200);
      for (const e of wide) expect(e.style).toEqual({});
    });

    it("solid fan-out edges never flow, a live source included", () => {
      const m = model({ sources: [source(1, { enabled: true, status: "online", clusters: [{ key: "G", points: pts(200) }] })], unidentified: [] });
      const edges = buildGraph(m, openG, { animate: true }).edges;
      expect(fan(edges).every((e) => e.animated === undefined)).toBe(true);
      expect(edges.find((e) => e.id === `e:src:1>${G}`)).toMatchObject({ animated: true, style: { strokeDasharray: "6 4" } });
    });
  });

  describe("folded assets", () => {
    // 10 Site > (11 Hall > (12 Row A, 13 Row B), 14 Hall 2); 20 Other
    const tree = () => [asset(10, null, "Site"), asset(11, 10, "Hall"), asset(12, 11, "Row A"), asset(13, 11, "Row B"), asset(14, 10, "Hall 2"), asset(20, null, "Other")];
    const treeModel = (mapTo: (i: number) => number | null = () => null, n = 3) => oneGroup(n, mapTo, { assets: tree() });
    const drawnAssets = (nodes: Node[]) => byType(nodes, "asset").map((n) => n.id);
    const aEdges = (edges: Edge[]) => edges.filter((e) => e.id.startsWith("a:")).map((e) => e.id);

    it("nothing closed: every asset is drawn, as before, and each carries its sub-asset count", () => {
      const { nodes, edges } = buildGraph(treeModel(), none, { view: NO_VIEW });
      expect(drawnAssets(nodes)).toEqual(["asset:10", "asset:11", "asset:12", "asset:13", "asset:14", "asset:20"]);
      expect(aEdges(edges)).toHaveLength(4);
      const data = (id: string) => nodes.find((n) => n.id === id)?.data;
      expect(data("asset:10")).toMatchObject({ children: 2, collapsed: false });
      expect(data("asset:11")).toMatchObject({ children: 2, collapsed: false });
      expect(data("asset:12")).toMatchObject({ children: 0, collapsed: false });
      expect(data("asset:10")).not.toHaveProperty("mappedInside");
    });

    it("a closed root hides everything under it: no node, no a: edge, no row", () => {
      const { nodes, edges } = buildGraph(treeModel(), none, { view: closed(10) });
      expect(drawnAssets(nodes)).toEqual(["asset:10", "asset:20"]);
      expect(aEdges(edges)).toEqual([]);
      expect(nodes.find((n) => n.id === "asset:10")?.data).toMatchObject({ children: 2, collapsed: true });
      expect(nodes.find((n) => n.id === "asset:20")?.data).toMatchObject({ children: 0, collapsed: false });
      expect(at(nodes, "asset:20")).toEqual({ x: 1200, y: 64 });
    });

    it("a closed asset in the middle hides only its own subtree; the rest keeps its edges and its rows", () => {
      const { nodes, edges } = buildGraph(treeModel(), none, { view: closed(11) });
      expect(drawnAssets(nodes)).toEqual(["asset:10", "asset:11", "asset:14", "asset:20"]);
      expect(aEdges(edges).sort()).toEqual(["a:10>11", "a:10>14"]);
      expect(nodes.find((n) => n.id === "asset:11")?.data).toMatchObject({ children: 2, collapsed: true });
      expect(nodes.find((n) => n.id === "asset:10")?.data).toMatchObject({ children: 2, collapsed: false });
      expect(at(nodes, "asset:14")).toEqual({ x: 1200 + 224, y: 128 });
      expect(at(nodes, "asset:20")).toEqual({ x: 1200, y: 192 });
    });

    it("a closed asset inside a closed one adds nothing: the outermost one stands for them both", () => {
      const nested = buildGraph(treeModel((i) => (i === 1 ? 12 : null)), { sources: new Set(), clusters: new Set() }, { view: closed(10, 11) });
      expect(drawnAssets(nested.nodes)).toEqual(["asset:10", "asset:20"]);
      expect(nested.edges.filter((e) => e.id.startsWith("m:")).map((e) => e.id)).toEqual(["m:src:1>asset:10"]);
    });

    it("a closed member of a pure parent cycle hides the other member and draws nobody twice or as a root by accident", () => {
      const cycle = oneGroup(1, undefined, { assets: [asset(10, 11, "A"), asset(11, 10, "B")] });
      const a = buildGraph(cycle, none, { view: closed(10) });
      expect(drawnAssets(a.nodes)).toEqual(["asset:10"]);
      expect(aEdges(a.edges)).toEqual([]);
      const b = buildGraph(cycle, none, { view: closed(11) });
      expect(drawnAssets(b.nodes)).toEqual(["asset:10", "asset:11"]);
      expect(aEdges(b.edges).sort()).toEqual(aEdges(buildGraph(cycle, none).edges).sort());
    });

    it("an orphan and a self-parent are roots and are never hidden by another asset's fold", () => {
      const m = oneGroup(1, undefined, { assets: [asset(10, null), asset(11, 10), asset(30, 99, "Orphan"), asset(31, 30), asset(40, 40, "Loop")] });
      const { nodes } = buildGraph(m, none, { view: closed(10) });
      expect(drawnAssets(nodes)).toEqual(["asset:10", "asset:30", "asset:31", "asset:40"]);
      expect(nodes.find((n) => n.id === "asset:30")?.data).toMatchObject({ navParent: null });
      expect(nodes.find((n) => n.id === "asset:40")?.data).toMatchObject({ navParent: null });
    });

    it("a hidden asset listed BEFORE its closed parent is not drawn as a root", () => {
      const m = oneGroup(1, undefined, { assets: [asset(11, 10), asset(12, 11), asset(10, null)] });
      expect(drawnAssets(buildGraph(m, none, { view: closed(10) }).nodes)).toEqual(["asset:10"]);
    });

    it("no asset node appears twice, whatever is closed", () => {
      const cyc = [asset(1, 2), asset(2, 3), asset(3, 1), asset(4, 2), asset(5, null), asset(6, 5)];
      for (const assets of [tree(), cyc]) {
        for (const set of [[], assets.map((a) => a.id), assets.slice(0, 2).map((a) => a.id), [assets[assets.length - 1].id]]) {
          const { nodes } = buildGraph(oneGroup(1, undefined, { assets }), none, { view: closed(...set) });
          const drawn = drawnAssets(nodes);
          expect(new Set(drawn).size, `${assets.length} assets, closed ${set}`).toBe(drawn.length);
        }
      }
    });

    describe("a mapping onto a hidden asset is drawn to the asset that hides it, one edge for all of them", () => {
      // Site 10 with two sub-assets 11 and 12; p1 -> 11, p2 -> 12, p3 unmapped.
      const twins = (n = 3, mapTo = (i: number): number | null => (i === 1 ? 11 : i === 2 ? 12 : null)) => oneGroup(n, mapTo, { assets: [asset(10, null), asset(11, 10), asset(12, 10)] });

      it("a collapsed source", () => {
        const edges = mapEdges(buildGraph(twins(), none, { view: closed(10) }).edges);
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({ id: "m:src:1>asset:10", label: "2 mapped" });
      });

      it("a collapsed group", () => {
        const edges = mapEdges(buildGraph(twins(), srcOnly, { view: closed(10) }).edges);
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({ id: `m:${G}>asset:10`, label: "2 mapped" });
      });

      it("drawn points: each carries its own edge, to the same asset, with no label", () => {
        const edges = mapEdges(buildGraph(twins(), openG, { view: closed(10) }).edges);
        expect(edges.map((e) => e.id).sort()).toEqual(["m:point:1>asset:10", "m:point:2>asset:10"]);
        expect(edges.every((e) => e.label === undefined)).toBe(true);
      });

      it("the aggregate for points that are not drawn yet", () => {
        const m = twins(60, (i) => (i === 51 ? 11 : i === 52 ? 12 : null));
        const edges = mapEdges(buildGraph(m, openG, { view: { ...closed(10), pageSize: PAGE_SIZE } }).edges);
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({ id: `m:${G}>asset:10`, label: "2 mapped" });
      });

      it("a point mapped to the closed asset itself adds to the same edge", () => {
        const edges = mapEdges(buildGraph(twins(4, (i) => (i === 1 ? 11 : i === 2 ? 12 : i === 3 ? 10 : null)), srcOnly, { view: closed(10) }).edges);
        expect(edges).toHaveLength(1);
        expect(edges[0].label).toBe("3 mapped");
      });
    });

    describe("mappedInside", () => {
      const three = () => oneGroup(3, (i) => [10, 11, 12][i - 1], { assets: [asset(10, null), asset(11, 10), asset(12, 11)] });

      it("counts the points mapped to the closed asset and to anything it hides; only a closed asset has it", () => {
        const { nodes } = buildGraph(three(), none, { view: closed(10) });
        expect(nodes.find((n) => n.id === "asset:10")?.data).toMatchObject({ collapsed: true, mappedInside: 3 });
        const open = buildGraph(three(), none).nodes.find((n) => n.id === "asset:10");
        expect(open?.data).not.toHaveProperty("mappedInside");
      });

      it("a nested closed asset counts under the outermost one only; the middle one, closed alone, counts its own subtree", () => {
        const both = buildGraph(three(), none, { view: closed(10, 11) }).nodes;
        expect(both.find((n) => n.id === "asset:10")?.data).toMatchObject({ mappedInside: 3 });
        const middle = buildGraph(three(), none, { view: closed(11) }).nodes;
        expect(middle.find((n) => n.id === "asset:11")?.data).toMatchObject({ collapsed: true, mappedInside: 2 });
        expect(middle.find((n) => n.id === "asset:10")?.data).not.toHaveProperty("mappedInside");
      });

      it("counts the whole model, even points the filter hides and sources that are not drawn", () => {
        const { nodes } = buildGraph(three(), none, { view: { ...closed(10), unmappedOnly: true } });
        expect(byType(nodes, "source")).toHaveLength(0); // every point is mapped: the filter hides the source
        expect(nodes.find((n) => n.id === "asset:10")?.data).toMatchObject({ mappedInside: 3 });
      });

      it("is absent when nothing inside is mapped, and a closed asset without sub-assets is not collapsed", () => {
        const m = oneGroup(1, undefined, { assets: [asset(10, null), asset(11, 10), asset(20, null)] });
        const { nodes } = buildGraph(m, none, { view: closed(10, 20) });
        expect(nodes.find((n) => n.id === "asset:10")?.data).toMatchObject({ collapsed: true });
        expect(nodes.find((n) => n.id === "asset:10")?.data).not.toHaveProperty("mappedInside");
        expect(nodes.find((n) => n.id === "asset:20")?.data).toMatchObject({ children: 0, collapsed: false });
      });
    });

    it("navParent is the node the walk came from: null for a root, an orphan, a self-parent and the head of a cycle", () => {
      const m = oneGroup(1, undefined, { assets: [asset(10, null), asset(11, 10), asset(12, 11), asset(30, 99), asset(40, 40), asset(50, 51), asset(51, 50)] });
      const nav = (id: string) => (buildGraph(m, none).nodes.find((n) => n.id === id)?.data as { navParent: string | null }).navParent;
      expect(nav("asset:10")).toBeNull();
      expect(nav("asset:11")).toBe("asset:10");
      expect(nav("asset:12")).toBe("asset:11");
      expect(nav("asset:30")).toBeNull();
      expect(nav("asset:40")).toBeNull();
      expect(nav("asset:50")).toBeNull(); // the head of a pure cycle
      expect(nav("asset:51")).toBe("asset:50");
    });
  });

  describe("labels (aria-label of every node but the more node)", () => {
    const label = (m: GraphModel, open: OpenState, id: string, view: GraphView = NO_VIEW) => buildGraph(m, open, { view }).nodes.find((n) => n.id === id)?.ariaLabel;
    const all = { sources: new Set([1, 2]), clusters: new Set([nodeId.cluster(1, "LVP01"), nodeId.cluster(2, "M")]) };

    it("a source: its name, its groups and points (the total), open or closed", () => {
      expect(label(model(), none, "src:1")).toBe("s1, source, 3 groups, 7 points, closed");
      expect(label(model(), all, "src:1")).toBe("s1, source, 3 groups, 7 points, open");
      expect(label(model(), none, "src:2")).toBe("s2, source, 1 group, 2 points, closed");
    });

    it("a group: its name, size and mapped count, open or closed", () => {
      expect(label(model(), all, nodeId.cluster(2, "M"))).toBe("M, group of 2 points, 2 mapped, open");
      expect(label(model(), all, nodeId.cluster(1, "LVP02"))).toBe("LVP02, group of 3 points, 0 mapped, closed");
      expect(label(model(), all, nodeId.cluster(1, UNGROUPED))).toBe("Ungrouped, group of 1 point, 0 mapped, closed");
    });

    it("an open group that draws fewer points than it has says how many it shows (it reads 50 of 120 on screen); closed, unpaged and fully drawn groups keep their names", () => {
      const m = oneGroup(120, (i) => (i <= 3 ? 10 : null), { assets: [asset(10, null)] });
      expect(label(m, openG, G, paged)).toBe("G, group of 120 points, 3 mapped, open, 50 shown");
      expect(label(m, openG, G, { ...paged, shown: new Map([[G, 100]]) })).toBe("G, group of 120 points, 3 mapped, open, 100 shown");
      expect(label(m, openG, G, { ...paged, shown: new Map([[G, 120]]) })).toBe("G, group of 120 points, 3 mapped, open");
      expect(label(m, srcOnly, G, paged)).toBe("G, group of 120 points, 3 mapped, closed");
      expect(label(oneGroup(40), openG, G, paged)).toBe("G, group of 40 points, 0 mapped, open");
      expect(label(oneGroup(50), openG, G, paged)).toBe("G, group of 50 points, 0 mapped, open");
    });

    it("the filter counts: a group paged only among its unmapped points says so, and one that fits in a page after the filter does not", () => {
      const m = oneGroup(120, (i) => (i <= 3 ? 10 : null), { assets: [asset(10, null)] });
      expect(label(m, openG, G, { ...paged, unmappedOnly: true })).toBe("G, group of 120 points, 3 mapped, open, 50 shown");
      const mostlyMapped = oneGroup(120, (i) => (i <= 100 ? 10 : null), { assets: [asset(10, null)] });
      expect(label(mostlyMapped, openG, G, { ...paged, unmappedOnly: true })).toBe("G, group of 120 points, 100 mapped, open");
    });

    it("a point: mapped to the asset's name, unmapped, or just mapped when the asset is not in the model", () => {
      expect(label(model(), all, "point:8")).toBe("M kW, point, mapped to Site");
      expect(label(model(), all, "point:1")).toBe("LVP01 kW, point, unmapped");
      expect(label(model({ assets: [] }), all, "point:8")).toBe("M kW, point, mapped");
    });

    it("an asset: sub-assets, what is mapped inside a closed one, and open or closed; the parts that do not apply are left out", () => {
      expect(label(model(), none, "asset:10")).toBe("Site, asset, 1 sub-asset, open");
      expect(label(model(), none, "asset:10", closed(10))).toBe("Site, asset, 1 sub-asset, 2 mapped inside, closed");
      expect(label(model(), none, "asset:11")).toBe("Panel 1, asset");
      const wide = model({ assets: [asset(1, null, "Rack A"), asset(2, 1), asset(3, 1), asset(4, 1)] });
      expect(label(wide, none, "asset:1")).toBe("Rack A, asset, 3 sub-assets, open");
      expect(label(wide, none, "asset:1", closed(1))).toBe("Rack A, asset, 3 sub-assets, closed");
    });

    it("an unidentified service", () => {
      expect(label(model(), none, "unid:10.0.0.9:8080")).toBe("10.0.0.9:8080, unidentified service");
    });

    it("every node but the more node has one, and the more node has none", () => {
      const m = oneGroup(70, (i) => (i % 7 === 0 ? 10 : null), { assets: [asset(10, null), asset(11, 10)], unidentified: [{ host: "h", port: 1, scan_id: 1 }] });
      const { nodes } = buildGraph(m, openG, { view: { ...paged, assetsClosed: new Set([10]) } });
      expect(new Set(nodes.map((n) => n.type))).toEqual(new Set(["source", "cluster", "point", "more", "asset", "unidentified"]));
      for (const n of nodes) {
        if (n.type === "more") expect(n.ariaLabel).toBeUndefined();
        else expect(typeof n.ariaLabel === "string" && n.ariaLabel.length > 0, n.id).toBe(true);
      }
    });
  });

  describe("places that are never saved or loaded: the more node", () => {
    const more = nodeId.more(G);

    it("ownPlaces never returns a more: id, whether it came from the saved layout or from this session", () => {
      const m = model({ layout: { [more]: { x: 1, y: 2 }, "src:1": { x: 5, y: 6 } } });
      expect([...ownPlaces(m, { moved: new Map([["more:cluster:2:Z", { x: 3, y: 4 }], ["src:2", { x: 7, y: 8 }]]) }).keys()].sort()).toEqual(["src:1", "src:2"]);
      expect([...ownPlaces(m).keys()]).toEqual(["src:1"]);
    });

    it("layoutBatches skips a more: id and does not count it against the batch size", () => {
      const batches = layoutBatches([["src:1", { x: 1, y: 1 }], [more, { x: 2, y: 2 }], ["src:2", { x: 3, y: 3 }]], 2);
      expect(batches).toEqual([[{ node_id: "src:1", x: 1, y: 1 }, { node_id: "src:2", x: 3, y: 3 }]]);
    });

    it("descendantNodeIds and childNodeIds never return a more: id; moreNodeIds does that job for a drag", () => {
      const m = oneGroup(60);
      expect(descendantNodeIds(m, G).some((id) => id.startsWith("more:"))).toBe(false);
      expect(descendantNodeIds(m, "src:1").some((id) => id.startsWith("more:"))).toBe(false);
      expect(childNodeIds(m, G).some((id) => id.startsWith("more:"))).toBe(false);
      expect(moreNodeIds(m, G)).toEqual([more]);
      expect(moreNodeIds(m, "src:1")).toEqual([more]);
      expect(moreNodeIds(model(), "src:1")).toEqual([nodeId.more(nodeId.cluster(1, "LVP01")), nodeId.more(nodeId.cluster(1, "LVP02")), nodeId.more(nodeId.cluster(1, UNGROUPED))]);
      for (const id of ["point:1", "asset:10", "unid:10.0.0.9:8080", "src:99", "cluster:1:NOPE", "garbage"]) expect(moreNodeIds(model(), id), id).toEqual([]);
    });
  });

  describe("initialView with a view", () => {
    it("frames only the sources the filter leaves, the first of them first", () => {
      // source 1 is all mapped (hidden), 2 and 3 are not
      const m = model({ sources: [source(1, { clusters: [{ key: "K", points: [mappedTo(1, 10)] }] }), source(2, { clusters: [{ key: "K", points: [point(2, "x")] }] }), source(3)], unidentified: [] });
      expect(initialView(m)?.nodes).toEqual([{ id: "src:1" }, { id: "src:2" }, { id: "src:3" }]);
      expect(initialView(m, filtered)?.nodes).toEqual([{ id: "src:2" }, { id: "src:3" }]);
    });

    it("counts the default places over the visible sources only (the index among them)", () => {
      // three hidden sources, then a placed one and an unplaced one: by index among ALL the unplaced one would lie 704 px down and fall out of the box
      const hidden = (id: number) => source(id, { clusters: [{ key: "K", points: [mappedTo(id, 10)] }] });
      const m = model({ sources: [hidden(1), hidden(2), hidden(3), source(4), source(5)], layout: { "src:4": { x: 0, y: 0 } }, unidentified: [] });
      expect(initialView(m, filtered)?.nodes).toEqual([{ id: "src:4" }, { id: "src:5" }]);
    });

    it("with every source hidden there is nothing to frame (the whole graph is fitted)", () => {
      const m = model({ sources: [source(1, { clusters: [{ key: "K", points: [mappedTo(1, 10)] }] })], unidentified: [] });
      expect(initialView(m, filtered)).toBeUndefined();
    });

    it("without a filter it is what it was", () => {
      expect(initialView(model(), NO_VIEW)).toEqual(initialView(model()));
    });
  });

  describe("edge ids", () => {
    it("are unique on every graph the view can make", () => {
      const assets = [asset(10, null), asset(11, 10), asset(12, 10), asset(13, 11), asset(20, 21), asset(21, 20)];
      const m = model({
        assets,
        sources: [
          source(1, { clusters: [{ key: "G", points: pts(120, (i) => [10, 11, 12, 13, null, null][i % 6]) }, { key: "H", points: [mappedTo(900, 12), mappedTo(901, 13)] }], ungrouped: [mappedTo(950, 10)] }),
          source(2, { clusters: [{ key: "K", points: [mappedTo(1000, 11), mappedTo(1001, 12), point(1002, "u")] }] }),
        ],
      });
      const views: GraphView[] = [NO_VIEW, paged, filtered, closed(10), closed(11, 20), { ...paged, ...closed(10), unmappedOnly: true }, { ...paged, shown: new Map([[G, 80]]) }];
      const opens = [none, everythingOpen(m), { sources: new Set([1, 2]), clusters: new Set<string>() }, openG];
      for (const view of views) {
        for (const open of opens) {
          const { edges, nodes } = buildGraph(m, open, { view, animate: true });
          expect(new Set(edges.map((e) => e.id)).size).toBe(edges.length);
          expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
        }
      }
    });
  });
});

// ---- w33: a new source that looks like an old one that stopped answering, and a different server at an address ----
describe("what the card and the panel say about a move offer, two candidates and a different server (w33)", () => {
  const match = { kind: "same_server" as const, evidence: "uri" as const, value: "urn:dcdash:simulator:dev", addresses: 12, missing_addresses: 0, needs_tick: false };
  const offer = {
    kind: "offer" as const, from_source_id: 2, from_name: "OPC UA server at 172.20.0.3:4840", from_endpoint: "opc.tcp://172.20.0.3:4840/dcdash/", from_since: "2026-10-18T04:52:51Z",
    mappings: 12, assets: 3, match,
  };
  const identity = { application_uri: null, application_name: null, product_uri: null, thumbprint: null, instance: null, usable: true, different: false };
  const SEEN = "Seen in scan #8, 2 min ago";
  const SENTENCE = "This looks like OPC UA server at 172.20.0.3:4840 (12 mappings on 3 assets), which has not answered since 18 Oct 07:52";
  const LINE = "Looks like OPC UA server (12 mappings)";

  it("moveOfferFor: the offer of a source, and nothing for two candidates, a null or an absent candidate", () => {
    expect(moveOfferFor(source(1, { move_candidate: offer }))).toBe(offer);
    expect(moveOfferFor(source(1, { move_candidate: { kind: "two", count: 2 } }))).toBeNull();
    expect(moveOfferFor(source(1, { move_candidate: null }))).toBeNull();
    expect(moveOfferFor(source(1))).toBeNull();
  });

  it("twoServers and isDifferentServer read the two flags and nothing else", () => {
    expect(twoServers(source(1, { move_candidate: { kind: "two", count: 3 } }))).toBe(true);
    expect(twoServers(source(1, { move_candidate: offer }))).toBe(false);
    expect(twoServers(source(1))).toBe(false);
    expect(isDifferentServer(source(1, { identity: { ...identity, different: true } }))).toBe(true);
    expect(isDifferentServer(source(1, { identity: { ...identity, different: false } }))).toBe(false);
    expect(isDifferentServer(source(1, { identity: null }))).toBe(false);
    expect(isDifferentServer(source(1))).toBe(false);
    expect(DIFFERENT_SERVER).toBe("A different server answers at this address");
  });

  it("looksLikeLine leads with the identifying part: the old source's title without the address its name ends with, then the mappings; the ellipsis cuts after it", () => {
    expect(looksLikeLine(offer)).toBe(LINE);
    expect(looksLikeLine({ ...offer, mappings: 1 })).toBe("Looks like OPC UA server (1 mapping)");
    expect(looksLikeLine({ ...offer, mappings: 1200 })).toBe("Looks like OPC UA server (1,200 mappings)");
    // a name somebody typed, or an address that is not the source's own, stays whole (the helper of the card's title)
    expect(looksLikeLine({ ...offer, from_name: "Meter room 2" })).toBe("Looks like Meter room 2 (12 mappings)");
    expect(looksLikeLine({ ...offer, from_name: "OPC UA server at 10.9.9.9:4840" })).toBe("Looks like OPC UA server at 10.9.9.9:4840 (12 mappings)");
    expect(looksLikeLine({ ...offer, from_endpoint: "" })).toBe("Looks like OPC UA server at 172.20.0.3:4840 (12 mappings)");
  });

  it("looksLikeSentence is the whole sentence: the full name, the mappings in words, and since when it has not answered (the time the page formats from from_since)", () => {
    expect(looksLikeSentence(offer, "18 Oct 07:52")).toBe(SENTENCE);
    expect(looksLikeSentence({ ...offer, mappings: 1, assets: 1 }, "18 Oct 07:52")).toBe(
      "This looks like OPC UA server at 172.20.0.3:4840 (1 mapping on 1 asset), which has not answered since 18 Oct 07:52");
    expect(looksLikeSentence({ ...offer, mappings: 1200, assets: 0 }, "18 Oct 07:52")).toBe(
      "This looks like OPC UA server at 172.20.0.3:4840 (1,200 mappings), which has not answered since 18 Oct 07:52"); // en-US thousands; no assets, no "on 0 assets"
  });

  it("looksLikeSentence without a time: the address is said only when the name does not hold it already, and never twice", () => {
    // from_since null (or a time that cannot be read): the name holds the address, so the sentence just stops after the counts
    expect(looksLikeSentence({ ...offer, from_since: null })).toBe("This looks like OPC UA server at 172.20.0.3:4840 (12 mappings on 3 assets)");
    expect(looksLikeSentence(offer, null)).toBe("This looks like OPC UA server at 172.20.0.3:4840 (12 mappings on 3 assets)");
    // a name that is not the address (a name somebody typed): the old fallback
    expect(looksLikeSentence({ ...offer, from_name: "Meter room 2" })).toBe("This looks like Meter room 2 (12 mappings on 3 assets), which stopped answering at 172.20.0.3:4840");
    expect(looksLikeSentence({ ...offer, from_name: "Meter room 2", from_endpoint: "opc.tcp://[::1]:4840" })).toContain("which stopped answering at [::1]:4840");
    // no endpoint at all (a connector without a URL): no empty "at"
    expect(looksLikeSentence({ ...offer, from_name: "Meter room 2", from_endpoint: "" })).toBe("This looks like Meter room 2 (12 mappings on 3 assets)");
  });

  it("seenCard, an offer: the short line, and the tooltip carries the whole sentence and then the seen line", () => {
    expect(seenCard(source(1, { move_candidate: offer }), SEEN, SENTENCE)).toEqual({ line: LINE, title: `${SENTENCE}. ${SEEN}` });
    // without the page's sentence (a caller that has no site clock) the card builds one without the time
    expect(seenCard(source(1, { move_candidate: offer }), SEEN)).toEqual({
      line: LINE, title: `This looks like OPC UA server at 172.20.0.3:4840 (12 mappings on 3 assets). ${SEEN}`,
    });
  });

  it("seenCard, two candidates: the sentence, no button's worth of anything else", () => {
    expect(seenCard(source(1, { move_candidate: { kind: "two", count: 2 } }), SEEN)).toEqual({
      line: "Two servers could be this one; edit the address by hand", title: `Two servers could be this one; edit the address by hand. ${SEEN}`,
    });
    expect(seenCard(source(1, { move_candidate: { kind: "two", count: 3 } }), SEEN)).toEqual({
      line: "Several servers could be this one; edit the address by hand", title: `Several servers could be this one; edit the address by hand. ${SEEN}`,
    });
  });

  it("seenCard, a different server: the warning line first (any source, added by hand too), with the tone, and the tooltip keeps the offer and the seen line", () => {
    const different = { ...identity, different: true };
    expect(seenCard(source(1, { identity: different }), SEEN)).toEqual({ line: DIFFERENT_SERVER, title: `${DIFFERENT_SERVER}. ${SEEN}`, tone: "warn" });
    expect(seenCard(source(1, { origin: "manual", identity: different }), "Added by hand")).toEqual({ line: DIFFERENT_SERVER, title: `${DIFFERENT_SERVER}. Added by hand`, tone: "warn" });
    expect(seenCard(source(1, { identity: different, move_candidate: offer }), SEEN, SENTENCE)).toEqual({ line: DIFFERENT_SERVER, title: `${DIFFERENT_SERVER}. ${SENTENCE}. ${SEEN}`, tone: "warn" });
  });

  it("seenCard leaves every other source as it was: the seen line, and the mapped not-seen sentence", () => {
    expect(seenCard(source(1, { move_candidate: null, identity }), SEEN)).toEqual({ line: SEEN, title: SEEN });
    expect(seenCard(source(1), SEEN)).toEqual({ line: SEEN, title: SEEN });
    const miss = { scan_id: 7, at: "2026-10-15T11:00:00Z", last_seen_scan_id: 5, last_seen_at: "2026-10-11T09:00:00Z" };
    const mapped = point(9, "M kW", { asset_id: 10, mapping_id: 3, mapped_metric: "active_power_kw" });
    expect(seenCard(source(1, { not_seen: miss, ungrouped: [mapped], status: "offline" }), "Not seen in scan #7")).toEqual({ line: MAPPED_NOT_SEEN, title: `Not seen in scan #7. ${MAPPED_NOT_SEEN}` });
  });
});
