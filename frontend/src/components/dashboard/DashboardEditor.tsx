import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useBlocker, type BlockerFunction } from "react-router";
import { useAssets, useGraph, useSaveDashboard } from "../../api/queries";
import type { Dashboard, RangePreset } from "../../api/types";
import { useAction } from "../../hooks/useAction";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { isDirty, isStaleConflict, MAX_TEXT, MAX_WIDGETS, metricAssetsOf, saveBody } from "../../lib/dashboardEdit";
import { defaultSize, newKey, nextPosition, toDrafts, type DraftWidget } from "../../lib/layout";
import { RANGE_LABELS, RANGE_PRESETS } from "../../lib/ranges";
import { DashboardGrid } from "./DashboardGrid";
import { WidgetEditor, type EditorFields } from "./WidgetEditor";
import { WidgetView } from "./WidgetView";

interface Props {
  /** The dashboard as loaded when editing started; its `updated_at` is what Save sends. Later changes to this prop are ignored. */
  dashboard: Dashboard;
  timezone: string;
  onSaved: (saved: Dashboard) => void;
  onCancel: () => void;
  /** Refetch the dashboard and restart the editor from it (discarding the drafts). */
  onReload: () => Promise<void>;
}

/** Edit mode: name, range, the draggable grid, Add/Edit/Delete widget, Save and Cancel, with a prompt before unsaved changes are lost. */
export function DashboardEditor({ dashboard, timezone, onSaved, onCancel, onReload }: Props) {
  const [baseline] = useState(dashboard);
  const assets = useAssets();
  // Which assets have which metric: the widget dialog offers a metric widget only those (there is no mappings listing for operators).
  const graph = useGraph();
  const metricAssets = useMemo(() => (graph.data ? metricAssetsOf(graph.data) : null), [graph.data]);
  const save = useSaveDashboard();
  const { run, busy, error } = useAction();
  const nameId = useId();
  const rangeId = useId();
  const [name, setName] = useState(baseline.name);
  const [range, setRange] = useState<RangePreset>(baseline.range);
  const [drafts, setDrafts] = useState<DraftWidget[]>(() => toDrafts(baseline.widgets));
  const [dialog, setDialog] = useState<{ draft: DraftWidget | null } | null>(null);
  /** True when a save lost a race with someone else's save (the API's "changed since you loaded it" 409). */
  const [conflict, setConflict] = useState(false);
  /** Cancel was pressed with unsaved edits: ask before they are thrown away. */
  const [confirmCancel, setConfirmCancel] = useState(false);
  /** The widget removed last in this session and where it sat, so Undo can put it back. */
  const [removed, setRemoved] = useState<{ draft: DraftWidget; index: number } | null>(null);

  const edit = { name, range, drafts };
  const dirty = isDirty(baseline, edit);
  useBeforeUnload(dirty);

  const problem = name.trim() === "" ? "Enter a dashboard name." : null;
  const full = drafts.length >= MAX_WIDGETS;
  const canSave = problem === null && dirty && !busy && !conflict;
  // Adding or editing a widget needs the asset tree and the metric mappings.
  const ready = assets.data !== undefined && metricAssets !== null;

  const submit = () => run(async () => {
    try {
      onSaved(await save.mutateAsync({ id: baseline.id, body: saveBody(baseline, edit) }));
    } catch (e) {
      if (isStaleConflict(e)) {
        setConflict(true);
        return;
      }
      throw e;
    }
  });
  const reload = () => run(() => onReload());

  const accept = (fields: EditorFields) => {
    const target = dialog?.draft ?? null;
    const key = newKey();
    if (!target) setRemoved(null);
    setDrafts((current) => {
      if (target) return current.map((d) => (d.key === target.key ? { ...d, ...fields } : d));
      const size = defaultSize(fields.type);
      return [...current, { key, ...fields, ...size, ...nextPosition(current, size) }];
    });
    setDialog(null);
  };
  const removeWidget = (d: DraftWidget) => {
    const index = drafts.findIndex((x) => x.key === d.key);
    if (index < 0) return;
    setRemoved({ draft: d, index });
    setDrafts((current) => current.filter((x) => x.key !== d.key));
  };
  const undoRemove = () => {
    if (!removed) return;
    const { draft, index } = removed;
    setDrafts((current) => (current.some((x) => x.key === draft.key) ? current : [...current.slice(0, index), draft, ...current.slice(index)]));
    setRemoved(null);
  };

  const renderWidget = (d: DraftWidget) => (
    <WidgetView
      widgetKey={d.key} type={d.type} title={d.title} config={d.config} dashboardRange={range} timezone={timezone}
      csv={false} live={false} dragHandle
      actions={
        <span className="widget-actions">
          <button type="button" disabled={!ready} onClick={() => setDialog({ draft: d })} aria-label={`Edit ${d.title}`}>Edit</button>
          <button type="button" onClick={() => removeWidget(d)} aria-label={`Delete ${d.title}`}>Delete</button>
        </span>
      }
    />
  );

  return (
    <>
      <div className="row dash-head">
        <label htmlFor={nameId}>Dashboard name</label>
        <input id={nameId} value={name} maxLength={MAX_TEXT} onChange={(e) => setName(e.target.value)} />
        <label htmlFor={rangeId}>Dashboard range</label>
        <select id={rangeId} value={range} onChange={(e) => setRange(e.target.value as RangePreset)}>
          {RANGE_PRESETS.map((p) => <option key={p} value={p}>{RANGE_LABELS[p]}</option>)}
        </select>
        <span className="spacer" />
        {dirty && <span className="muted">Not saved yet</span>}
        <button type="button" onClick={() => setDialog({ draft: null })} disabled={!ready || full}>Add widget</button>
        <button type="button" onClick={submit} disabled={!canSave}>Save</button>
        <button type="button" onClick={() => (dirty ? setConfirmCancel(true) : onCancel())} disabled={busy}>Cancel</button>
      </div>
      {problem && <p className="muted">{problem}</p>}
      {full && <p className="muted">A dashboard can have at most {MAX_WIDGETS} widgets.</p>}
      {assets.error && <p className="error" role="alert">Could not load the assets: {assets.error.message}</p>}
      {graph.error && <p className="error" role="alert">Could not load the metric mappings: {graph.error.message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {conflict && (
        <div className="panel" role="alert">
          <p>This dashboard was changed by someone else</p>
          <p className="muted">Reload shows their version and discards your edits here. Nothing was saved.</p>
          <div className="row"><button type="button" onClick={reload} disabled={busy}>Reload</button></div>
        </div>
      )}
      <div role="status" aria-live="polite">
        {removed && (
          <p className="muted">
            Removed “{removed.draft.title || "widget"}”. <button type="button" onClick={undoRemove}>Undo</button>
          </p>
        )}
      </div>
      <p className="muted">Drag a widget by its title bar and resize it from the corner or the edges. Nothing is saved until you press Save.</p>
      {drafts.length === 0 ? <p className="muted">No widgets yet. Use Add widget.</p> : <DashboardGrid drafts={drafts} onChange={(next) => { if (next !== drafts) setRemoved(null); setDrafts(next); }} renderWidget={renderWidget} />}
      {dialog && assets.data && metricAssets && (
        <WidgetEditor
          initial={dialog.draft} assets={assets.data} metricAssets={metricAssets} dashboardRange={range} timezone={timezone}
          onSave={accept} onClose={() => setDialog(null)}
        />
      )}
      {confirmCancel && <LeaveDialog onStay={() => setConfirmCancel(false)} onLeave={onCancel} />}
      {/* Last on purpose: every dialog backdrop has the same z-index, so the leave prompt must come after the widget dialog
          to paint above it (and it is the one that traps the focus, being opened last). */}
      <UnsavedGuard when={dirty} />
    </>
  );
}

/** Ask the browser to confirm closing or reloading the page while there is something unsaved. */
function useBeforeUnload(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);
}

/** Blocks in-app navigation to another page (not a same-page replace) while `when`, and asks. */
function UnsavedGuard({ when }: { when: boolean }) {
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => when && currentLocation.pathname !== nextLocation.pathname,
    [when],
  );
  const blocker = useBlocker(shouldBlock);
  if (blocker.state !== "blocked") return null;
  return <LeaveDialog onStay={() => blocker.reset()} onLeave={() => blocker.proceed()} />;
}

/** "Unsaved changes": keep editing (also Escape) or leave and lose them. Used for navigation away and for Cancel. */
function LeaveDialog({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useDialogFocus(root, onStay);
  return (
    <div className="dialog-backdrop">
      <div ref={root} role="alertdialog" aria-modal="true" aria-label="Unsaved changes" className="dialog narrow">
        <h2>Unsaved changes</h2>
        <p>This dashboard has changes that are not saved. If you leave now they are lost.</p>
        <div className="row">
          <button type="button" onClick={onStay}>Keep editing</button>
          <button type="button" onClick={onLeave}>Leave and discard changes</button>
        </div>
      </div>
    </div>
  );
}
