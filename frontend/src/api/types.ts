export type Role = "viewer" | "operator" | "admin";
export const ROLE_LEVEL: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export interface User { id: number; username: string; role: Role }

export interface Asset { id: number; parent_id: number | null; name: string; kind: string; sort_order: number }
export interface AssetIn { name: string; parent_id: number | null; kind: string; sort_order: number }
/** What deleting an asset takes with it (the 409 body of DELETE /api/assets/{id} without confirm=true). */
export interface AssetImpact { assets: number; mappings: number; tariffs: number }
/** What deleting a source takes with it (the 409 body of DELETE /api/sources/{id} without confirm=true). */
export interface SourceImpact { points: number; mappings: number }

export interface Source {
  id: number; name: string; connector_type: string; config: Record<string, unknown>; origin: "manual" | "discovered";
  enabled: boolean; status: string; last_seen: string | null; last_error: string | null; has_secret: boolean;
}
export interface SourceIn {
  name: string; connector_type: string; config: Record<string, unknown>; secret?: string | null; enabled: boolean;
}

export interface JsonSchema {
  type?: string; title?: string; properties?: Record<string, JsonSchemaProperty>; required?: string[];
}
export interface JsonSchemaProperty {
  type?: string; title?: string; description?: string; default?: unknown; format?: string;
  anyOf?: { type?: string; format?: string }[]; minimum?: number; maximum?: number;
}
export interface Connector { type: string; config_schema: JsonSchema }

export const METRICS = [
  "active_power_kw", "energy_kwh", "voltage_v", "current_a", "power_factor",
  "frequency_hz", "reactive_power_kvar", "apparent_power_kva", "custom",
] as const;
export type Metric = (typeof METRICS)[number];

export interface Mapping {
  id: number; point_id: number; asset_id: number; metric: Metric; scale: number;
  interval_seconds: number; custom_unit: string | null;
}
export interface MappingIn {
  point_id: number; asset_id: number; metric: Metric; scale: number;
  interval_seconds: number | null; custom_unit: string | null;
}
/** Row of GET /api/sources/{id}/points: mapping is embedded (without point_id). */
export interface PointRow {
  id: number; address: string; name: string; data_type: string; unit_hint: string | null;
  mapping: Omit<Mapping, "point_id"> | null;
}

export interface SummaryMetric {
  mapping_id: number; point_id: number; metric: Metric; unit: string;
  value: number | null; ts: string | null; quality: number | null;
}
export interface Summary {
  asset: { id: number; name: string; parent_id: number | null; kind: string };
  metrics: SummaryMetric[];
  energy_today: { kwh: number; estimated: boolean; no_data: boolean } | null;
  cost_today: CostToday | null;
  currency: string | null;
}
export interface SeriesPoint { ts: string; avg: number; min: number; max: number }
export type SeriesTier = "raw" | "1m" | "1h";
export interface Series { metric: Metric; unit: string; points: SeriesPoint[]; tier?: SeriesTier }

export type JobStatus = "pending" | "running" | "done" | "failed";
export interface Job {
  id: number; kind: string; status: JobStatus; result: Record<string, unknown> | null;
  created_at: string; finished_at: string | null;
}
/** result of a done test_source job (dataclasses.asdict(ConnectionCheck)) */
export interface CheckResult { ok: boolean; status: string; latency_ms: number | null; message: string }

export interface UserRow { id: number; username: string; role: Role; active: boolean }
export interface GeneralSettings { timezone: string }

export interface StorageSettings {
  raw_retention_days: number;
  compress_after_days: number;
  rollup_1m_retention_days: number;
  disk_capacity_gb: number;
  warn_threshold_pct: number;
}
/** What GET /api/settings/storage answers: the stored values plus the factory values; PUT takes and returns only the five. */
export type StorageSettingsOut = StorageSettings & { factory: StorageSettings };
export interface StorageStats {
  database_bytes: number;
  readings_bytes_uncompressed: number;
  readings_bytes_compressed: number;
  readings_bytes_total: number;
  rollup_1m_bytes: number;
  rollup_1h_bytes: number;
  rows_per_day: { day: string; rows: number }[];
  growth_bytes_per_day: number;
  disk_capacity_bytes: number;
  used_pct: number;
  days_until_full: number | null;
  warn: boolean;
  settings: StorageSettings;
}

