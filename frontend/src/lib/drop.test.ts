import { MAX_UNIT_LENGTH, acceptBody, assetChoices, bulkGroups, mappableClusters, dropPayload, metricConflicts, missingUnits, multiPointDrop, pickDropTarget, reviewRows, takenMetrics, withMetric, type ReviewRow } from "./drop";
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

describe("multiPointDrop", () => {
  it("several unmapped points of one source (clusters and the Ungrouped bag) yield one payload, in the order of the ids", () => {
    const result = multiPointDrop(model(), [nodeId.point(7), nodeId.point(4), nodeId.point(1)]);
    expect(result).toMatchObject({ payload: { kind: "points", label: "s1", source: { id: 1 } } });
    expect("payload" in result! && result.payload.points.map((x) => x.id)).toEqual([7, 4, 1]);
  });
  it("a repeated id yields its point once", () => {
    const result = multiPointDrop(model(), [nodeId.point(1), nodeId.point(2), nodeId.point(1)]);
    expect("payload" in result! && result.payload.points.map((x) => x.id)).toEqual([1, 2]);
  });
  it("fewer than two nodes, or any node that is not a point, is a plain move (null)", () => {
    expect(multiPointDrop(model(), [])).toBeNull();
    expect(multiPointDrop(model(), [nodeId.point(1)])).toBeNull();
    expect(multiPointDrop(model(), [nodeId.point(1), nodeId.point(1)])).toBeNull();
    for (const other of ["src:1", "asset:10", nodeId.cluster(1, "LVP01"), nodeId.cluster(1, UNGROUPED), "nonsense"]) {
      expect(multiPointDrop(model(), [nodeId.point(1), other])).toBeNull();
      expect(multiPointDrop(model(), [other, nodeId.point(1)])).toBeNull();
    }
  });
  it("a point the model does not hold is refused", () => {
    expect(multiPointDrop(model(), [nodeId.point(1), nodeId.point(999)]))
      .toEqual({ refusal: "Some of the selected points are not in the graph any more. Refresh and try again." });
  });
  it("mapped points are refused with their count, singular and plural", () => {
    expect(multiPointDrop(model(), [nodeId.point(8), nodeId.point(9)]))
      .toEqual({ refusal: "2 of the selected points are already mapped. Unmap them first, or select only unmapped points." });
    const one = multiPointDrop(model(), [nodeId.point(1), nodeId.point(2), nodeId.point(8)]);
    expect(one).toEqual({ refusal: "1 of the selected points is already mapped. Unmap it first, or select only unmapped points." });
  });
  it("points of different sources are refused", () => {
    const m = model();
    m.sources[1].clusters[0].points.push(point(20, "Other", {}));
    expect(multiPointDrop(m, [nodeId.point(1), nodeId.point(20)]))
      .toEqual({ refusal: "These points come from different sources. Select the points of one source at a time." });
  });
  it("a model that lacks a point is reported before a mapped one", () => {
    expect(multiPointDrop(model(), [nodeId.point(8), nodeId.point(999)])).toMatchObject({ refusal: expect.stringContaining("not in the graph") });
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

describe("custom units", () => {
  const custom = (over: Partial<ReviewRow> = {}): ReviewRow => ({
    pointId: 1, name: "T", checked: true, metric: "custom", scale: 1, intervalSeconds: 5, customUnit: "degC", unitHint: "degC", note: null, ...over,
  });
  const kwPoint = (hint: string | null) =>
    point(1, "P kW", { unit_hint: hint, suggestion: { metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null } });

  it("a row remembers its point's unit hint; a custom suggestion without a unit falls back to it", () => {
    const hinted = point(2, "T c", { unit_hint: "bar", suggestion: { metric: "custom", scale: 1, interval_seconds: 5, custom_unit: null } });
    expect(reviewRows([hinted], new Set())[0]).toMatchObject({ metric: "custom", unitHint: "bar", customUnit: "bar" });
    expect(reviewRows([kwPoint("kW")], new Set())[0]).toMatchObject({ unitHint: "kW", customUnit: null });
  });
  it("withMetric(custom) prefills the unit from the hint; an edited unit survives; any other metric drops it and the note", () => {
    const fromKw = reviewRows([kwPoint("kW")], new Set())[0];
    expect(withMetric(fromKw, "custom")).toMatchObject({ metric: "custom", customUnit: "kW", note: null });
    expect(withMetric(custom({ customUnit: "MWh" }), "custom").customUnit).toBe("MWh");
    expect(withMetric(withMetric(fromKw, "custom"), "voltage_v")).toMatchObject({ metric: "voltage_v", customUnit: null });
    expect(withMetric(reviewRows([kwPoint(null)], new Set())[0], "custom").customUnit).toBeNull();
    expect(withMetric(custom({ note: "This asset already has voltage_v." }), "frequency_hz").note).toBeNull();
  });
  it("missingUnits lists checked custom rows whose unit is empty or only spaces", () => {
    const rows = [
      custom({ pointId: 1, customUnit: null }), custom({ pointId: 2, customUnit: "   " }), custom({ pointId: 3, customUnit: "bar" }),
      custom({ pointId: 4, customUnit: "", checked: false }), custom({ pointId: 5, metric: "voltage_v", customUnit: null }),
    ];
    expect(missingUnits(rows)).toEqual([1, 2]);
  });
  it("acceptBody trims the unit and sends null for a non-custom metric", () => {
    const rows = [custom({ pointId: 1, customUnit: "  degC " }), custom({ pointId: 2, metric: "voltage_v", customUnit: "stale" })];
    expect(acceptBody(1, { kind: "existing", assetId: 2 }, rows).points.map((p) => p.custom_unit)).toEqual(["degC", null]);
  });
  it("the unit limit matches the server's", () => {
    expect(MAX_UNIT_LENGTH).toBe(20);
  });
});

describe("bulkGroups and mappableClusters (W7r: the one rule for which groups an asset can be created from)", () => {
  const power = { metric: "active_power_kw" as const, scale: 1, interval_seconds: 5, custom_unit: null };
  const volts = { metric: "voltage_v" as const, scale: 1, interval_seconds: 5, custom_unit: null };
  const unitless = { metric: "custom" as const, scale: 1, interval_seconds: 5, custom_unit: null };
  const withUnit = { metric: "custom" as const, scale: 1, interval_seconds: 5, custom_unit: "degC" };
  const src = (clusters: { key: string; points: ReturnType<typeof point>[] }[], ungrouped: ReturnType<typeof point>[] = []) =>
    ({ ...model().sources[0], clusters, ungrouped });

  it("lists the groups with an unmapped point, in order, never the Ungrouped bag, and leaves a fully mapped group out", () => {
    const s = src(
      [{ key: "A", points: [point(1, "A kW", { suggestion: power })] },
       { key: "B", points: [point(2, "B kW", { suggestion: power, asset_id: 10, mapping_id: 1 })] },
       { key: "C", points: [point(3, "C V", { suggestion: volts })] }],
      [point(4, "Status", { suggestion: power })],
    );
    expect(bulkGroups(s).map((g) => g.key)).toEqual(["A", "C"]);
    expect(mappableClusters(s).map((g) => g.key)).toEqual(["A", "C"]);
  });

  it("a group keeps only its unmapped points and starts the rows from the scan's guesses", () => {
    const s = src([{ key: "A", points: [point(1, "A kW", { suggestion: power }), point(2, "A V", { suggestion: volts, asset_id: 10, mapping_id: 3 })] }]);
    const [g] = bulkGroups(s);
    expect(g.points.map((p) => p.id)).toEqual([1]);
    expect(g.rows.map((r) => [r.pointId, r.metric, r.checked])).toEqual([[1, "active_power_kw", true]]);
    expect(g.mapped).toBe(1);
  });

  it("a repeated metric leaves the second row unchecked and the group still counts", () => {
    const [g] = bulkGroups(src([{ key: "A", points: [point(1, "A kW", { suggestion: power }), point(2, "A kW2", { suggestion: power })] }]));
    expect(g.rows.map((r) => r.checked)).toEqual([true, false]);
    expect(g.mapped).toBe(1);
  });

  it("a custom guess with no unit starts unchecked with a note; with a unit (or a unit hint) it is checked", () => {
    const [g] = bulkGroups(src([{ key: "A", points: [
      point(1, "T a", { suggestion: unitless }), point(2, "T b", { suggestion: withUnit }), point(3, "T c", { suggestion: unitless, unit_hint: "degC" })] }]));
    expect(g.rows.map((r) => [r.checked, r.note])).toEqual([[false, "Needs a unit."], [true, null], [true, null]]);
  });

  it("a group where nothing can be mapped is listed by bulkGroups but is not mappable", () => {
    const s = src([{ key: "A", points: [point(1, "T a", { suggestion: unitless })] }, { key: "B", points: [point(2, "B kW", { suggestion: power })] }]);
    expect(bulkGroups(s).map((g) => [g.key, g.mapped])).toEqual([["A", 0], ["B", 1]]);
    expect(mappableClusters(s).map((g) => g.key)).toEqual(["B"]);
  });
});

describe("a point that is the same tag as a mapped point is not offered (w34)", () => {
  const twinModel = () => {
    const m = model();
    m.sources[0].clusters[0].points[0] = point(1, "LVP01 kW", { asset_id: 11, mapping_id: 5, mapped_metric: "active_power_kw" });
    m.sources[0].clusters[0].points[1] = point(2, "LVP01 kWh", { same_tag_as: 1 });
    return m;
  };
  it("a cluster payload leaves the twin out", () => {
    expect(dropPayload(twinModel(), nodeId.cluster(1, "LVP01"))!.points.map((x) => x.id)).toEqual([3]);
  });
  it("a twin alone is not droppable, and a cluster of nothing but twins and mapped points yields no payload", () => {
    const m = twinModel();
    expect(dropPayload(m, nodeId.point(2))).toBeNull();
    m.sources[0].clusters[0].points[2] = point(3, "LVP01 V", { same_tag_as: 1 });
    expect(dropPayload(m, nodeId.cluster(1, "LVP01"))).toBeNull();
  });
  it("selecting a twin with another point refuses and says it is the same tag, with no advice to unmap", () => {
    expect(multiPointDrop(twinModel(), [nodeId.point(2), nodeId.point(3)])).toEqual({
      refusal: "1 of the selected points is the same tag as a mapped point." });
  });
  it("several twins are counted in the plural", () => {
    const m = twinModel();
    m.sources[0].clusters[0].points[2] = point(3, "LVP01 V", { same_tag_as: 1 });
    expect(multiPointDrop(m, [nodeId.point(2), nodeId.point(3)])).toEqual({
      refusal: "2 of the selected points are the same tag as a mapped point." });
  });
  it("a mapped point and a twin in one selection are each told, the mapped ones with the usual advice", () => {
    expect(multiPointDrop(twinModel(), [nodeId.point(1), nodeId.point(2)])).toEqual({
      refusal: "1 of the selected points is already mapped. Unmap it first, or select only unmapped points. 1 of the selected points is the same tag as a mapped point." });
  });
  it("the bulk list leaves the twin out", () => {
    const s = twinModel().sources[0];
    expect(bulkGroups(s).find((g) => g.key === "LVP01")!.points.map((p) => p.id)).toEqual([3]);
  });
});
