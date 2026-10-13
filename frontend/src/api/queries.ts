import { hashKey, keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiQuery, type AuditFilters } from "../lib/auditFilters";
import { rangeToQuery, trendRefetchMs, type Range } from "../lib/timeRange";
import { ApiError, api } from "./client";
import type {
  Asset, AuditEntry, AuditList, AuditOptions, AuditPosition, BillingCosts, BillingMonths, BillingSettings, Connector, Dashboard, DashboardIn, DashboardListItem, DashboardSave, DefaultDashboard,
  FleetSummary, GeneralSettings, GraphModel, Metric, PointRow, RangePreset, ScanDetail, ScanSummary, Scope, ScopeSuggestions,
  RowsPerDayRange, Series, SignInPolicy, SignInValues, Site, Source, StorageSettings, StorageSettingsOut, StorageStats, Summary, Tariff, TariffIn, TariffPatch, UserRow, WidgetConfig,
  WidgetData, WidgetType, CollectorStatus, LiveStatus, ReportParams, ReportReply, SecretKeyStatus, TlsStatus, VersionInfo,
} from "./types";

export const keys = {
  assets: ["assets"] as const,
  summary: (id: number) => ["assets", id, "summary"] as const,
  series: (id: number, metric: Metric, range: Range, mappingId?: number) =>
    ["assets", id, "series", metric, range, mappingId ?? null] as const,
  sources: ["sources"] as const,
  connectors: ["connectors"] as const,
  points: (sourceId: number) => ["sources", sourceId, "points"] as const,
  users: ["users"] as const,
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
  billingMonths: ["billing", "months"] as const,
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

export function useCreateUser() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { username: string; password: string; role: string }) => api.post<UserRow>("/api/users", body),
    onSuccess: () => invalidate(keys.users, keys.auditAll),
  });
}

export function usePatchUser() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: { role?: string; active?: boolean; password?: string } }) =>
      api.patch<UserRow>(`/api/users/${id}`, body),
    onSuccess: () => invalidate(keys.users, keys.auditAll),
  });
}

export function useDeleteUser() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/users/${id}`),
    // The audit options are cached for a minute and the delete adds "(deleted)" to the User filter.
    onSuccess: () => invalidate(keys.users, keys.auditAll),
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

/** Needs discovery.edit on the server: callers enable it only for someone who holds it, and only while the new-scope form is open. */
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

/** One page of the filtered audit log. The previous page stays on screen while the next loads (`isPlaceholderData` says so). */
export const useAudit = (filters: AuditFilters, limit: number, offset: number) =>
  useQuery({
    queryKey: keys.audit(filters, limit, offset),
    queryFn: () => api.get<AuditList>(`/api/audit?${apiQuery(filters, { limit, offset })}`),
    placeholderData: keepPreviousData,
  });

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

/**
 * `preset` is the effective range (the caller resolves inheritance). Refetches every 30 s. While a new range loads the old
 * figures stay, but only for the same widget: after a change of type or config (the editor's preview) the old answer
 * belongs to another kind of widget, so nothing is shown until the new one arrives.
 */
export const useWidgetData = (type: WidgetType, config: WidgetConfig, preset: RangePreset, enabled = true) =>
  useQuery({
    queryKey: [...keys.widgetData, type, config, preset] as const,
    enabled,
    refetchInterval: 30_000,
    placeholderData: (previous, previousQuery) => {
      const before = previousQuery?.queryKey; // [..keys.widgetData, type, config, preset]
      return before && before[1] === type && hashKey([before[2]]) === hashKey([config]) ? previous : undefined;
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
