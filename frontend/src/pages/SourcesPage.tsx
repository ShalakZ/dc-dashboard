import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { keys, useInvalidate, useSources } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { JobStatus } from "../components/JobStatus";
import { SourceForm } from "../components/SourceForm";
import { useAction } from "../hooks/useAction";

export function SourcesPage() {
  const { hasRole } = useAuth();
  const { data: sources = [], error, isLoading } = useSources();
  const invalidate = useInvalidate();
  const [jobs, setJobs] = useState<Record<number, number>>({});
  const [showAdd, setShowAdd] = useState(false);
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
  const remove = (id: number, name: string) => run(async () => {
    if (!window.confirm(`Delete source "${name}", its points and mappings?`)) return;
    await api.del(`/api/sources/${id}`);
    await invalidate(keys.sources);
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
