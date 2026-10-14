import type { Asset } from "../api/types";
import { findHits } from "./quickFind";

const asset = (id: number, name: string, parent_id: number | null = null): Asset => ({ id, parent_id, name, kind: "panel", sort_order: 0 });
const labels = (hits: { label: string }[]) => hits.map((h) => h.label);

const PAGES = [
  { label: "Assets", to: "/assets" },
  { label: "Dashboards", to: "/dashboards" },
  { label: "Billing", to: "/billing" },
  { label: "Settings", to: "/settings" },
  { label: "Sources", to: "/sources" },
];

// Site > MV2 > (Meter), Site > (MV2 East), Site > (Zeta MV2): "mv2" reaches them by name start, name start, name inside, and path only.
const TREE: Asset[] = [
  asset(1, "Site"),
  asset(2, "MV2", 1),
  asset(10, "Zeta MV2", 1),
  asset(11, "MV2 East", 1),
  asset(12, "Meter", 2),
];

describe("findHits ranking", () => {
  it("puts a name that starts with the query first, then one that contains it, then one only the path contains", () => {
    const hits = findHits("mv2", TREE, []);
    expect(labels(hits)).toEqual(["MV2", "MV2 East", "Zeta MV2", "Meter"]);
  });

  it("breaks a tie by path, then by id", () => {
    const twins = [asset(30, "Pump", 2), asset(31, "Pump", 1), asset(20, "Pump", 2), ...TREE];
    const hits = findHits("pump", twins, []);
    // "Site / MV2 / Pump" (ids 20, 30) sorts before "Site / Pump" (31): compared as text, "M" < "P"
    expect(hits.map((h) => h.key)).toEqual(["asset:20", "asset:30", "asset:31"]);
    expect(hits.map((h) => h.detail)).toEqual(["Site / MV2", "Site / MV2", "Site"]);
  });

  it("lists the assets first and the pages after them", () => {
    const hits = findHits("s", [asset(1, "Spare"), asset(2, "Rack")], PAGES);
    expect(hits.map((h) => h.kind)).toEqual(["asset", "page", "page", "page", "page"]);
  });

  it("ranks a page whose label starts with the query before one that contains it", () => {
    const hits = findHits("s", [], PAGES);
    expect(labels(hits)).toEqual(["Settings", "Sources", "Assets", "Dashboards"]); // "Billing" has no s
    // starts with first, then contains; inside each, the order the pages were given in
  });
});

describe("findHits matching", () => {
  it("matches the path as well as the name", () => {
    // "Meter" sits under "Site / MV2"; its own name has neither "site" nor "mv2"
    expect(labels(findHits("site / mv2 /", TREE, []))).toEqual(["Meter"]);
    expect(labels(findHits("mv2 / me", TREE, []))).toEqual(["Meter"]);
    // every path that holds the text matches, shortest path first ("/" sorts before "E")
    expect(labels(findHits("site / mv2", TREE, []))).toEqual(["MV2", "Meter", "MV2 East"]);
  });

  it("ignores case and the spaces around the query", () => {
    const lower = findHits("mv2", TREE, PAGES);
    expect(findHits("MV2", TREE, PAGES)).toEqual(lower);
    expect(findHits("  Mv2\t", TREE, PAGES)).toEqual(lower);
    expect(labels(findHits("BILL", [], PAGES))).toEqual(["Billing"]);
  });

  it("gives nothing for an empty or whitespace-only query", () => {
    expect(findHits("", TREE, PAGES)).toEqual([]);
    expect(findHits("   ", TREE, PAGES)).toEqual([]);
    expect(findHits("\t\n", TREE, PAGES)).toEqual([]);
  });

  it("gives nothing when nothing matches", () => {
    expect(findHits("zzzz", TREE, PAGES)).toEqual([]);
  });
});

