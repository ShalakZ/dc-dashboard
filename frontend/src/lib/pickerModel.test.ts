import type { Asset } from "../api/types";
import { FOLD_ROW_LIMIT } from "./foldLevels";
import {
  ancestorsOf, buildPickerModel, countsBelow, filterPicker, isFolded, pickAllUnder, sameAssets, visibleRows,
  type FoldState, type PickerModel,
} from "./pickerModel";
import { pickerRows } from "./pickerRows";

const asset = (id: number, parent_id: number | null, name: string, kind: string, sort_order = id): Asset => ({ id, parent_id, name, kind, sort_order });
const NO_STATE: FoldState = { marks: new Map(), seedOpen: new Set() };
const names = (model: PickerModel, ids: Iterable<number>) => [...ids].map((id) => model.byId.get(id)?.name);

/** The shape of the pilot hall: a site, 2 halls of 2 pods of 2 rows of 5 racks (numbered across the hall) with 2 feeds each, and a panel board. 144 assets. */
function pilotHall(): Asset[] {
  const out: Asset[] = [];
  const add = (parent: number | null, name: string, kind: string): number => {
    const id = out.length + 1;
    out.push(asset(id, parent, name, kind));
    return id;
  };
  const site = add(null, "Seeded pilot hall", "Site");
  for (const hall of [1, 2]) {
    const hallId = add(site, `Hall ${hall}`, "Hall");
    let rack = 0;
    for (const pod of ["A", "B"]) {
      const podId = add(hallId, `Pod ${pod}`, "Pod");
      for (const row of [1, 2]) {
        const rowId = add(podId, `Row ${row}`, "Row");
        for (let i = 0; i < 5; i++) {
          rack += 1;
          const rackId = add(rowId, `Rack ${String(rack).padStart(2, "0")}`, "Rack");
          add(rackId, "Feed A", "Feed");
          add(rackId, "Feed B", "Feed");
        }
      }
    }
  }
  const electrical = add(site, "Electrical", "Other equipment");
  for (let i = 1; i <= 8; i++) add(electrical, `Panel ${i}A`, "Panel");
  return out;
}

const hall = pilotHall();
const meterLike = hall.filter((a) => a.kind === "Feed" || a.kind === "Panel"); // what a metric widget offers
const metricModel = buildPickerModel(meterLike, hall);
const idOf = (name: string, parentName?: string): number => {
  const hit = hall.find((a) => a.name === name && (parentName === undefined || hall.find((p) => p.id === a.parent_id)?.name === parentName));
  if (!hit) throw new Error(`no ${name}`);
  return hit.id;
};
const hall1 = idOf("Hall 1");
const hall2 = idOf("Hall 2");
const site = idOf("Seeded pilot hall");
const racks05 = hall.filter((a) => a.name === "Rack 05").map((a) => a.id);

