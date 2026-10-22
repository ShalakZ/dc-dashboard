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
  /** The list endpoint only. False for a source that is filled by importing files (`file`): it is never tested, browsed or polled. A missing value counts as true. */
  polls?: boolean;
  /** The list endpoint only (w31): how far the history backfill got with this source. Left out by older fixtures; a missing or null value shows no history line. */
  history?: HistorySummary | null;
  /**
   * The list endpoint only (w32): while `status` is `offline`, the ISO time it began to be out of reach (the open incident's start, else the last answer); null
   * when the source is not offline or there is nothing to date it by. Left out by older fixtures: a missing value counts as null.
   */
  offline_since?: string | null;
  /** The list endpoint only (w32): how many readings of this source failed since it went offline (the open incident's count); null without an open incident. */
  failed_reads?: number | null;
  /** The list endpoint only (w33): for an offline source that a scan may have found again at a new address: the new source (`offer`), or several (`two`); null otherwise. */
  move_candidate?: MoveCandidateForOld | MoveTwo | null;
}
/**
 * The `history` object of a source list row (GET /api/sources): the part of the `history_status` row the Sources page shows. `supports_history` is the
 * connector class's flag (false = the backfill never asks this source for history). `state`: `never_run`, `idle` (caught up), `filling` (reading older
 * hours), `backing_off` (the last try failed; `next_try_at` is the earliest next one) or `not_supported`. The timestamps are ISO times; `last_error` is
 * already scrubbed of credentials by the server.
 */
