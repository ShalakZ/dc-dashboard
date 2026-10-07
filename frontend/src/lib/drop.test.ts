import { acceptBody, assetChoices, dropPayload, metricConflicts, pickDropTarget, reviewRows, takenMetrics } from "./drop";
import { nodeId, UNGROUPED } from "./graph";
import { model, point } from "../test/graphFixtures";

describe("dropPayload", () => {
  it("a cluster yields its unmapped points and the source", () => {
    const p = dropPayload(model(), nodeId.cluster(1, "LVP01"))!;
    expect(p.kind).toBe("cluster");
    expect(p.label).toBe("LVP01");
    expect(p.source.id).toBe(1);
    expect(p.points.map((x) => x.id)).toEqual([1, 2, 3]);
  });
  it("skips points that are already mapped, and returns null when nothing is left", () => {
    expect(dropPayload(model(), nodeId.cluster(2, "M"))).toBeNull();
  });
  it("a single unmapped point yields a point payload", () => {
    expect(dropPayload(model(), nodeId.point(4))).toMatchObject({ kind: "point", label: "LVP02 kW" });
  });
  it("a point of the Ungrouped bag is droppable although the bag itself is not", () => {
    expect(dropPayload(model(), nodeId.point(7))).toMatchObject({ kind: "point", label: "Status", source: { id: 1 } });
  });
  it("a mapped point is not droppable", () => {
    expect(dropPayload(model(), nodeId.point(8))).toBeNull();
  });
  it("a cluster payload leaves out the points that are already mapped", () => {
    const m = model();
    m.sources[0].clusters[0].points[0] = point(1, "LVP01 kW", { asset_id: 11, mapping_id: 5, mapped_metric: "active_power_kw" });
    expect(dropPayload(m, nodeId.cluster(1, "LVP01"))!.points.map((x) => x.id)).toEqual([2, 3]);
  });
  it("sources, assets, the Ungrouped bag and unknown ids are not droppable", () => {
    for (const id of ["src:1", "asset:10", nodeId.cluster(1, UNGROUPED), "cluster:9:x", "point:999", "nonsense"]) {
      expect(dropPayload(model(), id)).toBeNull();
    }
  });
});

describe("pickDropTarget", () => {
  it("returns the first asset node id and ignores everything else", () => {
    expect(pickDropTarget([{ id: "src:1" }, { id: "asset:11", type: "asset" }, { id: "asset:10" }])).toBe(11);
    expect(pickDropTarget([{ id: "src:1" }, { id: "cluster:1:x" }])).toBeNull();
    expect(pickDropTarget([])).toBeNull();
  });
});

describe("review rows", () => {
  const kw = point(1, "P kW", { suggestion: { metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null } });
  const kw2 = point(2, "P2 kW", { suggestion: { metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null } });
  const c1 = point(3, "T a", { suggestion: { metric: "custom", scale: 1, interval_seconds: 5, custom_unit: "degC" } });
  const c2 = point(4, "T b", { suggestion: { metric: "custom", scale: 1, interval_seconds: 5, custom_unit: "degC" } });

  it("rows come from the suggestions and start checked", () => {
    const rows = reviewRows([kw], new Set());
    expect(rows[0]).toMatchObject({ pointId: 1, checked: true, metric: "active_power_kw", scale: 1, intervalSeconds: 5, note: null });
  });
  it("a custom suggestion carries its unit", () => {
    expect(reviewRows([c1], new Set())[0]).toMatchObject({ metric: "custom", customUnit: "degC" });
  });
  it("a metric the asset already has starts unchecked with a note", () => {
    const [row] = reviewRows([kw], new Set(["active_power_kw"] as const));
    expect(row.checked).toBe(false);
    expect(row.note).toMatch(/already/);
  });
  it("the second point with the same metric starts unchecked with a note; several custom points are all fine", () => {
    expect(reviewRows([kw, kw2], new Set()).map((r) => r.checked)).toEqual([true, false]);
    expect(reviewRows([kw, kw2], new Set())[1].note).toMatch(/already/);
    expect(reviewRows([c1, c2], new Set()).map((r) => r.checked)).toEqual([true, true]);
  });
  it("a custom metric is never held back by the taken set", () => {
    expect(reviewRows([c1], new Set(["custom"] as const))[0].checked).toBe(true);
  });
  it("metricConflicts reports checked rows that collide", () => {
    const rows = reviewRows([kw, kw2], new Set());
    expect(metricConflicts(rows, new Set())).toEqual([]);
    rows[1].checked = true;
    expect(metricConflicts(rows, new Set()).sort()).toEqual([1, 2]);
    expect(metricConflicts([{ ...rows[0] }], new Set(["active_power_kw"] as const))).toEqual([1]);
  });
  it("metricConflicts ignores unchecked rows and custom metrics", () => {
    const rows = reviewRows([kw, kw2, c1, c2], new Set());
    expect(metricConflicts(rows, new Set(["custom"] as const))).toEqual([]);
    rows[0].checked = false;
    rows[1].checked = true;
    expect(metricConflicts(rows, new Set())).toEqual([]);
  });
  it("takenMetrics reads the metrics mapped on an asset and ignores custom", () => {
    const m = model();
    expect([...takenMetrics(m, 10)].sort()).toEqual(["active_power_kw", "voltage_v"]);
    expect([...takenMetrics(m, 11)]).toEqual([]);
    m.sources[1].clusters[0].points.push(point(20, "M T", { asset_id: 11, mapping_id: 9, mapped_metric: "custom" }));
    expect([...takenMetrics(m, 11)]).toEqual([]);
  });
  it("takenMetrics also reads the Ungrouped points", () => {
    const m = model();
    m.sources[0].ungrouped = [point(7, "Status", { asset_id: 11, mapping_id: 3, mapped_metric: "frequency_hz" })];
    expect([...takenMetrics(m, 11)]).toEqual(["frequency_hz"]);
  });
});

