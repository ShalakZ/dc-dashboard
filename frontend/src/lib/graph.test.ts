import type { RemoveSourcesResult } from "../api/types";
import { BLOCK_GAP, SOURCE_H, UNGROUPED, buildGraph, isRemovable, nodeId, removalDialogText, removalOutcome, seenLine, type OpenState } from "./graph";
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
