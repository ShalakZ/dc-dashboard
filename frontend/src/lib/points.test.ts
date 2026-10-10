import type { PointRow } from "../api/types";
import { DEFAULT_POINT_VIEW, sortBy, viewPoints, type PointView } from "./points";

type Mapped = { asset_id: number; metric: "active_power_kw" | "energy_kwh" | "voltage_v" };
let nextId = 1;
const point = (address: string, extra: Partial<Omit<PointRow, "mapping">> & { mapped?: Mapped } = {}): PointRow => {
  const { mapped, ...rest } = extra;
  return {
    id: nextId++, address, name: address, data_type: "float", unit_hint: null,
    mapping: mapped ? { id: nextId * 10, asset_id: mapped.asset_id, metric: mapped.metric, scale: 1, interval_seconds: 5, custom_unit: null } : null,
    ...rest,
  };
};
const labels: Record<number, string> = { 1: "Panel 1", 2: "Chiller (Room 2)" };
const assetLabel = (id: number) => labels[id] ?? `#${id}`;
const view = (changes: Partial<PointView> = {}): PointView => ({ ...DEFAULT_POINT_VIEW, ...changes });
const addresses = (rows: PointRow[]) => rows.map((p) => p.address);

describe("viewPoints", () => {
  it("orders addresses naturally by default: 3:2 before 3:10, 4:1 after both", () => {
    const rows = [point("4:1"), point("3:10"), point("3:2")];
    expect(addresses(viewPoints(rows, assetLabel, DEFAULT_POINT_VIEW))).toEqual(["3:2", "3:10", "4:1"]);
  });

  it("reverses the address order when descending", () => {
    const rows = [point("3:2"), point("3:10"), point("4:1")];
    expect(addresses(viewPoints(rows, assetLabel, view({ dir: "desc" })))).toEqual(["4:1", "3:10", "3:2"]);
  });

  it("sorts by name, ignoring case, in both directions", () => {
    const rows = [point("a", { name: "pump 10" }), point("b", { name: "Pump 2" }), point("c", { name: "Fan" })];
    expect(addresses(viewPoints(rows, assetLabel, view({ sort: "name" })))).toEqual(["c", "b", "a"]);
    expect(addresses(viewPoints(rows, assetLabel, view({ sort: "name", dir: "desc" })))).toEqual(["a", "b", "c"]);
  });

  it("sorts by type in both directions", () => {
    const rows = [point("a", { data_type: "int" }), point("b", { data_type: "bool" }), point("c", { data_type: "float" })];
    expect(addresses(viewPoints(rows, assetLabel, view({ sort: "data_type" })))).toEqual(["b", "c", "a"]);
    expect(addresses(viewPoints(rows, assetLabel, view({ sort: "data_type", dir: "desc" })))).toEqual(["a", "c", "b"]);
  });

  it("sorts a missing unit hint as blank, so it comes first ascending and last descending", () => {
    const rows = [point("a", { unit_hint: "kWh" }), point("b", { unit_hint: null }), point("c", { unit_hint: "V" })];
    expect(addresses(viewPoints(rows, assetLabel, view({ sort: "unit_hint" })))).toEqual(["b", "a", "c"]);
    expect(addresses(viewPoints(rows, assetLabel, view({ sort: "unit_hint", dir: "desc" })))).toEqual(["c", "a", "b"]);
  });

  it("sorts by the mapped asset and metric, unmapped first when ascending", () => {
    const rows = [
      point("a", { mapped: { asset_id: 2, metric: "energy_kwh" } }),
      point("b"),
      point("c", { mapped: { asset_id: 1, metric: "voltage_v" } }),
      point("d", { mapped: { asset_id: 1, metric: "active_power_kw" } }),
    ];
    expect(addresses(viewPoints(rows, assetLabel, view({ sort: "mapped" })))).toEqual(["b", "a", "d", "c"]);
    expect(addresses(viewPoints(rows, assetLabel, view({ sort: "mapped", dir: "desc" })))).toEqual(["c", "d", "a", "b"]);
  });

  it("breaks ties by address ascending, then id, even when the primary order is descending", () => {
    const rows = [point("3:10", { name: "same" }), point("3:2", { name: "same" }), point("1:1", { name: "other" })];
    expect(addresses(viewPoints(rows, assetLabel, view({ sort: "name" })))).toEqual(["1:1", "3:2", "3:10"]);
    expect(addresses(viewPoints(rows, assetLabel, view({ sort: "name", dir: "desc" })))).toEqual(["3:2", "3:10", "1:1"]);
    const twins = [{ ...point("x"), id: 9 }, { ...point("x"), id: 4 }];
    expect(viewPoints(twins, assetLabel, DEFAULT_POINT_VIEW).map((p) => p.id)).toEqual([4, 9]);
  });

  it("keeps only the unmapped points with unmappedOnly", () => {
    const rows = [point("a", { mapped: { asset_id: 1, metric: "energy_kwh" } }), point("b"), point("c")];
    expect(addresses(viewPoints(rows, assetLabel, view({ unmappedOnly: true })))).toEqual(["b", "c"]);
  });

  it("searches address, name, type, unit hint, the mapped asset's label and the metric, ignoring case", () => {
    const rows = [
      point("PLC/Alpha", { name: "one" }),
      point("b", { name: "Boiler Feed" }),
      point("c", { data_type: "Counter32" }),
      point("d", { unit_hint: "kVAr" }),
      point("e", { mapped: { asset_id: 2, metric: "voltage_v" } }),
      point("f", { mapped: { asset_id: 1, metric: "energy_kwh" } }),
    ];
    const hits = (query: string) => addresses(viewPoints(rows, assetLabel, view({ query })));
    expect(hits("plc/alpha")).toEqual(["PLC/Alpha"]);
    expect(hits("BOILER")).toEqual(["b"]);
    expect(hits("counter")).toEqual(["c"]);
    expect(hits("kvar")).toEqual(["d"]);
    expect(hits("chiller (room")).toEqual(["e"]);
    expect(hits("energy_kwh")).toEqual(["f"]);
    expect(hits("nothing like this")).toEqual([]);
  });

  it("treats a blank query, with or without spaces, as no filter, and trims a typed one", () => {
    const rows = [point("a", { name: "Pump" }), point("b", { name: "Fan" })];
    expect(viewPoints(rows, assetLabel, view({ query: "" }))).toHaveLength(2);
    expect(viewPoints(rows, assetLabel, view({ query: "   " }))).toHaveLength(2);
    expect(addresses(viewPoints(rows, assetLabel, view({ query: "  pump " })))).toEqual(["a"]);
  });

  it("combines the query with unmappedOnly", () => {
    const rows = [
      point("a", { name: "Pump", mapped: { asset_id: 1, metric: "energy_kwh" } }),
      point("b", { name: "Pump" }),
      point("c", { name: "Fan" }),
    ];
    expect(addresses(viewPoints(rows, assetLabel, view({ query: "pump", unmappedOnly: true })))).toEqual(["b"]);
  });

  it("does not change the array it is given", () => {
    const rows = [point("3:10"), point("3:2")];
    const before = [...rows];
    const shown = viewPoints(rows, assetLabel, view({ sort: "name", dir: "desc" }));
    expect(rows).toEqual(before);
    expect(shown).not.toBe(rows);
  });
});

describe("sortBy", () => {
  it("flips the direction when the same column is clicked again", () => {
    const once = sortBy(DEFAULT_POINT_VIEW, "address");
    expect(once).toMatchObject({ sort: "address", dir: "desc" });
    expect(sortBy(once, "address")).toMatchObject({ sort: "address", dir: "asc" });
  });

  it("starts a new column ascending, even from a descending one", () => {
    const desc = sortBy(DEFAULT_POINT_VIEW, "address");
    expect(sortBy(desc, "name")).toMatchObject({ sort: "name", dir: "asc" });
  });

  it("keeps the filters and does not change its input", () => {
    const start = view({ unmappedOnly: true, query: "pump" });
    const next = sortBy(start, "name");
    expect(next).toMatchObject({ unmappedOnly: true, query: "pump" });
    expect(start).toEqual(view({ unmappedOnly: true, query: "pump" }));
  });
});