describe("buildPickerModel", () => {
  it("shows the offered assets and the ancestors that hold them, in tree order, with context rows flagged and depths in the shown tree", () => {
    const m = metricModel;
    expect(m.nodes.length).toBe(144); // every asset is offered or holds an offered one
    expect(m.offeredCount).toBe(88);
    const root = m.byId.get(site)!;
    expect(root).toMatchObject({ index: 0, parentIndex: -1, parentId: null, depth: 0, offered: false, below: 88, hasKids: true, end: 144 });
    expect(m.byId.get(hall1)).toMatchObject({ depth: 1, offered: false, parentId: site });
    const rack = m.byId.get(racks05[0])!;
    expect(rack).toMatchObject({ depth: 4, offered: false, below: 2, hasKids: true, end: rack.index + 3 });
    const feed = m.nodes[rack.index + 1];
    expect(feed).toMatchObject({ name: "Feed A", depth: 5, offered: true, below: 0, hasKids: false, end: rack.index + 2, parentIndex: rack.index, parentId: rack.id });
    expect(m.byId.get(idOf("Electrical"))).toMatchObject({ depth: 1, offered: false, below: 8 });
    expect(m.byId.get(idOf("Panel 1A"))).toMatchObject({ depth: 2, offered: true });
    // pre-order: a parent comes first and indexes agree with the list
    m.nodes.forEach((node, i) => {
      expect(node.index).toBe(i);
      if (node.parentIndex >= 0) {
        expect(node.parentIndex).toBeLessThan(i);
        expect(m.nodes[node.parentIndex].id).toBe(node.parentId);
        expect(m.nodes[node.parentIndex].end).toBeGreaterThanOrEqual(node.end);
      }
    });
    expect(m.nodes[1].name).toBe("Hall 1"); // siblings keep buildTree's order: halls before the panel board
    expect(m.nodes.at(-1)!.name).toBe("Panel 8A");
  });

  it("labels offered rows exactly as pickerRows does, with the path for shared names, and context rows with their plain name", () => {
    const expected = new Map(pickerRows(meterLike, hall).map((row) => [row.id, row.label]));
    for (const node of metricModel.nodes) {
      if (node.offered) expect(node.label).toBe(expected.get(node.id));
      else expect(node.label).toBe(node.name);
    }
    const firstFeed = metricModel.nodes.find((n) => n.name === "Feed A")!;
    expect(firstFeed.label).toBe("Feed A (Seeded pilot hall / Hall 1 / Pod A / Row 1 / Rack 01)");
    expect(metricModel.byId.get(idOf("Panel 1A"))!.label).toBe("Panel 1A");
    expect(new Set(metricModel.nodes.filter((n) => n.offered).map((n) => n.label)).size).toBe(88); // every input has its own label
  });

  it("names the buttons of two same-named rows differently, from one call over the offered and the context rows", () => {
    const [first, second] = racks05.map((id) => metricModel.byId.get(id)!);
    expect(first.label).toBe("Rack 05");
    expect(second.label).toBe("Rack 05");
    expect(first.buttonLabel).toBe("Rack 05 (Seeded pilot hall / Hall 1 / Pod A / Row 1)");
    expect(second.buttonLabel).toBe("Rack 05 (Seeded pilot hall / Hall 2 / Pod A / Row 1)");
    expect(metricModel.byId.get(site)!.buttonLabel).toBe("Seeded pilot hall");
    const rows = new Map(pickerRows(hall.filter((a) => metricModel.byId.has(a.id)), hall).map((row) => [row.id, row.label]));
    for (const node of metricModel.nodes) expect(node.buttonLabel).toBe(rows.get(node.id));
  });

  it("ignores offered assets that are not in the tree, and an empty offering shows nothing", () => {
    const stray = asset(999, null, "Stray", "Rack");
    const m = buildPickerModel([...meterLike, stray], hall);
    expect(m.offeredCount).toBe(88);
    expect(m.byId.has(999)).toBe(false);
    const none = buildPickerModel([], hall);
    expect(none.nodes).toEqual([]);
    expect(none.offeredCount).toBe(0);
    expect(none.kinds).toEqual([]);
    expect(none.defaultFolded.size).toBe(0);
  });

  it("offered rows that are all top-level have no context and no kids", () => {
    const flat = [asset(1, null, "Alpha", "Rack"), asset(2, null, "Beta", "Rack")];
    const m = buildPickerModel(flat, flat);
    expect(m.nodes.map((n) => [n.name, n.depth, n.offered, n.hasKids, n.below, n.end])).toEqual([["Alpha", 0, true, false, 0, 1], ["Beta", 0, true, false, 0, 2]]);
  });

  it("counts an offered ancestor as a real row and as the 'below' of its own ancestors", () => {
    const tree = [asset(1, null, "Top", "Site"), asset(2, 1, "Mid", "Rack"), asset(3, 2, "Low", "Feed")];
    const m = buildPickerModel([tree[1], tree[2]], tree);
    expect(m.nodes.map((n) => [n.name, n.offered, n.below, n.depth])).toEqual([["Top", false, 2, 0], ["Mid", true, 1, 1], ["Low", true, 0, 2]]);
  });
});

