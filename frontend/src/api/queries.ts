import { hashKey, keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiQuery, type AuditFilters } from "../lib/auditFilters";
import { rangeToQuery, trendRefetchMs, type Range } from "../lib/timeRange";
import { upperFirst } from "../lib/upperFirst";
import { ApiError, api } from "./client";
import type {
  Asset, AssetImpact, AssetKind, AssetKindIn, AssetKindPatch, StarterPackResult, AuditEntry, AuditList, AuditOptions, AuditPosition, BillingCosts, BillingMonths, BillingReopened, BillingSettings, Connector, MonthCheck, Dashboard, DashboardIn, DashboardListItem, DashboardSave, DefaultDashboard,
  FleetSummary, GeneralSettings, GraphModel, Metric, MoveBody, MovePreview, MoveResult, PermissionRow, PointRow, RangePreset, RemoveSourcesResult, RoleRow, ScanDetail, ScanSummary, Scope, ScopeSuggestions,
  RowsPerDayRange, Series, SignInPolicy, SignInValues, Site, Source, SourceImpact, StorageSettings, StorageSettingsOut, StorageStats, Summary, Tariff, TariffIn, TariffPatch, UserRow, WidgetConfig,
  WidgetData, DataWidgetType, CollectorStatus, LiveStatus, ReportParams, ReportReply, SecretKeyStatus, TlsStatus, VersionInfo,
} from "./types";

export const keys = {
  assets: ["assets"] as const,
  /** Under the `assets` prefix on purpose: every `invalidate(keys.assets)` (an asset saved or deleted, discovery) then also refreshes the kinds and their asset counts. */
  assetKinds: ["assets", "kinds"] as const,
  summary: (id: number) => ["assets", id, "summary"] as const,
  series: (id: number, metric: Metric, range: Range, mappingId?: number) =>
    ["assets", id, "series", metric, range, mappingId ?? null] as const,
  sources: ["sources"] as const,
  connectors: ["connectors"] as const,
  points: (sourceId: number) => ["sources", sourceId, "points"] as const,
  users: ["users"] as const,
  roles: ["roles"] as const,
  permissions: ["permissions"] as const,
  general: ["settings", "general"] as const,
  signInPolicy: ["settings", "sign-in"] as const,
  storage: ["storage"] as const,
  storageSettings: ["settings", "storage"] as const,
  scopes: ["scopes"] as const,
  suggestions: ["scope-suggestions"] as const,
  scans: ["scans"] as const,
  scan: (id: number) => ["scans", id] as const,
  graph: ["graph"] as const,
  audit: (filters: AuditFilters, limit: number, offset: number) => ["audit", filters, limit, offset] as const,
  auditOptions: ["audit", "options"] as const,
  /** Prefix of every audit query (list, options, entry): invalidate this after a change that writes an audit row. */
  auditAll: ["audit"] as const,
  auditEntry: (id: number | null) => ["audit", "entry", id] as const,
  site: ["site"] as const,
  billingSettings: ["settings", "billing"] as const,
  tariffs: ["tariffs"] as const,
  fleet: ["fleet-summary"] as const,
  billing: ["billing"] as const,
  billingCosts: (month: string | null) => ["billing", "costs", month] as const,
  /** Prefix of every billing costs query (one per month): what a close or reopen reads again, and waits for. */
  billingCostsAll: ["billing", "costs"] as const,
  billingMonths: ["billing", "months"] as const,
  billingMonthCheck: (month: string | null) => ["billing", "month-check", month] as const,
  /** Prefix of every month check query: a close or reopen refreshes these in the background, without waiting for them. */
  billingMonthCheckAll: ["billing", "month-check"] as const,
  dashboardList: ["dashboards", "list"] as const,
  defaultDashboard: ["dashboards", "default"] as const,
  dashboard: (id: number) => ["dashboards", "detail", id] as const,
  widgetData: ["widget-data"] as const,
  collectorStatus: ["collector-status"] as const,
  status: ["status"] as const,
  secretKey: ["secret-key"] as const,
  tlsStatus: ["tls-status"] as const,
  version: ["version"] as const,
};

/** Everything whose figures move when a rate, the currency or the timezone changes. `assets` covers the asset summaries (cost_today), `fleet` the Assets Tree landing page's figures. */
const COST_DEPENDENT = [keys.billing, keys.widgetData, keys.assets, keys.fleet] as const;

/** `enabled` is false for a role that may not see assets (the quick find in the top bar asks for the list on every page). */
export const useAssets = (enabled = true) => useQuery({ queryKey: keys.assets, queryFn: () => api.get<Asset[]>("/api/assets"), enabled });

/**
 * The asset kinds registry, sorted by key by the server, with the number of assets each kind has. `enabled` is false for a role that may
 * not see assets (callers pass `can("assets.view")`). A failed request is not fatal to its callers: they fall back to the keyword guess.
 */
export const useAssetKinds = (enabled = true) =>
  useQuery({ queryKey: keys.assetKinds, queryFn: () => api.get<AssetKind[]>("/api/asset-kinds"), enabled });

