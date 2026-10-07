import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rangeToQuery, type Range } from "../lib/timeRange";
import { api } from "./client";
import type {
  Asset, AuditPage, Connector, GeneralSettings, GraphModel, Metric, PointRow, Role, ScanDetail, ScanSummary, Scope,
  ScopeSuggestions, Series, Source, StorageSettings, StorageStats, Summary, UserRow,
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
};

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
    onSuccess: () => invalidate(keys.general),
  });
}

export const useStorage = () => useQuery({ queryKey: keys.storage, queryFn: () => api.get<StorageStats>("/api/storage") });

export const useStorageSettings = () =>
  useQuery({ queryKey: keys.storageSettings, queryFn: () => api.get<StorageSettings>("/api/settings/storage") });

export function useSaveStorageSettings() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: StorageSettings) => api.put<StorageSettings>("/api/settings/storage", body),
    onSuccess: () => invalidate(keys.storageSettings, keys.storage),
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
