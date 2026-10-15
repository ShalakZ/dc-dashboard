import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { keys, useInvalidate, useScans, useScopes, useScopeSuggestions, useSite } from "../api/queries";
import type { ScanSummary, Scope, ScopePreview } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { PageHeader } from "../components/PageHeader";
import { RowActions } from "../components/RowActions";
import { ScanDrawer } from "../components/ScanDrawer";
import { ScopeForm } from "../components/ScopeForm";
import { ActionsSpace, TableSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toasts";
import { TrashButton } from "../components/TrashButton";
import { useAction } from "../hooks/useAction";
import { useConfirm } from "../hooks/useConfirm";
import { portsLine } from "../lib/ports";
import { plural, recognisedText, scopeDetail, sourcesAndPoints } from "../lib/scanText";
import { formatSiteDateTime } from "../lib/siteTime";

type FormState = "new" | Scope | null;

/** The chip of a scan's status: finished reads ok, failed reads bad, and queued or running is the hollow dot (not finished yet). */
const SCAN_CHIP: Record<string, string> = { done: "chip-ok", failed: "chip-bad" };

// Inline SVG, 24-unit viewBox, decoration only.
const ScansIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /><path d="M11 7v4l2.5 2" /></svg>
);

/**
 * Why Scan again cannot be pressed, or null. The order matters: the role first, then the scopes themselves (a list that is still loading or
 * could not be read has no scope to find, which says nothing about the scope having been deleted), and only then "deleted" and "busy".
 */
export function scanAgainBlock(state: { canScan: boolean; loading: boolean; failed: boolean; scope: Scope | undefined; busy: boolean }): string | null {
  if (!state.canScan) return "Your role may not start scans.";
  if (state.loading) return "Loading scopes…";
  if (state.failed) return "The scopes could not be read.";
  if (!state.scope) return "The scope was deleted.";
  if (state.busy) return "Another request is in progress.";
  return null;
}

