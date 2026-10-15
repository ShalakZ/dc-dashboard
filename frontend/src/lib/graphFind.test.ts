import type { GraphModel } from "../api/types";
import { model, point, source } from "../test/graphFixtures";
import { buildFindIndex, findMatches, findPlan, type FindEntry, type FindKind } from "./graphFind";
import { nodeId, UNGROUPED, type OpenState } from "./graph";
import { EXPAND_NODE_BUDGET } from "./graphView";

const closed = (): OpenState => ({ sources: new Set(), clusters: new Set() });
const openOf = (sources: number[], clusters: string[] = []): OpenState => ({ sources: new Set(sources), clusters: new Set(clusters) });
const snapshot = (o: OpenState) => JSON.stringify([[...o.sources].sort(), [...o.clusters].sort()]);
const byId = (index: readonly FindEntry[], id: string): FindEntry => {
  const found = index.find((e) => e.id === id);
  if (!found) throw new Error(`no entry ${id}`);
  return found;
};
const labels = (r: { items: FindEntry[] }) => r.items.map((e) => e.label);

/** n points named `${prefix} ${i}` with ids from `from`. */
const points = (from: number, n: number, prefix = "P") => Array.from({ length: n }, (_, i) => point(from + i, `${prefix} ${i}`));
/** One source with the given groups (key -> point count); ids of the points run on from 1000. */
function sized(groups: Record<string, number>, ungrouped = 0, over: object = {}): GraphModel {
  let next = 1000;
  const clusters = Object.entries(groups).map(([key, n]) => { const c = { key, points: points(next, n, key) }; next += n; return c; });
  return model({ sources: [source(1, { name: "Plant OPC", clusters, ungrouped: points(next, ungrouped, "U"), ...over })], unidentified: [], assets: [] });
}

describe("buildFindIndex", () => {
  const index = buildFindIndex(model());
  const count = (kind: FindKind) => index.filter((e) => e.kind === kind).length;

  it("has one entry per source, asset, group (the Ungrouped one included) and point", () => {
    expect([count("source"), count("asset"), count("cluster"), count("point")]).toEqual([2, 2, 4, 9]);
    expect(index).toHaveLength(17);
  });

  it("uses the canvas node ids", () => {
    expect(index.map((e) => e.id)).toEqual(expect.arrayContaining([
      nodeId.source(1), nodeId.asset(11), nodeId.cluster(1, "LVP01"), nodeId.cluster(1, UNGROUPED), nodeId.point(7),
    ]));
    expect(new Set(index.map((e) => e.id)).size).toBe(index.length);
  });

  it("keeps the label as written and the search text lowercased", () => {
    const p = byId(index, nodeId.point(2));
    expect(p.label).toBe("LVP01 kWh");
    expect(p.text).toBe(p.text.toLowerCase());
    expect(p.text).toContain("lvp01 kwh");
    expect(p.text).toContain("a2"); // the address
  });

  it("finds a source by name and by endpoint (opc.tcp url, host:port, simulator url)", () => {
    const m = model({ sources: [
      source(1, { name: "Plant OPC", config: { endpoint: "opc.tcp://10.1.2.3:4840" } }),
      source(2, { name: "Meter bus", connector_type: "modbus", config: { host: "10.9.9.9", port: 502 } }),
      source(3, { name: "Sim", connector_type: "simulator", config: { url: "sim://lab:9000" } }),
      source(4, { name: "Bare", config: {} }),
    ] });
    const idx = buildFindIndex(m);
    expect(findMatches(idx, "10.1.2.3").items.map((e) => e.id)).toEqual([nodeId.source(1)]);
    expect(findMatches(idx, "10.9.9.9:502").items.map((e) => e.id)).toEqual([nodeId.source(2)]);
    expect(findMatches(idx, "lab:9000").items.map((e) => e.id)).toEqual([nodeId.source(3)]);
    expect(findMatches(idx, "bare").items.map((e) => e.id)).toEqual([nodeId.source(4)]);
    expect(byId(idx, nodeId.source(1)).context).toContain("opc.tcp://10.1.2.3:4840");
  });

  it("finds an asset by name and by kind", () => {
    const idx = buildFindIndex(model({ assets: [{ id: 10, parent_id: null, name: "Site", kind: "generic" }, { id: 11, parent_id: 10, name: "Panel 1", kind: "ups" }] }));
    expect(findMatches(idx, "ups").items.map((e) => e.id)).toEqual([nodeId.asset(11)]);
    expect(byId(idx, nodeId.asset(11)).context).toContain("Site");
  });

  it("puts a point's group and source on its muted line, and the Ungrouped ones under Ungrouped", () => {
    expect(byId(index, nodeId.point(2)).context).toBe("point in LVP01 · s1");
    expect(byId(index, nodeId.point(7)).context).toBe("point in Ungrouped · s1");
    expect(byId(index, nodeId.cluster(1, UNGROUPED)).label).toBe("Ungrouped");
    expect(byId(index, nodeId.cluster(1, "LVP02")).context).toBe("group in s1");
  });

  it("indexes a model without sources or assets", () => {
    expect(buildFindIndex(model({ sources: [], assets: [], unidentified: [] }))).toEqual([]);
  });
});