/**
 * What a kind change moves: every asset response (`kind_icon`, and the kind text a rename rewrites; `keys.assets` also covers the kinds list and
 * every asset summary), the fleet summary and the audit log with its filters. `onSettled`, not `onSuccess`: a refused change (a 409 "assets use
 * this kind", a taken name, a 404) means the list on screen is out of date.
 */
function useKindMutation<Variables, Result>(mutationFn: (variables: Variables) => Promise<Result>) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn, onSettled: () => invalidate(keys.assets, keys.fleet, keys.auditAll) });
}

export const useCreateAssetKind = () => useKindMutation((body: AssetKindIn) => api.post<AssetKind>("/api/asset-kinds", body));

export const usePatchAssetKind = () =>
  useKindMutation(({ id, body }: { id: number; body: AssetKindPatch }) => api.patch<AssetKind>(`/api/asset-kinds/${id}`, body));

/**
 * `moveTo`: a kind in use is deleted by moving its assets to this kind (its id). `expectAssets`: how many assets the person was shown; the server
 * refuses with a 409 carrying the real count when it is not that many, and moves nothing. Neither is sent when not given: a plain delete has no query.
 */
export const useDeleteAssetKind = () =>
  useKindMutation(({ id, moveTo, expectAssets }: { id: number; moveTo?: number; expectAssets?: number }) => {
    const query = new URLSearchParams();
    if (moveTo !== undefined) query.set("move_to", String(moveTo));
    if (expectAssets !== undefined) query.set("expect_assets", String(expectAssets));
    const sent = query.toString();
    return api.del(`/api/asset-kinds/${id}${sent ? `?${sent}` : ""}`);
  });

/**
 * Adds the starter kinds the registry lacks (idempotent on the server); `mutateAsync()` takes no argument. `set` picks the pack: "common" is the
 * server's default and sends no query, "all" sends `?set=all` for the whole catalogue.
 */
export const useAddStarterKinds = (set: "common" | "all" = "common") =>
  useKindMutation((_: void) => api.post<StarterPackResult>(`/api/asset-kinds/starter-pack${set === "all" ? "?set=all" : ""}`));

/** One kind to delete: `assetCount` is the number the person was shown (it is sent back as `expect_assets` when the kind is in use). */
export interface BulkDeleteItem { id: number; name: string; assetCount: number }
export interface BulkDeleteVariables {
  items: readonly BulkDeleteItem[];
  /** Where the assets of the kinds in use go (name: for the sentences). Never one of `items`. */
  moveTo: { id: number; name: string } | null;
}
export interface BulkDeleteFailure { id: number; name: string; reason: string }
export interface BulkDeleteResult {
  /** The ids this call deleted. */
  deleted: number[];
  /** The ids the server said were gone already (a 404: another tab deleted them). They are not failures; the list loses them all the same. */
  gone: number[];
  /** Refused one by one (a 409 because the count moved, a 422, a 500...), in list order, with the reason as a sentence. */
  failed: BulkDeleteFailure[];
  /** Not deleted because the loop stopped: the kind whose request met the problem, and every kind after it. Empty unless `stoppedBy` is set. */
  notTried: number[];
  /** Why the loop stopped (no connection, the session ended, the role lost the permission, the server is not answering). */
  stoppedBy?: string;
  /** The assets that went to `to` with the kinds this call deleted; null when none moved. */
  moved: { assets: number; to: string } | null;
}

/** A problem with the connection, the session or the role: every kind after it would meet the same one (and each 401 or 403 makes the app re-check the account). */
const stopsTheLoop = (e: ApiError) => e.status === 0 || e.status === 401 || e.status === 403 || e.status === 502 || e.status === 503 || e.status === 504;
const stopReason = (e: ApiError) => (e.status === 401 ? "Your session has ended. Sign in again." : upperFirst(e.message));
const assetsUse = (n: number) => (n === 0 ? "It has no assets now. Try again." : n === 1 ? "1 asset uses it now." : `${n} assets use it now.`);
const TARGET_GONE = "That kind no longer exists.";

/** Why one kind was not deleted, as a sentence a toast can put after its name. */
function failureReason(e: unknown, moveToName: string | undefined): string {
  if (!(e instanceof ApiError)) return upperFirst(e instanceof Error ? e.message : String(e));
  if (e.status === 409) {
    const assets = (e.body as { assets?: unknown } | null | undefined)?.assets;
    if (typeof assets === "number" && Number.isInteger(assets) && assets >= 0) return assetsUse(assets);
  }
  if (e.status === 422 && e.detail === TARGET_GONE && moveToName !== undefined) return `The kind chosen for their assets ("${moveToName}") no longer exists.`;
  return upperFirst(e.message);
}

/**
 * Deletes the kinds one at a time, in the order given, each with the route a single delete uses (a kind in use goes with `move_to` and the count
 * it was shown; an unused one with no query). A refusal is collected and the loop goes on; only a problem every later request would share stops
 * it. One at a time on purpose: each deletion is its own transaction with its own audit row and its own stale-count check on the server.
 */
