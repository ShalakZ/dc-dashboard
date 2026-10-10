import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { keys, useCollectorStatus, useInvalidate, useSecretKeyStatus, useSite, useSources } from "../api/queries";
import type { Source, SourceImpact } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { JobStatus } from "../components/JobStatus";
import { Modal } from "../components/Modal";
import { SourceForm } from "../components/SourceForm";
import { useAction } from "../hooks/useAction";
import { useNow } from "../hooks/useNow";
import { ageNow, formatAge, formatSpan, secondsSince } from "../lib/age";
import { sourceImpact, sourceLoss } from "../lib/impact";
import { formatSiteDateTime } from "../lib/siteTime";
import { sourceStatusText } from "../lib/sourceStatus";

/** The collector status counts as unreadable when its last answer is older than this. It is the backend's STALE_AFTER_SECONDS (backend/dcdash/core/heartbeat.py), the age at which a heartbeat reads as silent. */
const COLLECTOR_STATUS_STALE_SECONDS = 30;
/** How often the ages on the page are brought up to date between answers. */
const TICK_MS = 5_000;

export function SourcesPage() {
  const { hasRole } = useAuth();
  const { data, error, isLoading, dataUpdatedAt: sourcesAnsweredAt } = useSources();
  const sources = data ?? [];
  const collector = useCollectorStatus();
  const secretKey = useSecretKeyStatus();
  // The ages in both answers are the server's, as of the answer. Against a database that stops answering, the last answers stay on the
  // page, so the page adds the time elapsed since them (its own elapsed time, not its clock against the server's).
  const now = useNow(TICK_MS);
  const statusSilentFor = secondsSince(collector.dataUpdatedAt, now);
  const statusUnreadable = collector.dataUpdatedAt > 0 && statusSilentFor > COLLECTOR_STATUS_STALE_SECONDS;
  const site = useSite();
  const invalidate = useInvalidate();
  const [jobs, setJobs] = useState<Record<number, number>>({});
  const [showAdd, setShowAdd] = useState(false);
  // The source as it was when Edit was pressed, not a lookup into the list: the list is fetched every 10 s with new objects, which would reset the open form.
  const [editing, setEditing] = useState<Source | null>(null);
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
    // Its points and mappings go with it, so what the assets, the graph, Billing, the dashboards' widgets and the tariff list show can change too.
    await invalidate(keys.sources, keys.secretKey, keys.billing, keys.widgetData, keys.tariffs, keys.assets, keys.graph);
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
  // A failed refetch keeps the last list (and any open dialog, with what was typed in it) and shows the error above the table.
  if (error && data === undefined) return <p className="error" role="alert">{error.message}</p>;
  return (
    <>
      <h1>Sources</h1>
      <div className="row">
        <button onClick={testAll} disabled={sources.length === 0 || busy}>Test all</button>
        {hasRole("admin") && <button onClick={() => setShowAdd(true)}>Add source</button>}
      </div>
      {error && <p className="error" role="alert">{error.message}</p>}
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {secretKey.data && !secretKey.data.ok && (
        <p className="error" role="alert">
          {`The DCDASH_SECRET_KEY in .env ${secretKey.data.key_changed ? "is different from the one this database was set up with" : "does not open the stored secrets"}: `}
          {`the secrets of ${secretKey.data.unreadable.map((s) => s.name).join(", ")} cannot be decrypted, so those sources stay offline. `}
          Put the original .env back, or have an admin type each source's secret in again.
        </p>
      )}
      {statusUnreadable ? (
        <p className="error" role="alert">
          {`Collector status cannot be read (no answer for ${formatSpan(statusSilentFor)}). Last-reading ages are counted from the last answer.`}
        </p>
      ) : collector.data && !collector.data.alive && (
        <p className="error" role="alert">
          {collector.data.age_seconds === null
            ? "The collector has not reported yet. No readings are collected until it does."
            : `The collector has not reported for ${formatSpan(ageNow(collector.data.age_seconds, collector.dataUpdatedAt, now))}. No readings are collected while it is silent.`}
        </p>
      )}
      {showAdd && (
        <Modal title="Add source" onClose={() => setShowAdd(false)}>
          <SourceForm onDone={() => setShowAdd(false)} />
        </Modal>
      )}
      {editing && (
        <Modal title={`Edit source ${editing.name}`} onClose={() => setEditing(null)}>
          <SourceForm source={editing} onDone={() => setEditing(null)} />
        </Modal>
      )}
      {confirming && (
        <ConfirmDeleteDialog
          title={`Delete source "${confirming.name}"?`}
          message={sourceLoss(confirming.impact)}
          onConfirm={() => removed(confirming.id, true)}
          onCancel={() => setConfirming(null)}
        />
      )}
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Enabled</th><th>Status</th><th>Last seen</th><th>Last reading</th><th>Last error</th><th>Test result</th><th></th></tr></thead>
        <tbody>
          {sources.map((s) => {
            const status = sourceStatusText(s);
            return (
              <tr key={s.id}>
                <td>{s.name}</td><td>{s.connector_type}</td><td>{s.enabled ? "yes" : "no"}</td>
                <td>{status.polled ? status.text : <span className="muted">{status.text}</span>}</td>
                <td>{s.last_seen && site.data ? formatSiteDateTime(s.last_seen, site.data.timezone) : "—"}</td>
                <td>{formatAge(ageNow(s.last_reading_age_seconds, sourcesAnsweredAt, now))}</td>
                <td className="error">{s.last_error ?? ""}</td>
                <td><JobStatus jobId={jobs[s.id] ?? null} /></td>
                <td className="row">
                  <button onClick={() => testOne(s.id)}>Test</button>
                  {hasRole("admin") && <button onClick={() => setEditing(s)}>Edit</button>}
                  {hasRole("admin") && <Link to={`/sources/${s.id}/points`}>Points</Link>}
                  {hasRole("admin") && <button onClick={() => remove(s.id, s.name)}>Delete</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
