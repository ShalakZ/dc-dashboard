import type { Appearance } from "../lib/appearance";
import type { PermissionId } from "../lib/permissions";

/** The account's appearance choice, as /api/me, /api/login, /api/setup and PUT /api/me/preferences answer it. */
export type Preferences = Appearance;
/**
 * The signed-in account, as /api/me, /api/login and /api/setup answer it. `role` is the role's name (a built-in one is `viewer`, `operator` or
 * `admin`; an administrator may add others); `permissions` is what the role lets the account do. A newer server may send an id this build has
 * never heard of: it is kept and nothing asks for it.
 */
export interface User { id: number; username: string; role: string; permissions: PermissionId[]; preferences: Preferences }

/**
 * `icon` is the chosen icon id (lib/assetIcons.ts), null for Automatic. `kind_icon` is the icon of the asset's kind in the registry (the server
 * matches the kind text to a registry kind by its key), null when the kind is not registered. Both are optional in the type because many fixtures
 * build an Asset by hand; the API always sends them.
 */
export interface Asset { id: number; parent_id: number | null; name: string; kind: string; sort_order: number; icon?: string | null; kind_icon?: string | null }
/** `icon`: a catalogue id, null to go back to Automatic, left out to leave it as it is (the server treats an absent key as unchanged). */
export interface AssetIn { name: string; parent_id: number | null; kind: string; sort_order: number; icon?: string | null }
/** One kind of the registry (GET /api/asset-kinds, sorted by key). `icon` is a catalogue id as stored; `asset_count` counts the assets whose kind text has this kind's key. */
export interface AssetKind {
  id: number; name: string; icon: string; asset_count: number;
  /** The server's word that this name is one of the built-in kinds (matched by key). */
  starter: boolean;
}
/** `icon` left out = generic. */
export interface AssetKindIn { name: string; icon?: string }
/** A key left out is left as it is; neither may be null. */
export interface AssetKindPatch { name?: string; icon?: string }
/** The answer to POST /api/asset-kinds/starter-pack: the names of the kinds it added (in the order it added them), and how many starter kinds were already in the registry. */
export interface StarterPackResult { added: string[]; already_there: number }
/** What deleting an asset takes with it (GET /api/assets/{id}/impact; also the counts in the 409 body of DELETE /api/assets/{id}). */
export interface AssetImpact { assets: number; mappings: number; tariffs: number }
/** What deleting a source takes with it (GET /api/sources/{id}/impact; also the counts in the 409 body of DELETE /api/sources/{id}). */
export interface SourceImpact { points: number; mappings: number }

/**
 * POST /api/assets/move-preview and /api/assets/move (assets.edit). One group puts `ids` under `parent_id` (null = the top level), in front
 * of the sibling `before_id` (null = last). The server reduces `ids` to roots (an id below another id of the request travels inside it) and
 * orders them as the tree orders them. At most 500 groups and 500 ids in all, each id once.
 */
export interface MoveGroup { ids: number[]; parent_id: number | null; before_id: number | null }
/**
 * What the person was shown; the server refuses (409 `stale`) when reality differs and moves nothing. `assets`: assets that move in all
 * (roots plus descendants); `parents`: each ROOT's parent id as shown, keyed by the root's id, the roots already in place included (at most 500); `rate_changes`: the preview's verdict, so
 * a tariff added after it cannot slip past the warning. Every key is optional; the preview answers with all three.
 */
export interface MoveExpect { assets?: number; parents?: Record<string, number | null>; rate_changes?: boolean }
export interface MoveBody { moves: MoveGroup[]; expect?: MoveExpect | null; undo_of?: string | null }
/**
 * One moved root in a preview. `rate_before`/`rate_after` are the per-kWh rates of today (null: no tariff applies, its energy shows without
 * cost). The rate can also change on other days (a dated tariff row): `rate_changes_other_days`. `change` "order" is a reorder inside one
 * parent, which never changes a rate.
 */