async function deleteKindsOneByOne({ items, moveTo }: BulkDeleteVariables): Promise<BulkDeleteResult> {
  const result: BulkDeleteResult = { deleted: [], gone: [], failed: [], notTried: [], moved: null };
  let movedAssets = 0;
  for (let at = 0; at < items.length; at += 1) {
    const { id, name, assetCount } = items[at];
    const target = assetCount > 0 ? moveTo : null;
    try {
      await api.del(`/api/asset-kinds/${id}${target ? `?move_to=${target.id}&expect_assets=${assetCount}` : ""}`);
      result.deleted.push(id);
      if (target) movedAssets += assetCount;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        result.gone.push(id);
      } else if (e instanceof ApiError && stopsTheLoop(e)) {
        result.stoppedBy = stopReason(e);
        result.notTried = items.slice(at).map((item) => item.id);
        break;
      } else {
        result.failed.push({ id, name, reason: failureReason(e, moveTo?.name) });
      }
    }
  }
  if (moveTo && movedAssets > 0) result.moved = { assets: movedAssets, to: moveTo.name };
  return result;
}

/**
 * Deletes several kinds, one request each (see `deleteKindsOneByOne`). It resolves with what happened to each, and rejects only for a failure
 * of its own. The three lists a kind change makes stale are refetched ONCE at the end (`useKindMutation`'s `onSettled`, awaited before
 * `mutateAsync` resolves), not after each request: twelve deletions would otherwise read the kinds, the fleet and the audit log twelve times.
 */
export const useBulkDeleteAssetKinds = () => useKindMutation(deleteKindsOneByOne);

/**
 * The Assets Tree landing page: live power, today's energy and cost over the whole site, and the readings that need attention.
 * `enabled` is false until the asset list says there is something to count (a site with no assets asks for no figures).
 */
export const useFleetSummary = (enabled = true) =>
  useQuery({ queryKey: keys.fleet, queryFn: () => api.get<FleetSummary>("/api/fleet/summary"), refetchInterval: 15_000, enabled });

export const useSummary = (id: number) =>
  useQuery({ queryKey: keys.summary(id), queryFn: () => api.get<Summary>(`/api/assets/${id}/summary`), refetchInterval: 60_000 });

/** `paused` stops the polling (the Trend chart pauses while a mouse rests on it: a refetch would close an open tooltip). */
export const useSeries = (id: number, metric: Metric | null, range: Range, mappingId?: number, paused = false) =>
  useQuery({
    queryKey: keys.series(id, metric ?? "custom", range, mappingId),
    enabled: metric !== null,
    refetchInterval: paused ? false : trendRefetchMs(range),
    queryFn: () => {
      const q = rangeToQuery(range);
      const params = new URLSearchParams({ metric: metric!, start: q.start, end: q.end, buckets: String(q.buckets) });
      if (mappingId !== undefined) params.set("mapping_id", String(mappingId));
      return api.get<Series>(`/api/assets/${id}/series?${params}`);
    },
  });

export const useSources = () =>
  useQuery({ queryKey: keys.sources, queryFn: () => api.get<Source[]>("/api/sources"), refetchInterval: 10_000 });

/** What deleting this asset would take with it (read-only; the delete dialog asks at every open, so these are not cached hooks). */
export const loadAssetImpact = (id: number) => api.get<AssetImpact>(`/api/assets/${id}/impact`);
/** What deleting this source would take with it (read-only; see `loadAssetImpact`). */
export const loadSourceImpact = (id: number) => api.get<SourceImpact>(`/api/sources/${id}/impact`);

/**
 * What a move would do, and the `expect` to send back with it (read-only: a POST because the plan is the body; nothing is written, audited
 * or locked). Asked for at the moment of the drop or of "Move", so it is a plain function and not a cached hook. A 422 carries `refusals`.
 */
export const loadMovePreview = (body: MoveBody) => api.post<MovePreview>("/api/assets/move-preview", body);

/**
 * Moves assets (and reorders them), or undoes a move (the body then carries `undo_of`). Everything that follows the tree moves with it:
 * the asset list (and the kinds and summaries under that prefix), the fleet figures, billing, widget data (their numbers add up per
 * branch), the tariff table (its `asset_path`), the audit log and the discovery graph. `onSettled`, not `onSuccess`: a refused move
 * (a 422, or a 409 `stale`) means the tree on screen is out of date. The error keeps `status` and the parsed `body` (`moveRefusals`,
 * `isStaleMove` in lib/moveText.ts read them). Resolves after the lists are fetched again, so the moved rows are on screen by then.
 */
export function useMoveAssets() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: MoveBody) => api.post<MoveResult>("/api/assets/move", body),
    onSettled: () => invalidate(keys.assets, keys.fleet, keys.billing, keys.widgetData, keys.tariffs, keys.auditAll, keys.graph),
  });
}