export type HistoryState = "never_run" | "idle" | "filling" | "backing_off" | "not_supported";
export interface HistorySummary {
  supports_history: boolean; state: HistoryState;
  answered_through: string | null; last_success_at: string | null; next_try_at: string | null; last_error: string | null;
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
/** `polls`: false for a type that is filled by importing files (`file`), which is never tested, browsed or polled; the server lists those last. `description`: a sentence for the form, empty for most types. */
export interface Connector { type: string; config_schema: JsonSchema; polls: boolean; description: string }

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
  /** (w33) Set on a discovered source the newest done scan of the SAME range did not find (`scan_id`, `at`: that scan; `last_seen_*`: the one that last found it); null otherwise and for hand-added sources; absent in old fixtures. */
  not_seen?: NotSeen | null;
  /** (w33) What the source's server said about itself (read-only); `usable` = it identifies a server (not a default URI); `different` = another server answered at this address; null until learned. */
  identity?: SourceIdentity | null;
  /** (w33) A Docker container name for the source's current host (`simulator`), or null. */
  name_hint?: string | null;
  /** (w33) On a new unmapped source: it looks like an old mapped one that stopped answering (`offer`), or several old ones could be it (`two`). */
  move_candidate?: MoveCandidateForNew | MoveTwo | null;
}
export interface NotSeen { scan_id: number; at: string; last_seen_scan_id: number; last_seen_at: string }
export interface SourceIdentity {
  application_uri: string | null; application_name: string | null; product_uri: string | null; thumbprint: string | null; instance: string | null;
  usable: boolean; different: boolean;
}
/** Why a move is offered: `same_server` (equal application URI or instance id) or `possibly` (every mapped address and point name exists on the new server). */
export interface MoveMatch {
  kind: "same_server" | "possibly"; evidence: "uri" | "instance" | "addresses"; value: string | null;
  /** How many of the old source's mapped (address, name) pairs the new server has. */
  addresses: number;
  /** How many it lacks; null when the new server could not be browsed (it needs credentials). */
  missing_addresses: number | null;
  needs_tick: boolean;
}
export interface MoveTwo { kind: "two"; count: number }
/** On the NEW source's card (Discovery): the old source it looks like. Endpoints carry no user name or password. */
export interface MoveCandidateForNew {
  kind: "offer"; from_source_id: number; from_name: string; from_endpoint: string; from_since: string | null; mappings: number; assets: number; match: MoveMatch;
}
/** On the OLD source's row (Sources): the new source a scan found. */
export interface MoveCandidateForOld { kind: "offer"; to_source_id: number; to_name: string; to_endpoint: string; match: MoveMatch }
export interface MoveAddress { host: string; port: number; endpoint: string }
/** The body of POST /api/sources/{id}/move; `expect` is required for a real run (the numbers and texts the preview showed). */
export interface MoveIn {
  to: number; address: "as_found" | "name";
  expect?: { mappings: number; address_before: string; address_after: string; name_after: string | null };
}
/** The answer to POST /api/sources/{id}/move?dry_run=1. `scan_running`: a scan is queued or running (the real run would be refused). */
export interface MovePreview {
  dry_run: true; scan_running: boolean; source: { id: number; name: string }; target: { id: number; name: string; points: number };
  from: MoveAddress; to: MoveAddress; address: "as_found" | "name"; name_hint: string | null; rename: { from: string; to: string } | null;
  match: MoveMatch; mappings: number; mapped_points: number; assets: number; needs_tick: boolean;
}
export interface MoveDone {
  dry_run: false; audit_id: number; source: { id: number; name: string }; from: MoveAddress; to: MoveAddress; rename: { from: string; to: string } | null; undo_until: string;
}
/** The answer to POST /api/sources/moves/{audit_id}/undo; `readings_since_move` stay after an Undo. */
export interface MoveUndoResult { source: { id: number; name: string }; restored: { host: string; port: number; name: string }; readings_since_move: number; text: string }
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
export type RefKind = "asset" | "user" | "source" | "dashboard" | "point" | "display" | "playlist";
/** Kind -> id (as a string key) -> the name it has now. A kind or an id that is missing is a target that no longer exists. */
export type AuditRefs = Partial<Record<RefKind, Record<string, string>>>;
export interface AuditEntry {
  id: number; user_id: number | null; actor_id: number | null; username: string | null; action: string;
  detail: Record<string, unknown>; ts: string;
  /** Optional only so test fixtures stay small: undefined = no lookup was made (not "everything is deleted"). */
  refs?: AuditRefs;
  /**
   * w32: how the check or test this entry started ended. Only entries of `source.tested`, `source.checked` and `source.test_all` carry one; every other entry
   * has none (null or missing, and older fixtures leave it out).
   */
  outcome?: AuditOutcome | null;
}
/**
 * `state`: `passed`, `failed`, `running` (the job has not ended) or `gone` (neither the job nor its journal row is kept any more). `text` is a sentence for a person
 * ("The connection check passed (7 steps)."; for several jobs "3 passed, 1 failed"). `event_id`: the System events row that holds the end, or null. `counts`:
 * only for a started test of several sources.
 */
export type AuditOutcomeState = "passed" | "failed" | "running" | "gone";
export interface AuditOutcome {
  state: AuditOutcomeState; text: string; event_id: number | null;
  counts: { passed: number; failed: number; running: number; gone: number } | null;
}
export interface AuditList { total: number; offset: number; limit: number; items: AuditEntry[] }
export interface AuditOptions { actions: string[]; users: { id: number; name: string }[]; unattributed: boolean }
export interface AuditPosition { offset: number; total: number; on_day: boolean }

// ---- w32: system events (the journal behind Diagnostics: GET /api/events, needs diagnostics.view) ----

export type EventLevel = "info" | "warning" | "error";
/**
 * A source's trouble counted as ONE row (`source.offline`, `points.bad`): only rows that carry `detail.state` have one. `first_at` is when the trouble began (the
 * stored `since`, else the row's own time), `last_at` the newest failure; `duration_seconds` is stored once closed and measured at read time while open.
 * `closed_by`: `recovered` (the source answered again) or `polling_stopped` (the source was disabled, deleted or lost its last mapping); null while open.
 */
