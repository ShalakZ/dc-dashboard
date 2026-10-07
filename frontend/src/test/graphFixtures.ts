import type { GraphModel, GraphPoint } from "../api/types";

/** Builders shared by the graph and drop tests: source 1 is discovered and unmapped, source 2 is manual with two points mapped to asset 10. */
export const point = (id: number, name: string, extra: Partial<GraphPoint> = {}): GraphPoint => ({
  id, address: `a${id}`, name, unit_hint: null, mapping_id: null, asset_id: null, mapped_metric: null,
  suggestion: { metric: "custom", scale: 1, interval_seconds: 5, custom_unit: null }, ...extra,
});
export const source = (id: number, over: object = {}) => ({
  id, name: `s${id}`, connector_type: "opcua", config: {}, origin: "discovered" as const, enabled: false, status: "unknown",
  last_error: null, has_secret: false, needs_credentials: false, point_count: 0, clusters: [], ungrouped: [], ...over,
});
export const model = (over: Partial<GraphModel> = {}): GraphModel => ({
  sources: [
    source(1, {
      point_count: 7,
      clusters: [{ key: "LVP01", points: [point(1, "LVP01 kW"), point(2, "LVP01 kWh"), point(3, "LVP01 V")] },
                 { key: "LVP02", points: [point(4, "LVP02 kW"), point(5, "LVP02 kWh"), point(6, "LVP02 V")] }],
      ungrouped: [point(7, "Status")],
    }),
    source(2, { origin: "manual", enabled: true, clusters: [{ key: "M", points: [
      point(8, "M kW", { asset_id: 10, mapping_id: 1, mapped_metric: "active_power_kw" }),
      point(9, "M V", { asset_id: 10, mapping_id: 2, mapped_metric: "voltage_v" })] }] }),
  ],
  unidentified: [{ host: "10.0.0.9", port: 8080, scan_id: 4 }],
  assets: [{ id: 10, parent_id: null, name: "Site", kind: "generic" }, { id: 11, parent_id: 10, name: "Panel 1", kind: "generic" }],
  layout: {}, ...over,
});