describe("the kinds of a model", () => {
  const tree = [
    asset(1, null, "Site", "Site"),
    asset(2, 1, "A", " rack "), asset(3, 1, "B", "Rack"), asset(4, 1, "C", "Rack"), asset(5, 1, "D", "rack"),
    asset(6, 1, "E", "Feed"), asset(7, 1, "F", "Panel"),
  ];

  it("joins spellings of one key and names the option by the most frequent spelling, counting offered assets only", () => {
    const m = buildPickerModel(tree.filter((a) => a.id >= 2 && a.id <= 6), tree);
    expect(m.kinds).toEqual([{ key: "feed", name: "Feed", count: 1 }, { key: "rack", name: "Rack", count: 4 }]);
  });

  it("sorts by key, and a tie in spelling goes to the first in tree order", () => {
    const m = buildPickerModel([tree[1], tree[4], tree[5], tree[6]], tree); // " rack ", "rack", Feed, Panel: rack is 1 and 1
    expect(m.kinds.map((k) => k.key)).toEqual(["feed", "panel", "rack"]);
    expect(m.kinds.find((k) => k.key === "rack")).toEqual({ key: "rack", name: " rack ", count: 2 });
  });

  it("leaves out a kind that only context rows have, and a blank kind (its key is the 'All kinds' value)", () => {
    const m = buildPickerModel([tree[5], asset(8, 1, "G", "  ")], [...tree, asset(8, 1, "G", "  ")]);
    expect(m.kinds).toEqual([{ key: "feed", name: "Feed", count: 1 }]);
  });

  it("lists the kinds of the metric-like offering", () => {
    expect(metricModel.kinds).toEqual([{ key: "feed", name: "Feed", count: 80 }, { key: "panel", name: "Panel", count: 8 }]);
  });
});

describe("the default fold", () => {
  /** root > g1 (a leaves) and g2 (b leaves): 1 + 2 + a + b rows. */
  const grouped = (a: number, b: number): Asset[] => {
    const out = [asset(1, null, "Root", "Site"), asset(2, 1, "G1", "Row"), asset(3, 1, "G2", "Row")];
    for (let i = 0; i < a; i++) out.push(asset(10 + i, 2, `L1-${i}`, "Rack"));
    for (let i = 0; i < b; i++) out.push(asset(1000 + i, 3, `L2-${i}`, "Rack"));
    return out;
  };

  it("is empty for 60 shown rows", () => {
    const tree = grouped(30, 27);
    expect(tree.length).toBe(FOLD_ROW_LIMIT);
    expect(buildPickerModel(tree, tree).defaultFolded.size).toBe(0);
  });

  it("folds exactly the foldable rows at depth 1 and below for 61 shown rows", () => {
    const tree = grouped(30, 28);
    expect(tree.length).toBe(FOLD_ROW_LIMIT + 1);
    const m = buildPickerModel(tree, tree);
    expect([...m.defaultFolded].sort((x, y) => x - y)).toEqual([2, 3]); // the root (depth 0) stays open, the leaves are not foldable
  });

  it("counts the shown rows, context rows included, not the offered ones", () => {
    const m = metricModel; // 144 shown, 88 offered
    expect(m.defaultFolded.has(hall1)).toBe(true);
    expect(m.defaultFolded.has(site)).toBe(false);
    expect(m.defaultFolded.has(racks05[0])).toBe(true);
    expect(m.defaultFolded.has(m.nodes.find((n) => n.name === "Feed A")!.id)).toBe(false); // not foldable
  });
});