export interface Incident {
  state: "open" | "closed"; count: number; first_at: string; last_at: string; closed_at: string | null;
  duration_seconds: number; closed_by: "recovered" | "polling_stopped" | null;
}
/**
 * One row of the system journal. `message` and `detail` are already scrubbed of credentials by the server. `source_name` is null when the name is not known
 * (an event of no source, or one of a source that is gone: `source_deleted` says the latter; the options call it "deleted source #3"). Rows written before
 * w32 have no `incident`. Recovery rows keep these detail keys: `source.online` {incident_id, offline_seconds, failed_reads, interval} and `points.recovered`
 * {incident_id, bad_seconds, polls_with_bad_readings, interval}; the older rows have `source.online` {offline_seconds|null, failures, interval} and
 * `points.recovered` {bad_seconds, first, total}.
 */
export interface SystemEvent {
  id: number; ts: string; level: EventLevel; component: string; source_id: number | null; source_name: string | null; source_deleted: boolean;
  kind: string; code: string | null; message: string; detail: Record<string, unknown>; incident: Incident | null;
}
/**
 * GET /api/events, newest first. `next` is the cursor for the page after this one (`before=<next>`), null on the last page. `total` is asked for with `include_total=1`
 * (null without it) and is capped at 10,000: `total_capped` says there are more.
 */
export interface EventPage { items: SystemEvent[]; next: string | null; total: number | null; total_capped: boolean }
/** Who started the job this event ended (an audit entry), for `source.tested`, `source.checked` and `source.test_all`; `username` is null for a deleted account. */
export interface EventStartedBy { audit_id: number; username: string | null; ts: string }
/** GET /api/events/{id}. `started_by` is always there: null without `audit.view`, for other kinds of event, or when no audit entry started it. */
export interface EventDetail extends SystemEvent { started_by: EventStartedBy | null }
/** GET /api/events/options: the kinds that occur in the journal and the sources that have events (a gone source is named "deleted source #3"). */
export interface EventOptions { kinds: string[]; sources: { id: number; name: string }[] }
/** GET /api/events/summary: the tiles. `kept` is how many rows the journal holds, `oldest` the time of the oldest. */
export interface EventSummary {
  open_incidents: number; warnings_24h: number; errors_24h: number; kept: number; oldest: string | null; retention_days: number; max_rows: number;
}
/** The filters of the System events page, as the list, the CSV and the options take them: "" and [] mean "not set"; `source` is a source id as text; `from` and `to` are site days. */
export interface EventFilters { source: string; levels: EventLevel[]; kinds: string[]; from: string; to: string; open: boolean }
/** What PUT /api/settings/events takes (and GET returns as its first two fields). */
export interface EventsRetention { retention_days: number; max_rows: number }
/** GET and PUT /api/settings/events (storage.view / storage.edit). `bounds` are [min, max]; `kept` and `oldest` as in the summary. */
export interface EventsSettings extends EventsRetention {
  factory: EventsRetention;
  bounds: { retention_days: [number, number]; max_rows: [number, number] };
  kept: number;
  oldest: string | null;
}

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

// ---- w21: the Billing month check (GET /api/billing/month-check) ----

/** Where the month is by the site clock: `not_begun` (nothing is read), `open` (read up to the last full hour) or `finished`. */
export type MonthCheckState = "not_begun" | "open" | "finished";
/** `counter` = the asset's own meter counts energy (kWh); `power` = it only reports power (kW), so its energy is worked out and marked estimated. */
export type MonthCheckMeterKind = "counter" | "power";
/** One group of findings: `total` is the true number, `items` holds at most `limits.cap` of them, worst first. */
export interface MonthCheckGroup<T> { total: number; items: T[] }
/**
 * What every finding says about its meter. `path` runs from the root down and ends with the asset's name. `point` and `source` are the names of the
 * point it reads and of its source, or null when the caller may not see sources (`sources.view`); the address is never sent.
 */
export interface MonthCheckHead {
  asset_id: number; path: string; kind: MonthCheckMeterKind; point: string | null; source: string | null; interval_seconds: number;
}
/**
 * No readings at the end, in the whole month, or ever. `never`: the point has never recorded anything (`hours` = every hour looked at, `since` and
 * `last_reading` null). `none_in_month`: it has older readings but none in the month (`last_reading` = the last one before it, or null).
 * `trailing`: it stopped (`since` = the first hour with nothing after the last reading, `hours` = how long, `last_reading` = its last reading looked at).
 * `children` = assets directly under it: while its own meter has no readings their energy is not counted in its figure.
 */
