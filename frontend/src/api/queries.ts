import { useQuery, useQueryClient } from "@tanstack/react-query";
import { rangeToQuery, type Range } from "../lib/timeRange";
import { api } from "./client";
import type { Asset, Connector, Metric, PointRow, Series, Source, Summary } from "./types";

export const keys = {
  assets: ["assets"] as const,
  summary: (id: number) => ["assets", id, "summary"] as const,
  series: (id: number, metric: Metric, range: Range) => ["assets", id, "series", metric, range] as const,
  sources: ["sources"] as const,
  connectors: ["connectors"] as const,
  points: (sourceId: number) => ["sources", sourceId, "points"] as const,
};

export const useAssets = () => useQuery({ queryKey: keys.assets, queryFn: () => api.get<Asset[]>("/api/assets") });

export const useSummary = (id: number) =>
  useQuery({ queryKey: keys.summary(id), queryFn: () => api.get<Summary>(`/api/assets/${id}/summary`), refetchInterval: 60_000 });

export const useSeries = (id: number, metric: Metric | null, range: Range) =>
  useQuery({
    queryKey: keys.series(id, metric ?? "custom", range),
    enabled: metric !== null,
    refetchInterval: 30_000,
    queryFn: () => {
      const q = rangeToQuery(range);
      const params = new URLSearchParams({ metric: metric!, start: q.start, end: q.end, buckets: String(q.buckets) });
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