describe("filterPicker", () => {
  it("does not filter on an empty search and no kind (a blank search is empty)", () => {
    for (const query of ["", "   "]) {
      const view = filterPicker(metricModel, query, "");
      expect(view).toMatchObject({ filtering: false, shown: null, results: null, count: 88, total: 144 });
      expect(view.shownKids.size).toBe(0);
      expect(view.forcedOpen.size).toBe(0);
    }
  });

  it("'rack 05' gives the feeds of both Rack 05 (inside a match) with the racks and the way down to them as context", () => {
    const view = filterPicker(metricModel, "rack 05", "");
    expect(view.filtering).toBe(true);
    expect(view.count).toBe(4);
    expect(names(metricModel, view.results!)).toEqual(["Feed A", "Feed B", "Feed A", "Feed B"]);
    expect(view.shown!.size).toBe(13); // 4 feeds, 2 racks, 2 rows, 2 pods, 2 halls, the site
    expect(view.total).toBe(13);
    for (const rack of racks05) {
      expect(view.shown!.has(rack)).toBe(true);
      expect(view.results!.has(rack)).toBe(false); // a rack is context here, not a result
      expect(view.shownKids.has(rack)).toBe(true);
    }
    expect(view.shown!.has(idOf("Electrical"))).toBe(false);
    expect(view.forcedOpen.has(site)).toBe(true);
    expect(view.forcedOpen.has(racks05[0])).toBe(false); // the rack itself is a hit: it needs no more than to be seen
  });

  it("folds the case of the query and trims it", () => {
    const plain = filterPicker(metricModel, "rack 05", "");
    const odd = filterPicker(metricModel, "  RaCk 05 \t", "");
    expect([...odd.results!]).toEqual([...plain.results!]);
    expect(odd.total).toBe(plain.total);
  });

  it("a kind alone gives every offered asset of the kind, and the ways down to them", () => {
    const view = filterPicker(metricModel, "", "feed");
    expect(view.count).toBe(80);
    expect(view.total).toBe(135); // everything but the panel board (9)
    expect(view.shown!.has(idOf("Electrical"))).toBe(false);
    expect(view.forcedOpen.has(site)).toBe(true);
    expect(view.forcedOpen.has(racks05[0])).toBe(true); // a feed is needed, so its rack is forced open
    expect(view.forcedOpen.has(metricModel.nodes.find((n) => n.name === "Feed A")!.id)).toBe(false);
  });

  it("combines a search and a kind: both must hold", () => {
    const feeds = filterPicker(metricModel, "hall 1", "feed");
    expect(feeds.count).toBe(40);
    for (const id of feeds.results!) {
      expect(metricModel.byId.get(id)!.kindKey).toBe("feed");
      expect(ancestorsOf(metricModel, [id]).has(hall1)).toBe(true);
    }
    expect(feeds.shown!.has(hall2)).toBe(false);
    const panels = filterPicker(metricModel, "hall 1", "panel"); // the panel board is beside the halls, not in one
    expect(panels.count).toBe(0);
    expect(panels.shown!.size).toBe(0);
    expect(panels.total).toBe(0);
    expect(panels.results!.size).toBe(0);
  });

  it("a search that matches nothing shows nothing", () => {
    const view = filterPicker(metricModel, "zzz", "");
    expect(view).toMatchObject({ filtering: true, count: 0, total: 0 });
    expect(view.shown!.size).toBe(0);
    expect(view.forcedOpen.size).toBe(0);
  });

  it("matches the kind text as well as the name", () => {
    const view = filterPicker(metricModel, "other equip", "");
    expect(view.count).toBe(8); // the board's panels, inside the board
    expect(view.shown!.has(idOf("Electrical"))).toBe(true);
  });

  it("an offered ancestor shows as a row but is not counted unless it passes", () => {
    const tree = [asset(1, null, "Top", "Site"), asset(2, 1, "Mid", "Rack"), asset(3, 2, "Low", "Feed")];
    const m = buildPickerModel(tree, tree);
    const view = filterPicker(m, "", "feed");
    expect([...view.shown!].sort()).toEqual([1, 2, 3]);
    expect([...view.results!]).toEqual([3]);
    expect(view.count).toBe(1);
  });
});