export const useCollectorStatus = () =>
  useQuery({ queryKey: keys.collectorStatus, queryFn: () => api.get<CollectorStatus>("/api/collector/status"), refetchInterval: 10_000 });

/** The top bar's live chip; any signed-in user. */
export const useStatus = () =>
  useQuery({ queryKey: keys.status, queryFn: () => api.get<LiveStatus>("/api/status"), refetchInterval: 10_000 });

/** Needs sources.view (the Sources page). A fetch error shows nothing: the warning is an extra, not a gate. */
export const useSecretKeyStatus = () =>
  useQuery({ queryKey: keys.secretKey, queryFn: () => api.get<SecretKeyStatus>("/api/secret-key/status"), refetchInterval: 60_000 });

/** Needs settings.view (the app shell's notice and the Settings page). The collector checks the certificate hourly, so ten minutes is plenty. */
export const useTlsStatus = () =>
  useQuery({ queryKey: keys.tlsStatus, queryFn: () => api.get<TlsStatus>("/api/tls/status"), refetchInterval: 600_000 });

/** The build the api runs. It changes only when the image is rebuilt, which reloads the page, so it is read once. */
export const useVersion = () =>
  useQuery({ queryKey: keys.version, queryFn: () => api.get<VersionInfo>("/api/version"), staleTime: Infinity });

export const useConnectors = (enabled: boolean) =>
  useQuery({ queryKey: keys.connectors, queryFn: () => api.get<Connector[]>("/api/connectors"), enabled, staleTime: Infinity });

export const usePoints = (sourceId: number) =>
  useQuery({ queryKey: keys.points(sourceId), queryFn: () => api.get<PointRow[]>(`/api/sources/${sourceId}/points`) });

export function useInvalidate() {
  const client = useQueryClient();
  return (...queryKeys: readonly (readonly unknown[])[]) =>
    Promise.all(queryKeys.map((queryKey) => client.invalidateQueries({ queryKey })));
}

export const useUsers = () => useQuery({ queryKey: keys.users, queryFn: () => api.get<UserRow[]>("/api/users") });

/** The roles and which of them the caller may hand out (`assignable`). Open to users.view and users.edit; the Users tab reads it for its selects and the Roles tab for its list (which also gets each role's permissions, for roles.manage only). */
export const useRoles = (enabled = true) => useQuery({ queryKey: keys.roles, queryFn: () => api.get<RoleRow[]>("/api/roles"), enabled });

/** The permission catalogue as the server words it (area, kind, label, description). roles.manage only; it changes with the build, which reloads the page. */
export const usePermissions = () =>
  useQuery({ queryKey: keys.permissions, queryFn: () => api.get<PermissionRow[]>("/api/permissions"), staleTime: Infinity });

/**
 * What a role change moves: the roles (the list), the users (their role selects and the role's name or description in a row) and the audit log
 * and its filter options. `onSettled`, not `onSuccess`: a refused change (a 409 "in use", a 404 "Role not found.") means the list on screen is out of date.
 */
function useRoleMutation<Variables, Result>(mutationFn: (variables: Variables) => Promise<Result>) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn, onSettled: () => invalidate(keys.roles, keys.users, keys.auditAll) });
}

export const useCreateRole = () =>
  useRoleMutation((body: { name: string; description: string; permissions: string[] }) => api.post<RoleRow>("/api/roles", body));

export const usePatchRole = () =>
  useRoleMutation(({ id, body }: { id: number; body: Partial<{ name: string; description: string; permissions: string[] }> }) =>
    api.patch<RoleRow>(`/api/roles/${id}`, body));

export const useDeleteRole = () => useRoleMutation((id: number) => api.del(`/api/roles/${id}`));

/** `name` left out = the server's "Copy of <name>" (it finds a free one). */
export const useDuplicateRole = () =>
  useRoleMutation(({ id, name }: { id: number; name?: string }) => api.post<RoleRow>(`/api/roles/${id}/duplicate`, name === undefined ? {} : { name }));

export function useCreateUser() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { username: string; password: string; role: string }) => api.post<UserRow>("/api/users", body),
    onSuccess: () => invalidate(keys.users, keys.roles, keys.auditAll), // keys.roles: each role's Users count and whether it may be deleted
  });
}

export function usePatchUser() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: { role?: string; active?: boolean; password?: string } }) =>
      api.patch<UserRow>(`/api/users/${id}`, body),
    onSuccess: () => invalidate(keys.users, keys.roles, keys.auditAll), // keys.roles: each role's Users count and whether it may be deleted
  });
}

