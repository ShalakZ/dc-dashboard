import { useJob } from "../hooks/useJob";

export function JobStatus({ jobId }: { jobId: number | null }) {
  const { job, running, error } = useJob(jobId);
  if (jobId === null) return null;
  if (error) return <span className="error">{error}</span>;
  if (running) return <span className="muted">running…</span>;
  const result = job!.result ?? {};
  if (job!.status === "failed") return <span className="error">failed: {String(result.error ?? "unknown error")}</span>;
  if (job!.kind === "browse_source") return <span>found {String(result.count ?? 0)} points</span>;
  const latency = typeof result.latency_ms === "number" ? ` ${result.latency_ms.toFixed(0)} ms` : "";
  return <span className={result.ok ? undefined : "error"}>{String(result.status)}{latency}{result.message ? ` — ${String(result.message)}` : ""}</span>;
}