describe("what is drawn (visibleRows, nothing folded or opened by the person)", () => {
  const drawn = (query: string, kind = "", state: FoldState = NO_STATE) => visibleRows(metricModel, filterPicker(metricModel, query, kind), state);

  it("without a filter: the site and its first level, folded", () => {
    const rows = visibleRows(metricModel, filterPicker(metricModel, "", ""), NO_STATE);
    expect(rows.map((r) => r.node.name)).toEqual(["Seeded pilot hall", "Hall 1", "Hall 2", "Electrical"]);
    expect(rows.map((r) => r.open)).toEqual([true, false, false, false]);
    expect(rows.every((r) => r.foldable && !r.locked)).toBe(true);
  });

  it("'s' matches the root by name: the root and its first level only, and every offered asset counts", () => {
    const view = filterPicker(metricModel, "s", "");
    expect(view.count).toBe(88);
    const rows = visibleRows(metricModel, view, NO_STATE);
    expect(rows.map((r) => r.node.name)).toEqual(["Seeded pilot hall", "Hall 1", "Hall 2", "Electrical"]);
    expect(rows.map((r) => r.open)).toEqual([true, false, false, false]);
    expect(rows.every((r) => r.foldable && !r.locked)).toBe(true);
  });

  it("'r' (the rows and the racks, by name and kind) does not draw every feed", () => {
    const rows = drawn("r");
    expect(filterPicker(metricModel, "r", "").count).toBeGreaterThan(80); // every feed is inside a rack
    expect(rows.filter((r) => r.node.kindKey === "feed").length).toBe(0);
    expect(rows.filter((r) => r.node.kindKey === "rack").length).toBe(40); // the way down to every rack is open, the racks are folded
    expect(rows.filter((r) => r.node.kindKey === "rack").every((r) => r.foldable && !r.open && !r.locked)).toBe(true);
    expect(rows.find((r) => r.node.name === "Row 1")!.locked).toBe(true);
  });

  it("'rack 05' draws the way down to both racks and their feeds, all open", () => {
    const view = filterPicker(metricModel, "rack 05", "");
    expect(view.total).toBeLessThanOrEqual(FOLD_ROW_LIMIT);
    const rows = visibleRows(metricModel, view, NO_STATE);
    expect(rows.length).toBe(13);
    expect(rows.filter((r) => r.node.kindKey === "feed").length).toBe(4);
    expect(rows.filter((r) => r.node.kindKey === "rack").map((r) => [r.open, r.foldable, r.locked])).toEqual([[true, true, false], [true, true, false]]);
    expect(rows.find((r) => r.node.name === "Pod A")!.locked).toBe(true); // a hit is below
  });

  it("'hall 1' draws the way to Hall 1 and Hall 1 folded, its button working; a mark of 'open' shows its children, folded", () => {
    const rows = drawn("hall 1");
    expect(rows.map((r) => r.node.name)).toEqual(["Seeded pilot hall", "Hall 1"]);
    expect(rows[1]).toMatchObject({ open: false, foldable: true, locked: false });
    expect(rows[0]).toMatchObject({ open: true, foldable: true, locked: true });
    const opened = drawn("hall 1", "", { marks: new Map([[hall1, false]]), seedOpen: new Set() });
    expect(opened.map((r) => r.node.name)).toEqual(["Seeded pilot hall", "Hall 1", "Pod A", "Pod B"]);
    expect(opened.slice(2).every((r) => !r.open && r.foldable && !r.locked)).toBe(true);
  });

  it("'hall 1' with the kind Feed draws the same way down, Hall 1 folded", () => {
    const rows = drawn("hall 1", "feed");
    expect(rows.map((r) => r.node.name)).toEqual(["Seeded pilot hall", "Hall 1"]);
    expect(rows[1].open).toBe(false);
  });

  it("a kind alone draws the way down to its assets; a short list is all open", () => {
    const view = filterPicker(metricModel, "", "panel");
    expect(view.total).toBe(10); // the site, the board and its 8 panels
    const rows = visibleRows(metricModel, view, NO_STATE);
    expect(rows.map((r) => r.node.name)).toEqual(["Seeded pilot hall", "Electrical", ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `Panel ${i}A`)]);
    expect(rows.slice(0, 2).map((r) => [r.open, r.foldable, r.locked])).toEqual([[true, true, true], [true, true, true]]);
    expect(rows.slice(2).every((r) => r.open && !r.foldable && !r.locked)).toBe(true);
  });

  it("hides the rows under a folded row up to the next row at or above it", () => {
    const state: FoldState = { marks: new Map([[hall1, false]]), seedOpen: new Set() };
    const rows = visibleRows(metricModel, filterPicker(metricModel, "", ""), state).map((r) => r.node.name);
    expect(rows).toEqual(["Seeded pilot hall", "Hall 1", "Pod A", "Pod B", "Hall 2", "Electrical"]);
  });

  it("an empty search with no kind draws everything when the person opens every branch", () => {
    const marks = new Map(metricModel.nodes.filter((n) => n.hasKids).map((n) => [n.id, false]));
    expect(visibleRows(metricModel, filterPicker(metricModel, "", ""), { marks, seedOpen: new Set() }).length).toBe(144);
  });
});