export function useDeleteUser() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/users/${id}`),
    // The audit options are cached for a minute and the delete adds "(deleted)" to the User filter.
    onSuccess: () => invalidate(keys.users, keys.roles, keys.auditAll), // keys.roles: each role's Users count and whether it may be deleted
  });
}

/** Clears every sign-in block on the account (any address); the Users list then shows it unblocked. */
export function useUnblockUser() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => api.post<{ cleared: number }>(`/api/users/${id}/unblock`, {}),
    onSuccess: () => invalidate(keys.users, keys.auditAll),
  });
}

export const useChangePassword = () =>
  useMutation({
    mutationFn: (body: { current_password: string; new_password: string }) => api.post<void>("/api/me/password", body),
  });

export const useGeneralSettings = () =>
  useQuery({ queryKey: keys.general, queryFn: () => api.get<GeneralSettings>("/api/settings/general") });

export function usePutGeneralSettings() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: GeneralSettings) => api.put<GeneralSettings>("/api/settings/general", body),
    onSuccess: () => invalidate(keys.general, keys.site, ...COST_DEPENDENT),
  });
}

export const useSignInPolicy = () =>
  useQuery({ queryKey: keys.signInPolicy, queryFn: () => api.get<SignInPolicy>("/api/settings/sign-in") });

export function usePutSignInPolicy() {
  const invalidate = useInvalidate();
  return useMutation({
    // `enabled` omitted = the server's safe default (ON); `confirm` travels in the query string only (the body forbids extras)
    mutationFn: ({ confirm, ...body }: SignInValues & { enabled?: boolean; confirm?: boolean }) =>
      api.put<SignInPolicy>(`/api/settings/sign-in${confirm ? "?confirm=true" : ""}`, body),
    onSuccess: () => invalidate(keys.signInPolicy, keys.auditAll),
    // A 409 that asks for confirmation means the page's switch no longer matches the server (another admin changed it, or the page is old):
    // read the policy again, so the switch shows the real state. The page still shows the server's text.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409 && (error.body as { needs_confirmation?: unknown } | null)?.needs_confirmation === true) {
        void invalidate(keys.signInPolicy);
      }
    },
  });
}

export const useStorage = () => useQuery({ queryKey: keys.storage, queryFn: () => api.get<StorageStats>("/api/storage") });

/** Rows per UTC day for a range; nothing is requested until both days are given. */
export const useRowsPerDay = (start: string | null, end: string | null) =>
  useQuery({
    queryKey: [...keys.storage, "rows-per-day", start, end] as const,
    queryFn: () => api.get<RowsPerDayRange>(`/api/storage/rows-per-day?start=${start}&end=${end}`),
    enabled: start !== null && end !== null,
    staleTime: 30_000,
  });

export const useStorageSettings = () =>
  useQuery({ queryKey: keys.storageSettings, queryFn: () => api.get<StorageSettingsOut>("/api/settings/storage") });

export function useSaveStorageSettings() {
  const invalidate = useInvalidate();
  return useMutation({
    // `confirm` goes in the query string: the server asks for it when the save would delete readings (HTTP 409).
    mutationFn: ({ values, confirm }: { values: StorageSettings; confirm: boolean }) =>
      api.put<StorageSettings>(`/api/settings/storage${confirm ? "?confirm=true" : ""}`, values),
    onSuccess: () => invalidate(keys.storageSettings, keys.storage),
  });
}

/** "Set as default": remembers the values as this site's default. Applies nothing. */
export function useSetStorageDefault() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (values: StorageSettings) => api.put<StorageSettings>("/api/settings/storage/default", values),
    onSuccess: () => invalidate(keys.storageSettings),
  });
}

export const useScopes = () => useQuery({ queryKey: keys.scopes, queryFn: () => api.get<Scope[]>("/api/scopes") });

/** Needs discovery.edit on the server: callers enable it only for someone who holds it, and only while a scope form (new or edit) is open. */
export const useScopeSuggestions = (enabled: boolean) =>
  useQuery({
    queryKey: keys.suggestions,
    queryFn: () => api.get<ScopeSuggestions>("/api/scopes/suggestions"),
    enabled,
  });

const ACTIVE_SCANS = new Set(["queued", "running"]);

/** Scan history, newest first. Polls while any listed scan is still queued or running so a finished scan shows up. */
export const useScans = () =>
  useQuery({
    queryKey: keys.scans,
    queryFn: () => api.get<ScanSummary[]>("/api/scans"),
    refetchInterval: (query) => (query.state.data?.some((scan) => ACTIVE_SCANS.has(scan.status)) ? 2000 : false),
  });

/** Scan progress: polls `GET /api/scans/{id}` every second until the scan is done or failed. */
export const useScan = (scanId: number | null) =>
  useQuery({
    queryKey: scanId === null ? ["scans", "none"] : keys.scan(scanId),
    enabled: scanId !== null,
    queryFn: () => api.get<ScanDetail>(`/api/scans/${scanId}`),
    refetchInterval: (query) => (["done", "failed"].includes(query.state.data?.status ?? "") ? false : 1000),
  });

/** The discovery graph. No polling: refresh it by invalidating `keys.graph`. */
export const useGraph = () => useQuery({ queryKey: keys.graph, queryFn: () => api.get<GraphModel>("/api/discovery/graph") });

/** The most ids one `POST /api/discovery/sources/remove` takes (`RemoveIn` in api/discovery.py): a longer list goes in several calls. */
const REMOVE_BATCH = 500;

/**
 * Removes discovered sources that have nothing mapped (`discovery.edit`). The ids are the ones the person was shown, and the
 * answer says which went and which were kept (a mapping appeared meanwhile, the source was added by hand, or it was already gone); a running
 * scan is a 409 with nothing removed. The graph, the sources list and the audit log are refetched once, in `onSettled` (a refusal also means
 * the page is out of date), and the call resolves after that, so the removed nodes are gone when the caller closes its dialog.
 * More than 500 ids are sent in calls of 500, one after the other, and the answers are joined; a refusal part-way rejects (what the
 * earlier calls removed stays removed, and the refetch shows it).
 */
export function useRemoveDiscoveredSources() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (ids: readonly number[]) => {
      const joined: RemoveSourcesResult = { removed: [], skipped: [] };
      for (let from = 0; from === 0 || from < ids.length; from += REMOVE_BATCH) {
        const part = await api.post<RemoveSourcesResult>("/api/discovery/sources/remove", { source_ids: ids.slice(from, from + REMOVE_BATCH) });
        joined.removed.push(...part.removed);
        joined.skipped.push(...part.skipped);
      }
      return joined;
    },
    onSettled: () => invalidate(keys.graph, keys.sources, keys.auditAll),
  });
}

/**
 * Tidy layout (`discovery.edit`): removes every saved node position of the Discovery graph, for everyone (`DELETE /api/discovery/layout`, 204, idempotent).
 * `onDeleted` runs as soon as the route has answered, BEFORE the graph is read again (`onSuccess` runs ahead of `onSettled`): the page clears its own
 * session places there, so the old layout never shows between the answer and the read. The graph is refetched in `onSettled` (a refusal also
 * means the page may be out of date), and the call resolves after that read.
 */
export function useTidyLayout({ onDeleted }: { onDeleted?: () => void } = {}) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => api.del("/api/discovery/layout"),
    onSuccess: () => onDeleted?.(),
    onSettled: () => invalidate(keys.graph),
  });
}

/**
 * One page of the filtered audit log, as a query. `useAudit` and the drawer's Previous/Next (`queryClient.fetchQuery`, to look into the
 * neighbouring page before moving to it) both take this, so they share a key: the page fetched for a step is already in the cache when the list shows it.
 */
export const auditPageOptions = (filters: AuditFilters, limit: number, offset: number) =>
  queryOptions({
    queryKey: keys.audit(filters, limit, offset),
    queryFn: () => api.get<AuditList>(`/api/audit?${apiQuery(filters, { limit, offset })}`),
  });

/** One page of the filtered audit log. The previous page stays on screen while the next loads (`isPlaceholderData` says so). */
export const useAudit = (filters: AuditFilters, limit: number, offset: number) =>
  useQuery({ ...auditPageOptions(filters, limit, offset), placeholderData: keepPreviousData });

/** The actions and users the audit filters offer. */
export const useAuditOptions = () =>
  useQuery({ queryKey: keys.auditOptions, queryFn: () => api.get<AuditOptions>("/api/audit/options"), staleTime: 60_000 });

const isEntryId = (id: number | null): id is number => id !== null && Number.isInteger(id) && id >= 1 && id <= 2_147_483_647;

/** One entry by id; no request for an id the API cannot hold. */
export const useAuditEntry = (id: number | null) =>
  useQuery({
    queryKey: keys.auditEntry(id),
    enabled: isEntryId(id),
    queryFn: () => api.get<AuditEntry>(`/api/audit/${id}`),
  });

/** Where the first entry on or before `date` (a site day) sits in the filtered log. */
export function auditPosition(filters: AuditFilters, date: string): Promise<AuditPosition> {
  return api.get<AuditPosition>(`/api/audit/position?${apiQuery(filters, { date })}`);
}

export const useSite = () =>
  useQuery({ queryKey: keys.site, queryFn: () => api.get<Site>("/api/site"), staleTime: 60_000 });

export const useBillingSettings = () =>
  useQuery({ queryKey: keys.billingSettings, queryFn: () => api.get<BillingSettings>("/api/settings/billing") });

export function usePutBillingSettings() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: BillingSettings) => api.put<BillingSettings>("/api/settings/billing", body),
    onSuccess: () => invalidate(keys.billingSettings, keys.site, ...COST_DEPENDENT),
  });
}

/** Where the Billing month picker starts; the first month with energy data, or null. */
export const useBillingMonths = () =>
  useQuery({ queryKey: keys.billingMonths, queryFn: () => api.get<BillingMonths>("/api/billing/months"), staleTime: 60_000 });

export const useTariffs = () => useQuery({ queryKey: keys.tariffs, queryFn: () => api.get<Tariff[]>("/api/tariffs") });

export function useCreateTariff() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: TariffIn) => api.post<Tariff>("/api/tariffs", body),
    onSuccess: () => invalidate(keys.tariffs, ...COST_DEPENDENT),
  });
}

export function useUpdateTariff() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: TariffPatch }) => api.patch<Tariff>(`/api/tariffs/${id}`, body),
    onSuccess: () => invalidate(keys.tariffs, ...COST_DEPENDENT),
  });
}

export function useDeleteTariff() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/tariffs/${id}`),
    onSuccess: () => invalidate(keys.tariffs, ...COST_DEPENDENT),
  });
}

