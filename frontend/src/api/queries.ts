import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rangeToQuery, type Range } from "../lib/timeRange";
import { api } from "./client";
import type {
  Asset, Connector, GeneralSettings, Metric, PointRow, Role, Series, Source, StorageSettings, StorageStats, Summary, UserRow,
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
