import type { Edge, Node } from "@xyflow/react";
import type { GraphModel, GraphPoint } from "../api/types";
import {
  ASSET_PAGE, NO_VIEW, PAGE_SIZE, UNGROUPED, buildGraph, layoutBatches, moreNodeIds, nodeId, ownPlaces, pruneAssetsShown,
  type GraphView, type OpenState,
} from "./graph";
import { pickDropTarget } from "./drop";
import { model, point, source } from "../test/graphFixtures";

// w37: a parent with more than ASSET_PAGE sub-assets is drawn as ONE summary node (`more:asset:<parent>`), the sub-assets 50 at a time.
// The models here are built from the shared fixtures (never from graph.test.ts, whose describes would run twice).

const none: OpenState = { sources: new Set(), clusters: new Set() };
const A = (id: number, parent: number | null, name = `A${id}`) => ({ id, parent_id: parent, name, kind: "generic" });
const pt = (id: number, assetId: number | null): GraphPoint =>
  assetId === null ? point(id, `p${id}`) : point(id, `p${id}`, { asset_id: assetId, mapping_id: id, mapped_metric: "active_power_kw" });
const paged = (shown: [number, number][] = [], extra: Partial<GraphView> = {}): GraphView =>
  ({ ...NO_VIEW, assetPageSize: ASSET_PAGE, assetsShown: new Map(shown), ...extra });
const find = (nodes: Node[], id: string) => nodes.find((n) => n.id === id);
const assetNodes = (nodes: Node[]) => nodes.filter((n) => n.type === "asset").map((n) => n.id);
/** The number of mapped points the `m:` edges stand for (a label "N mapped" is N, no label is one). */
const mappedSum = (edges: Edge[]) => edges.filter((e) => e.id.startsWith("m:")).reduce((sum, e) => sum + (e.label ? parseInt(String(e.label), 10) : 1), 0);
const unique = (edges: Edge[]) => new Set(edges.map((e) => e.id)).size === edges.length;

const ROOM = 100;
/** "Room 3" (id 100, a root) with `n` sub-assets (ids 1000...), then `extra` assets. */
const family = (n: number, extra: ReturnType<typeof A>[] = []) =>
  [A(ROOM, null, "Room 3"), ...Array.from({ length: n }, (_, i) => A(1000 + i, ROOM, `Child ${i + 1}`)), ...extra];
const familyModel = (n: number, sources: GraphModel["sources"] = [], extra: ReturnType<typeof A>[] = []) =>
  model({ sources, assets: family(n, extra), unidentified: [] });

/** The owner's shape: MV2, three rooms, five racks under each of rooms 1 and 2, 400 sub-assets under room 3 (one point of a large source each), a small source on nine racks (six points each). */
const ownerShape = (): GraphModel => {
  const assets = [A(1, null, "MV2"), A(2, 1, "Room 1"), A(3, 1, "Room 2"), A(4, 1, "Room 3")];
  for (let i = 0; i < 5; i++) assets.push(A(10 + i, 2, `Rack ${i + 1}`), A(20 + i, 3, `Rack ${i + 6}`));
  for (let i = 0; i < 400; i++) assets.push(A(1000 + i, 4, `PDU${i + 1}`));
  const large = Array.from({ length: 400 }, (_, i) => pt(i + 1, 1000 + i));
  const racks = [10, 11, 12, 13, 14, 20, 21, 22, 23]; // nine of the ten racks
  const small = racks.flatMap((rack, r) => Array.from({ length: 6 }, (_, k) => pt(600 + r * 6 + k, rack)));
  return model({
    sources: [
      source(1, { name: "Large", point_count: 400, large: { points: 400, mapped: 400, unmapped: 0, rules_new: 0 }, clusters: [{ key: "K", points: large }] }),
      source(2, { name: "Small", point_count: 54, clusters: [{ key: "R", points: small }] }),
    ],
    assets, unidentified: [],
  });
};