/** One call returns the whole asset tree for the month. Idle while `month` is null (the site timezone has not loaded yet). */
export const useBillingCosts = (month: string | null) =>
  useQuery({
    queryKey: keys.billingCosts(month),
    enabled: month !== null,
    refetchInterval: 60_000,
    queryFn: () => api.get<BillingCosts>(`/api/billing/costs?${new URLSearchParams({ month: month! })}`),
  });

/** How often an open month's check is read again: a quarter of an hour. */
const MONTH_CHECK_OPEN_REFETCH_MS = 15 * 60_000;

/** The month check's re-read interval for the answer it holds: `15 * 60_000` while the month is open, `false` (never) for a finished month, a month that has not begun or no answer yet. */
export function monthCheckRefetchMs(data: MonthCheck | undefined): number | false {
  return data?.state === "open" ? MONTH_CHECK_OPEN_REFETCH_MS : false;
}

/**
 * What the month check reports for a month: every meter of the site, so it is a big read, and a month's check changes when its readings, tree,
 * meters or rates change, never by itself within minutes. Hence `staleTime` of five minutes, and a re-read every 15 minutes for an OPEN month only
 * (`monthCheckRefetchMs`: the costs are re-read every minute, so the count would otherwise stay at its first answer while the page stays open; a
 * finished month's readings do not move, so it never polls). Every billing write still reaches it through the `["billing"]` prefix of its key, and a
 * navigation back to the page after five minutes reads it again. The Check month button's count and the drawer read the same cache entry, so opening
 * the drawer costs nothing. Idle while `month` is null (the site timezone has not loaded yet).
 */
