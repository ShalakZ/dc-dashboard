import { useJob } from "../hooks/useJob";

export function JobStatus({ jobId, maxWaitMs }: { jobId: number | null; maxWaitMs?: number }) {
  const { job, running, timedOut, error } = useJob(jobId, maxWaitMs);
  if (jobId === null) return null;
  // Each state keeps its old colour class and gets a shape (st-*) beside the one text node, so colour is never the only sign.
  if (error) return <span className="job st st-bad error">{error}</span>;
  if (running) return <span className="job st st-stale muted">running…</span>;
  if (timedOut) return <span className="job st st-warn muted">still running — check back later</span>;
  const result = job!.result ?? {};
  if (job!.status === "failed") return <span className="job st st-bad error">failed: {String(result.error ?? "unknown error")}</span>;
  if (job!.kind === "browse_source") return <span className="job st st-ok">found {String(result.count ?? 0)} points</span>;
  const latency = typeof result.latency_ms === "number" ? ` ${result.latency_ms.toFixed(0)} ms` : "";
  return <span className={result.ok ? "job st st-ok" : "job st st-bad error"}>{String(result.status)}{latency}{result.message ? ` — ${String(result.message)}` : ""}</span>;
}
