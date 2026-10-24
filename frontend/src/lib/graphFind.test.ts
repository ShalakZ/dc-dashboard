import type { GraphModel } from "../api/types";
import { model, point, source } from "../test/graphFixtures";
import { buildFindIndex, extendPagesFor, findMatches, findPlan, type FindEntry, type FindKind } from "./graphFind";
import { ASSET_PAGE, NO_VIEW, PAGE_SIZE, nodeId, UNGROUPED, type GraphView, type OpenState } from "./graph";
import { EXPAND_NODE_BUDGET } from "./graphView";
import { assetIcon } from "./assetIcons";
import { clusterIcon } from "./graphIcons";

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

  it("a point that is the same tag as a mapped one says so first on its muted line, so two options of one name differ (w34)", () => {
    const twinned = buildFindIndex(model({
      sources: [source(1, { name: "s1", clusters: [{ key: "G", points: [point(1, "PM0_P", { asset_id: 10, mapping_id: 5 }), point(2, "PM0_P", { same_tag_as: 1 }), point(3, "PM0_Q", { same_tag_as: 99 })] }], ungrouped: [] })],
      assets: [{ id: 10, parent_id: null, name: "Site", kind: "generic" }], unidentified: [],
    }));
    expect(byId(twinned, nodeId.point(1)).context).toBe("point in G · s1"); // the mapped point: as it was
    expect(byId(twinned, nodeId.point(2)).context).toBe("already mapped as PM0_P · point in G · s1"); // the twin: the reason first, the name it is a twin of
    expect(byId(twinned, nodeId.point(3)).context).toBe("already mapped as another point · point in G · s1"); // a twin of a point that is not in the source
    expect(byId(twinned, nodeId.point(2)).text).toBe(byId(twinned, nodeId.point(1)).text.replace("a1", "a2")); // what a query is matched against is not touched
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
    const result = findPlan(m, open, { id: "point:999", kind: "point", label: "x", context: "", text: "x", icon: "metricOther" });
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

    it("(w36: the known limit of before, changed on purpose) a closed source with more groups than the budget is not opened for a group target either; Expand all refuses it the same way", () => {
      const wide = sized(Object.fromEntries(Array.from({ length: EXPAND_NODE_BUDGET + 100 }, (_v, i) => [`G${i}`, 1])));
      const entry = buildFindIndex(wide).find((e) => e.id === nodeId.cluster(1, "G5"))!;
      const result = findPlan(wide, closed(), entry);
      expect(result.open.sources.size).toBe(0); // 700 groups alone are more than the budget: nothing opens
      expect(result.open.clusters.size).toBe(0);
      expect(result.targetId).toBe(nodeId.source(1)); // the card is what the person is taken to
      expect(result.note).toBe("Plant OPC has 700 groups, too many to draw; use Map by shape");
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

/* ---------------------------------------------------------------------------------------------------------------------------- W12b: the view */

describe("findPlan with a view", () => {
  const paged = (over: Partial<GraphView> = {}): GraphView => ({ ...NO_VIEW, pageSize: PAGE_SIZE, ...over });
  const filtered = (over: Partial<GraphView> = {}): GraphView => paged({ unmappedOnly: true, ...over });
  const plan = (m: GraphModel, label: string, open: OpenState, view: GraphView, budget?: number) => {
    const entry = buildFindIndex(m).find((e) => e.label === label);
    if (!entry) throw new Error(`no entry ${label}`);
    return findPlan(m, open, entry, budget, view);
  };
  const FAR = (group: string, count: string) =>
    `${group} has ${count} points; the one you chose is too far down to draw at once. Showing the group: use Show 50 more to go on.`;
  /** One source with one group per entry [key, total, mapped]: the first `mapped` points of a group are mapped to asset 10. */
  function mixed(groups: [string, number, number][]): GraphModel {
    let next = 5000;
    const clusters = groups.map(([key, n, mapped]) => {
      const c = { key, points: Array.from({ length: n }, (_, i) => point(next + i, `${key} ${i}`, i < mapped ? { asset_id: 10 } : {})) };
      next += n;
      return c;
    });
    return model({ sources: [source(1, { name: "Plant OPC", clusters })], unidentified: [], assets: [] });
  }
  const BIG = sized({ SMALL: 10, BIG: 6000 });
  const big = nodeId.cluster(1, "BIG");

  it("with NO_VIEW (or none) the plan is the old one, and carries no view", () => {
    const entry = buildFindIndex(BIG).find((e) => e.label === "BIG 5")!;
    const old = findPlan(BIG, closed(), entry);
    const same = findPlan(BIG, closed(), entry, EXPAND_NODE_BUDGET, NO_VIEW);
    expect(same).toEqual(old);
    expect("view" in same).toBe(false);
    expect(old.note).toBe("BIG has 6,000 points, too many to draw at once. Showing the group instead.");
  });

  describe("pages", () => {
    it("a point on the first page opens its group and changes no page: no view comes back", () => {
      const result = plan(BIG, "BIG 49", closed(), paged());
      expect([...result.open.clusters]).toEqual([big]);
      expect(result.targetId).toBe(buildFindIndex(BIG).find((e) => e.label === "BIG 49")!.id);
      expect(result.note).toBeNull();
      expect("view" in result).toBe(false);
    });

    it.each([
      ["BIG 50", 100], ["BIG 99", 100], ["BIG 100", 150], ["BIG 120", 150], ["BIG 540", 550],
    ])("%s extends the page of its group to %i (a whole number of pages)", (label, extent) => {
      const result = plan(BIG, label, closed(), paged());
      expect(result.view?.shown.get(big)).toBe(extent);
      expect([...result.open.clusters]).toEqual([big]);
      expect(result.note).toBeNull();
      expect(result.targetId).toBe(buildFindIndex(BIG).find((e) => e.label === label)!.id);
    });

    it("the extent never goes past the points the group has", () => {
      const m = sized({ G: 120 });
      expect(plan(m, "G 119", closed(), paged()).view?.shown.get(nodeId.cluster(1, "G"))).toBe(120);
      expect(plan(m, "G 105", closed(), paged()).view?.shown.get(nodeId.cluster(1, "G"))).toBe(120);
    });

    it("a group of one page or less is never paged: no view", () => {
      const m = sized({ G: 50, H: 30 });
      expect("view" in plan(m, "G 49", closed(), paged())).toBe(false);
      expect("view" in plan(m, "H 29", closed(), paged())).toBe(false);
    });

    it("an open group whose page is short is extended; its open state is the same object", () => {
      const open = openOf([1], [big]);
      const result = plan(BIG, "BIG 70", open, paged());
      expect(result.open).toBe(open);
      expect(result.view?.shown.get(big)).toBe(100);
    });

    it("a page that is long enough already changes nothing at all", () => {
      const open = openOf([1], [big]);
      const result = plan(BIG, "BIG 70", open, paged({ shown: new Map([[big, 150]]) }));
      expect(result.open).toBe(open);
      expect("view" in result).toBe(false);
    });

    it("a page is never shortened", () => {
      const result = plan(BIG, "BIG 120", openOf([1], [big]), paged({ shown: new Map([[big, 300]]) }));
      expect("view" in result).toBe(false);
    });

    it("keeps the other pages and the other fields of the view it is given, and never changes it", () => {
      const other = nodeId.cluster(1, "SMALL");
      const view = paged({ shown: new Map([[other, 77]]), assetsClosed: new Set([3]), unmappedOnly: false });
      const result = plan(BIG, "BIG 120", closed(), view);
      expect(result.view?.shown.get(other)).toBe(77);
      expect(result.view?.shown.get(big)).toBe(150);
      expect([...result.view!.assetsClosed]).toEqual([3]);
      expect(result.view?.pageSize).toBe(PAGE_SIZE);
      expect(view.shown.has(big)).toBe(false);
    });

    it("counts the position among the points the filter lets through, and leaves the filter on", () => {
      const m = mixed([["G", 400, 300]]); // 100 unmapped: G 300 ... G 399
      const result = plan(m, "G 380", closed(), filtered()); // 81st unmapped point
      expect(result.view?.shown.get(nodeId.cluster(1, "G"))).toBe(100);
      expect(result.view?.unmappedOnly).toBe(true);
      expect(result.note).toBeNull();
      expect("view" in plan(m, "G 320", closed(), filtered())).toBe(false); // the 21st: on the first page
    });

    describe("over the budget", () => {
      it("a point too far down falls back to the group, opened on its page, with the new note", () => {
        const result = plan(BIG, "BIG 5000", closed(), paged());
        expect(result.targetId).toBe(big);
        expect([...result.open.sources]).toEqual([1]);
        expect([...result.open.clusters]).toEqual([big]);
        expect(result.note).toBe(FAR("BIG", "6,000"));
        expect("view" in result).toBe(false);
      });

      it("the same, naming the Ungrouped group by its source", () => {
        const m = sized({ A: 1 }, 700);
        const result = plan(m, "U 650", closed(), paged());
        expect(result.targetId).toBe(nodeId.cluster(1, UNGROUPED));
        expect(result.note).toBe(FAR("Ungrouped in Plant OPC", "700"));
      });

      it("the budget is a parameter: a page and a half costs the extent plus the `more` node", () => {
        const m = sized({ G: 200 });
        const g = nodeId.cluster(1, "G");
        // the source costs 1 group; G 120 needs 150 points + the `more` node
        expect(plan(m, "G 120", closed(), paged(), 152).view?.shown.get(g)).toBe(150);
        const tight = plan(m, "G 120", closed(), paged(), 151);
        expect(tight.targetId).toBe(g);
        expect(tight.note).toBe(FAR("G", "200"));
        expect([...tight.open.clusters]).toEqual([g]); // 1 + 51 fits: the group opens on its first page
        expect("view" in tight).toBe(false);
      });

      it("when even the first page does not fit, the group stays closed as before", () => {
        const m = sized({ G: 200 });
        const result = plan(m, "G 120", closed(), paged(), 30);
        expect(result.targetId).toBe(nodeId.cluster(1, "G"));
        expect(result.open.clusters.size).toBe(0);
        expect(result.note).toBe(FAR("G", "200"));
      });

      it("an open group with a long page is charged only for the points it still has to draw", () => {
        const m = sized({ G: 400 });
        const g = nodeId.cluster(1, "G");
        const open = openOf([1], [g]);
        const view = paged({ shown: new Map([[g, 100]]) });
        expect(plan(m, "G 190", open, view, 100).view?.shown.get(g)).toBe(200); // 100 more points, the `more` node is there already
        expect(plan(m, "G 190", open, view, 99).targetId).toBe(g);
      });

      it("a closed source drags its open groups in, at their paged cost, and they are closed first when that is too much", () => {
        const m = sized({ A: 700, B: 200 });
        const [a, b] = [nodeId.cluster(1, "A"), nodeId.cluster(1, "B")];
        const open = openOf([], [a]);
        const view = paged({ shown: new Map([[a, 300]]) });
        // 2 groups + A's 300 + `more` + B's 100 + `more` = 404
        const roomy = plan(m, "B 70", open, view, 404);
        expect([...roomy.open.clusters].sort()).toEqual([a, b]);
        expect(roomy.note).toBeNull();
        expect(roomy.view?.shown.get(a)).toBe(300);
        const result = plan(m, "B 70", open, view, 403);
        expect([...result.open.clusters]).toEqual([b]);
        expect(result.note).toBe("Opening Plant OPC would draw more than 403 nodes, so its open groups were closed.");
        expect(result.view?.shown.has(a)).toBe(false); // A starts again at one page when it is opened next
        expect(result.view?.shown.get(b)).toBe(100);
      });
    });
  });

  describe("folded assets", () => {
    const assets = [
      { id: 10, parent_id: null, name: "Site", kind: "generic" }, { id: 11, parent_id: 10, name: "Hall", kind: "generic" },
      { id: 13, parent_id: 11, name: "Rack", kind: "generic" }, { id: 20, parent_id: null, name: "Other", kind: "generic" },
    ];
    const m = model({ assets });
    const plan1 = (id: string, closedAssets: number[], open: OpenState = closed()) =>
      findPlan(m, open, byId(buildFindIndex(m), id), EXPAND_NODE_BUDGET, paged({ assetsClosed: new Set(closedAssets) }));

    it("an asset inside folded assets opens its folded ancestors, and only them", () => {
      const open = openOf([2]);
      const result = plan1(nodeId.asset(13), [10, 11, 20], open);
      expect([...result.view!.assetsClosed]).toEqual([20]);
      expect(result.targetId).toBe("asset:13");
      expect(result.open).toBe(open);
      expect(result.note).toBeNull();
    });

    it("one folded ancestor is enough", () => {
      expect([...plan1(nodeId.asset(13), [10]).view!.assetsClosed]).toEqual([]);
      expect([...plan1(nodeId.asset(13), [11, 20]).view!.assetsClosed]).toEqual([20]);
    });

    it("the asset itself may stay folded: it is drawn", () => {
      const result = plan1(nodeId.asset(11), [10, 11]);
      expect([...result.view!.assetsClosed]).toEqual([11]);
      expect("view" in plan1(nodeId.asset(11), [11])).toBe(false);
    });

    it("an asset nothing hides changes nothing", () => {
      expect("view" in plan1(nodeId.asset(13), [])).toBe(false);
      expect("view" in plan1(nodeId.asset(13), [20])).toBe(false);
      expect("view" in plan1(nodeId.asset(10), [10])).toBe(false);
    });

    it("is safe on a cycle, an orphan and a self-parent", () => {
      const odd = model({ assets: [
        { id: 10, parent_id: 11, name: "A", kind: "generic" }, { id: 11, parent_id: 10, name: "B", kind: "generic" },
        { id: 12, parent_id: 99, name: "Orphan", kind: "generic" }, { id: 13, parent_id: 13, name: "Loop", kind: "generic" },
      ] });
      const run = (id: string, closedAssets: number[]) => findPlan(odd, closed(), byId(buildFindIndex(odd), id), EXPAND_NODE_BUDGET, paged({ assetsClosed: new Set(closedAssets) }));
      expect([...run(nodeId.asset(11), [10, 11]).view!.assetsClosed]).toEqual([11]);
      expect("view" in run(nodeId.asset(12), [12, 99])).toBe(false);
      expect("view" in run(nodeId.asset(13), [13])).toBe(false);
    });

    it("never changes the set it is given", () => {
      const folded = new Set([10, 11]);
      findPlan(m, closed(), byId(buildFindIndex(m), nodeId.asset(13)), EXPAND_NODE_BUDGET, paged({ assetsClosed: folded }));
      expect([...folded]).toEqual([10, 11]);
    });
  });

  describe("the Unmapped only filter", () => {
    const m = mixed([["DONE", 3, 3], ["TODO", 3, 0], ["MIXED", 4, 1]]);

    it("a mapped point is hidden: the filter goes off, the point is shown, the toast says why", () => {
      const result = plan(m, "MIXED 0", closed(), filtered());
      expect(result.view?.unmappedOnly).toBe(false);
      expect(result.note).toBe("Unmapped only is off so MIXED 0 can be shown.");
      expect([...result.open.sources]).toEqual([1]);
      expect([...result.open.clusters]).toEqual([nodeId.cluster(1, "MIXED")]);
      expect(result.targetId).toBe(buildFindIndex(m).find((e) => e.label === "MIXED 0")!.id);
    });

    it("a point that is the same tag as a mapped one is hidden by the filter too: the filter goes off (w34)", () => {
      const twinned = mixed([["MIXED", 3, 1]]);
      twinned.sources[0].clusters[0].points[1] = { ...twinned.sources[0].clusters[0].points[1], same_tag_as: twinned.sources[0].clusters[0].points[0].id };
      const result = plan(twinned, "MIXED 1", closed(), filtered());
      expect(result.view?.unmappedOnly).toBe(false);
      expect(result.note).toBe("Unmapped only is off so MIXED 1 can be shown.");
      expect("view" in plan(twinned, "MIXED 2", closed(), filtered())).toBe(false);
    });

    it("a group the filter hides, the same", () => {
      const result = plan(m, "DONE", closed(), filtered());
      expect(result.view?.unmappedOnly).toBe(false);
      expect(result.note).toBe("Unmapped only is off so DONE can be shown.");
      expect(result.targetId).toBe(nodeId.cluster(1, "DONE"));
      expect([...result.open.sources]).toEqual([1]);
    });

    it("a source the filter hides, the same: the source is on the canvas at once, so nothing opens", () => {
      const allMapped = mixed([["A", 2, 2]]);
      const open = closed();
      const result = plan(allMapped, "Plant OPC", open, filtered());
      expect(result.view?.unmappedOnly).toBe(false);
      expect(result.note).toBe("Unmapped only is off so Plant OPC can be shown.");
      expect(result.targetId).toBe(nodeId.source(1));
      expect(result.open).toBe(open);
    });

    it("a node the filter shows leaves it on, and no view comes back", () => {
      for (const label of ["TODO 1", "TODO", "MIXED 2", "MIXED", "Plant OPC"]) expect("view" in plan(m, label, closed(), filtered())).toBe(false);
      expect(plan(m, "TODO 1", closed(), filtered()).note).toBeNull();
    });

    it("an asset is never hidden by the filter", () => {
      const withAsset = model({ assets: [{ id: 10, parent_id: null, name: "Site", kind: "generic" }] });
      const result = findPlan(withAsset, closed(), byId(buildFindIndex(withAsset), nodeId.asset(10)), EXPAND_NODE_BUDGET, filtered());
      expect("view" in result).toBe(false);
    });

    it("with the filter off nothing is hidden", () => {
      expect("view" in plan(m, "MIXED 0", closed(), paged())).toBe(false);
    });

    it("the plan is worked out with the filter off: all the group's points are there to draw and to page", () => {
      const heavy = mixed([["G", 700, 700]]); // every point mapped: hidden source, group and points
      const result = plan(heavy, "G 650", closed(), filtered());
      expect(result.view?.unmappedOnly).toBe(false);
      // 1 group + 700 points (a whole number of pages is the whole group) is over 600: the group, on its first page
      expect(result.targetId).toBe(nodeId.cluster(1, "G"));
      expect(result.note).toBe(`Unmapped only is off so G 650 can be shown. ${FAR("G", "700")}`);
      expect([...result.open.clusters]).toEqual([nodeId.cluster(1, "G")]);
    });

    it("the filter note comes first and joins the others with a space", () => {
      const heavy = mixed([["A", 400, 0], ["B", 700, 700]]);
      const open = openOf([], [nodeId.cluster(1, "A")]);
      const result = plan(heavy, "B 650", open, filtered(), 500);
      expect(result.note).toBe(
        `Unmapped only is off so B 650 can be shown. Opening Plant OPC would draw more than 500 nodes, so its open groups were closed. ${FAR("B", "700")}`);
    });

    it("never changes the view it is given", () => {
      const view = filtered();
      plan(m, "MIXED 0", closed(), view);
      expect(view.unmappedOnly).toBe(true);
    });
  });
});

describe("buildFindIndex icons (w12c)", () => {
  const withIcons = model({
    sources: [
      source(1, { name: "Plant OPC", clusters: [{ key: "G", points: [
        point(1, "Volts", { mapped_metric: "voltage_v" }),
        point(2, "Amps", { suggestion: { metric: "current_a", scale: 1, interval_seconds: 5, custom_unit: null } }),
        point(3, "Power", { mapped_metric: "active_power_kw" }),
        point(4, "Energy", { mapped_metric: "energy_kwh" }),
        point(5, "Other"),
      ] }] }),
      source(2, { name: "Meter bus", connector_type: "modbus" }),
      source(3, { name: "Sim", connector_type: "simulator" }),
      source(4, { name: "Mystery", connector_type: "http" }),
    ],
    assets: [
      { id: 10, parent_id: null, name: "Chosen", kind: "generic", icon: "battery", kind_icon: "panel" },
      { id: 11, parent_id: 10, name: "From kind", kind: "weird", icon: null, kind_icon: "ups" },
      { id: 12, parent_id: 10, name: "By guess", kind: "UPS room" },
    ],
  });
  const index = buildFindIndex(withIcons);

  it("gives a source the icon of its protocol, and the generic one for a type it does not know", () => {
    expect(byId(index, nodeId.source(1)).icon).toBe("protoOpcua");
    expect(byId(index, nodeId.source(2)).icon).toBe("protoModbus");
    expect(byId(index, nodeId.source(3)).icon).toBe("protoSimulator");
    expect(byId(index, nodeId.source(4)).icon).toBe("sources");
  });

  it("gives an asset the very icon assetIcon gives (a chosen one, the kind's, or the keyword guess)", () => {
    for (const asset of withIcons.assets) expect(byId(index, nodeId.asset(asset.id)).icon, asset.name).toBe(assetIcon(asset));
    expect(byId(index, nodeId.asset(10)).icon).toBe("kindBattery");
    expect(byId(index, nodeId.asset(11)).icon).toBe("kindUps");
  });

  it("gives a group the layers icon", () => {
    expect(byId(index, nodeId.cluster(1, "G")).icon).toBe(clusterIcon);
  });

  it("gives a point the icon of its mapped metric, else of the suggested one", () => {
    expect(byId(index, nodeId.point(1)).icon).toBe("metricVoltage");
    expect(byId(index, nodeId.point(2)).icon).toBe("metricCurrent");
    expect(byId(index, nodeId.point(3)).icon).toBe("rate");
    expect(byId(index, nodeId.point(4)).icon).toBe("energy");
    expect(byId(index, nodeId.point(5)).icon).toBe("metricOther");
  });

  it("changes nothing else: the order, the ids, the labels, the contexts and the search text of the old index", () => {
    const plain = buildFindIndex(model());
    expect(plain.map((e) => e.id)).toEqual([
      nodeId.source(1), nodeId.source(2), nodeId.asset(10), nodeId.asset(11),
      nodeId.cluster(1, "LVP01"), nodeId.point(1), nodeId.point(2), nodeId.point(3),
      nodeId.cluster(1, "LVP02"), nodeId.point(4), nodeId.point(5), nodeId.point(6),
      nodeId.cluster(1, UNGROUPED), nodeId.point(7),
      nodeId.cluster(2, "M"), nodeId.point(8), nodeId.point(9),
    ]);
    expect(byId(plain, nodeId.point(2))).toMatchObject({ label: "LVP01 kWh", context: "point in LVP01 · s1", text: expect.stringContaining("lvp01 kwh") });
    expect(plain.every((e) => typeof e.icon === "string" && e.icon.length > 0)).toBe(true);
  });
});

describe("findPlan: a closed source whose groups alone are too many to draw (w36)", () => {
  /** One source with n groups of two points each ("G0 0", "G0 1", ...); `over` changes the source (a `large`, a mapped share). */
  function crowded(n: number, over: object = {}, mapped: (g: number) => boolean = () => false): GraphModel {
    let next = 1000;
    const clusters = Array.from({ length: n }, (_, g) => ({
      key: `G${g}`, points: [0, 1].map((i) => point(next++, `G${g} ${i}`, mapped(g) ? { asset_id: 10 } : {})),
    }));
    return model({ sources: [source(1, { name: "Plant OPC", clusters, ...over })], unidentified: [], assets: [] });
  }
  const entryOf = (m: GraphModel, label: string) => {
    const found = buildFindIndex(m).find((e) => e.label === label);
    if (!found) throw new Error(`no entry ${label}`);
    return found;
  };
  const SENTENCE = (n: string) => `Plant OPC has ${n} groups, too many to draw; use Map by shape`;
  const withFilter = (over: Partial<GraphView> = {}): GraphView => ({ ...NO_VIEW, pageSize: PAGE_SIZE, unmappedOnly: true, ...over });

  it("a group or a point of such a source opens nothing and targets the source card, with the number and where to go", () => {
    const m = crowded(13851);
    for (const label of ["G6000", "G6000 1"]) {
      const open = closed();
      const result = findPlan(m, open, entryOf(m, label));
      expect(result.open).toBe(open); // the very same object: the page rebuilds nothing
      expect(result.targetId).toBe(nodeId.source(1));
      expect(result.note).toBe(SENTENCE("13,851"));
      expect("view" in result).toBe(false);
    }
  });

  it("adds `or the Points page` only for a person who may open it", () => {
    const m = crowded(13851);
    const entry = entryOf(m, "G6000 1");
    expect(findPlan(m, closed(), entry, EXPAND_NODE_BUDGET, NO_VIEW, false).note).toBe(SENTENCE("13,851"));
    expect(findPlan(m, closed(), entry, EXPAND_NODE_BUDGET, NO_VIEW, true).note).toBe(`${SENTENCE("13,851")} or the Points page`);
    expect(findPlan(m, closed(), entry).note).toBe(SENTENCE("13,851")); // the default is the shorter sentence
  });

  it("exactly 600 groups is still opened (a group of it opens as before); 601 is not", () => {
    const m600 = crowded(600);
    const group = findPlan(m600, closed(), entryOf(m600, "G10"));
    expect([...group.open.sources]).toEqual([1]);
    expect(group.targetId).toBe(nodeId.cluster(1, "G10"));
    expect(group.note).toBeNull();
    const m601 = crowded(601);
    const refused = findPlan(m601, closed(), entryOf(m601, "G10"));
    expect(refused.open.sources.size).toBe(0);
    expect(refused.targetId).toBe(nodeId.source(1));
    expect(refused.note).toBe(SENTENCE("601"));
  });

  it("counts the Ungrouped group too", () => {
    const m = crowded(600, { ungrouped: [point(90001, "Loose 0"), point(90002, "Loose 1")] });
    expect(findPlan(m, closed(), entryOf(m, "Loose 0")).note).toBe(SENTENCE("601"));
  });

  it("a source that is already open is left as it is: the guard is for opening", () => {
    const m = crowded(13851);
    const result = findPlan(m, openOf([1]), entryOf(m, "G6000"));
    expect(result.targetId).toBe(nodeId.cluster(1, "G6000"));
    expect(result.note).toBeNull();
  });

  it("a source with `large` is guarded too (M6: the rule is for every source)", () => {
    const m = crowded(700, { large: { points: 1400, mapped: 0, unmapped: 1400, rules_new: 0 } });
    expect(findPlan(m, closed(), entryOf(m, "G5")).note).toBe(SENTENCE("700"));
  });

  it("counts the groups the Unmapped only filter lets through: 100 left of 700 opens as before", () => {
    const m = crowded(700, {}, (g) => g >= 100); // groups 100.. are fully mapped, so hidden
    const result = findPlan(m, closed(), entryOf(m, "G5"), EXPAND_NODE_BUDGET, withFilter());
    expect([...result.open.sources]).toEqual([1]);
    expect(result.note).toBeNull();
  });

  it("a target the filter hides in a visible source does not slip past: the plan would turn the filter off and draw every group, so the guard counts them all and the filter stays on", () => {
    const m = crowded(700, {}, (g) => g >= 100); // groups 100.. are fully mapped, so hidden; G5 is on the canvas
    for (const label of ["G500", "G500 0"]) { // a hidden group, and a mapped point in a hidden group
      const open = closed();
      const result = findPlan(m, open, entryOf(m, label), EXPAND_NODE_BUDGET, withFilter());
      expect(result.open).toBe(open);
      expect(result.targetId).toBe(nodeId.source(1));
      expect(result.note).toBe(SENTENCE("700"));
      expect("view" in result).toBe(false);
    }
  });

  it("the same for a mapped point and for the twin of one inside a group the filter shows", () => {
    const m = crowded(700, {}, (g) => g >= 100);
    const group = m.sources[0].clusters[5]; // G5: two unmapped points; one becomes mapped, one its twin, and a third stays to be offered
    const [mapped, twin] = group.points;
    group.points = [{ ...mapped, asset_id: 10 }, { ...twin, same_tag_as: mapped.id }, point(99999, "G5 c")];
    for (const label of [mapped.name, twin.name]) {
      const result = findPlan(m, closed(), entryOf(m, label), EXPAND_NODE_BUDGET, withFilter());
      expect(result.open.sources.size).toBe(0);
      expect(result.targetId).toBe(nodeId.source(1));
      expect(result.note).toBe(SENTENCE("700"));
      expect("view" in result).toBe(false);
    }
    const offered = findPlan(m, closed(), entryOf(m, "G5 c"), EXPAND_NODE_BUDGET, withFilter()); // an offerable point does not hide: counted under the filter, 101 groups
    expect([...offered.open.sources]).toEqual([1]);
    expect(offered.note).toBeNull();
  });

  it("a source the filter hides is shown for the plan: the filter goes off, the note says so, then the sentence", () => {
    const m = crowded(700, {}, () => true); // everything mapped: the source is hidden by the filter
    const result = findPlan(m, closed(), entryOf(m, "G5"), EXPAND_NODE_BUDGET, withFilter());
    expect(result.targetId).toBe(nodeId.source(1));
    expect(result.view?.unmappedOnly).toBe(false);
    expect(result.note).toBe(`Unmapped only is off so Plant OPC can be shown. ${SENTENCE("700")}`);
    expect(result.open.sources.size).toBe(0);
  });

  it("the budget parameter is the limit: 5 groups against a budget of 4", () => {
    const m = crowded(5);
    expect(findPlan(m, closed(), entryOf(m, "G1"), 4).note).toBe(SENTENCE("5"));
    expect(findPlan(m, closed(), entryOf(m, "G1"), 5).note).toBeNull();
  });
});

/* ---------------------------------------------------------------------------------------------------------------------------- w37: an asset behind a summary */

describe("findPlan and extendPagesFor: an asset behind a summary (w37)", () => {
  const withPages = (over: Partial<GraphView> = {}): GraphView => ({ ...NO_VIEW, pageSize: PAGE_SIZE, assetPageSize: ASSET_PAGE, ...over });
  const asset = (id: number, parent: number | null, name: string) => ({ id, parent_id: parent, name, kind: "generic" });
  /** Site (10) > Room 3 (20) > `n` PDUs: ids 1000 + the index, "PDU 1" and up. */
  const room = (n: number, prefix = "PDU ") => model({
    sources: [], unidentified: [],
    assets: [asset(10, null, "Site"), asset(20, 10, "Room 3"), ...Array.from({ length: n }, (_, i) => asset(1000 + i, 20, `${prefix}${i + 1}`))],
  });
  /** Site (10) > `halls` Halls (ids 100 and up, "Hall 1" and up); Hall 55 (id 154) has `under` UPSs (ids 5000 and up, "UPS 1" and up). */
  const campus = (halls: number, under: number) => model({
    sources: [], unidentified: [],
    assets: [
      asset(10, null, "Site"),
      ...Array.from({ length: halls }, (_, i) => asset(100 + i, 10, `Hall ${i + 1}`)),
      ...Array.from({ length: under }, (_, i) => asset(5000 + i, 154, `UPS ${i + 1}`)),
    ],
  });
  const planFor = (m: GraphModel, label: string, view: GraphView, budget?: number) => {
    const entry = buildFindIndex(m).find((e) => e.kind === "asset" && e.label === label);
    if (!entry) throw new Error(`no entry ${label}`);
    return findPlan(m, closed(), entry, budget, view);
  };
  const pagesOf = (result: { view?: GraphView }) => Object.fromEntries(result.view?.assetsShown ?? []);

  it("an asset 377th of 400 under a summarised parent extends the page to 400", () => {
    const result = planFor(room(400), "PDU 377", withPages());
    expect(pagesOf(result)).toEqual({ 20: 400 });
    expect(result.targetId).toBe("asset:1376");
    expect(result.note).toBeNull();
    expect(result.open).toBeDefined();
  });

  it("child 3 extends it to 50, child 50 stays on page 1, child 51 needs 100, 301 needs 350", () => {
    const m = room(400);
    expect(pagesOf(planFor(m, "PDU 3", withPages()))).toEqual({ 20: 50 });
    expect(pagesOf(planFor(m, "PDU 50", withPages()))).toEqual({ 20: 50 });
    expect(pagesOf(planFor(m, "PDU 51", withPages()))).toEqual({ 20: 100 });
    expect(pagesOf(planFor(m, "PDU 301", withPages()))).toEqual({ 20: 350 });
  });

  it("the page never goes past the sub-assets there are", () => {
    expect(pagesOf(planFor(room(120), "PDU 115", withPages()))).toEqual({ 20: 120 });
  });

  it("two summarised ancestors each extend (the outer one holds the inner one)", () => {
    const m = campus(60, 70); // Site has 60 Halls, Hall 55 (id 154) has 70 UPSs
    const result = planFor(m, "UPS 60", withPages());
    expect(pagesOf(result)).toEqual({ 10: 60, 154: 70 });
    expect(result.targetId).toBe("asset:5059");
    expect(result.note).toBeNull();
  });

  it("a folded ancestor plus a summary: both change in one plan", () => {
    const m = room(120);
    const result = planFor(m, "PDU 100", withPages({ assetsClosed: new Set([10]) }));
    expect([...result.view!.assetsClosed]).toEqual([]);
    expect(pagesOf(result)).toEqual({ 20: 100 });
    // the parent itself folded: it is opened, and its page (a fold forgets the pages) starts from nothing
    const parent = planFor(m, "PDU 70", withPages({ assetsClosed: new Set([20]) }));
    expect([...parent.view!.assetsClosed]).toEqual([]);
    expect(pagesOf(parent)).toEqual({ 20: 100 });
  });

  it("keeps the other pages and the other fields of the view, and never changes the map it is given", () => {
    const given = new Map([[777, 150]]);
    const view = withPages({ assetsShown: given, unmappedOnly: true });
    const result = planFor(room(400), "PDU 377", view);
    expect(pagesOf(result)).toEqual({ 777: 150, 20: 400 });
    expect(result.view!.unmappedOnly).toBe(true);
    expect([...given]).toEqual([[777, 150]]);
    expect(view.assetsShown).toBe(given);
  });

  describe("over the budget", () => {
    const SENTENCE = (parent: string, n: string, label: string) =>
      `${parent} has ${n} sub-assets; ${label} is too far down to draw at once. Showing the first ones: use Show 50 more to go on.`;

    it("over the 600 budget the plan targets the summary and says how to go on", () => {
      const result = planFor(room(5000, "PDU"), "PDU4321", withPages());
      expect(result.targetId).toBe("more:asset:20");
      expect(result.note).toBe(SENTENCE("Room 3", "5,000", "PDU4321"));
      expect("view" in result).toBe(false); // nothing else had to change: the page stays as it is
    });

    it("the budget is a parameter: 377 of 400 needs 400 new nodes", () => {
      const m = room(400);
      expect(planFor(m, "PDU 377", withPages(), 400).targetId).toBe("asset:1376");
      const tight = planFor(m, "PDU 377", withPages(), 399);
      expect(tight.targetId).toBe("more:asset:20");
      expect(tight.note).toBe(SENTENCE("Room 3", "400", "PDU 377"));
    });

    it("a page that is shown already costs nothing: only what is newly drawn counts", () => {
      const m = room(400);
      const view = withPages({ assetsShown: new Map([[20, 300]]) });
      expect(pagesOf(planFor(m, "PDU 377", view, 100))).toEqual({ 20: 400 });
      expect(planFor(m, "PDU 377", view, 99).targetId).toBe("more:asset:20");
    });

    it("outer page fits, inner page does not: the outer is extended and the target is the inner parent's summary", () => {
      const m = campus(60, 5000); // the outer page costs 60, the inner one 4,050
      const result = planFor(m, "UPS 4001", withPages());
      expect(pagesOf(result)).toEqual({ 10: 60 });
      expect(result.targetId).toBe("more:asset:154");
      expect(result.note).toBe(SENTENCE("Hall 55", "5,000", "UPS 4001"));
    });

    it("the cost runs on from the outer ancestor to the inner one", () => {
      const m = campus(60, 70); // 60 for the outer page, then 70 for the inner one
      expect(pagesOf(planFor(m, "UPS 60", withPages(), 130))).toEqual({ 10: 60, 154: 70 });
      const result = planFor(m, "UPS 60", withPages(), 129);
      expect(pagesOf(result)).toEqual({ 10: 60 });
      expect(result.targetId).toBe("more:asset:154");
    });

    it("an outer page that does not fit stops there: nothing is extended and its summary is the target", () => {
      const m = campus(60, 70);
      const result = planFor(m, "UPS 60", withPages(), 50);
      expect("view" in result).toBe(false);
      expect(result.targetId).toBe("more:asset:10");
    });
  });

  describe("nothing to do", () => {
    it("an asset already drawn leaves the plan with no view", () => {
      const m = room(400);
      expect("view" in planFor(m, "PDU 3", withPages({ assetsShown: new Map([[20, 50]]) }))).toBe(false);
      expect("view" in planFor(m, "PDU 300", withPages({ assetsShown: new Map([[20, 400]]) }))).toBe(false);
      expect("view" in planFor(m, "Room 3", withPages())).toBe(false);
      expect("view" in planFor(m, "Site", withPages())).toBe(false);
    });

    it("a parent of 50 or fewer sub-assets has no summary, so nothing is extended", () => {
      const m = room(50);
      const result = planFor(m, "PDU 50", withPages());
      expect("view" in result).toBe(false);
      expect(result.targetId).toBe("asset:1049");
    });

    it("a view with no assetPageSize (NO_VIEW) never extends anything", () => {
      const result = planFor(room(400), "PDU 377", { ...NO_VIEW });
      expect("view" in result).toBe(false);
      expect(result.targetId).toBe("asset:1376");
    });
  });

  describe("extendPagesFor", () => {
    it("returns the very map it is given when nothing changes, and a new one otherwise", () => {
      const m = room(400);
      const pages = new Map([[20, 100]]);
      const view = withPages({ assetsShown: pages });
      expect(extendPagesFor(m, view, 1010).assetsShown).toBe(pages);
      const extended = extendPagesFor(m, view, 1150);
      expect(extended.assetsShown).not.toBe(pages);
      expect(extended.stoppedAt).toBeNull();
      expect([...pages]).toEqual([[20, 100]]);
      expect(extended.assetsShown.get(20)).toBe(200);
    });

    it("answers with a stable empty map for a view with none, and for an unknown asset", () => {
      const m = room(400);
      const first = extendPagesFor(m, withPages(), 1005).assetsShown;
      expect(first.get(20)).toBe(50);
      const none = extendPagesFor(m, withPages(), 424242);
      expect(none.assetsShown.size).toBe(0);
      expect(none.stoppedAt).toBeNull();
      expect(extendPagesFor(m, withPages(), 424242).assetsShown).toBe(none.assetsShown);
    });

    it("is safe on a cycle and on a self-parent", () => {
      const odd = model({ sources: [], unidentified: [], assets: [asset(10, 11, "A"), asset(11, 10, "B"), asset(13, 13, "Loop")] });
      expect(extendPagesFor(odd, withPages(), 10).assetsShown.size).toBe(0);
      expect(extendPagesFor(odd, withPages(), 13).stoppedAt).toBeNull();
    });
  });
});
