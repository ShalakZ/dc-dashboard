import { useState } from "react";
import { api } from "../api/client";
import { keys, useInvalidate, useScans, useScopes, useScopeSuggestions } from "../api/queries";
import type { Scope, ScopePreview } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ScanProgress } from "../components/ScanProgress";
import { ScopeForm } from "../components/ScopeForm";
import { useAction } from "../hooks/useAction";

type FormState = "new" | Scope | null;

export function ScansPage() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole("admin");
  const { data: scopes = [], error: scopesError, isLoading } = useScopes();
  const { data: scans = [], error: scansError, isLoading: scansLoading } = useScans();
  const invalidate = useInvalidate();
  const { run, busy, error: actionError } = useAction();
  const [form, setForm] = useState<FormState>(null);
  const suggestions = useScopeSuggestions(isAdmin && form === "new");
  const [pending, setPending] = useState<{ scope: Scope; preview: ScopePreview } | null>(null);
  const [activeScan, setActiveScan] = useState<number | null>(null);

  // Nothing runs before the operator has seen the size of the scan: preview first, then confirm with that host count.
  const requestPreview = (scope: Scope) => run(async () => {
    setPending({ scope, preview: await api.get<ScopePreview>(`/api/scopes/${scope.id}/preview`) });
  });
  const startScan = () => run(async () => {
    if (!pending) return;
    let scanId: number;
    try {
      ({ scan_id: scanId } = await api.post<{ scan_id: number; job_id: number }>(
        `/api/scopes/${pending.scope.id}/scan`, { confirm_host_count: pending.preview.hosts },
      ));
    } finally {
      setPending(null); // a stale count or a running scan needs a fresh preview, so never leave the old one up
    }
    await invalidate(keys.scans);
    setActiveScan(scanId);
  });
  const remove = (scope: Scope) => run(async () => {
    if (!window.confirm(`Delete scope "${scope.name}"?`)) return;
    await api.del(`/api/scopes/${scope.id}`);
    await invalidate(keys.scopes);
  });

  if (isLoading) return <p className="muted">loading…</p>;
  if (scopesError) return <p className="error" role="alert">{scopesError.message}</p>;
  return (
    <>
      <h1>Scans</h1>
      {isAdmin && form === null && (
        <div className="row"><button onClick={() => setForm("new")}>New scope</button></div>
      )}
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {form === "new" && suggestions.isPending && <p className="muted">loading suggestions…</p>}
      {form === "new" && !suggestions.isPending && (
        <>
          {suggestions.error && <p className="muted">Could not load suggestions: {suggestions.error.message}</p>}
          <ScopeForm suggestions={suggestions.data} onSaved={() => setForm(null)} onCancel={() => setForm(null)} />
        </>
      )}
      {form !== null && form !== "new" && (
        <ScopeForm key={form.id} initial={form} onSaved={() => setForm(null)} onCancel={() => setForm(null)} />
      )}
      {pending && (
        <div className="panel">
          <p>Scan "{pending.scope.name}"?</p>
          <p>{`${pending.preview.hosts} hosts × ${pending.preview.ports} ports (${pending.preview.pairs} probes)`}</p>
          <div className="row">
            <button onClick={startScan} disabled={busy}>Start scan</button>
            <button onClick={() => setPending(null)} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}
      <table>
        <thead><tr><th>Name</th><th>Targets</th><th>Ports</th>{isAdmin && <th></th>}</tr></thead>
        <tbody>
          {scopes.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td><td>{s.targets.join(", ")}</td><td>{s.ports.join(", ")}</td>
              {isAdmin && (
                <td className="row">
                  <button onClick={() => requestPreview(s)} disabled={busy}>Scan</button>
                  <button onClick={() => setForm(s)}>Edit</button>
                  <button onClick={() => remove(s)} disabled={busy}>Delete</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {activeScan !== null && <ScanProgress scanId={activeScan} />}
      <h2>Recent scans</h2>
      {scansLoading && <p className="muted">loading…</p>}
      {scansError && <p className="error" role="alert">{scansError.message}</p>}
      {!scansLoading && !scansError && (
        <table>
          <thead><tr><th>Scope</th><th>Status</th><th>Started</th><th>Claimed / points</th><th></th></tr></thead>
          <tbody>
            {scans.map((scan) => (
              <tr key={scan.id}>
                <td>{scan.scope_name}</td>
                <td>{scan.status}</td>
                <td>{new Date(scan.created_at).toLocaleString()}</td>
                <td>{scan.progress.claimed ?? 0} / {scan.progress.points ?? 0}</td>
                <td><button onClick={() => setActiveScan(scan.id)}>Details</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