export interface MovePreviewRoot {
  id: number; name: string; subtree_assets: number;
  from_parent_id: number | null; from_parent_name: string | null; to_parent_id: number | null; to_parent_name: string | null;
  change: "parent" | "order";
  rate_before: number | null; rate_after: number | null; rate_changes_today: boolean; rate_changes_other_days: boolean;
}
/** The answer to POST /api/assets/move-preview: nothing is written. `expect` is what to send back with the move. `currency` is the site's (null = not set). */
export interface MovePreview {
  assets: number; unchanged: number[]; currency: string | null; rate_changes: boolean; roots: MovePreviewRoot[];
  expect: Required<MoveExpect>;
}
/** One root the move moved or reordered. */
export interface MovedAsset {
  id: number; name: string;
  from_parent_id: number | null; to_parent_id: number | null; from_parent_name: string | null; to_parent_name: string | null;
  change: "parent" | "order";
}
/** The request that puts everything back: send `moves` with `expect`, and `undo_of` = the first request's `request_id`. */
export interface MoveUndo { moves: MoveGroup[]; expect: Required<Pick<MoveExpect, "assets" | "parents">> }
/** The answer to POST /api/assets/move. `unchanged` ids were skipped (already there). */
export interface MoveResult { request_id: string; assets: number; unchanged: number[]; moved: MovedAsset[]; undo: MoveUndo }
/**
 * One entry of the `refusals` list in the body of a 422 from the move routes; `reason` is a full sentence in names, `code` a short word
 * (cycle, name_clash, ...). `name` is null when the server has no asset to name (the `invalid` code, which body validation makes unreachable);
 * `moveRefusals` turns that into "".
 */
export interface MoveRefusal { id: number; name: string | null; reason: string; code: string }

export interface Source {
  id: number; name: string; connector_type: string; config: Record<string, unknown>; origin: "manual" | "discovered";
  enabled: boolean; status: string; last_seen: string | null; last_error: string | null; has_secret: boolean;
  /** Seconds since the newest stored reading (BAD-quality rows count); null when the source has none. */
  last_reading_age_seconds?: number | null;
  /** How many of its points have a mapping (the list endpoint only). */
  mapped_points?: number;
  /** Config keys whose value had a user name and password removed from it (the `config` here is already masked). */
  hidden_config_keys?: string[];
}
export interface CollectorStatus { alive: boolean; age_seconds: number | null }
/**
 * GET /api/status (any signed-in user), the top bar's chip. `readings_fresh` is the server's verdict (each mapping judged against its
 * own poll interval; null when no mapped point has ever been read), `last_reading_age_seconds` only a caption.
 */
