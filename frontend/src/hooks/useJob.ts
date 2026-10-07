import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Job } from "../api/types";

const FINISHED = new Set(["done", "failed"]);

export function useJob(jobId: number | null) {
  const { data, error } = useQuery({
    queryKey: ["jobs", jobId],
    enabled: jobId !== null,
    queryFn: () => api.get<Job>(`/api/jobs/${jobId}`),
    refetchInterval: (query) => (query.state.data && FINISHED.has(query.state.data.status) ? false : 1000),
  });
  const job = data ?? null;
  return { job, running: jobId !== null && (job === null || !FINISHED.has(job.status)), error: error ? error.message : null };
}