export type ScanStatus = "queued" | "running" | "done" | "failed";
export interface ScanCounters { hosts?: number; pairs?: number; checked?: number; open?: number; claimed?: number; points?: number; unidentified?: number; needs_credentials?: number }
export interface Scope { id: number; name: string; targets: string[]; ports: number[]; created_at: string }
export interface ScopeIn { name: string; targets: string[]; ports: number[] }
export interface ScopePreview { hosts: number; ports: number; pairs: number; digest: string }
export interface ScopeSuggestions { targets: string[]; ports: number[] }
export interface Finding { host: string; port: number; source_id: number | null; connector_type: string | null; outcome: "claimed" | "needs_credentials" | "unclaimed"; detail: string }
export interface ScanSummary { id: number; scope_id: number | null; scope_name: string; status: ScanStatus; stage: "sweep" | "probe" | "browse" | null; progress: ScanCounters; created_at: string; finished_at: string | null; error: string | null }
export interface ScanDetail extends ScanSummary { scope_snapshot: Record<string, unknown>; findings: Finding[] }
export interface Suggestion { metric: Metric; scale: number; interval_seconds: number; custom_unit: string | null }
export interface GraphPoint { id: number; address: string; name: string; unit_hint: string | null; mapping_id: number | null; asset_id: number | null; mapped_metric: Metric | null; suggestion: Suggestion }
export interface GraphCluster { key: string; points: GraphPoint[] }
export interface GraphSource {
  id: number; name: string; connector_type: string; config: Record<string, unknown>; origin: "manual" | "discovered";
  enabled: boolean; status: string; last_error: string | null; has_secret: boolean; needs_credentials: boolean;
  point_count: number; clusters: GraphCluster[]; ungrouped: GraphPoint[];
}
export interface GraphModel {
  sources: GraphSource[];
  unidentified: { host: string; port: number; scan_id: number }[];
  assets: Pick<Asset, "id" | "parent_id" | "name" | "kind">[];
  layout: Record<string, { x: number; y: number }>;
}
export interface AcceptPointIn { point_id: number; metric: Metric; scale: number; interval_seconds: number | null; custom_unit: string | null }
/** Exactly one target: an existing asset or a new one. The `never` keeps a body that names both from compiling. */
export type AcceptIn = { source_id: number; points: AcceptPointIn[] } & (
  | { asset_id: number; new_asset?: never }
  | { new_asset: { name: string; parent_id: number | null }; asset_id?: never }
);
export interface AcceptResult { asset_id: number; mapping_ids: number[] }
export interface AuditEntry { id: number; user_id: number | null; username: string | null; action: string; detail: Record<string, unknown>; ts: string }
export interface AuditPage { total: number; items: AuditEntry[] }

// ---- Phase 3: site info, tariffs, billing, dashboards ----

export type RangePreset = "1h" | "6h" | "24h" | "7d" | "30d" | "today" | "yesterday" | "this_month" | "last_month";

export interface Site { timezone: string; currency: string | null }
export interface BillingSettings { currency: string | null }

export interface Tariff {
  id: number; asset_id: number | null; asset_name: string | null; asset_path: string | null; rate_per_kwh: number;
  effective_from: string; created_by: number | null; created_at: string;
}
export interface TariffIn { asset_id: number | null; rate_per_kwh: number; effective_from: string }
export interface TariffPatch { rate_per_kwh?: number; effective_from?: string }

/**
 * One asset on one day (or the whole month). `cost` is null when no rate applied; `no_data` means no hour of it was
 * recorded, so its 0 kWh is not a measurement.
 */
export interface CostFigure { kwh: number; cost: number | null; estimated: boolean; partial: boolean; no_data: boolean }
/** `cost_today` of the asset summary: no kWh, the energy tile already has it. */
export interface CostToday { cost: number | null; estimated: boolean; partial: boolean; no_data: boolean }
export interface BillingAssetRow {
  asset_id: number; parent_id: number | null; name: string; path: string; rate_per_kwh: number | null;
  days: (CostFigure | null)[]; total: CostFigure | null;
}
export interface BillingCosts { month: string; timezone: string; currency: string | null; days: string[]; assets: BillingAssetRow[] }

export const WIDGET_TYPES = ["timeseries", "bar", "stat", "gauge", "table"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export type WidgetSource = "metric" | "energy" | "cost";
export type WidgetAggregation = "avg" | "min" | "max" | "last" | "sum";
export interface WidgetConfig {
  assets: number[]; source: WidgetSource; metric: Metric | null; aggregation: WidgetAggregation;
  range: RangePreset | null; bars: "asset" | "time"; min: number; max: number | null;
}
export interface Widget { id: number; type: WidgetType; title: string; config: WidgetConfig; x: number; y: number; w: number; h: number }
export type WidgetIn = Omit<Widget, "id">;
export interface Dashboard { id: number; name: string; range: RangePreset; updated_at: string; widgets: Widget[] }
export interface DashboardListItem { id: number; name: string; range: RangePreset; widget_count: number; updated_at: string }
export interface DashboardIn { name: string; range?: RangePreset }
export interface DashboardSave { name: string; range: RangePreset; updated_at: string; widgets: WidgetIn[] }

/**
 * One bucket of a widget series. `value === null && !no_data` is a bucket that was recorded but has no rate (draw a
 * dash); `no_data` is a gap (draw nothing).
 */
export interface WidgetPoint {
  ts: string; value: number | null; min: number | null; max: number | null;
  estimated: boolean; partial: boolean; no_data: boolean;
}
export interface WidgetSeries { asset_id: number; name: string; points: WidgetPoint[]; estimated: boolean; partial: boolean }
/** `ts`/`stale` describe a metric `last` reading (null/false for every other value); `no_data` is true when nothing was recorded. */
export interface WidgetValue {
  asset_id: number; name: string; value: number | null; estimated: boolean; partial: boolean; point_id: number | null;
  no_data: boolean; ts: string | null; stale: boolean;
}
export interface WidgetData {
  type: WidgetType; mode: "series" | "values"; source: WidgetSource; metric: Metric | null; unit: string | null;
  range: { preset: RangePreset; start: string; end: string }; tier: SeriesTier | null; bucket: "hour" | "day" | null;
  series: WidgetSeries[]; values: WidgetValue[]; missing: number[]; no_metric: number[];
}
