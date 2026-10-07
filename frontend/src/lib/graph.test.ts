import { UNGROUPED, buildGraph, nodeId, type OpenState } from "./graph";
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
    expect(nodes.every((n) => n.draggable === true)).toBe(true);
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
