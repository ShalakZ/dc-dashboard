import { UNGROUPED } from "./graph";
import { MAX_SOURCE_ITEMS, mappedRefs, mappedSources, mappedSourcesByAsset, mappingsWhat } from "./mappedRefs";
import { model, point, source } from "../test/graphFixtures";

const mapped = (id: number, name: string, assetId: number, mappingId: number, metric = "active_power_kw" as const) =>
  point(id, name, { asset_id: assetId, mapping_id: mappingId, mapped_metric: metric });

// Source 1 "Plant": group LVP01 (kW to asset 10, V to asset 11, an unmapped kWh), group LVP02 (all unmapped), ungrouped Status (mapped to 10).
// Source 2 "Atrium": group M (kW to asset 10, a custom point to asset 10).
const world = () => model({
  sources: [
    source(1, {
      name: "Plant",
      clusters: [
        { key: "LVP01", points: [mapped(1, "LVP01 kW", 10, 101), mapped(2, "LVP01 V", 11, 102, "voltage_v" as never), point(3, "LVP01 kWh")] },
        { key: "LVP02", points: [point(4, "LVP02 kW")] },
      ],
      ungrouped: [mapped(5, "Status", 10, 103, "custom" as never)],
    }),
    source(2, {
      name: "Atrium", origin: "manual",
      clusters: [{ key: "M", points: [mapped(8, "M kW", 10, 201), mapped(9, "M raw", 10, 202, "custom" as never)] }],
    }),
  ],
});

describe("mappedRefs", () => {
  it("a mapped point node is its one mapping, named by the point, with the asset it is on and its metric", () => {
    expect(mappedRefs(world(), "point:1")).toEqual([{ id: 101, name: "LVP01 kW", assetId: 10, metric: "active_power_kw" }]);
  });

  it("an unmapped point, an unknown point and a node that is not a point have no refs", () => {
    const m = world();
    expect(mappedRefs(m, "point:3")).toEqual([]);
    expect(mappedRefs(m, "point:999")).toEqual([]);
    expect(mappedRefs(m, "src:1")).toEqual([]);
    expect(mappedRefs(m, "unid:10.0.0.9:8080")).toEqual([]);
  });

  it("a group node is every mapped point of the group (not the unmapped ones), in the group's order", () => {
    expect(mappedRefs(world(), "cluster:1:LVP01")).toEqual([
      { id: 101, name: "LVP01 kW", assetId: 10, metric: "active_power_kw" },
      { id: 102, name: "LVP01 V", assetId: 11, metric: "voltage_v" },
    ]);
    expect(mappedRefs(world(), "cluster:1:LVP02")).toEqual([]);
  });

  it("the Ungrouped bag is a group too", () => {
    expect(mappedRefs(world(), `cluster:1:${UNGROUPED}`)).toEqual([{ id: 103, name: "Status", assetId: 10, metric: "custom" }]);
  });

  it("a group key that holds colons is matched whole, and a group of another source is not mixed up", () => {
    const m = model({ sources: [source(1, { clusters: [{ key: "A:B:C", points: [mapped(1, "x", 10, 7)] }] }), source(2, { clusters: [{ key: "A:B:C", points: [mapped(2, "y", 10, 8)] }] })] });
    expect(mappedRefs(m, "cluster:1:A:B:C").map((r) => r.id)).toEqual([7]);
    expect(mappedRefs(m, "cluster:2:A:B:C").map((r) => r.id)).toEqual([8]);
    expect(mappedRefs(m, "cluster:3:A:B:C")).toEqual([]);
  });

  it("an asset node with a source id is every point of that source on that asset: all groups and the Ungrouped bag, no other source", () => {
    expect(mappedRefs(world(), "asset:10", 1).map((r) => r.id)).toEqual([101, 103]);
    expect(mappedRefs(world(), "asset:10", 2).map((r) => r.id)).toEqual([201, 202]);
    expect(mappedRefs(world(), "asset:11", 1).map((r) => r.id)).toEqual([102]);
    expect(mappedRefs(world(), "asset:11", 2)).toEqual([]);
  });

  it("an asset node without a source id has no refs (it is always asked per source)", () => {
    expect(mappedRefs(world(), "asset:10")).toEqual([]);
  });

  it("a point with a mapping id but no asset is left out (it cannot be named by its place)", () => {
    const m = model({ sources: [source(1, { ungrouped: [point(1, "odd", { mapping_id: 5 })] })] });
    expect(mappedRefs(m, "point:1")).toEqual([]);
  });
});

describe("mappedSources", () => {
  it("lists the sources that have mappings on the asset with their counts, sorted by name", () => {
    expect(mappedSources(world(), 10)).toEqual([
      { sourceId: 2, sourceName: "Atrium", count: 2 },
      { sourceId: 1, sourceName: "Plant", count: 2 },
    ]);
    expect(mappedSources(world(), 11)).toEqual([{ sourceId: 1, sourceName: "Plant", count: 1 }]);
  });

  it("an asset with nothing mapped has none", () => {
    expect(mappedSources(world(), 99)).toEqual([]);
  });

  it(`shows at most ${MAX_SOURCE_ITEMS}, the first by name`, () => {
    const many = model({ sources: ["g", "c", "a", "f", "b", "e", "d"].map((name, i) => source(i + 1, { name, ungrouped: [mapped(i + 1, `p${i}`, 10, i + 1)] })) });
    expect(mappedSources(many, 10).map((s) => s.sourceName)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("the index holds the same answer for every asset in one pass", () => {
    const index = mappedSourcesByAsset(world());
    expect([...index.keys()].sort()).toEqual([10, 11]);
    expect(index.get(10)).toEqual(mappedSources(world(), 10));
    expect(index.get(11)).toEqual(mappedSources(world(), 11));
  });
});

describe("mappingsWhat", () => {
  it("a group is named in the title; a point and a source's points are named as they are", () => {
    const m = world();
    expect(mappingsWhat(m, "cluster:1:LVP01")).toBe('the group "LVP01"');
    expect(mappingsWhat(m, `cluster:1:${UNGROUPED}`)).toBe("the Ungrouped points");
    expect(mappingsWhat(m, "point:1")).toBeUndefined();
    expect(mappingsWhat(m, "asset:10", 1)).toBe('the 2 points of source "Plant"');
    expect(mappingsWhat(m, "asset:11", 1)).toBe('the point of source "Plant"');
  });
});