export const useBillingMonthCheck = (month: string | null) =>
  useQuery({
    queryKey: keys.billingMonthCheck(month),
    enabled: month !== null,
    staleTime: 5 * 60_000,
    refetchInterval: (query) => monthCheckRefetchMs(query.state.data),
    queryFn: () => api.get<MonthCheck>(`/api/billing/month-check?${new URLSearchParams({ month: month! })}`),
  });

/**
 * Closing or reopening a month moves what Billing shows for it (the costs, and the months list whose first month now counts the closed ones) and
 * writes an audit row. `onSettled`, not `onSuccess`: a refused request (409 already closed, not closed) means the page on screen is out of date.
 * The returned promise lets `mutateAsync` resolve once the month's costs, the months list and the audit log have been read again, so a caller that
 * closes its dialog then finds the page in its new state. It does NOT wait for the month check: that is a big read the dialog has no use for, and a
 * slow or stuck one would keep the dialog open on a month that is already closed. The check is refreshed in the background (`void`), and its count
 * on the page moves when the answer arrives. The widgets' data is refreshed in the background too (w24): a plain `last_month` widget reads live figures,
 * which a close does not change, but a widget that compares with last month reads the frozen figures of a closed month, so closing or reopening moves it.
 * Not the whole of `COST_DEPENDENT`: nothing else in it depends on a close.
 */
function useBillingCloseMutation<Result>(action: "close" | "reopen") {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ month, note }: { month: string; note: string }) => api.post<Result>(`/api/billing/months/${month}/${action}`, { note }),
    onSettled: () => {
      void invalidate(keys.billingMonthCheckAll, keys.widgetData);
      return invalidate(keys.billingCostsAll, keys.billingMonths, keys.auditAll);
    },
  });
}

/** Freeze a finished month as it is now. `note` is optional (empty string for none). The answer is not used: the month is read again. */
export const useCloseBillingMonth = () => useBillingCloseMutation<unknown>("close");

/** Go back to live figures for a closed month. `note` is the reason and is required by the server (5 to 500 characters once trimmed). */
export const useReopenBillingMonth = () => useBillingCloseMutation<BillingReopened>("reopen");

export const useDashboards = () =>
  useQuery({ queryKey: keys.dashboardList, queryFn: () => api.get<DashboardListItem[]>("/api/dashboards") });

/**
 * The dashboard people land on (null = none). The server answers null for a stale or unusable value too.
 * The sidebar keeps this query alive for the whole session, so it looks again by itself (when the tab becomes visible again, once stale, and every minute):
 * another admin may delete the dashboard or pick a new default while a control-room screen stays open.
 * `enabled` is false for a role that may not see dashboards: the query then never leaves `isPending`, so a caller that waits for it must check `enabled` too.
 */
export const useDefaultDashboard = (enabled = true) =>
  useQuery({
    queryKey: keys.defaultDashboard,
    enabled,
    queryFn: () => api.get<DefaultDashboard>("/api/dashboards/default"),
    staleTime: 30_000,
    refetchOnWindowFocus: true, // the app turns this off for every query (main.tsx); react-query fires it when the tab becomes visible again
    refetchInterval: 60_000,
  });