export interface LiveStatus { collector_alive: boolean; readings_fresh: boolean | null; last_reading_age_seconds: number | null }
/** GET /api/secret-key/status: whether every stored source secret can be decrypted with the key in .env. */
export interface SecretKeyStatus {
  ok: boolean;
  key_changed: boolean;
  unreadable: { id: number; name: string }[];
}
/** GET /api/tls/status (admin): the HTTPS certificate's expiry as the collector last published it. `state` is null when `enabled` is false. */
export type TlsState = "ok" | "expiring" | "expired" | "unreadable" | "unknown";
export interface TlsStatus {
  enabled: boolean;
  state: TlsState | null;
  not_after: string | null;
  days_left: number | null; // whole days, 0 once expired
  subject: string | null;
  checked_at: string | null;
  error: string | null;
}
/** GET /api/version (any signed-in user): the build the api runs. `dev` / `unknown` when the image was built without the build id. */
export interface VersionInfo {
  build_id: string;
  build_time: string;
  uptime_seconds: number;
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
/** One meter that makes up a parent's live power; `value` is already scaled and null when there is no good reading. */
export interface RollupSource {
  asset_id: number; name: string; path: string; point_id: number; value: number | null; ts: string | null; stale: boolean;
}
export interface Summary {
  asset: { id: number; name: string; parent_id: number | null; kind: string; icon?: string | null; kind_icon?: string | null };
  metrics: SummaryMetric[];
  /** Set only for an asset with no power meter of its own whose sub-assets have some (optional so older fixtures type-check). */
  power_rollup?: { sources: RollupSource[] } | null;
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

/** `blocked`: some sign-in key of this account name is blocked right now (GET /api/users). */
export interface UserRow { id: number; username: string; role: string; active: boolean; blocked?: boolean }
/** One role as GET /api/roles answers it. `assignable`: the caller holds every permission the role grants, so may give it to an account and manage the accounts that hold it. `permissions` is null unless the caller holds roles.manage. */
export interface RoleRow { id: number; name: string; description: string; builtin: boolean; user_count: number; assignable: boolean; permissions: string[] | null }
/** One permission as GET /api/permissions answers it (roles.manage only). `kind`: a See, a Change, or a risky action that gets its own group in the editor. `area` is the server's word for the row of the editor's grid. */
export interface PermissionRow { id: string; area: string; kind: "see" | "change" | "risky"; label: string; description: string }
export interface GeneralSettings { timezone: string }

export interface SignInValues { max_failures: number; block_minutes: number }
/** What GET and PUT /api/settings/sign-in answer: the policy in force (`enabled` false = nobody is blocked), its bounds as [min, max] and the factory values; PUT takes the two numbers and `enabled`. */
export interface SignInPolicy extends SignInValues {
  enabled: boolean;
  limits: { max_failures: [number, number]; block_minutes: [number, number] };
  defaults: SignInValues;
}

export interface StorageSettings {
  raw_retention_days: number;
  compress_after_days: number;
  rollup_1m_retention_days: number;
  disk_capacity_gb: number;
  warn_threshold_pct: number;
}
/** What GET /api/settings/storage answers: the stored values, the factory values and this site's own default (null until one is set); PUT takes and returns only the five. */
export type StorageSettingsOut = StorageSettings & { factory: StorageSettings; site_default: StorageSettings | null };
/** GET /api/storage/rows-per-day: one entry per UTC day from `start` to `end`, zero filled. */
export interface RowsPerDayRange {
  start: string;
  end: string;
  days: { day: string; rows: number }[];
  total_rows: number;
  first_day: string | null;
  last_day: string;
}
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
  retention_paused: boolean;
}

export type ScanStatus = "queued" | "running" | "done" | "failed";
export interface ScanCounters { hosts?: number; pairs?: number; checked?: number; open?: number; claimed?: number; points?: number; unidentified?: number; needs_credentials?: number }
export interface Scope { id: number; name: string; targets: string[]; ports: number[]; created_at: string }
export interface ScopeIn { name: string; targets: string[]; ports: number[] }
export interface ScopePreview { hosts: number; ports: number; pairs: number; digest: string }
export interface ScopeSuggestions { targets: string[]; ports: number[] }
export interface Finding { host: string; port: number; source_id: number | null; connector_type: string | null; outcome: "claimed" | "needs_credentials" | "unclaimed"; detail: string }
export interface ScanSummary { id: number; scope_id: number | null; scope_name: string; /** What the scan covered, from its snapshot (so it outlives a deleted scope); absent in old fixtures. */ targets?: string[]; ports?: number[]; status: ScanStatus; stage: "sweep" | "probe" | "browse" | null; progress: ScanCounters; created_at: string; finished_at: string | null; error: string | null }
export interface ScanDetail extends ScanSummary { scope_snapshot: Record<string, unknown>; findings: Finding[] }
export interface Suggestion { metric: Metric; scale: number; interval_seconds: number; custom_unit: string | null }
export interface GraphPoint { id: number; address: string; name: string; unit_hint: string | null; mapping_id: number | null; asset_id: number | null; mapped_metric: Metric | null; suggestion: Suggestion }
export interface GraphCluster { key: string; points: GraphPoint[] }
export interface GraphSource {
  id: number; name: string; connector_type: string; config: Record<string, unknown>; origin: "manual" | "discovered";
  enabled: boolean; status: string; last_error: string | null; has_secret: boolean; needs_credentials: boolean;
  point_count: number; clusters: GraphCluster[]; ungrouped: GraphPoint[];
  /** The newest scan that found this source (named last_scan: `last_seen` on a source is its last successful poll); null = never found by a scan; absent in old fixtures. */
  last_scan?: { scan_id: number; at: string } | null;
}
export interface GraphModel {
  sources: GraphSource[];
  unidentified: { host: string; port: number; scan_id: number }[];
  /** `icon` (the one chosen, null = Automatic) and `kind_icon` (the registry's, resolved) are what `assetIcon` needs; left out by an older response and by old fixtures. */
  assets: (Pick<Asset, "id" | "parent_id" | "name" | "kind"> & { icon?: string | null; kind_icon?: string | null })[];
  layout: Record<string, { x: number; y: number }>;
}
export interface AcceptPointIn { point_id: number; metric: Metric; scale: number; interval_seconds: number | null; custom_unit: string | null }
/** Exactly one target: an existing asset or a new one. The `never` keeps a body that names both from compiling. */
export type AcceptIn = { source_id: number; points: AcceptPointIn[] } & (
  | { asset_id: number; new_asset?: never }
  | { new_asset: { name: string; parent_id: number | null }; asset_id?: never }
);
export interface AcceptResult { asset_id: number; mapping_ids: number[] }
/** The kinds of record an audit entry's details can point at; the server looks their names up (GET /api/audit `refs`). */
export type RefKind = "asset" | "user" | "source" | "dashboard" | "point";
/** Kind -> id (as a string key) -> the name it has now. A kind or an id that is missing is a target that no longer exists. */
export type AuditRefs = Partial<Record<RefKind, Record<string, string>>>;
export interface AuditEntry {
  id: number; user_id: number | null; actor_id: number | null; username: string | null; action: string;
  detail: Record<string, unknown>; ts: string;
  /** Optional only so test fixtures stay small: undefined = no lookup was made (not "everything is deleted"). */
  refs?: AuditRefs;
}
export interface AuditList { total: number; offset: number; limit: number; items: AuditEntry[] }
export interface AuditOptions { actions: string[]; users: { id: number; name: string }[]; unattributed: boolean }
export interface AuditPosition { offset: number; total: number; on_day: boolean }

// ---- Phase 3: site info, tariffs, billing, dashboards ----

export type RangePreset = "1h" | "6h" | "24h" | "7d" | "30d" | "today" | "yesterday" | "this_month" | "last_month";

export interface Site { timezone: string; currency: string | null }
export interface BillingSettings { currency: string | null }
/** The site-local month (`YYYY-MM`) of the first energy reading; `null` when there is none. */
export interface BillingMonths { first_month: string | null }

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
/** One asset with a reading that needs attention, as the fleet summary lists it (`path` runs from the root down and ends with `name`). */
export interface AttentionItem { asset_id: number; name: string; path: string; problem: "bad" | "stale"; points: number; last_ts: string }
/** GET /api/fleet/summary: the Assets Tree landing page. `power.kw` is null (never 0) when no meter is counted; `attention.total` counts all, `items` is cut at 25. */
export interface FleetSummary {
  power: { kw: number | null; counted: number; of: number };
  energy_today: { kwh: number; estimated: boolean; no_data: boolean } | null;
  cost_today: CostToday | null;
  currency: string | null;
  attention: { total: number; items: AttentionItem[] };
}
export interface BillingAssetRow {
  asset_id: number; parent_id: number | null; name: string; path: string; rate_per_kwh: number | null;
  days: (CostFigure | null)[]; total: CostFigure | null;
}
/** A closed month's record (billing.close): who froze it and when, the reason typed then, and the two header totals of the stored figures (the sum of the root assets). */
export interface BillingClosed { id: number; closed_name: string; closed_at: string; note: string; total_kwh: number; total_cost: number | null }
/**
 * What today's tree and rates would give for a closed month, beside the frozen figures. `delta_*` is live minus closed; `delta_cost` is null when only one side
 * has a cost. `changed_assets` counts the assets whose own figures or place differ, which the root totals cannot show. `currency` is today's.
 */
export interface BillingLive {
  total_kwh: number; total_cost: number | null; delta_kwh: number; delta_cost: number | null;
  differs: boolean; changed_assets: number; currency: string | null;
}
/** `closed` is null for an open month; for a closed one the rest of the body is the stored snapshot and `live` says what today's data would give (null when it cannot be priced). */
export interface BillingCosts {
  month: string; timezone: string; currency: string | null; days: string[]; assets: BillingAssetRow[];
  closed: BillingClosed | null; live?: BillingLive | null;
}
/** The answer to reopening a month. */
export interface BillingReopened { month: string; reopened_at: string }

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
/** The dashboard people land on; `null` when none is set. */
export interface DefaultDashboard { dashboard_id: number | null }
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

/** One step of a connection check (backend diagnostics/check.py `Step.to_json`). `ok: null` = skipped (a step it needs failed). */
export interface CheckStepError { class: string; status_name: string | null; status_hex: string | null; message: string }
export interface CheckStep {
  id: string; name: string; ok: boolean | null; ms: number | null; summary: string;
  error: CheckStepError | null; hint: string | null; detail: Record<string, unknown>;
}
/** `result` of a `check_connection` job: rewritten after every step while the job is `running`, final when it is `done`. */
export interface ConnectionCheckResult {
  source_id: number | null; connector_type: string; started_at: string; finished: boolean; ok: boolean | null; first_failed: string | null;
  steps: CheckStep[];
  clock: { server_time: string | null; local_time: string; skew_seconds: number | null };
  names: { hosts: string[]; uris: string[] };
}

/** GET /api/diagnostics/report?format=json (needs diagnostics.view). Part sizes are the server's (`chars` leaves out line breaks, as the part's footer does). */
export type ReportDetail = "summary" | "full";
export interface ReportPart { index: number; of: number; text: string; chars: number; lines: number }
export interface ReportReply {
  format: string; build_id: string; detail: ReportDetail; mask: boolean; checksum: string; parts: ReportPart[];
  legend: { alias: string; original: string }[]; // empty unless mask; for the screen only, never in the text
}
export interface ReportParams { detail: ReportDetail; mask: boolean; source: number | null }
/** POST /api/discovery/sources/remove: what it removed and what it kept (and why). */
export interface RemoveSourcesResult {
  removed: { id: number; name: string }[];
  skipped: { id: number; name: string | null; reason: "mapped" | "manual" | "gone" }[];
}