describe("findHits shape", () => {
  it("describes an asset by its id, its name and the path above it", () => {
    const [hit] = findHits("meter", TREE, []);
    expect(hit).toEqual({ kind: "asset", key: "asset:12", label: "Meter", detail: "Site / MV2", to: "/assets/12", assetKind: "panel", assetIcon: null, assetKindIcon: null });
  });

  it("gives a top-level asset no detail", () => {
    const [hit] = findHits("site", TREE, []);
    expect(hit).toEqual({ kind: "asset", key: "asset:1", label: "Site", detail: null, to: "/assets/1", assetKind: "panel", assetIcon: null, assetKindIcon: null });
  });

  it("describes a page by its route", () => {
    const [hit] = findHits("billing", [], PAGES);
    expect(hit).toEqual({ kind: "page", key: "page:/billing", label: "Billing", detail: null, to: "/billing" });
  });

  it("carries the asset's kind (as stored) on an asset hit and nothing of the sort on a page hit", () => {
    const hits = findHits("i", [{ ...asset(1, "Cooling unit"), kind: "Chiller-1" }], [{ label: "Settings", to: "/settings" }]);
    expect(hits.map((h) => h.kind)).toEqual(["asset", "page"]);
    expect(hits[0].assetKind).toBe("Chiller-1");
    expect(hits[1]).not.toHaveProperty("assetKind");
  });

  it("carries the asset's icon as stored (null when it has none, an unknown id passed on for the display rule) and nothing of the sort on a page hit", () => {
    const hits = findHits("i", [{ ...asset(1, "Cooling unit"), icon: "crac" }, { ...asset(2, "Old unit"), icon: "zzz" }, asset(3, "Plain unit")], [
      { label: "Settings", to: "/settings" },
    ]);
    expect(hits.map((h) => h.label)).toEqual(["Cooling unit", "Old unit", "Plain unit", "Settings"]);
    expect(hits.map((h) => h.assetIcon)).toEqual(["crac", "zzz", null, undefined]);
    expect(hits[3]).not.toHaveProperty("assetIcon");
  });

  it("carries the icon of the asset's kind in the registry as the server resolved it (null when the kind is not registered or the field is absent) and nothing of the sort on a page hit", () => {
    const hits = findHits("i", [{ ...asset(1, "Cooling unit"), kind_icon: "crac" }, { ...asset(2, "Old unit"), kind_icon: "zzz" }, { ...asset(3, "Plain unit"), kind_icon: null }, asset(4, "Bare unit")], [
      { label: "Settings", to: "/settings" },
    ]);
    expect(hits.map((h) => h.label)).toEqual(["Bare unit", "Cooling unit", "Old unit", "Plain unit", "Settings"]);
    expect(hits.map((h) => h.assetKindIcon)).toEqual([null, "crac", "zzz", null, undefined]);
    expect(hits[4]).not.toHaveProperty("assetKindIcon");
  });

  it("keeps a 46-character name whole (the ellipsis is the stylesheet's job)", () => {
    const long = "A".repeat(23) + "-" + "b".repeat(22);
    expect(long).toHaveLength(46);
    const [hit] = findHits("aaa", [asset(5, long, 1), asset(1, "Site")], []);
    expect(hit.label).toBe(long);
  });
});

describe("findHits limits", () => {
  const many = Array.from({ length: 12 }, (_, i) => asset(100 + i, `Panel ${String(i).padStart(2, "0")}`));
  const pages = Array.from({ length: 7 }, (_, i) => ({ label: `Panel page ${i}`, to: `/p${i}` }));

  it("stops at 8 assets and 5 pages", () => {
    const hits = findHits("panel", many, pages);
    expect(hits.filter((h) => h.kind === "asset")).toHaveLength(8);
    expect(hits.filter((h) => h.kind === "page")).toHaveLength(5);
    expect(hits.slice(0, 8).every((h) => h.kind === "asset")).toBe(true);
    // the cap keeps the best ones: the first eight by path
    expect(labels(hits.slice(0, 8))).toEqual(many.slice(0, 8).map((a) => a.name));
  });

  it("takes other limits", () => {
    const hits = findHits("panel", many, pages, { assets: 2, pages: 1 });
    expect(hits.map((h) => h.key)).toEqual(["asset:100", "asset:101", "page:/p0"]);
  });

  it("takes a limit of zero as none of that kind", () => {
    expect(findHits("panel", many, pages, { assets: 0, pages: 1 }).map((h) => h.kind)).toEqual(["page"]);
  });
});

describe("findHits and bad parents", () => {
  it("does not hang on a parent cycle, and cuts the path where it comes round", () => {
    const loop = [asset(1, "Alpha", 2), asset(2, "Beta", 1), asset(3, "Self", 3)];
    const detailOf = (query: string, label: string) => findHits(query, loop, []).find((h) => h.label === label)?.detail;
    expect(detailOf("alpha", "Alpha")).toBe("Beta");
    expect(detailOf("beta", "Beta")).toBe("Alpha");
    const self = findHits("self", loop, []);
    expect(self).toHaveLength(1);
    expect(self[0].detail).toBeNull();
  });

  it("starts the path where an ancestor is missing", () => {
    const orphan = [asset(7, "Orphan", 999), asset(8, "Child", 7)];
    expect(findHits("orphan", orphan, [])[0].detail).toBeNull();
    expect(findHits("child", orphan, [])[0].detail).toBe("Orphan");
  });

  it("does not change what it was given", () => {
    const copy = JSON.stringify([TREE, PAGES]);
    findHits("mv2", TREE, PAGES);
    expect(JSON.stringify([TREE, PAGES])).toBe(copy);
  });
});