describe("acceptBody", () => {
  it("sends only checked rows, for an existing asset", () => {
    const rows = reviewRows([point(1, "P kW", { suggestion: { metric: "active_power_kw", scale: 0.001, interval_seconds: 5, custom_unit: null } }), point(2, "P2 kW")], new Set());
    rows[1].checked = false;
    expect(acceptBody(7, { kind: "existing", assetId: 5 }, rows)).toEqual({
      source_id: 7, asset_id: 5,
      points: [{ point_id: 1, metric: "active_power_kw", scale: 0.001, interval_seconds: 5, custom_unit: null }],
    });
  });
  it("builds a new-asset body", () => {
    const body = acceptBody(7, { kind: "new", name: "LVP01", parentId: 10 }, reviewRows([point(1, "P kW")], new Set()));
    expect(body).toMatchObject({ source_id: 7, new_asset: { name: "LVP01", parent_id: 10 } });
    expect("asset_id" in body).toBe(false);
  });
  it("a blank interval goes out as null and a custom unit is kept", () => {
    const rows = reviewRows([point(3, "T", { suggestion: { metric: "custom", scale: 1, interval_seconds: 5, custom_unit: "degC" } })], new Set());
    rows[0].intervalSeconds = null;
    expect(acceptBody(1, { kind: "existing", assetId: 2 }, rows).points).toEqual([
      { point_id: 3, metric: "custom", scale: 1, interval_seconds: null, custom_unit: "degC" },
    ]);
  });
});

describe("assetChoices", () => {
  it("lists assets depth first, children right after their parent, with their depth", () => {
    const assets = [
      { id: 1, parent_id: null, name: "A", kind: "generic" },
      { id: 2, parent_id: null, name: "B", kind: "generic" },
      { id: 3, parent_id: 1, name: "A1", kind: "generic" },
      { id: 4, parent_id: 3, name: "A1a", kind: "generic" },
      { id: 5, parent_id: 2, name: "B1", kind: "generic" },
    ];
    expect(assetChoices(assets).map((a) => [a.id, a.depth])).toEqual([[1, 0], [3, 1], [4, 2], [2, 0], [5, 1]]);
  });
  it("keeps orphans, self-parents and parent cycles instead of dropping them", () => {
    const assets = [
      { id: 1, parent_id: 99, name: "Orphan", kind: "generic" },
      { id: 2, parent_id: 2, name: "Loop", kind: "generic" },
      { id: 3, parent_id: 4, name: "C", kind: "generic" },
      { id: 4, parent_id: 3, name: "D", kind: "generic" },
    ];
    expect(assetChoices(assets).map((a) => a.id).sort()).toEqual([1, 2, 3, 4]);
  });
});
