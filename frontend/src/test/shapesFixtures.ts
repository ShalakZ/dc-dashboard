import type { Shape, ShapeCheck, ShapeLinesAnswer, ShapesAnswer } from "../api/shapes";
import type { TagListReport } from "../api/types";

// The answers of the shapes routes, as the plan's contract words them (w36). Used by the tests of the shapes page, its row and its Review dialog.

/** `PDUA#_PM0_PENRG`: 200 tags, a kWh counter. */
export const shape = (over: Partial<Shape> = {}): Shape => ({
  key: "pdua#_pm#_penrg", label: "PDUA#_PM0_PENRG", count: 200, mapped: 0, twins: 0, duplicates: 0,
  examples: [
    { name: "PDUA01_PM0_PENRG", address: "ns=3;s=20403:Site.PDUA01_PM0_PENRG" },
    { name: "PDUA02_PM0_PENRG", address: "ns=3;s=20404:Site.PDUA02_PM0_PENRG" },
    { name: "PDUA03_PM0_PENRG", address: "ns=3;s=20405:Site.PDUA03_PM0_PENRG" },
  ],
  unit_hints: ["kWh"], mixed_units: false,
  suggestion: { metric: "energy_kwh", scale: 1, interval_seconds: 60, custom_unit: null, guess: true, mixed: false },
  billing: "counter", per_equipment: 1, equipment: null, similar: ["pdub#_pm#_penrg"], rule: null, ...over,
});

export const PENRG_B = (): Shape =>
  shape({
    key: "pdub#_pm#_penrg", label: "PDUB#_PM0_PENRG", similar: ["pdua#_pm#_penrg"],
    examples: [{ name: "PDUB01_PM0_PENRG", address: "ns=3;s=20503:Site.PDUB01_PM0_PENRG" }],
  });

export const POWER = (): Shape =>
  shape({
    key: "pdua#_pm#_p", label: "PDUA#_PM0_P", billing: "power", unit_hints: ["kW"], similar: [],
    suggestion: { metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null, guess: true, mixed: false },
    examples: [{ name: "PDUA01_PM0_P", address: "ns=3;s=20403:Site.PDUA01_PM0_P" }],
  });

export const VOLTAGE = (): Shape =>
  shape({
    key: "pdua#_pm#_vl#n", label: "PDUA#_PM0_VL#N", billing: null, count: 600, unit_hints: ["V"], similar: [],
    suggestion: { metric: "voltage_v", scale: 1, interval_seconds: 5, custom_unit: null, guess: true, mixed: false },
    examples: [{ name: "PDUA01_PM0_VL1N", address: "ns=3;s=20403:Site.PDUA01_PM0_VL1N" }],
  });

export const answer = (over: Partial<ShapesAnswer> = {}): ShapesAnswer => ({
  source_id: 5, source_name: "Plant SCADA", points: 15000, mapped: 12, other_tags: 4190,
  other_examples: [{ name: "PDUA01_Q1_P", address: "ns=3;s=20403:Site.PDUA01_Q1_P" }, { name: "PDUA02_Q1_P", address: "a2" }, { name: "PDUA03_Q1_P", address: "a3" }],
  shapes: [shape(), PENRG_B(), POWER(), VOLTAGE()], shapes_total: 4, more_shapes: 0,
  assets: [
    { id: 1, parent_id: null, name: "Hall 1", kind: "room", icon: null },
    { id: 2, parent_id: 1, name: "Row A", kind: "row", icon: null },
  ],
  ...over,
});

export const check = (over: Partial<ShapeCheck> = {}): ShapeCheck => ({ kind: "outlier", severity: "warning", shape: "pdua#_pm#_penrg", text: "198 of 200 like PDUA01 have this tag; PDUA17 and PDUA44 do not", ...over });

export const linesAnswer = (over: Partial<ShapeLinesAnswer> = {}): ShapeLinesAnswer => ({
  csv: 'tag,asset,metric,unit,scale,interval_seconds\n"ns=3;s=20403:Site.PDUA01_PM0_PENRG","Hall 1/PDUA01","energy_kwh","","",""\n',
  lines: 400, blocking: false,
  by_shape: [{ shape: "pdua#_pm#_penrg", label: "PDUA#_PM0_PENRG", lines: 400, assets: 400, skipped_mapped: 12, skipped_twins: 0 }],
  checks: [],
  samples: [
    { shape: "pdua#_pm#_penrg", tag: "PDUA01_PM0_PENRG", address: "ns=3;s=20403:Site.PDUA01_PM0_PENRG", asset: "Hall 1/PDUA01", unit_hint: "kWh", metric: "energy_kwh", scale: 1 },
    { shape: "pdua#_pm#_penrg", tag: "PDUA02_PM0_PENRG", address: "ns=3;s=20404:Site.PDUA02_PM0_PENRG", asset: "Hall 1/PDUA02", unit_hint: "kWh", metric: "energy_kwh", scale: 1 },
  ],
  ...over,
});

export const report = (over: Partial<TagListReport> = {}): TagListReport => ({
  dry_run: true, source_id: 5, sha256: "abc", plan_digest: "digest-1", lines: 400,
  points_to_create: 0, assets_to_create: ["Hall 1/PDUA01", "Hall 1/PDUA02"], assets_to_create_total: 398, mappings_to_create: 400,
  units: [{ unit: null, metric: "energy_kwh", scale: 1, count: 400 }], problems: [], problems_total: 0, ok: true,
  text: "Would create 400 mappings and 398 assets", audit_id: null, undo_until: null, ...over,
});
export const created = (over: Partial<TagListReport> = {}): TagListReport =>
  report({ dry_run: false, text: "Created 400 mappings and 398 assets", audit_id: 91, undo_until: "2026-10-24T10:00:00Z", ...over });