describe("isFolded", () => {
  const unfiltered = filterPicker(metricModel, "", "");
  const rack = racks05[0];

  it("a person's mark beats the default fold, and seedOpen keeps a branch open at the start", () => {
    expect(isFolded(metricModel, unfiltered, NO_STATE, rack)).toBe(true);
    expect(isFolded(metricModel, unfiltered, { marks: new Map([[rack, false]]), seedOpen: new Set() }, rack)).toBe(false);
    expect(isFolded(metricModel, unfiltered, { marks: new Map(), seedOpen: new Set([rack]) }, rack)).toBe(false);
    expect(isFolded(metricModel, unfiltered, { marks: new Map([[rack, true]]), seedOpen: new Set([rack]) }, rack)).toBe(true);
    expect(isFolded(metricModel, unfiltered, NO_STATE, site)).toBe(false); // the root is not in the default fold
  });

  it("while filtering, a branch that leads to a hit stays open whatever the mark says", () => {
    const view = filterPicker(metricModel, "hall 1", "");
    expect(view.forcedOpen.has(site)).toBe(true);
    expect(isFolded(metricModel, view, { marks: new Map([[site, true]]), seedOpen: new Set() }, site)).toBe(false);
    expect(isFolded(metricModel, view, NO_STATE, hall1)).toBe(true); // the hit itself folds: 68 rows
    expect(isFolded(metricModel, view, { marks: new Map([[hall1, false]]), seedOpen: new Set() }, hall1)).toBe(false);
  });

  it("while filtering, seedOpen does not count and a short list opens everything", () => {
    const view = filterPicker(metricModel, "rack 05", "");
    expect(view.total).toBeLessThanOrEqual(FOLD_ROW_LIMIT);
    expect(isFolded(metricModel, view, NO_STATE, rack)).toBe(false);
    expect(isFolded(metricModel, view, { marks: new Map([[rack, true]]), seedOpen: new Set() }, rack)).toBe(true);
    const long = filterPicker(metricModel, "hall 1", "");
    expect(isFolded(metricModel, long, { marks: new Map(), seedOpen: new Set([hall1]) }, hall1)).toBe(true);
  });

  it("while filtering, a long list folds from the second level down and leaves the top level open", () => {
    const view = filterPicker(metricModel, "s", "");
    expect(view.total).toBeGreaterThan(FOLD_ROW_LIMIT);
    expect(isFolded(metricModel, view, NO_STATE, site)).toBe(false);
    expect(isFolded(metricModel, view, NO_STATE, hall1)).toBe(true);
  });
});

describe("ancestorsOf", () => {
  it("gives the strict ancestors of the ids, skipping the ids that are not in the model", () => {
    const feed = metricModel.byId.get(racks05[0])!.index + 1;
    const feedId = metricModel.nodes[feed].id;
    const got = ancestorsOf(metricModel, [feedId, 123456]);
    expect(names(metricModel, got).sort()).toEqual(["Hall 1", "Pod A", "Rack 05", "Row 1", "Seeded pilot hall"]);
    expect(got.has(feedId)).toBe(false);
  });

  it("gives nothing for a top-level row, an empty list or only strangers", () => {
    expect(ancestorsOf(metricModel, [site]).size).toBe(0);
    expect(ancestorsOf(metricModel, []).size).toBe(0);
    expect(ancestorsOf(metricModel, [-1, 0]).size).toBe(0);
  });

  it("joins the ancestors of several ids without repeating them, and takes a context row's own ancestors", () => {
    const got = ancestorsOf(metricModel, racks05);
    expect(got.size).toBe(1 + 2 + 2 + 2); // site, 2 halls, 2 pods, 2 rows (the racks themselves are not in)
    expect(got.has(racks05[0])).toBe(false);
    expect(ancestorsOf(metricModel, new Set(racks05)).size).toBe(7); // any iterable works
  });
});

