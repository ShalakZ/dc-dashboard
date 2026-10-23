import { useJob } from "../hooks/useJob";

/** `found 15,180 points`, plus (w34) how many tags were left alone because the same stable address was found more than once; with none left alone the text is what it always was, and `warn` says whether the line needs the warning shape. */
function browseLine(result: Record<string, unknown>): { text: string; warn: boolean } {
  const count = typeof result.count === "number" ? result.count : 0;
  const ambiguous = typeof result.ambiguous === "number" ? result.ambiguous : 0;
  const found = `found ${count.toLocaleString("en-US")} points`;
  if (ambiguous <= 0) return { text: found, warn: false };
  const n = ambiguous.toLocaleString("en-US");
  const why = "(the same stable address was found more than once)";
  return { text: ambiguous === 1 ? `${found}; ${n} tag was left as it is ${why}` : `${found}; ${n} tags were left as they are ${why}`, warn: true };
}

export function JobStatus({ jobId, maxWaitMs }: { jobId: number | null; maxWaitMs?: number }) {
  const { job, running, timedOut, error } = useJob(jobId, maxWaitMs);
  if (jobId === null) return null;
  // Each state keeps its old colour class and gets a shape (st-*) beside the one text node, so colour is never the only sign.
  if (error) return <span className="job st st-bad error">{error}</span>;
  if (running) return <span className="job st st-stale muted">running…</span>;
  if (timedOut) return <span className="job st st-warn muted">still running — check back later</span>;
  const result = job!.result ?? {};
  if (job!.status === "failed") return <span className="job st st-bad error">failed: {String(result.error ?? "unknown error")}</span>;
  if (job!.kind === "browse_source") {
    // A browse that left tags alone did not do everything it was asked to: the warning shape (a triangle, not the ok dot), so the colour is never the only sign.
    const line = browseLine(result);
    return <span className={line.warn ? "job st st-warn" : "job st st-ok"}>{line.text}</span>;
  }
  const latency = typeof result.latency_ms === "number" ? ` ${result.latency_ms.toFixed(0)} ms` : "";
  return <span className={result.ok ? "job st st-ok" : "job st st-bad error"}>{String(result.status)}{latency}{result.message ? ` — ${String(result.message)}` : ""}</span>;
}
