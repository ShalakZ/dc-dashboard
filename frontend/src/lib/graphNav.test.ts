import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { navFirst, navIndex, navTarget } from "./graphNav";

const at = { x: 0, y: 0 };
const source = (id: number): Node => ({ id: `src:${id}`, type: "source", position: at, data: { source: { id } } });
const cluster = (sourceId: number, key: string): Node => ({
  id: `cluster:${sourceId}:${key}`, type: "cluster", position: at, data: { sourceId, key },
});
const point = (sourceId: number, clusterKey: string, id: number): Node => ({
  id: `point:${id}`, type: "point", position: at, data: { sourceId, clusterKey },
});
const more = (clusterId: string): Node => ({ id: `more:${clusterId}`, type: "more", position: at, data: { clusterId } });
const asset = (id: number, navParent: string | null): Node => ({ id: `asset:${id}`, type: "asset", position: at, data: { navParent } });
/** (w37) The summary node of an asset with many sub-assets: it belongs to the asset column and hangs under that asset (`navParent`). */
const summary = (parentId: number): Node => ({ id: `more:asset:${parentId}`, type: "moreAssets", position: at, data: { parentId, navParent: `asset:${parentId}` } });
const unid = (host: string, port: number): Node => ({ id: `unid:${host}:${port}`, type: "unidentified", position: at, data: {} });

/** Draw order as buildGraph makes it: each source with its groups and points, then unidentified services, then the assets depth first. */
const sample = (): Node[] => [
  source(1), cluster(1, "a"), point(1, "a", 11), point(1, "a", 12), more("cluster:1:a"), cluster(1, "b"), point(1, "b", 13),
  source(2), cluster(2, "c"),
  unid("10.0.0.5", 502),
  asset(1, null), asset(2, "asset:1"), asset(3, "asset:1"), asset(4, null),
];

describe("navTarget", () => {
  const index = navIndex(sample());

  it("moves between sources with up and down and stops at the ends", () => {
    expect(navTarget(index, "src:1", "down")).toBe("src:2");
    expect(navTarget(index, "src:2", "up")).toBe("src:1");
    expect(navTarget(index, "src:1", "up")).toBeNull();
  });

  it("puts the unidentified services after the last source in the same column", () => {
    expect(navTarget(index, "src:2", "down")).toBe("unid:10.0.0.5:502");
    expect(navTarget(index, "unid:10.0.0.5:502", "up")).toBe("src:2");
    expect(navTarget(index, "unid:10.0.0.5:502", "down")).toBeNull();
  });

  it("goes from a source to its first group, and back from a group to its source", () => {
    expect(navTarget(index, "src:1", "right")).toBe("cluster:1:a");
    expect(navTarget(index, "cluster:1:a", "left")).toBe("src:1");
    expect(navTarget(index, "src:1", "left")).toBeNull();
  });

  it("walks the groups of one source as siblings", () => {
    expect(navTarget(index, "cluster:1:a", "down")).toBe("cluster:1:b");
    expect(navTarget(index, "cluster:1:b", "up")).toBe("cluster:1:a");
    expect(navTarget(index, "cluster:1:b", "down")).toBeNull();
    // The group of the other source is not a sibling.
    expect(navTarget(index, "cluster:2:c", "up")).toBeNull();
  });

  it("goes from a group to its first point and from a point back to its group", () => {
    expect(navTarget(index, "cluster:1:a", "right")).toBe("point:11");
    expect(navTarget(index, "point:11", "left")).toBe("cluster:1:a");
    expect(navTarget(index, "point:11", "down")).toBe("point:12");
    expect(navTarget(index, "point:12", "up")).toBe("point:11");
    expect(navTarget(index, "point:11", "up")).toBeNull();
  });

  it("makes the more node the last child of its group", () => {
    expect(navTarget(index, "point:12", "down")).toBe("more:cluster:1:a");
    expect(navTarget(index, "more:cluster:1:a", "up")).toBe("point:12");
    expect(navTarget(index, "more:cluster:1:a", "down")).toBeNull();
    expect(navTarget(index, "more:cluster:1:a", "left")).toBe("cluster:1:a");
    expect(navTarget(index, "more:cluster:1:a", "right")).toBeNull();
  });

  it("keeps the more node last even when it is drawn before the points", () => {
    const early = navIndex([source(1), cluster(1, "a"), more("cluster:1:a"), point(1, "a", 11), point(1, "a", 12)]);
    expect(navTarget(early, "cluster:1:a", "right")).toBe("point:11");
    expect(navTarget(early, "point:12", "down")).toBe("more:cluster:1:a");
  });

  it("gives a group with no drawn points no child", () => {
    expect(navTarget(index, "cluster:2:c", "right")).toBeNull();
  });

  it("has no right move from a point", () => {
    expect(navTarget(index, "point:11", "right")).toBeNull();
  });

  it("makes the asset roots siblings of each other and never of the sources", () => {
    expect(navTarget(index, "asset:1", "down")).toBe("asset:4");
    expect(navTarget(index, "asset:4", "up")).toBe("asset:1");
    expect(navTarget(index, "asset:1", "up")).toBeNull();
    expect(navTarget(index, "asset:4", "down")).toBeNull();
    expect(navTarget(index, "src:2", "down")).not.toBe("asset:1");
  });

  it("follows navParent for an asset: left goes to the parent asset, right to the first sub-asset", () => {
    expect(navTarget(index, "asset:2", "left")).toBe("asset:1");
    expect(navTarget(index, "asset:1", "right")).toBe("asset:2");
    expect(navTarget(index, "asset:2", "down")).toBe("asset:3");
    expect(navTarget(index, "asset:3", "up")).toBe("asset:2");
    expect(navTarget(index, "asset:3", "down")).toBeNull();
    expect(navTarget(index, "asset:1", "left")).toBeNull();
    expect(navTarget(index, "asset:4", "right")).toBeNull();
  });

  it("treats an asset whose navParent is not drawn as a root", () => {
    const orphaned = navIndex([asset(1, null), asset(5, "asset:99"), asset(6, "asset:99")]);
    expect(navTarget(orphaned, "asset:5", "left")).toBeNull();
    expect(navTarget(orphaned, "asset:1", "down")).toBe("asset:5");
    expect(navTarget(orphaned, "asset:5", "down")).toBe("asset:6");
  });

  it("treats a node whose parent is not drawn as a root of its column", () => {
    const lone = navIndex([source(1), cluster(7, "x"), point(7, "x", 70)]);
    expect(navTarget(lone, "cluster:7:x", "left")).toBeNull();
    expect(navTarget(lone, "src:1", "down")).toBe("cluster:7:x");
    expect(navTarget(lone, "point:70", "left")).toBe("cluster:7:x");
  });

  it("returns null for an id that is not in the list", () => {
    for (const move of ["up", "down", "left", "right"] as const) expect(navTarget(index, "point:999", move)).toBeNull();
  });

  it("stays put in a list with one node", () => {
    const one = navIndex([source(1)]);
    for (const move of ["up", "down", "left", "right"] as const) expect(navTarget(one, "src:1", move)).toBeNull();
  });

  it("returns null for every move on an empty list", () => {
    const empty = navIndex([]);
    expect(navTarget(empty, "src:1", "down")).toBeNull();
  });

  it("is not fooled by a navParent that names the node itself", () => {
    const self = navIndex([asset(1, "asset:1")]);
    expect(navTarget(self, "asset:1", "left")).toBeNull();
    expect(navTarget(self, "asset:1", "right")).toBeNull();
  });
});

