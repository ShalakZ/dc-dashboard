import { useState } from "react";
import { api } from "../api/client";
import { keys, useInvalidate, useScans, useScopes, useScopeSuggestions, useSite } from "../api/queries";
import type { Scope, ScopePreview } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { PageHeader } from "../components/PageHeader";
import { RowActions } from "../components/RowActions";
import { ScanProgress } from "../components/ScanProgress";
import { ScopeForm } from "../components/ScopeForm";
import { TrashButton } from "../components/TrashButton";
import { useAction } from "../hooks/useAction";
import { claimedCount } from "../lib/scanText";
import { formatSiteDateTime } from "../lib/siteTime";

type FormState = "new" | Scope | null;

/** The chip of a scan's status: finished reads ok, failed reads bad, and queued or running is the hollow dot (not finished yet). */
const SCAN_CHIP: Record<string, string> = { done: "chip-ok", failed: "chip-bad" };

// Inline SVG, 24-unit viewBox, decoration only.
const ScansIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /><path d="M11 7v4l2.5 2" /></svg>
);

export function ScansPage() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole("admin");
  const { data: scopes = [], error: scopesError, isLoading } = useScopes();
  const { data: scans = [], error: scansError, isLoading: scansLoading } = useScans();
  const site = useSite();
  const invalidate = useInvalidate();
  const { run, busy, error: actionError } = useAction();
  const [form, setForm] = useState<FormState>(null);
  const suggestions = useScopeSuggestions(isAdmin && form === "new");
  const [pending, setPending] = useState<{ scope: Scope; preview: ScopePreview } | null>(null);
  const [activeScan, setActiveScan] = useState<number | null>(null);

  // Nothing runs before the operator has seen the size of the scan: preview first, then confirm with that host count and the digest of the scope that was previewed.
  const requestPreview = (scope: Scope) => run(async () => {
    setPending({ scope, preview: await api.get<ScopePreview>(`/api/scopes/${scope.id}/preview`) });
  });
  const startScan = () => run(async () => {
    if (!pending) return;
    let scanId: number;
    try {
      ({ scan_id: scanId } = await api.post<{ scan_id: number; job_id: number }>(
        `/api/scopes/${pending.scope.id}/scan`, { confirm_host_count: pending.preview.hosts, digest: pending.preview.digest },
      ));
    } finally {
      setPending(null); // a stale count or a running scan needs a fresh preview, so never leave the old one up
    }
    await invalidate(keys.scans);
    setActiveScan(scanId);
  });
  // A preview describes the scope as it was when previewed, so any change to the scope discards it.
  const edit = (scope: Scope) => {
    setPending(null);
    setForm(scope);
  };
  const saved = () => {
    setPending(null);
    setForm(null);
  };
  const remove = (scope: Scope) => run(async () => {
    setPending(null);
    if (!window.confirm(`Delete scope "${scope.name}"?`)) return;
    await api.del(`/api/scopes/${scope.id}`);
    await invalidate(keys.scopes);
  });

  if (isLoading) return <p className="muted">loading…</p>;
  if (scopesError) return <p className="error" role="alert">{scopesError.message}</p>;
  return (
    <>
      <PageHeader
        title="Scans"
        actions={isAdmin && form === null ? (
          // One primary per page: while a scan waits for its confirmation, that button is the one.
          <button className={pending ? undefined : "primary"} onClick={() => setForm("new")}>New scope</button>
        ) : undefined}
      />
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {form === "new" && suggestions.isPending && <p className="muted">loading suggestions…</p>}
      {form === "new" && !suggestions.isPending && (
        <div className="scope-card">
          {suggestions.error && <p className="muted">Could not load suggestions: {suggestions.error.message}</p>}
          <ScopeForm suggestions={suggestions.data} onSaved={saved} onCancel={() => setForm(null)} />
        </div>
      )}
      {form !== null && form !== "new" && (
        <div className="scope-card">
          <ScopeForm key={form.id} initial={form} onSaved={saved} onCancel={() => setForm(null)} />
        </div>
      )}
      {pending && (
        <div className="panel confirm-scan">
          <p className="confirm-title">Scan "{pending.scope.name}"?</p>
          <p>{`${pending.preview.hosts} hosts × ${pending.preview.ports} ports (${pending.preview.pairs} probes)`}</p>
          <div className="row">
            <button onClick={() => setPending(null)} disabled={busy}>Cancel</button>
            <button className="primary" onClick={startScan} disabled={busy}>Start scan</button>
          </div>
        </div>
      )}
      {scopes.length === 0 ? (
        <div className="empty">
          <div className="empty-icon"><ScansIcon /></div>
          <p className="muted">
            {isAdmin ? "No scopes yet. Use New scope to define what to scan." : "No scopes have been defined yet."}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Targets</th><th>Ports</th>{isAdmin && <th className="row-actions"></th>}</tr></thead>
            <tbody>
              {scopes.map((s) => (
                <tr key={s.id}>
                  <td><span className="cell-name" title={s.name}>{s.name}</span></td><td className="wrap-any">{s.targets.join(", ")}</td><td className="wrap-any">{s.ports.join(", ")}</td>
                  {isAdmin && (
                    <td className="row-actions">
                      <RowActions label={`Actions for ${s.name}`} items={[
                        { label: "Scan", onSelect: () => requestPreview(s), disabled: busy },
                        { label: "Edit", onSelect: () => edit(s) },
                      ]} />
                      <TrashButton label={`Delete ${s.name}`} onClick={() => remove(s)} disabled={busy} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {activeScan !== null && <ScanProgress scanId={activeScan} />}
      <h2 className="section-title">Recent scans</h2>
      {scansLoading && <p className="muted">loading…</p>}
      {scansError && <p className="error" role="alert">{scansError.message}</p>}
      {!scansLoading && !scansError && scans.length === 0 && (
        <div className="empty"><div className="empty-icon"><ScansIcon /></div><p className="muted">No scans yet.</p></div>
      )}
      {!scansLoading && !scansError && scans.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Scope</th><th>Status</th><th>Started</th><th className="num">Claimed / points</th><th className="row-actions"></th></tr></thead>
            <tbody>
              {scans.map((scan) => (
                <tr key={scan.id}>
                  <td><span className="cell-name" title={scan.scope_name}>{scan.scope_name}</span></td>
                  <td><span className={`chip ${SCAN_CHIP[scan.status] ?? "chip-stale"}`}>{scan.status}</span></td>
                  <td className="nowrap">{site.data ? formatSiteDateTime(scan.created_at, site.data.timezone) : "—"}</td>
                  <td className="num nowrap">{claimedCount(scan.progress)} / {scan.progress.points ?? 0}</td>
                  <td className="row-actions"><button className="quiet" onClick={() => setActiveScan(scan.id)}>Details</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
