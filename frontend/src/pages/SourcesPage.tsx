import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { keys, useInvalidate, useSources } from "../api/queries";
import type { SourceImpact } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { JobStatus } from "../components/JobStatus";
import { SourceForm } from "../components/SourceForm";
import { useAction } from "../hooks/useAction";
import { sourceImpact, sourceLoss } from "../lib/impact";

export function SourcesPage() {
  const { hasRole } = useAuth();
  const { data: sources = [], error, isLoading } = useSources();
  const invalidate = useInvalidate();
  const [jobs, setJobs] = useState<Record<number, number>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [confirming, setConfirming] = useState<{ id: number; name: string; impact: SourceImpact } | null>(null);
  const { run, busy, error: actionError } = useAction();

  const testOne = (id: number) => run(async () => {
    const { job_id } = await api.post<{ job_id: number }>(`/api/sources/${id}/test`);
    setJobs((j) => ({ ...j, [id]: job_id }));
  });
  const testAll = () => run(async () => {
    const { job_ids } = await api.post<{ job_ids: number[] }>("/api/sources/test-all");
    // The API creates one job per enabled source in Source.id order; the list itself is sorted by name.
    const enabled = sources.filter((s) => s.enabled).map((s) => s.id).sort((a, b) => a - b);
    setJobs(Object.fromEntries(enabled.map((id, i) => [id, job_ids[i]])));
  });
  const removed = async (id: number, confirm: boolean) => {
    await api.del(`/api/sources/${id}${confirm ? "?confirm=true" : ""}`);
    setConfirming(null);
    // Its points and mappings go with it, so what Billing, the dashboards' widgets and the tariff list show can change too.
    await invalidate(keys.sources, keys.billing, keys.widgetData, keys.tariffs);
  };
  const remove = (id: number, name: string) => run(async () => {
    if (!window.confirm(`Delete source "${name}", its points and mappings?`)) return;
    try {
      await removed(id, false);
    } catch (e) {
      // The API refuses to delete mapped points without being told to: ask, then repeat the request with confirm.
      const impact = sourceImpact(e);
      if (!impact) throw e;
      setConfirming({ id, name, impact });
    }
  });

  if (isLoading) return <p className="muted">loading…</p>;
  if (error) return <p className="error" role="alert">{error.message}</p>;
  return (
    <>
      <h1>Sources</h1>
      <div className="row">
        <button onClick={testAll} disabled={sources.length === 0 || busy}>Test all</button>
        {hasRole("admin") && <button onClick={() => setShowAdd((v) => !v)}>Add source</button>}
      </div>
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {showAdd && <SourceForm onDone={() => setShowAdd(false)} />}
      {confirming && (
        <ConfirmDeleteDialog
          title={`Delete source "${confirming.name}"?`}
          message={sourceLoss(confirming.impact)}
          onConfirm={() => removed(confirming.id, true)}
          onCancel={() => setConfirming(null)}
        />
      )}
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Enabled</th><th>Status</th><th>Last seen</th><th>Last error</th><th>Test result</th><th></th></tr></thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td><td>{s.connector_type}</td><td>{s.enabled ? "yes" : "no"}</td>
              <td>{s.status}</td>
              <td>{s.last_seen ? new Date(s.last_seen).toLocaleString() : "—"}</td>
              <td className="error">{s.last_error ?? ""}</td>
              <td><JobStatus jobId={jobs[s.id] ?? null} /></td>
              <td className="row">
                <button onClick={() => testOne(s.id)}>Test</button>
                {hasRole("admin") && <Link to={`/sources/${s.id}/points`}>Points</Link>}
                {hasRole("admin") && <button onClick={() => remove(s.id, s.name)}>Delete</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
