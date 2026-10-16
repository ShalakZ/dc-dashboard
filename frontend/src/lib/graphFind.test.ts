import type { GraphModel } from "../api/types";
import { model, point, source } from "../test/graphFixtures";
import { buildFindIndex, findMatches, findPlan, type FindEntry, type FindKind } from "./graphFind";
import { NO_VIEW, PAGE_SIZE, nodeId, UNGROUPED, type GraphView, type OpenState } from "./graph";
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

    it("KNOWN LIMIT: the budget counts points, not a source's own group count, so a closed source with more groups than the budget still opens for a group target (Expand all would refuse); change this on purpose, not by accident", () => {
      const wide = sized(Object.fromEntries(Array.from({ length: EXPAND_NODE_BUDGET + 100 }, (_v, i) => [`G${i}`, 1])));
      const entry = buildFindIndex(wide).find((e) => e.id === nodeId.cluster(1, "G5"))!;
      const result = findPlan(wide, closed(), entry);
      expect([...result.open.sources]).toEqual([1]); // opened, drawing 700 groups
      expect(result.open.clusters.size).toBe(0);
      expect(result.targetId).toBe(entry.id);
      expect(result.note).toBeNull(); // and no note: nothing is held back
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