describe("buildGraph: a parent with many sub-assets", () => {
  it("owner shape at rest builds 17 nodes and 24 edges", () => {
    const { nodes, edges } = buildGraph(ownerShape(), none, { view: paged() });
    expect(nodes).toHaveLength(17);
    expect(edges).toHaveLength(24);
    expect(find(nodes, "more:asset:4")).toMatchObject({
      type: "moreAssets", draggable: false, selectable: false, focusable: false,
      data: { parentId: 4, parentName: "Room 3", left: 400, step: 50, shown: 0, mapped: 400, navParent: "asset:4" },
    });
    expect(edges.find((e) => e.id === "m:src:1>more:asset:4")).toMatchObject({ source: "src:1", target: "more:asset:4", label: "400 mapped" });
    expect(edges.filter((e) => e.source === "src:2" && e.label === "6 mapped")).toHaveLength(9);
    const hierarchy = edges.find((e) => e.id === "a:4>more:asset:4");
    expect(hierarchy).toMatchObject({ source: "asset:4", target: "more:asset:4" });
    expect(hierarchy?.style).toBeUndefined();
    expect(unique(edges)).toBe(true);
    expect(mappedSum(edges)).toBe(454);
  });

  it("a parent with exactly 50 children builds as without assetPageSize", () => {
    const m = familyModel(50, [source(1, { clusters: [{ key: "K", points: [pt(1, 1000), pt(2, 1049)] }] })]);
    const open: OpenState = { sources: new Set([1]), clusters: new Set([nodeId.cluster(1, "K")]) };
    for (const state of [none, open]) {
      expect(buildGraph(m, state, { view: paged() })).toStrictEqual(buildGraph(m, state, { view: NO_VIEW }));
    }
    expect(buildGraph(m, none, { view: paged() }).nodes.some((n) => n.type === "moreAssets")).toBe(false);
  });

  it("a parent with 51 children draws no child and a summary of 51", () => {
    const { nodes, edges } = buildGraph(familyModel(51), none, { view: paged() });
    expect(nodes.map((n) => n.id)).toEqual(["asset:100", "more:asset:100"]);
    expect(find(nodes, "more:asset:100")?.data).toMatchObject({ left: 51, step: 50, shown: 0, mapped: 0 });
    expect(edges.map((e) => e.id)).toEqual(["a:100>more:asset:100"]);
    // the parent still says how many sub-assets it has
    expect(find(nodes, "asset:100")?.data).toMatchObject({ children: 51, collapsed: false });
  });

  it("the output equals the output without the fields for every model of the shared fixtures", () => {
    const cycle = [A(1, 2), A(2, 3), A(3, 1), A(4, null), A(5, 5), A(6, 99)]; // a cycle, a root, a self-parent and an orphan
    const tree = [A(10, null), A(11, 10), A(12, 11), A(13, 11), A(14, 10), A(15, null)];
    const mapped = [source(1, { clusters: [{ key: "K", points: [pt(1, 12), pt(2, 12), pt(3, 14), pt(4, 99), pt(5, null)] }], ungrouped: [pt(6, 11)] })];
    const models: GraphModel[] = [
      model(), familyModel(50), familyModel(50, mapped.map((s) => ({ ...s, clusters: [{ key: "K", points: [pt(1, 1000), pt(2, 1001)] }] }))),
      model({ assets: cycle, sources: mapped }), model({ assets: tree, sources: mapped }), model({ assets: tree, sources: mapped, layout: { "asset:11": { x: 900, y: 40 } } }),
    ];
    const states: OpenState[] = [
      none, { sources: new Set([1]), clusters: new Set() }, { sources: new Set([1, 2]), clusters: new Set([nodeId.cluster(1, "K"), nodeId.cluster(1, "LVP01"), nodeId.cluster(1, UNGROUPED), nodeId.cluster(2, "M")]) },
    ];
    const views: GraphView[] = [
      NO_VIEW, { ...NO_VIEW, unmappedOnly: true }, { ...NO_VIEW, pageSize: PAGE_SIZE }, { ...NO_VIEW, assetsClosed: new Set([11, 1, 5]) },
      { ...NO_VIEW, pageSize: 2, shown: new Map([[nodeId.cluster(1, "K"), 3]]) },
    ];
    let compared = 0;
    for (const m of models) for (const state of states) for (const view of views) for (const extra of [{}, { animate: true }, { moved: new Map([["asset:10", { x: 5, y: 6 }]]) }, { ignoreSaved: true }]) {
      const plain = buildGraph(m, state, { ...extra, view });
      const withFields = buildGraph(m, state, { ...extra, view: { ...view, assetPageSize: ASSET_PAGE, assetsShown: new Map([[10, 3], [ROOM, 7]]) } });
      expect(withFields).toStrictEqual(plain);
      expect(buildGraph(m, state, { ...extra, view: { ...view, assetsShown: new Map([[10, 3]]) } })).toStrictEqual(plain); // no assetPageSize: the shown map alone changes nothing
      compared++;
    }
    expect(compared).toBe(6 * 3 * 5 * 4);
  });

  it("shown 100 draws the first 100 children in order, then the summary with left 300 and mapped counted over the hidden ones", () => {
    const points = Array.from({ length: 400 }, (_, i) => pt(i + 1, 1000 + i));
    const m = familyModel(400, [source(1, { clusters: [{ key: "K", points }] })]);
    const { nodes, edges } = buildGraph(m, none, { view: paged([[ROOM, 100]]) });
    expect(assetNodes(nodes)).toEqual(["asset:100", ...Array.from({ length: 100 }, (_, i) => `asset:${1000 + i}`)]);
    expect(nodes[nodes.length - 1]?.id).toBe("more:asset:100");
    expect(nodes[nodes.length - 1]?.data).toMatchObject({ left: 300, step: 50, shown: 100, mapped: 300 });
    // the closed source: 100 edges to the drawn children (one each), one to the summary labelled 300
    expect(edges.filter((e) => e.id.startsWith("m:src:1>asset:"))).toHaveLength(100);
    expect(edges.find((e) => e.id === "m:src:1>more:asset:100")?.label).toBe("300 mapped");
    expect(edges.filter((e) => e.id.startsWith("a:100>"))).toHaveLength(101);
    // the last page: 30 left, the step is what is left
    const last = buildGraph(m, none, { view: paged([[ROOM, 370]]) });
    expect(find(last.nodes, "more:asset:100")?.data).toMatchObject({ left: 30, step: 30, shown: 370, mapped: 30 });
  });

  it("shown >= children draws all and no summary", () => {
    const m = familyModel(120);
    for (const shown of [120, 121, 5000]) {
      const { nodes, edges } = buildGraph(m, none, { view: paged([[ROOM, shown]]) });
      expect(nodes, String(shown)).toHaveLength(121);
      expect(nodes.some((n) => n.type === "moreAssets"), String(shown)).toBe(false);
      expect(edges.some((e) => e.target.startsWith("more:")), String(shown)).toBe(false);
    }
  });

  it("a folded parent draws no summary and keeps its badge", () => {
    const m = familyModel(60, [source(1, { clusters: [{ key: "K", points: [pt(1, 1000), pt(2, 1001), pt(3, ROOM)] }] })]);
    const { nodes, edges } = buildGraph(m, none, { view: paged([[ROOM, 10]], { assetsClosed: new Set([ROOM]) }) });
    expect(nodes.map((n) => n.id)).toEqual(["src:1", "asset:100"]);
    expect(nodes.some((n) => n.type === "moreAssets")).toBe(false);
    expect(find(nodes, "asset:100")?.data).toMatchObject({ children: 60, collapsed: true, mappedInside: 3 });
    expect(find(nodes, "asset:100")?.ariaLabel).toBe("Room 3, asset, 60 sub-assets, 3 mapped inside, closed");
    expect(edges.map((e) => e.id)).toEqual(["m:src:1>asset:100"]);
    expect(edges[0]?.label).toBe("3 mapped");
  });

  it("a hidden child's subtree is hidden and its mapped points end on the summary", () => {
    const extra = [A(9000, 1000, "Deep"), A(9001, 9000, "Deeper"), A(9002, 1003, "Other deep")];
    const m = familyModel(60, [source(1, { clusters: [{ key: "K", points: [pt(1, 1000), pt(2, 9000), pt(3, 9001), pt(4, 9002), pt(5, 1010)] }] })], extra);
    const { nodes, edges } = buildGraph(m, none, { view: paged() });
    expect(nodes.map((n) => n.id)).toEqual(["src:1", "asset:100", "more:asset:100"]);
    expect(assetNodes(nodes)).toEqual(["asset:100"]);
    expect(edges.map((e) => e.id).sort()).toEqual(["a:100>more:asset:100", "m:src:1>more:asset:100"]);
    expect(edges.find((e) => e.target === "more:asset:100" && e.id.startsWith("m:"))?.label).toBe("5 mapped");
    expect(find(nodes, "more:asset:100")?.data).toMatchObject({ left: 60, mapped: 5 });
  });

  it("a point mapped under a hidden grandchild counts once", () => {
    const m = familyModel(60, [source(1, { clusters: [{ key: "K", points: [pt(1, 9000)] }] })], [A(9000, 1005, "Deep")]);
    const { edges } = buildGraph(m, none, { view: paged() });
    expect(edges.filter((e) => e.id.startsWith("m:"))).toEqual([expect.objectContaining({ id: "m:src:1>more:asset:100", target: "more:asset:100" })]);
    expect(edges.find((e) => e.id.startsWith("m:"))?.label).toBeUndefined();
    expect(mappedSum(edges)).toBe(1);
  });

  it("an open group's mapped point under a hidden child ends on the summary with no label (n = 1), a closed group's with the count", () => {
    const m = familyModel(60, [source(1, { clusters: [{ key: "K", points: [pt(1, 1000), pt(2, 1001), pt(3, 1002)] }] })]);
    const open = buildGraph(m, { sources: new Set([1]), clusters: new Set([nodeId.cluster(1, "K")]) }, { view: paged() }).edges;
    const perPoint = open.filter((e) => e.target === "more:asset:100" && e.id.startsWith("m:"));
    expect(perPoint.map((e) => e.id).sort()).toEqual(["m:point:1>more:asset:100", "m:point:2>more:asset:100", "m:point:3>more:asset:100"]);
    expect(perPoint.every((e) => e.label === undefined)).toBe(true);
    const closedGroup = buildGraph(m, { sources: new Set([1]), clusters: new Set() }, { view: paged() }).edges;
    expect(closedGroup.filter((e) => e.id.startsWith("m:"))).toEqual([expect.objectContaining({ id: "m:cluster:1:K>more:asset:100", label: "3 mapped" })]);
  });

  it("the summary stands two rows after the last drawn subtree and follows the parent's moved place; its id is never in ownPlaces or layoutBatches", () => {
    const extra = [A(9000, 1000, "Deep"), A(2000, null, "Next root")];
    const base = familyModel(60, [], extra); // Room 3 at row 0; shown 2: child 1 row 1, its child row 2, child 2 row 3, summary row 4 (two rows), next root row 6
    const { nodes } = buildGraph(base, none, { view: paged([[ROOM, 2]]) });
    const at = (id: string) => find(nodes, id)?.position;
    expect(at("asset:100")).toEqual({ x: 1200, y: 0 });
    expect(at("asset:1000")).toEqual({ x: 1200 + 224, y: 64 });
    expect(at("asset:9000")).toEqual({ x: 1200 + 2 * 224, y: 128 });
    expect(at("asset:1001")).toEqual({ x: 1200 + 224, y: 192 });
    expect(at("more:asset:100")).toEqual({ x: 1200 + 224, y: 256 });
    expect(at("asset:2000")).toEqual({ x: 1200, y: 256 + 128 });
    // the parent moved: the summary follows like a child; so does it when an ancestor of the parent moved
    const moved = buildGraph(base, none, { view: paged([[ROOM, 2]]), moved: new Map([["asset:100", { x: 2000, y: 500 }]]) });
    expect(find(moved.nodes, "more:asset:100")?.position).toEqual({ x: 1200 + 224 + 800, y: 256 + 500 });
    const deeper = model({ sources: [], assets: [A(1, null, "Root"), A(ROOM, 1, "Room 3"), ...Array.from({ length: 60 }, (_, i) => A(1000 + i, ROOM))], unidentified: [] });
    const grand = buildGraph(deeper, none, { view: paged(), moved: new Map([["asset:1", { x: 1300, y: 100 }]]) });
    expect(find(grand.nodes, "more:asset:100")?.position).toEqual({ x: 1200 + 2 * 224 + 100, y: 2 * 64 + 100 });
    // a saved place under its id is ignored, and the id is never a place of its own
    const saved = buildGraph({ ...base, layout: { "more:asset:100": { x: 7, y: 7 } } }, none, { view: paged([[ROOM, 2]]), moved: new Map([["more:asset:100", { x: 9, y: 9 }]]) });
    expect(find(saved.nodes, "more:asset:100")?.position).toEqual({ x: 1200 + 224, y: 256 });
    const places = ownPlaces({ ...base, layout: { "more:asset:100": { x: 7, y: 7 }, "asset:100": { x: 1, y: 2 } } }, { moved: new Map([["more:asset:100", { x: 9, y: 9 }]]) });
    expect([...places.keys()]).toEqual(["asset:100"]);
    expect(layoutBatches([["more:asset:100", { x: 1, y: 1 }], ["asset:100", { x: 2, y: 2 }]])).toEqual([[{ node_id: "asset:100", x: 2, y: 2 }]]);
  });

  describe("moreNodeIds", () => {
    const tree = () => model({
      assets: [
        A(1, null, "Root"), A(2, 1, "Room A"), A(3, 1, "Room B"), A(4, 1, "Room C"),
        ...Array.from({ length: 51 }, (_, i) => A(200 + i, 2)), ...Array.from({ length: 60 }, (_, i) => A(400 + i, 3)), ...Array.from({ length: 50 }, (_, i) => A(600 + i, 4)),
      ],
      unidentified: [],
    });

    it("for an ancestor lists the summaries below it (and its own); for an asset with 50 or fewer children it is []", () => {
      expect(moreNodeIds(tree(), "asset:1")).toEqual(["more:asset:2", "more:asset:3"]);
      expect(moreNodeIds(tree(), "asset:2")).toEqual(["more:asset:2"]);
      expect(moreNodeIds(tree(), "asset:3")).toEqual(["more:asset:3"]);
      for (const id of ["asset:4", "asset:200", "asset:400"]) expect(moreNodeIds(tree(), id), id).toEqual([]); // 50 children (room C) and leaves
      expect(moreNodeIds(familyModel(50), "asset:100")).toEqual([]);
      expect(moreNodeIds(familyModel(51), "asset:100")).toEqual(["more:asset:100"]);
    });

    it("for an unknown id it is []", () => {
      for (const id of ["asset:9999", "asset:", "asset:abc", "more:asset:2", "garbage"]) expect(moreNodeIds(tree(), id), id).toEqual([]);
    });

    it("is cycle safe", () => {
      // a pure cycle 1 -> 2 -> 3 -> 1, with 60 children under 2
      const m = model({ assets: [A(1, 3), A(2, 1), A(3, 2), ...Array.from({ length: 60 }, (_, i) => A(100 + i, 2))], unidentified: [] });
      expect(moreNodeIds(m, "asset:1")).toEqual(["more:asset:2"]);
      expect(moreNodeIds(m, "asset:3")).toEqual(["more:asset:2"]);
    });
  });

  it("the summary is never a drop target", () => {
    expect(pickDropTarget([{ id: "more:asset:4" }])).toBeNull();
    expect(pickDropTarget([{ id: "more:asset:4" }, { id: "asset:7" }])).toBe(7);
  });

  it("a paged group's remainder edge counts mapped points that sit under hidden children on the summary", () => {
    const points = Array.from({ length: 120 }, (_, i) => pt(i + 1, 1000 + (i % 60)));
    const m = familyModel(60, [source(1, { clusters: [{ key: "K", points }] })]);
    const open: OpenState = { sources: new Set([1]), clusters: new Set([nodeId.cluster(1, "K")]) };
    const view = paged([], { pageSize: PAGE_SIZE });
    const { nodes, edges } = buildGraph(m, open, { view });
    expect(nodes.filter((n) => n.type === "point")).toHaveLength(50);
    expect(edges.find((e) => e.id === "m:cluster:1:K>more:asset:100")?.label).toBe("70 mapped");
    expect(edges.filter((e) => e.id.startsWith("m:point:") && e.target === "more:asset:100")).toHaveLength(50);
    expect(mappedSum(edges)).toBe(120);
    expect(unique(edges)).toBe(true);
    // and when part of the children are drawn, the rest of the points split between the children and the summary
    const some = buildGraph(m, open, { view: paged([[ROOM, 10]], { pageSize: PAGE_SIZE }) });
    expect(mappedSum(some.edges)).toBe(120);
    expect(some.edges.find((e) => e.id === "m:cluster:1:K>more:asset:100")).toBeDefined();
  });

  it("Unmapped only draws no m: edge to the summary while the node still says N mapped", () => {
    const points = [...Array.from({ length: 4 }, (_, i) => pt(i + 1, 1000 + i)), pt(10, null), pt(11, null)];
    const m = familyModel(60, [source(1, { clusters: [{ key: "K", points }] })]);
    for (const state of [none as OpenState, { sources: new Set([1]), clusters: new Set<string>() }, { sources: new Set([1]), clusters: new Set([nodeId.cluster(1, "K")]) }]) {
      const { nodes, edges } = buildGraph(m, state, { view: paged([], { unmappedOnly: true }) });
      expect(edges.some((e) => e.id.startsWith("m:"))).toBe(false);
      expect(find(nodes, "more:asset:100")?.data).toMatchObject({ left: 60, mapped: 4 });
      expect(edges.some((e) => e.id === "a:100>more:asset:100")).toBe(true);
    }
  });

  it("a point mapped directly to the summarised parent and one under a hidden child, same source: two edges, no collision", () => {
    const m = familyModel(60, [source(1, { clusters: [{ key: "K", points: [pt(1, ROOM), pt(2, 1000)] }] })]);
    const { edges } = buildGraph(m, none, { view: paged() });
    expect(edges.filter((e) => e.id.startsWith("m:")).map((e) => e.id).sort()).toEqual(["m:src:1>asset:100", "m:src:1>more:asset:100"]);
    expect(unique(edges)).toBe(true);
  });

  it("invariant: over the owner shape with the large source open, closed, filtered and paged, the m: edge counts equal the mapped points drawn plus hidden", () => {
    const m = ownerShape();
    const both = (clusters: string[]) => ({ sources: new Set([1, 2]), clusters: new Set(clusters) });
    const states: OpenState[] = [
      none, { sources: new Set([1]), clusters: new Set() }, { sources: new Set([2]), clusters: new Set() },
      { sources: new Set([1]), clusters: new Set([nodeId.cluster(1, "K")]) }, both([nodeId.cluster(1, "K"), nodeId.cluster(2, "R")]), both([]),
    ];
    for (const [i, state] of states.entries()) {
      for (const pageSize of [Infinity, PAGE_SIZE]) for (const shown of [0, 100, 400, 1000]) {
        const view = paged(shown > 0 ? [[4, shown]] : [], { pageSize });
        const { edges, nodes } = buildGraph(m, state, { view });
        const label = `state ${i}, page ${pageSize}, shown ${shown}`;
        expect(mappedSum(edges), label).toBe(454);
        expect(unique(edges), label).toBe(true);
        const nodeIds = new Set(nodes.map((n) => n.id));
        expect(edges.every((e) => nodeIds.has(e.source) && nodeIds.has(e.target)), label).toBe(true);
        const filtered = buildGraph(m, state, { view: { ...view, unmappedOnly: true } });
        expect(mappedSum(filtered.edges), `${label}, filtered`).toBe(0); // "Unmapped only" draws no mapped edge at all
        expect(unique(filtered.edges), `${label}, filtered`).toBe(true);
      }
    }
  });

  it("a cycle head's already-visited children are not counted in left", () => {
    // 1 (C) is a child of 2 (B), B of 3 (A), A of 1: a pure cycle, walked from C (first in the list): C -> A -> B, and B's children are C (already drawn) and 60 more
    const m = model({ sources: [], assets: [A(1, 2, "C"), A(3, 1, "A"), A(2, 3, "B"), ...Array.from({ length: 60 }, (_, i) => A(100 + i, 2))], unidentified: [] });
    const { nodes, edges } = buildGraph(m, none, { view: paged() });
    expect(assetNodes(nodes)).toEqual(["asset:1", "asset:3", "asset:2"]);
    expect(find(nodes, "more:asset:2")?.data).toMatchObject({ parentId: 2, left: 60, shown: 0 });
    expect(edges.map((e) => e.id).sort()).toEqual(["a:1>3", "a:2>1", "a:2>more:asset:2", "a:3>2"]);
  });

  it("pruneAssetsShown drops closed parents and returns the same map when nothing drops", () => {
    const shown = new Map([[4, 100], [7, 50]]);
    expect(pruneAssetsShown(shown, new Set())).toBe(shown);
    expect(pruneAssetsShown(shown, new Set([9]))).toBe(shown);
    const pruned = pruneAssetsShown(shown, new Set([4, 9]));
    expect([...pruned]).toEqual([[7, 50]]);
    expect([...shown]).toEqual([[4, 100], [7, 50]]); // the one passed in is never changed
  });

  it("a root with 60 children is summarised but the set of roots never is (80 roots draw 80 nodes)", () => {
    const roots = model({ sources: [], assets: Array.from({ length: 80 }, (_, i) => A(i + 1, null)), unidentified: [] });
    const { nodes } = buildGraph(roots, none, { view: paged() });
    expect(nodes).toHaveLength(80);
    expect(nodes.every((n) => n.type === "asset")).toBe(true);
    expect(buildGraph(familyModel(60), none, { view: paged() }).nodes.map((n) => n.id)).toEqual(["asset:100", "more:asset:100"]);
  });

  it("two summarised parents each get their own summary, and a hidden child keeps its fold for the page it is drawn on", () => {
    const m = model({ sources: [], assets: [A(1, null), A(2, 1), A(3, 1), ...Array.from({ length: 51 }, (_, i) => A(100 + i, 2)), ...Array.from({ length: 55 }, (_, i) => A(300 + i, 3)), A(900, 100)], unidentified: [] });
    const { nodes } = buildGraph(m, none, { view: paged() });
    expect(nodes.map((n) => n.id)).toEqual(["asset:1", "asset:2", "more:asset:2", "asset:3", "more:asset:3"]);
    // the fold of a child that is hidden today is still in the view and applies once it is drawn
    const later = buildGraph(m, none, { view: paged([[2, 1]], { assetsClosed: new Set([100]) }) });
    expect(find(later.nodes, "asset:100")?.data).toMatchObject({ collapsed: true, children: 1 });
    expect(find(later.nodes, "asset:900")).toBeUndefined();
    expect(find(later.nodes, "more:asset:2")?.data).toMatchObject({ left: 50, shown: 1 });
  });
});
