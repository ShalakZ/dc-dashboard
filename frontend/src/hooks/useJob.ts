import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Job } from "../api/types";

const FINISHED = new Set(["done", "failed"]);
export const DEFAULT_MAX_WAIT_MS = 60_000;

/**
 * Poll a job until it finishes or `maxWaitMs` elapses. After the cap, polling stops and
 * `timedOut` is true so the caller can say "still running" instead of spinning forever.
 */
export function useJob(jobId: number | null, maxWaitMs = DEFAULT_MAX_WAIT_MS) {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (jobId === null) return;
    const timer = setTimeout(() => setTimedOut(true), maxWaitMs);
    return () => clearTimeout(timer);
  }, [jobId, maxWaitMs]);

  const { data, error } = useQuery({
    queryKey: ["jobs", jobId],
    enabled: jobId !== null,
    queryFn: () => api.get<Job>(`/api/jobs/${jobId}`),
    refetchInterval: (query) => (timedOut || (query.state.data && FINISHED.has(query.state.data.status)) ? false : 1000),
  });
  const job = data ?? null;
  const finished = job !== null && FINISHED.has(job.status);
  return {
    job,
    running: jobId !== null && !finished && !timedOut,
    timedOut: jobId !== null && !finished && timedOut,
    error: error ? error.message : null,
  };
}