describe("countsBelow", () => {
  const rack = metricModel.byId.get(racks05[0])!;
  const feeds = [metricModel.nodes[rack.index + 1].id, metricModel.nodes[rack.index + 2].id];

  it("counts the offered nodes below each node and those not picked yet, with no filter", () => {
    const empty = countsBelow(metricModel, filterPicker(metricModel, "", ""), new Set());
    expect(empty.results[0]).toBe(88);
    expect(empty.pending[0]).toBe(88);
    expect(empty.results[rack.index]).toBe(2);
    expect(empty.results[rack.index + 1]).toBe(0); // a leaf
    const some = countsBelow(metricModel, filterPicker(metricModel, "", ""), new Set([feeds[0], 999]));
    expect(some.results[0]).toBe(88);
    expect(some.pending[0]).toBe(87);
    expect(some.pending[rack.index]).toBe(1);
    expect(some.pending[metricModel.byId.get(hall1)!.index]).toBe(39);
  });

  it("counts only the results of a filter", () => {
    const view = filterPicker(metricModel, "hall 1", "feed");
    const got = countsBelow(metricModel, view, new Set());
    expect(got.results[0]).toBe(40);
    expect(got.results[metricModel.byId.get(hall1)!.index]).toBe(40);
    expect(got.results[metricModel.byId.get(hall2)!.index]).toBe(0);
    expect(got.results[metricModel.byId.get(idOf("Electrical"))!.index]).toBe(0);
  });

  it("does not count a context row, nor the node itself", () => {
    const view = filterPicker(metricModel, "rack 05", "");
    const got = countsBelow(metricModel, view, new Set());
    expect(got.results[rack.index]).toBe(2);
    expect(got.results[0]).toBe(4);
  });
});

describe("pickAllUnder", () => {
  const rack = metricModel.byId.get(racks05[0])!;
  const feedA = metricModel.nodes[rack.index + 1].id;
  const feedB = metricModel.nodes[rack.index + 2].id;
  const all = filterPicker(metricModel, "", "");

  it("adds what is below and not picked, in tree order", () => {
    expect(pickAllUnder(metricModel, all, rack.id, [], 20)).toEqual({ kind: "add", ids: [feedA, feedB] });
    expect(pickAllUnder(metricModel, all, rack.id, [feedA], 20)).toEqual({ kind: "add", ids: [feedB] });
    const row = metricModel.nodes.find((n) => n.id === rack.parentId)!;
    const got = pickAllUnder(metricModel, all, row.id, [feedB], 20);
    expect(got.kind).toBe("add");
    expect((got as { ids: number[] }).ids.length).toBe(9);
    expect((got as { ids: number[] }).ids[0]).toBe(metricModel.nodes[row.index + 2].id); // tree order: the first rack's feeds come first
    expect((got as { ids: number[] }).ids).not.toContain(feedB);
  });

  it("does nothing when all are picked, when nothing is below, and for an unknown id", () => {
    expect(pickAllUnder(metricModel, all, rack.id, [feedA, feedB], 20)).toEqual({ kind: "none" });
    expect(pickAllUnder(metricModel, all, feedA, [], 20)).toEqual({ kind: "none" });
    expect(pickAllUnder(metricModel, all, 987654, [], 20)).toEqual({ kind: "none" });
    expect(pickAllUnder(metricModel, all, rack.id, [feedA, feedB], 1)).toEqual({ kind: "none" }); // nothing to add is not a refusal
  });

  it("adds when it fits exactly and refuses, with the count and the room, when it does not", () => {
    expect(pickAllUnder(metricModel, all, rack.id, [], 2)).toEqual({ kind: "add", ids: [feedA, feedB] });
    expect(pickAllUnder(metricModel, all, rack.id, [], 1)).toEqual({ kind: "refuse", count: 2, room: 1 });
    expect(pickAllUnder(metricModel, all, site, [], 20)).toEqual({ kind: "refuse", count: 88, room: 20 });
    expect(pickAllUnder(metricModel, all, rack.id, [], 0)).toEqual({ kind: "refuse", count: 2, room: 0 });
  });

  it("counts every pick against the room, also those that are not in the tree, and never gives a negative room", () => {
    expect(pickAllUnder(metricModel, all, rack.id, [999, 998], 3)).toEqual({ kind: "refuse", count: 2, room: 1 });
    expect(pickAllUnder(metricModel, all, rack.id, [1, 2, 3, 4], 3)).toEqual({ kind: "refuse", count: 2, room: 0 });
  });

  it("a filter narrows what is picked", () => {
    const view = filterPicker(metricModel, "hall 1", "feed");
    const got = pickAllUnder(metricModel, view, site, [], 100);
    expect(got.kind).toBe("add");
    expect((got as { ids: number[] }).ids.length).toBe(40);
    for (const id of (got as { ids: number[] }).ids) expect(ancestorsOf(metricModel, [id]).has(hall1)).toBe(true);
    expect(pickAllUnder(metricModel, view, hall2, [], 100)).toEqual({ kind: "none" });
    expect(pickAllUnder(metricModel, view, site, [], 20)).toEqual({ kind: "refuse", count: 40, room: 20 });
    const search = filterPicker(metricModel, "rack 05", "");
    expect(pickAllUnder(metricModel, search, site, [], 20)).toMatchObject({ kind: "add" });
    expect((pickAllUnder(metricModel, search, site, [], 20) as { ids: number[] }).ids.length).toBe(4);
  });
});