export function usePutDefaultDashboard() {
  const client = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: DefaultDashboard) => api.put<DefaultDashboard>("/api/dashboards/default", body),
    onSuccess: (saved) => {
      client.setQueryData(keys.defaultDashboard, saved);
      return invalidate(keys.auditAll);
    },
  });
}

export const useDashboard = (id: number) =>
  useQuery({ queryKey: keys.dashboard(id), queryFn: () => api.get<Dashboard>(`/api/dashboards/${id}`) });

export function useCreateDashboard() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardIn) => api.post<Dashboard>("/api/dashboards", body),
    onSuccess: (created) => {
      client.setQueryData(keys.dashboard(created.id), created);
      return client.invalidateQueries({ queryKey: keys.dashboardList });
    },
  });
}

/** The editor's single PUT. The saved dashboard (with its new updated_at) replaces the cached one, so no refetch is needed. */
export function useSaveDashboard() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: DashboardSave }) => api.put<Dashboard>(`/api/dashboards/${id}`, body),
    onSuccess: (saved) => {
      client.setQueryData(keys.dashboard(saved.id), saved);
      return client.invalidateQueries({ queryKey: keys.dashboardList });
    },
  });
}

export function useDeleteDashboard() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/dashboards/${id}`),
    onSuccess: (_data, id) => {
      client.removeQueries({ queryKey: keys.dashboard(id) });
      client.invalidateQueries({ queryKey: keys.defaultDashboard });
      return client.invalidateQueries({ queryKey: keys.dashboardList });
    },
  });
}

/** A widget config as a cache key, without its `kind`: two configs that differ only in the kind a breakdown by kind splits by are the same widget. */
const withoutKind = (config: WidgetConfig): string => hashKey([{ ...config, kind: undefined }]);

/** How often a widget's figures are read again: every 30 s. */
const WIDGET_REFETCH_MS = 30_000;
/** A comparison's figures change only when a day completes or a month is closed (a close or a reopen already invalidates `keys.widgetData`), and each answer costs two whole-month reads: every five minutes. */
const COMPARE_REFETCH_MS = 5 * 60_000;

/** The re-read interval of a widget's data: five minutes for a widget that compares with last month's same days, 30 s for every other. */
export const widgetRefetchMs = (config: WidgetConfig): number => (config.compare === "same_days_last_month" ? COMPARE_REFETCH_MS : WIDGET_REFETCH_MS);

/**
 * `preset` is the effective range (the caller resolves inheritance). Refetches every 30 s, or every five minutes for a comparison (`widgetRefetchMs`). While a new range loads the old
 * figures stay, but only for the same widget: after a change of type or config (the editor's preview) the old answer
 * belongs to another kind of widget, so nothing is shown until the new one arrives. The one exception is the `kind` of a breakdown
 * by kind (w24): the viewer's "Split by" changes it, and the card keeps the previous bars (it does not swap to a skeleton, so the select stays
 * where it is and keeps its focus) until the new answer lands.
 */
export const useWidgetData = (type: DataWidgetType, config: WidgetConfig, preset: RangePreset, enabled = true) =>
  useQuery({
    queryKey: [...keys.widgetData, type, config, preset] as const,
    enabled,
    refetchInterval: widgetRefetchMs(config),
    placeholderData: (previous, previousQuery) => {
      const before = previousQuery?.queryKey; // [..keys.widgetData, type, config, preset]
      return before && before[1] === type && withoutKind(before[2] as WidgetConfig) === withoutKind(config) ? previous : undefined;
    },
    queryFn: () => api.post<WidgetData>("/api/widget-data", { type, config, range: preset }),
  });

/**
 * Queue the step-by-step connection check of a source: `{ job_id }`, which `useJob` then polls. A source with a check already queued
 * or running answers 409 (the ApiError's `body.job_id` is that check); one that finished a moment ago answers 429. Both are sentences, not faults.
 */
export function useStartCheck(sourceId: number | null) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => api.post<{ job_id: number }>(`/api/sources/${sourceId}/check`),
    onSuccess: () => invalidate(keys.auditAll), // the start is audited ("source.checked")
  });
}

/**
 * One diagnostics report. An explicit request, never a query: every call writes an audit row, so a refocus or a remount must not make
 * one. `client_time` is this browser's clock, which the report compares with the container's (the one witness outside the VM).
 */
export function buildReport({ detail, mask, source }: ReportParams): Promise<ReportReply> {
  const query = new URLSearchParams({ detail, mask: mask ? "1" : "0", format: "json", client_time: new Date().toISOString() });
  if (source !== null) query.set("source", String(source));
  return api.get<ReportReply>(`/api/diagnostics/report?${query}`);
}

export function useBuildReport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: buildReport,
    onSuccess: () => invalidate(keys.auditAll), // the build is audited ("diagnostics.report")
  });
}