describe("findMatches", () => {
  const index = buildFindIndex(model());

  it("returns nothing for an empty or blank query", () => {
    expect(findMatches(index, "")).toEqual({ items: [], more: 0 });
    expect(findMatches(index, "   \t ")).toEqual({ items: [], more: 0 });
  });

  it("returns nothing, and no error, when nothing matches", () => {
    expect(findMatches(index, "zzz")).toEqual({ items: [], more: 0 });
  });

  it("is not case sensitive and trims the query", () => {
    expect(labels(findMatches(index, "  LVP02 KWH "))).toEqual(["LVP02 kWh"]);
  });

  it("needs every term, in any order", () => {
    expect(labels(findMatches(index, "kwh lvp01"))).toEqual(["LVP01 kWh"]);
    expect(findMatches(index, "lvp01 zzz").items).toEqual([]);
  });

  it("matches the address of a point too", () => {
    expect(labels(findMatches(index, "a8"))).toEqual(["M kW"]);
  });

  it("treats regex characters as plain text", () => {
    expect(() => findMatches(index, "(")).not.toThrow();
    expect(findMatches(index, ".*")).toEqual({ items: [], more: 0 });
    const idx = buildFindIndex(sized({ "A.B": 1, AxB: 1 }));
    expect(findMatches(idx, "a.b").items.filter((e) => e.kind === "cluster").map((e) => e.label)).toEqual(["A.B"]);
  });

  it("ranks a label that starts with the first term, then a word that starts with it, then anywhere", () => {
    const m = model({ sources: [source(1, { name: "S", clusters: [{ key: "G", points: [
      point(1, "xlvp01 other"), point(2, "Main lvp01"), point(3, "LVP01 main"), point(4, "main-LVP01.b"),
    ] }] })], assets: [], unidentified: [] });
    expect(labels(findMatches(buildFindIndex(m), "lvp01"))).toEqual(["LVP01 main", "Main lvp01", "main-LVP01.b", "xlvp01 other"]);
  });

  it("breaks a tie by kind (source, asset, group, point) and then by the order of the index", () => {
    const m = model({
      sources: [source(1, { name: "Plant", clusters: [{ key: "Plant", points: [point(1, "Plant b"), point(2, "Plant a")] }] })],
      assets: [{ id: 5, parent_id: null, name: "Plant", kind: "generic" }], unidentified: [],
    });
    expect(findMatches(buildFindIndex(m), "plant").items.map((e) => e.id)).toEqual([
      nodeId.source(1), nodeId.asset(5), nodeId.cluster(1, "Plant"), nodeId.point(1), nodeId.point(2)]);
  });

  it("ranks by the FIRST term only", () => {
    const m = model({ sources: [source(1, { name: "S", clusters: [{ key: "G", points: [point(1, "kw lvp01"), point(2, "lvp01 kw")] }] })], assets: [], unidentified: [] });
    expect(labels(findMatches(buildFindIndex(m), "lvp01 kw"))[0]).toBe("lvp01 kw");
    expect(labels(findMatches(buildFindIndex(m), "kw lvp01"))[0]).toBe("kw lvp01");
  });

  it("caps the list at 50 and counts the rest in `more`", () => {
    const idx = buildFindIndex(sized({ G: 120 }));
    const result = findMatches(idx, "g 1");
    expect(result.items).toHaveLength(50);
    expect(result.more).toBe(findMatches(idx, "g 1", 1000).items.length - 50);
    expect(result.more).toBeGreaterThan(0);
    const few = findMatches(idx, "g 1", 7);
    expect(few.items).toHaveLength(7);
    expect(few.more + 7).toBe(findMatches(idx, "g 1", 1000).items.length);
  });

  it("does not change the index it searches", () => {
    const copy = JSON.stringify(index);
    findMatches(index, "lvp");
    expect(JSON.stringify(index)).toBe(copy);
  });

  it("builds an index of 6,000 points and answers in well under 50 ms (asserted under 200 ms; measured: build about 1.5 ms, a search about 1 ms)", () => {
    const big = sized({ A: 1000, B: 1000, C: 1000, D: 1000, E: 1000, F: 1000 });
    const t0 = performance.now();
    const idx = buildFindIndex(big);
    const t1 = performance.now();
    expect(idx.length).toBe(1 + 6 + 6000);
    const one = findMatches(idx, "a 9");
    const t2 = performance.now();
    findMatches(idx, "p");
    const wide = findMatches(idx, "1");
    const t3 = performance.now();
    expect(one.items.length).toBeGreaterThan(0);
    expect(wide.items).toHaveLength(50);
    expect(t1 - t0).toBeLessThan(200);
    expect(t2 - t1).toBeLessThan(200);
    expect(t3 - t2).toBeLessThan(400);
  });
});