export function ScansPage() {
  const { can } = useAuth();
  const canEdit = can("discovery.edit"); // New scope, Edit, Delete and the suggestions
  const canScan = can("discovery.scan"); // the Scan item: the preview it starts from opens to either permission
  const hasActions = canEdit || canScan;
  const { data: scopes = [], error: scopesError, isLoading } = useScopes();
  const { data: scans = [], error: scansError, isLoading: scansLoading } = useScans();
  const site = useSite();
  const invalidate = useInvalidate();
  const { run, busy, error: actionError } = useAction();
  const [ask, confirmDialog] = useConfirm();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(null);
  // Read for the edit form too: its typo guard compares with the ports the server suggests (it works from the names alone until they arrive).
  const suggestions = useScopeSuggestions(canEdit && form !== null);
  const [pending, setPending] = useState<{ scope: Scope; preview: ScopePreview } | null>(null);
  const [activeScan, setActiveScan] = useState<number | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const bringPanelIntoView = useRef(false);

  // The confirmation stands above the Scopes table, off screen when Scan again was pressed low in Recent scans: bring it into view without moving the focus.
  useEffect(() => {
    if (!pending || !bringPanelIntoView.current) return;
    bringPanelIntoView.current = false;
    panel.current?.scrollIntoView?.({ block: "nearest", behavior: "auto" }); // "auto" follows the page's own scroll-behavior, which honours reduced motion
  }, [pending]);

  // Nothing runs before the operator has seen the size of the scan: preview first, then confirm with that host count and the digest of the scope that was previewed.
  const requestPreview = (scope: Scope, reveal = false) => run(async () => {
    const preview = await api.get<ScopePreview>(`/api/scopes/${scope.id}/preview`);
    bringPanelIntoView.current = reveal;
    setPending({ scope, preview });
  });
  // Scan again: the same preview and confirmation as the scope row's Scan item, for the scope as it is now (it may have been edited since).
  // `null` = the button can be pressed. It is drawn for every role that can read the table: a reason beats a missing control.
  const scanAgainScope = (scan: ScanSummary) => (scan.scope_id === null ? undefined : scopes.find((s) => s.id === scan.scope_id));
  const scanAgainReason = (scan: ScanSummary): string | null =>
    scanAgainBlock({ canScan, loading: isLoading, failed: Boolean(scopesError), scope: scanAgainScope(scan), busy });
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
  const remove = async (scope: Scope) => {
    setPending(null);
    // Asked outside `run`: while the question is open nothing is in flight, so the trash button stays enabled and can take the focus back.
    if (!(await ask({ title: `Delete scope "${scope.name}"?`, message: "This can't be undone." }))) return;
    await run(async () => {
      await api.del(`/api/scopes/${scope.id}`);
      toast.success(`Scan scope "${scope.name}" deleted`);
      await invalidate(keys.scopes);
    });
  };

  if (isLoading) {
    // The gap stands where the New scope button will be; a role without it has no actions slot (it would be 6.5px taller than the real one).
    return (
      <>
        <PageHeader title="Scans" actions={canEdit ? <ActionsSpace /> : undefined} />
        <TableSkeleton columns={hasActions ? 4 : 3} rows={3} label="Loading scopes" />
      </>
    );
  }
  if (scopesError) return <p className="error" role="alert">{scopesError.message}</p>;
  return (
    <>
      <PageHeader
        title="Scans"
        actions={canEdit && form === null ? (
          // One primary per page: while a scan waits for its confirmation, that button is the one.
          <button className={pending ? undefined : "primary"} onClick={() => setForm("new")}>New scope</button>
        ) : undefined}
      />
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {confirmDialog}
      {form === "new" && suggestions.isPending && <p className="muted">loading suggestions…</p>}
      {form === "new" && !suggestions.isPending && (
        <div className="scope-card">
          {suggestions.error && <p className="muted">Could not load suggestions: {suggestions.error.message}</p>}
          <ScopeForm suggestions={suggestions.data} onSaved={saved} onCancel={() => setForm(null)} />
        </div>
      )}
      {form !== null && form !== "new" && (
        <div className="scope-card">
          <ScopeForm key={form.id} initial={form} suggestions={suggestions.data} onSaved={saved} onCancel={() => setForm(null)} />
        </div>
      )}
      {pending && (
        <div className="panel confirm-scan scan-confirm-reveal" ref={panel}>
          <p className="confirm-title">Scan "{pending.scope.name}"?</p>
          <p>{`${plural(pending.preview.hosts, "host")} × ${plural(pending.preview.ports, "port")} (${plural(pending.preview.pairs, "check")})`}</p>
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
            {canEdit ? "No scopes yet. Use New scope to define what to scan." : "No scopes have been defined yet."}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Targets</th><th>Ports</th>{hasActions && <th className="row-actions"></th>}</tr></thead>
            <tbody>
              {scopes.map((s) => (
                <tr key={s.id}>
                  <td><span className="cell-name" title={s.name}>{s.name}</span></td><td className="wrap-any">{s.targets.join(", ")}</td><td className="wrap-any">{portsLine(s.ports)}</td>
                  {hasActions && (
                    <td className="row-actions">
                      <RowActions label={`Actions for ${s.name}`} items={[
                        ...(canScan ? [{ label: "Scan", onSelect: () => requestPreview(s), disabled: busy }] : []),
                        ...(canEdit ? [{ label: "Edit", onSelect: () => edit(s) }] : []),
                      ]} />
                      {canEdit && <TrashButton label={`Delete ${s.name}`} onClick={() => remove(s)} disabled={busy} />}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {activeScan !== null && (
        <ScanDrawer
          key={activeScan}
          scanId={activeScan}
          onClose={() => setActiveScan(null)}
          // This scan's Details button, asked for when the drawer goes away. If the row is not in the list (a scan older than the list shows), the drawer falls back to the page.
          returnFocus={() => document.querySelector<HTMLElement>(`[data-scan-details="${activeScan}"]`)}
        />
      )}
      <h2 className="section-title">Recent scans</h2>
      {scansLoading && <TableSkeleton columns={5} rows={3} label="Loading recent scans" />}
      {scansError && <p className="error" role="alert">{scansError.message}</p>}
      {!scansLoading && !scansError && scans.length === 0 && (
        <div className="empty"><div className="empty-icon"><ScansIcon /></div><p className="muted">No scans yet.</p></div>
      )}
      {!scansLoading && !scansError && scans.length > 0 && (
        <div className="table-wrap scans-recent">
          <table>
            <thead><tr><th>Scope</th><th>Status</th><th>Started</th><th className="num scan-figures">Sources / points</th><th className="row-actions"></th></tr></thead>
            <tbody>
              {scans.map((scan) => {
                const detail = scopeDetail(scan.targets ?? [], scan.ports ?? []);
                const again = scanAgainScope(scan);
                const reason = scanAgainReason(scan);
                return (
                  <tr key={scan.id}>
                    <td>
                      <span className="cell-name" title={scan.scope_name}>{scan.scope_name}</span>
                      {detail && <>{" "}<span className="cell-sub" title={detail}>{detail}</span></>}
                    </td>
                    <td><span className={`chip ${SCAN_CHIP[scan.status] ?? "chip-stale"}`}>{scan.status}</span></td>
                    <td className="nowrap">{site.data ? formatSiteDateTime(scan.created_at, site.data.timezone) : "—"}</td>
                    <td className="num scan-figures" title={recognisedText(scan.progress)}>{sourcesAndPoints(scan.progress)}</td>
                    <td className="row-actions scan-actions">
                      {/* aria-disabled with a click guard, never native `disabled`: the pressed button keeps the focus while the preview loads. The title is the reason (and its description). */}
                      <button
                        type="button"
                        className="quiet"
                        data-scan-again={scan.id}
                        aria-disabled={reason !== null ? "true" : undefined}
                        title={reason ?? (again ? `Preview and scan "${again.name}" again` : undefined)}
                        onClick={() => { if (reason === null && again) void requestPreview(again, true); }}
                      >Scan again</button>
                      <button type="button" className="quiet" data-scan-details={scan.id} onClick={() => setActiveScan(scan.id)}>Details</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