describe("sameAssets", () => {
  const a = [asset(1, null, "A", "Rack", 1), asset(2, 1, "B", "Feed", 2)];

  it("is true for the same objects, the same list and equal copies", () => {
    expect(sameAssets(a, a)).toBe(true);
    expect(sameAssets(a, [...a])).toBe(true);
    expect(sameAssets(a, a.map((x) => ({ ...x })))).toBe(true);
    expect(sameAssets([], [])).toBe(true);
  });

  it("is false for a changed name, kind, parent, id or sort_order", () => {
    expect(sameAssets(a, [a[0], { ...a[1], name: "B2" }])).toBe(false);
    expect(sameAssets(a, [a[0], { ...a[1], kind: "Panel" }])).toBe(false);
    expect(sameAssets(a, [a[0], { ...a[1], parent_id: null }])).toBe(false);
    expect(sameAssets(a, [a[0], { ...a[1], id: 3 }])).toBe(false);
    expect(sameAssets(a, [a[0], { ...a[1], sort_order: 9 }])).toBe(false);
  });

  it("is false for different lengths or a different order", () => {
    expect(sameAssets(a, [a[0]])).toBe(false);
    expect(sameAssets([a[0]], a)).toBe(false);
    expect(sameAssets(a, [a[1], a[0]])).toBe(false);
  });

  it("ignores the icon fields", () => {
    expect(sameAssets(a, [a[0], { ...a[1], icon: "x", kind_icon: "y" }])).toBe(true);
  });
});

describe("frozen inputs", () => {
  it("are never changed: nothing throws when the assets and the arrays are frozen", () => {
    const frozen = hall.map((x) => Object.freeze({ ...x }));
    const tree = Object.freeze([...frozen]) as Asset[];
    const offered = Object.freeze(tree.filter((x) => x.kind === "Feed")) as Asset[];
    const picked = Object.freeze([tree[5].id]) as readonly number[];
    const model = buildPickerModel(offered, tree);
    const view = filterPicker(model, "hall 1", "feed");
    const state: FoldState = Object.freeze({ marks: new Map<number, boolean>(), seedOpen: new Set<number>() });
    expect(() => {
      visibleRows(model, view, state);
      visibleRows(model, filterPicker(model, "", ""), state);
      ancestorsOf(model, picked);
      countsBelow(model, view, new Set(picked));
      pickAllUnder(model, view, tree[0].id, picked, 20);
      isFolded(model, view, state, tree[1].id);
      sameAssets(tree, offered);
    }).not.toThrow();
    expect(tree.map((x) => x.name)).toEqual(hall.map((x) => x.name));
  });
});