describe("navTarget over the summary node of a parent with many sub-assets (w37)", () => {
  // Room 3 (asset:4) under MV2 (asset:1) draws two sub-assets and then its summary; Room 4 (asset:5) is its next sibling.
  const drawn = [asset(1, null), asset(4, "asset:1"), asset(10, "asset:4"), asset(11, "asset:4"), summary(4), asset(5, "asset:1")];
  const index = navIndex(drawn);

  it("Down from the last drawn sub-asset reaches the summary, Up goes back, and the summary is the last child", () => {
    expect(navTarget(index, "asset:11", "down")).toBe("more:asset:4");
    expect(navTarget(index, "more:asset:4", "up")).toBe("asset:11");
    expect(navTarget(index, "more:asset:4", "down")).toBeNull();
  });

  it("Left from the summary reaches its parent, and it has no children (Right goes nowhere)", () => {
    expect(navTarget(index, "more:asset:4", "left")).toBe("asset:4");
    expect(navTarget(index, "more:asset:4", "right")).toBeNull();
  });

  it("Right from a parent with nothing shown reaches the summary, the only child", () => {
    const none = navIndex([asset(1, null), asset(4, "asset:1"), summary(4), asset(5, "asset:1")]);
    expect(navTarget(none, "asset:4", "right")).toBe("more:asset:4");
    expect(navTarget(none, "more:asset:4", "up")).toBeNull();
  });

  it("stays the last child even when it is listed before the sub-assets", () => {
    const early = navIndex([asset(4, null), summary(4), asset(10, "asset:4"), asset(11, "asset:4")]);
    expect(navTarget(early, "asset:11", "down")).toBe("more:asset:4");
    expect(navTarget(early, "asset:4", "right")).toBe("asset:10");
  });

  it("does not disturb the parent's own siblings", () => {
    expect(navTarget(index, "asset:4", "down")).toBe("asset:5");
    expect(navTarget(index, "asset:5", "up")).toBe("asset:4");
  });

  it("belongs to the assets column: it is never the first node of the discovered one", () => {
    expect(navFirst(navIndex([summary(9), source(1)]))).toBe("src:1");
    expect(navFirst(navIndex([summary(9)]))).toBe("more:asset:9");
  });
});

describe("navFirst", () => {
  it("is the first node of the discovered column", () => {
    expect(navFirst(navIndex(sample()))).toBe("src:1");
  });

  it("skips the assets when a discovered root is drawn after them", () => {
    expect(navFirst(navIndex([asset(1, null), source(3)]))).toBe("src:3");
  });

  it("falls back to the first node when only assets are drawn", () => {
    expect(navFirst(navIndex([asset(1, null), asset(2, "asset:1")]))).toBe("asset:1");
  });

  it("is null for an empty list", () => {
    expect(navFirst(navIndex([]))).toBeNull();
  });
});

describe("navIndex", () => {
  it("builds 2,000 nodes well under 100 ms", () => {
    const nodes: Node[] = [];
    for (let s = 1; s <= 5; s++) {
      nodes.push(source(s));
      for (let c = 0; c < 5; c++) {
        nodes.push(cluster(s, `k${c}`));
        for (let p = 0; p < 90; p++) nodes.push(point(s, `k${c}`, s * 10000 + c * 100 + p));
      }
    }
    expect(nodes.length).toBeGreaterThanOrEqual(2000);
    const started = performance.now();
    const index = navIndex(nodes);
    const last = navTarget(index, "cluster:4:k0", "right");
    const elapsed = performance.now() - started;
    expect(last).toBe("point:40000");
    expect(elapsed).toBeLessThan(100);
  });
});