export interface SilentItem extends MonthCheckHead {
  reason: "never" | "none_in_month" | "trailing"; since: string | null; hours: number; last_reading: string | null; children: number;
}
/**
 * Whole hours with no reading (not counting the stretch at the end, that is `silent`). `runs` may be 0 for a power meter listed for the time missing
 * inside hours that do have readings (`short_hours` hours, `short_minutes` minutes in all; both 0 for a counter). `leading_hours` is the length of the
 * gap that starts the month and `previous_reading` the counter reading before the month that its first reading of the month is measured from (null
 * for a power meter, or when the counter has none). `hours_before_month` = hours without a reading between `previous_reading` and the month start: a
 * counter bills everything since that reading into its first reading of the month. `runs` may also be 0 for a counter listed only for that hole.
 */
export interface GapsItem extends MonthCheckHead {
  runs: number; hours: number; longest_hours: number | null; longest_start: string | null; first_start: string | null; last_end: string | null;
  leading_hours: number; hours_before_month: number; previous_reading: string | null; short_hours: number; short_minutes: number;
}
/**
 * A power meter: its energy is worked out from average power in `hours_estimated` of its `hours_total` hours. `negative_hours` = hours whose power
 * reading was below 0 (a meter fitted the wrong way round), `negative_kwh` = their energy in all (0 or below); both 0 when there are none.
 */
export interface EstimatedItem extends MonthCheckHead { hours_estimated: number; hours_total: number; negative_hours: number; negative_kwh: number }
/** The three kinds of counter trouble (`reset`: went back down; `dip`: dipped below an earlier reading and recovered; `fell`: went down inside an hour). */
export type ResetKind = "reset" | "dip" | "fell";
/**
 * A counter that went back or dipped. `resets`, `dips` and `falls` are the full counts; `events` are the first five by time, each with its `size`:
 * how far the reading went down, in the meter's own units (`previous - last` for a reset, `previous - min` for a dip, `max - last` for a fall).
 */
export interface ResetsItem extends MonthCheckHead {
  resets: number; dips: number; falls: number; events: { at: string; kind: ResetKind; size: number }[];
}
/** A meter whose first reading came after the month began (and before what was looked at ended); `children` = assets directly under it. */
export interface StartedItem extends MonthCheckHead { first_reading: string; children: number }
/** Energy in hours that no rate covers. `first_day` and `last_day` are site-local dates (`YYYY-MM-DD`). */
export interface UnpricedItem extends MonthCheckHead { kwh: number; hours: number; days: number; first_day: string; last_day: string }
/** Readings that did not change for a long time (`limits.flat_hours` or more): `runs` such stretches, the longest one `longest_hours` long. */
export interface FlatItem extends MonthCheckHead { runs: number; longest_hours: number; longest_start: string; first_start: string }
/** An asset nothing measures (information only). `beside_measured`: the asset above it is billed from other meters under it. */
export interface UnmeteredItem { asset_id: number; path: string; beside_measured: boolean }
/** A meter whose first reading came at or after the end of what was looked at (information only). */
export interface LaterItem { asset_id: number; path: string; kind: MonthCheckMeterKind; first_reading: string }
/** The thresholds the check used, so the answer can state them. `short_share` is a fraction (0.01 = one part in a hundred). */
export interface MonthCheckLimits { flat_hours: number; short_minutes: number; short_share: number; max_tolerated_hours: number; cap: number }
/**
 * The month check: a read-only list of what to look at before a month is trusted or closed. `from` is the start of the month and `to` the end of the
 * last full hour looked at (the end of the month once it is over). `meters` counts the meters with at least one hour looked at, `meter_hours` the
 * hours they were looked at in all, and `things` the findings of the seven counted groups (never `unmetered` or `later`). `closed`: the month has an
 * active close, whose billed figures are frozen; the check still describes the readings as they are stored today.
 */
