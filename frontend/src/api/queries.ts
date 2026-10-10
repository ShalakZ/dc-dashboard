import { hashKey, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rangeToQuery, type Range } from "../lib/timeRange";
import { api } from "./client";
import type {
  Asset, AuditPage, BillingCosts, BillingSettings, Connector, Dashboard, DashboardIn, DashboardListItem, DashboardSave,
  GeneralSettings, GraphModel, Metric, PointRow, RangePreset, Role, ScanDetail, ScanSummary, Scope, ScopeSuggestions,
  Series, Site, Source, StorageSettings, StorageSettingsOut, StorageStats, Summary, Tariff, TariffIn, TariffPatch, UserRow, WidgetConfig,
  WidgetData, WidgetType, CollectorStatus, SecretKeyStatus,
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
  storage: ["storage"] as const,
  storageSettings: ["settings", "storage"] as const,
  scopes: ["scopes"] as const,
  suggestions: ["scope-suggestions"] as const,
  scans: ["scans"] as const,
  scan: (id: number) => ["scans", id] as const,
  graph: ["graph"] as const,
  audit: (limit: number, offset: number) => ["audit", limit, offset] as const,
  site: ["site"] as const,
  billingSettings: ["settings", "billing"] as const,
  tariffs: ["tariffs"] as const,
  billing: ["billing"] as const,
  billingCosts: (month: string | null) => ["billing", "costs", month] as const,
  dashboardList: ["dashboards", "list"] as const,
  dashboard: (id: number) => ["dashboards", "detail", id] as const,
  widgetData: ["widget-data"] as const,
  collectorStatus: ["collector-status"] as const,
  secretKey: ["secret-key"] as const,
};

/** Everything whose figures move when a rate, the currency or the timezone changes. `assets` covers the asset summaries (cost_today). */
const COST_DEPENDENT = [keys.billing, keys.widgetData, keys.assets] as const;

export const useAssets = () => useQuery({ queryKey: keys.assets, queryFn: () => api.get<Asset[]>("/api/assets") });

export const useSummary = (id: number) =>
  useQuery({ queryKey: keys.summary(id), queryFn: () => api.get<Summary>(`/api/assets/${id}/summary`), refetchInterval: 60_000 });

export const useSeries = (id: number, metric: Metric | null, range: Range, mappingId?: number) =>
  useQuery({
    queryKey: keys.series(id, metric ?? "custom", range, mappingId),
    enabled: metric !== null,
    refetchInterval: 30_000,
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

/** Operators and admins only (the Sources page). A fetch error shows nothing: the warning is an extra, not a gate. */
export const useSecretKeyStatus = () =>
  useQuery({ queryKey: keys.secretKey, queryFn: () => api.get<SecretKeyStatus>("/api/secret-key/status"), refetchInterval: 60_000 });

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
    mutationFn: (body: { username: string; password: string; role: Role }) => api.post<UserRow>("/api/users", body),
    onSuccess: () => invalidate(keys.users),
  });
}

export function usePatchUser() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: { role?: Role; active?: boolean; password?: string } }) =>
      api.patch<UserRow>(`/api/users/${id}`, body),
    onSuccess: () => invalidate(keys.users),
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

export const useStorage = () => useQuery({ queryKey: keys.storage, queryFn: () => api.get<StorageStats>("/api/storage") });

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

/** Admin-only on the server: callers enable it only for admins, and only while the new-scope form is open. */
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

export const useAudit = (limit: number, offset: number) =>
  useQuery({
    queryKey: keys.audit(limit, offset),
    queryFn: () => api.get<AuditPage>(`/api/audit?${new URLSearchParams({ limit: String(limit), offset: String(offset) })}`),
  });

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