describe("findPlan", () => {
  const m = model();
  const index = buildFindIndex(m);
  const plan = (id: string, open: OpenState = closed(), budget?: number) => findPlan(m, open, byId(index, id), budget);

  it("a source or an asset is always on the canvas: nothing to open", () => {
    for (const id of [nodeId.source(1), nodeId.asset(10)]) {
      const open = openOf([2], ["cluster:2:M"]);
      const result = plan(id, open);
      expect(result.targetId).toBe(id);
      expect(result.note).toBeNull();
      expect(snapshot(result.open)).toBe(snapshot(open));
    }
  });

  it("a group opens its source and stays closed itself", () => {
    const result = plan(nodeId.cluster(1, "LVP01"));
    expect([...result.open.sources]).toEqual([1]);
    expect([...result.open.clusters]).toEqual([]);
    expect(result.targetId).toBe("cluster:1:LVP01");
    expect(result.note).toBeNull();
  });

  it("a point in a small group opens its source and its group", () => {
    const result = plan(nodeId.point(2));
    expect([...result.open.sources]).toEqual([1]);
    expect([...result.open.clusters]).toEqual(["cluster:1:LVP01"]);
    expect(result.targetId).toBe("point:2");
    expect(result.note).toBeNull();
  });

  it("an ungrouped point opens the Ungrouped group", () => {
    const result = plan(nodeId.point(7));
    expect([...result.open.clusters]).toEqual([nodeId.cluster(1, UNGROUPED)]);
    expect(result.targetId).toBe("point:7");
  });

  it("keeps whatever else is open", () => {
    const open = openOf([2], ["cluster:2:M"]);
    const result = plan(nodeId.point(2), open);
    expect([...result.open.sources].sort()).toEqual([1, 2]);
    expect([...result.open.clusters].sort()).toEqual(["cluster:1:LVP01", "cluster:2:M"]);
  });

  it("a point that is already drawn changes nothing (the same state back, so nothing is rebuilt)", () => {
    const open = openOf([1], ["cluster:1:LVP01"]);
    const result = plan(nodeId.point(2), open);
    expect(result.open).toBe(open);
    expect(result.targetId).toBe("point:2");
    expect(result.note).toBeNull();
  });

  it("never changes the state it is given", () => {
    const open = openOf([2], ["cluster:2:M"]);
    const before = snapshot(open);
    plan(nodeId.point(2), open);
    plan(nodeId.cluster(1, "LVP02"), open);
    expect(snapshot(open)).toBe(before);
  });

  it("an id the graph no longer holds (it was refreshed while the box was open) changes nothing", () => {
    const open = openOf([2]);
    const result = findPlan(m, open, { id: "point:999", kind: "point", label: "x", context: "", text: "x" });
    expect(result.open).toBe(open);
    expect(result.targetId).toBe("point:999");
    expect(result.note).toBeNull();
  });

  describe("over the node budget", () => {
    const big = sized({ SMALL: 10, BIG: 6000 });
    const bigIndex = buildFindIndex(big);
    const pointIn = (prefix: string, i: number) => bigIndex.find((e) => e.kind === "point" && e.label === `${prefix} ${i}`)!;

    it("a point in a group that is too big leaves the group closed and points at the group, with a note naming the count", () => {
      const result = findPlan(big, closed(), pointIn("BIG", 5));
      expect([...result.open.sources]).toEqual([1]);
      expect([...result.open.clusters]).toEqual([]);
      expect(result.targetId).toBe(nodeId.cluster(1, "BIG"));
      expect(result.note).toBe("BIG has 6,000 points, too many to draw at once. Showing the group instead.");
    });

    it("the same group with the source already open: the source stays, the group stays closed", () => {
      const result = findPlan(big, openOf([1]), pointIn("BIG", 5));
      expect([...result.open.sources]).toEqual([1]);
      expect(result.open.clusters.size).toBe(0);
      expect(result.targetId).toBe(nodeId.cluster(1, "BIG"));
    });

    it("a small group of the same source still opens", () => {
      const result = findPlan(big, closed(), pointIn("SMALL", 3));
      expect([...result.open.clusters]).toEqual([nodeId.cluster(1, "SMALL")]);
      expect(result.targetId).toBe(pointIn("SMALL", 3).id);
      expect(result.note).toBeNull();
    });

    it("a budget is a parameter, and the default is the Expand all one", () => {
      const point3 = pointIn("SMALL", 3);
      expect(findPlan(big, closed(), point3, EXPAND_NODE_BUDGET).note).toBeNull();
      expect(findPlan(big, closed(), point3).note).toBeNull();
      const tight = findPlan(big, closed(), point3, 5); // 2 groups + 10 points
      expect(tight.targetId).toBe(nodeId.cluster(1, "SMALL"));
      expect(tight.note).toContain("SMALL has 10 points");
      const fits = findPlan(big, closed(), point3, 12); // exactly 2 + 10
      expect(fits.targetId).toBe(point3.id);
    });

    it("names the Ungrouped group by its source", () => {
      const withUngrouped = sized({ A: 1 }, 700);
      const entry = buildFindIndex(withUngrouped).find((e) => e.label === "U 3")!;
      const result = findPlan(withUngrouped, closed(), entry);
      expect(result.targetId).toBe(nodeId.cluster(1, UNGROUPED));
      expect(result.note).toBe("Ungrouped in Plant OPC has 700 points, too many to draw at once. Showing the group instead.");
    });

    it("a closed source drags its already-open groups in when it opens: they are closed first, and the note says so", () => {
      const two = sized({ A: 500, B: 200 });
      const open = openOf([], [nodeId.cluster(1, "A")]);
      const before = snapshot(open);
      const entry = buildFindIndex(two).find((e) => e.label === "B 7")!;
      const result = findPlan(two, open, entry);
      // 2 groups + 500 points of the open A + 200 points of B = 702 > 600; without A it is 202
      expect([...result.open.sources]).toEqual([1]);
      expect([...result.open.clusters]).toEqual([nodeId.cluster(1, "B")]);
      expect(result.targetId).toBe(entry.id);
      expect(result.note).toBe("Opening Plant OPC would draw more than 600 nodes, so its open groups were closed.");
      expect(snapshot(open)).toBe(before);
    });

    it("the same groups fit when the source is already open: nothing is closed", () => {
      const two = sized({ A: 500, B: 200 });
      const open = openOf([1], [nodeId.cluster(1, "A")]);
      const entry = buildFindIndex(two).find((e) => e.label === "B 7")!;
      const result = findPlan(two, open, entry, 250);
      expect([...result.open.clusters].sort()).toEqual([nodeId.cluster(1, "A"), nodeId.cluster(1, "B")]);
      expect(result.note).toBeNull();
    });

    it("a group target over budget through its open groups: they are closed, the source opens", () => {
      const two = sized({ A: 700, B: 3 });
      const open = openOf([], [nodeId.cluster(1, "A")]);
      const entry = buildFindIndex(two).find((e) => e.id === nodeId.cluster(1, "B"))!;
      const result = findPlan(two, open, entry);
      expect([...result.open.sources]).toEqual([1]);
      expect(result.open.clusters.size).toBe(0);
      expect(result.targetId).toBe(entry.id);
      expect(result.note).toContain("open groups were closed");
    });

    it("both at once: the open groups are closed and the target group is still too big", () => {
      const three = sized({ A: 400, BIG: 900 });
      const open = openOf([], [nodeId.cluster(1, "A")]);
      const entry = buildFindIndex(three).find((e) => e.label === "BIG 1")!;
      const result = findPlan(three, open, entry);
      expect(result.open.clusters.size).toBe(0);
      expect(result.targetId).toBe(nodeId.cluster(1, "BIG"));
      expect(result.note).toBe(
        "Opening Plant OPC would draw more than 600 nodes, so its open groups were closed. BIG has 900 points, too many to draw at once. Showing the group instead.");
    });
  });
});