export interface MonthCheck {
  month: string; timezone: string; state: MonthCheckState; closed: boolean;
  from: string; to: string; month_end: string;
  hours: number; meters: number; meter_hours: number; things: number;
  limits: MonthCheckLimits;
  groups: {
    silent: MonthCheckGroup<SilentItem>; gaps: MonthCheckGroup<GapsItem>; estimated: MonthCheckGroup<EstimatedItem>;
    resets: MonthCheckGroup<ResetsItem>; started: MonthCheckGroup<StartedItem>; unpriced: MonthCheckGroup<UnpricedItem>;
    flat: MonthCheckGroup<FlatItem>; unmetered: MonthCheckGroup<UnmeteredItem>; later: MonthCheckGroup<LaterItem>;
  };
}

export const WIDGET_TYPES = ["timeseries", "bar", "stat", "gauge", "table", "text"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
/** The five types that show data: everything that fetches takes this, so the compiler finds every data consumer. */
export type DataWidgetType = Exclude<WidgetType, "text">;
export type WidgetSource = "metric" | "energy" | "cost";
export type WidgetAggregation = "avg" | "min" | "max" | "last" | "sum";
export type WidgetBars = "asset" | "time" | "kind";
export type WidgetCompareMode = "none" | "same_days_last_month";
/**
 * `compare`, `kind`, `root` and `top` are written to a stored config only when they are not their default (`"none"`, no kind, no root, 10), so the
 * config of every widget made before w24 reads exactly as it did: an absent key means the default. `bars: "kind"` draws one bar for each asset of
 * the kind `kind` below the asset `root` (null: anywhere on the site), with `assets` empty; `top` is how many bars it draws (3 to 50).
 */
export interface WidgetConfig {
  assets: number[]; source: WidgetSource; metric: Metric | null; aggregation: WidgetAggregation;
  range: RangePreset | null; bars: WidgetBars; min: number; max: number | null;
  compare?: WidgetCompareMode; kind?: string; root?: number | null; top?: number;
  scope?: WidgetScope;
}
/**
 * w25. What a widget draws: its own `assets` ("fixed", the default; the key is left out of a stored config), the dashboard's focus asset ("focus"; `assets` is
 * empty, and a breakdown by kind looks under the focus) or the focus asset's direct children ("children": time series, bars per asset or time, table).
 */
export type WidgetScope = "fixed" | "focus" | "children";
/** What a text widget shows: a heading, a paragraph or a divider, plain text only (a divider holds no text). */
export const TEXT_STYLES = ["heading", "paragraph", "divider"] as const;
export type TextStyle = (typeof TEXT_STYLES)[number];
export interface TextConfig { style: TextStyle; text: string }
/** `Omit` that keeps a union apart (the plain one collapses a union to its common keys). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
interface WidgetBase { id: number; title: string; x: number; y: number; w: number; h: number }
export interface DataWidget extends WidgetBase { type: DataWidgetType; config: WidgetConfig }
export interface TextWidget extends WidgetBase { type: "text"; config: TextConfig }
/** A saved widget, discriminated by `type`: narrow on `type === "text"` before reading `config`. */
export type Widget = DataWidget | TextWidget;
export type WidgetIn = DistributiveOmit<Widget, "id">;
export interface Dashboard { id: number; name: string; range: RangePreset; updated_at: string; widgets: Widget[] }
export interface DashboardListItem { id: number; name: string; range: RangePreset; widget_count: number; updated_at: string }
/** The dashboard people land on; `null` when none is set. */
export interface DefaultDashboard { dashboard_id: number | null }
/** The ids of the server's dashboard templates, in the order it lists them (w27). */
export type TemplateId = "power" | "cost" | "areas" | "day";
/** `recipe` (w25, widened in w27): a template id makes the server fill the new dashboard with that template's widgets; Blank sends no key. */
export interface DashboardIn { name: string; range?: RangePreset; recipe?: TemplateId }
/**
 * One widget of a template, as `GET /api/dashboard-templates` lists it (w27): the place on the 12-column grid and just enough of the config to draw a glyph.
 * A text widget has `source` null, `compare` "none", `bars` "asset" and `scope` "fixed" (never null, so these types stay plain).
 */
export interface TemplateWidget {
  type: WidgetType; x: number; y: number; w: number; h: number;
  source: WidgetSource | null; compare: WidgetCompareMode; bars: WidgetBars; scope: WidgetScope;
}
/** A template: `recommended` is true of THIS site; `needs` says in a plain sentence what is missing when it is not (null when nothing is). `range` is the default range of the dashboard it makes. */
export interface DashboardTemplate {
  id: TemplateId; title: string; description: string; range: RangePreset; recommended: boolean; needs: string | null; widgets: TemplateWidget[];
}
/** The answer: `nothing_metered` is true when no asset has its own meter, so every template would show no data. Blank is the client's own card. */
export interface DashboardTemplates { nothing_metered: boolean; templates: DashboardTemplate[] }
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
/** One side (this month's days 1 to D, or last month's) of a comparison: the sums of Billing's day cells; `cost` is null when no day has a rate. */
export interface CompareSide { kwh: number; cost: number | null; estimated: boolean; partial: boolean; no_data_days: number }
export type CompareWhyNone = "currency" | "no_cost" | "no_previous" | "no_current" | "missing_days" | "partial" | "previous_zero";
/** The change of one measure: `abs` when both sides have a number, `percent` only when it is safe to show (otherwise `why_none` says why). */
export interface CompareChange { abs: number | null; percent: number | null; why_none: CompareWhyNone | null }
export interface CompareAsset {
  asset_id: number; name: string; this: CompareSide | null; last: CompareSide | null;
  last_state: "ok" | "no_readings" | "not_in_closed" | "other_zone";
  kwh: CompareChange; cost: CompareChange;
  rate_change: { date: string } | null;
  /** A time series only: last month's days 1 to D (empty for a stat). */
  last_points: WidgetPoint[];
}
/** Month to date against the same days of last month. Dates are the site's local dates (`YYYY-MM-DD`); D = min(elapsed days, the length of last month). */
export interface WidgetCompare {
  mode: "same_days_last_month"; state: "ok" | "nothing_yet"; elapsed_days: number; days: number;
  this_window: { from: string; to: string } | null; last_window: { from: string; to: string } | null;
  left_out_days: string[]; last_month: { month: string; closed: boolean }; currency: string | null;
  assets: CompareAsset[];
}
/** `bars: "kind"`: the bars drawn are the first `shown` of `count`; `more` sums the rest (never an "Other" bar). */
export interface WidgetBreakdown {
  kind: string; root: { id: number; name: string } | null;
  count: number; shown: number;
  more: { count: number; with_value: number; value: number | null; estimated: boolean; partial: boolean };
  no_data: number; inside_others: number;
  kinds: { kind: string; count: number }[];
}
export interface WidgetData {
  type: DataWidgetType; mode: "series" | "values"; source: WidgetSource; metric: Metric | null; unit: string | null;
  range: { preset: RangePreset; start: string; end: string }; tier: SeriesTier | null; bucket: "hour" | "day" | null;
  series: WidgetSeries[]; values: WidgetValue[]; missing: number[]; no_metric: number[];
  /** Always sent by the server (null when unused); optional here so a test fixture that predates w24 still compiles. */
  compare?: WidgetCompare | null; breakdown?: WidgetBreakdown | null;
  /** w25: null for a widget that does not follow the focus. */
  focus?: WidgetFocus | null;
}

/**
 * w25. What a widget that follows the focus was asked about. `asset` is the focus asset (null: none, or gone); `state` "gone" is an id that is not in
 * the tree (no figures), "choose" a site with other than one top-level asset and no focus (a widget that shows one asset draws nothing); `children` is
 * how many of the focus asset's children a "children" widget shows of how many it has; `top_level` is the number of top-level assets (only when no focus was sent).
 */
export interface WidgetFocus {
  asset: { id: number; name: string; path: string } | null;
  state: "ok" | "gone" | "choose";
  children: { shown: number; count: number } | null;
  top_level: number | null;
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

/** w28 display screens. GET /api/displays (needs displays.manage): the screens, the playlists and the limits. Never carries a link secret or its hash. */
export type DisplayStatus = "active" | "revoked";
/** Why a playlist item is skipped by a screen: its dashboard was deleted, its focus asset is gone, or its dashboard has no widgets. */
export type PlaylistSkip = "dashboard_deleted" | "focus_gone" | "no_widgets";
export interface DisplayRow {
  id: number; name: string; playlist_id: number; playlist_name: string; status: DisplayStatus;
  created_at: string; last_seen_at: string | null; last_client: string | null; revoked_at: string | null;
}
/** `dashboard_name` and `focus_name` are the live name, or the stored one when the thing is gone; null when the caller lacks the permission to read it (dashboards.view, assets.view). */
export interface PlaylistItemRow {
  id: number; position: number; seconds: number;
  dashboard_id: number | null; dashboard_name: string | null; focus_asset_id: number | null; focus_name: string | null; skipped: PlaylistSkip | null;
}
export interface PlaylistRow { id: number; name: string; item_count: number; skipped_count: number; display_count: number; items: PlaylistItemRow[] }
export interface DisplayLimits { displays: number; playlists: number; items: number; min_seconds: number; max_seconds: number }
export interface DisplaysList { displays: DisplayRow[]; playlists: PlaylistRow[]; limits: DisplayLimits }
/** An item sent back with its own `id` and the stored `dashboard_id` / `focus_asset_id` is kept as stored (a null dashboard included); an item without `id` is new. */
export interface PlaylistItemIn { id?: number; dashboard_id: number | null; focus_asset_id?: number | null; seconds: number }
export interface PlaylistIn { name: string; items: PlaylistItemIn[] }
export interface DisplayIn { name: string; playlist_id: number }
export interface DisplayPatch { name?: string; playlist_id?: number }
/** The answer to creating a display: `link_secret` is in this one answer and nowhere else. Keep it out of every cache. */
export interface DisplayCreated { display: DisplayRow; link_secret: string }

// ---- w31: import readings from a file, map a tag list, fill an older range ----

/** What a value column means: a running total (`counter`), an instantaneous power, or a total for one period (`interval`, which needs `period_seconds` and `stamp`). */
export type ImportReading = "counter" | "power" | "interval";
/**
 * One saved layout of a CSV export (GET /api/import-profiles answers `{ profiles: ImportProfile[] }`; PUT /api/import-profiles/{name} takes and answers one,
 * and the name in the path wins). `tag`, `time`, `value`, `unit` and `quality` are column NAMES of the file's header line. `delimiter` null = found from
 * the header line. `zone` (an IANA name) is needed only for times written without an offset. The server keeps at most 20 profiles (the 21st is a 409).
 */
export interface ImportProfile {
  name: string; tag: string; time: string; value: string; unit: string | null; quality: string | null;
  delimiter: string | null; decimal: "." | ","; time_format: string; zone: string | null;
  reading: ImportReading; period_seconds: number | null; stamp: "start" | "end" | null; good_codes: string[];
}
/** A line of the file the importer did not take, with the plain reason code (`rejectedText` in lib/importReport.ts words it). */
export interface ImportProblem { line: number; reason: string }
/** A reading the file sent again with another value than the one stored (the stored one is kept). `tag` is clipped by the server; React shows it as text. */
export interface ImportDifference { tag: string; ts: string; stored: number | null; file: number | null }
/** An energy counter value that went down, or jumped by a lot, against the one before it in the file (`tag` is clipped by the server; React shows it as text). A check says it will be stored all the same, an import that it was. */
export interface ImportCounterWarning { tag: string; ts: string; previous: number; value: number }
export type ImportRefreshState = "not_needed" | "done" | "failed";
/**
 * The answer to POST /api/sources/{id}/import (the dry run and the real run have this one shape). `rows_read` = new + already + differing + rejected +
 * unknown_rows. `rejected_by` counts the rejected rows by reason code; `closed_months` counts the accepted rows that fall in a closed billing month, by
 * `YYYY-MM`. `problems` holds at most the first 20 lines, `differing_samples` at most 5, `unknown_tags.names` at most 20 (`count` is the true number).
 * `refresh` is the rollup refresh after a real run. `complete` is false when the run stopped half-way: `error` then says why, and the counts are what was
 * written so far. `text` is the server's one-sentence summary.
 */
export interface ImportReport {
  dry_run: boolean; source_id: number; profile: string; sha256: string; size: number;
  rows_read: number; new: number; already: number; differing: number; rejected: number; unknown_rows: number;
  unknown_tags: { count: number; names: string[] };
  rejected_by: Record<string, number>;
  /** Accepted rows that were stored as BAD quality (they are part of `new`, and count in no figure), by the label of their quality code. */
  bad_quality?: Record<string, number>;
  closed_months: Record<string, number>;
  /** The first 20 counter values that go down or jump, and how many there are in all. Optional here so older fixtures compile; the server always sends both. */
  counter_warnings?: ImportCounterWarning[]; counter_warnings_total?: number; raw_floor?: string | null;
  differing_samples: ImportDifference[];
  problems: ImportProblem[]; problems_total: number;
  refresh: { state: ImportRefreshState; days: number; note: string | null };
  complete: boolean; error: string | null; text: string;
}

/** One unit of a tag list and the scale the run will give it (the factor to the metric's base unit). */
export interface TagListUnit { unit: string | null; metric: Metric; scale: number; count: number }
/** A line of a tag list that stops the run (any problem line stops it: nothing is written). */
export interface TagListProblem { line: number; tag: string; reason: string }
/**
 * The answer to POST /api/sources/{id}/tag-list (the dry run and the real run have this one shape). `assets_to_create` holds the first 50 paths
 * (`assets_to_create_total` is the true number), `problems` the first 50 (`problems_total`). `plan_digest` is sent back as `expect_plan` with
 * `expect_points`, `expect_assets` and `expect_mappings` on the real run. `audit_id` and `undo_until` are set by a real run only.
 */
export interface TagListReport {
  dry_run: boolean; source_id: number; sha256: string; plan_digest: string; lines: number;
  points_to_create: number; assets_to_create: string[]; assets_to_create_total: number; mappings_to_create: number;
  units: TagListUnit[]; problems: TagListProblem[]; problems_total: number; ok: boolean; text: string;
  audit_id: number | null; undo_until: string | null;
}
/** The body of the 409 a real tag-list run answers when what it would do differs from the dry run: `detail` is the sentence, the numbers are what it would do now. */
export interface TagListChanged { detail: string; points: number; assets: number; mappings: number }
/** The answer to POST /api/tag-lists/{audit_id}/undo: what was removed (`points_kept`: created points that hold readings and stay, unmapped). */
export interface TagListUndoResult { mappings: number; assets: number; points_removed: number; points_kept: number; text?: string }

/** The body of POST /api/sources/{id}/history/fill: aware ISO times; at most 31 days. */
export interface HistoryFillIn { start: string; end: string; before_first_reading: boolean }
/** The answer to POST /api/sources/{id}/history/fill?dry_run=1: nothing is asked of the source. `windows` are the slices a fill would ask, as [start, end] pairs, oldest first. */
export interface HistoryFillPlan { plan: string; windows: [string, string][]; expected_rows: number }
/** `result` of a finished `history_fill` job (GET /api/jobs/{id}): the counts and a sentence, or the sentence that stopped it. Narrow with `"error" in result`. */
export interface HistoryFillDone { ok: true; text: string; read: number; new: number; already: number; differing: number; rejected: number }
export interface HistoryFillFailed { ok?: false; error: string }
export type HistoryFillJobResult = HistoryFillDone | HistoryFillFailed;
