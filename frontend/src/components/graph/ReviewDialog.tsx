import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { keys, useInvalidate } from "../../api/queries";
import { METRICS, type AcceptResult, type GraphModel, type Metric } from "../../api/types";
import { useAction } from "../../hooks/useAction";
import {
  acceptBody, assetChoices, metricConflicts, reviewRows, takenMetrics,
  type AcceptTarget, type DropPayload, type ReviewRow,
} from "../../lib/drop";

/** Where the points should go when the dialog opens. `assetId: null` means "no asset chosen yet". */
export type InitialTarget =
  | { kind: "existing"; assetId: number | null }
  | { kind: "new"; name: string; parentId: number | null };

interface Props {
  model: GraphModel;
  payload: DropPayload;
  initialTarget: InitialTarget;
  onClose: () => void;
}

type Mode = InitialTarget["kind"];
/** What the user has typed into the number boxes, kept as text so a half-typed value is not rewritten under them. */
type Draft = { scale?: string; interval?: string };

const NONE: ReadonlySet<Metric> = new Set();
const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const indent = (depth: number) => "  ".repeat(depth);

/** A scale must be above zero (the server rejects anything else). null = not a usable number. */
function parseScale(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}
/** An interval is blank (server default, null) or a whole number of seconds from 1. undefined = not usable. */
function parseInterval(text: string): number | null | undefined {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

const takenFor = (model: GraphModel, mode: Mode, assetId: number | null): ReadonlySet<Metric> =>
  mode === "existing" && assetId !== null ? takenMetrics(model, assetId) : NONE;

/**
 * Review and commit the mappings for what was dropped (or picked): choose the asset (existing or new), tick the points,
 * adjust metric, scale and interval, then create them all in one request. Nothing is saved until "Create mappings".
 */
export function ReviewDialog({ model, payload, initialTarget, onClose }: Props) {
  const invalidate = useInvalidate();
  const { run, busy, error } = useAction();
  const dialog = useRef<HTMLDivElement>(null);
  // The two asset selects are labelled from outside (htmlFor), not by wrapping: a label that wraps a select takes the
  // option texts as part of its own, so browser tooling that matches a label exactly would never find "Asset".
  const assetSelectId = useId();
  const parentSelectId = useId();

  const [mode, setMode] = useState<Mode>(initialTarget.kind);
  const [assetId, setAssetId] = useState<number | null>(initialTarget.kind === "existing" ? initialTarget.assetId : null);
  const [name, setName] = useState(initialTarget.kind === "new" ? initialTarget.name : payload.label);
  const [parentId, setParentId] = useState<number | null>(initialTarget.kind === "new" ? initialTarget.parentId : null);
  const [rows, setRows] = useState<ReviewRow[]>(() =>
    reviewRows(payload.points, takenFor(model, initialTarget.kind, initialTarget.kind === "existing" ? initialTarget.assetId : null)));
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});

  const choices = useMemo(() => assetChoices(model.assets), [model.assets]);
  const taken = useMemo(() => takenFor(model, mode, assetId), [model, mode, assetId]);

  // Moving to another asset starts the review over: which metrics are free depends on the asset.
  const retarget = (nextMode: Mode, nextAssetId: number | null) => {
    setMode(nextMode);
    setAssetId(nextAssetId);
    setRows(reviewRows(payload.points, takenFor(model, nextMode, nextAssetId)));
    setDrafts({});
  };
  const patchRow = (pointId: number, patch: Partial<ReviewRow>) =>
    setRows((current) => current.map((r) => (r.pointId === pointId ? { ...r, ...patch } : r)));
  const editDraft = (pointId: number, patch: Draft) => setDrafts((current) => ({ ...current, [pointId]: { ...current[pointId], ...patch } }));

  const scaleText = (r: ReviewRow) => drafts[r.pointId]?.scale ?? String(r.scale);
  const intervalText = (r: ReviewRow) => drafts[r.pointId]?.interval ?? (r.intervalSeconds === null ? "" : String(r.intervalSeconds));

  const target: AcceptTarget | null = mode === "existing"
    ? (assetId === null ? null : { kind: "existing", assetId })
    : (name.trim() === "" ? null : { kind: "new", name: name.trim(), parentId });
  const conflictIds = metricConflicts(rows, taken);
  const conflicting = new Set(conflictIds);
  const unusable = rows.filter((r) => {
    const d = drafts[r.pointId];
    return r.checked && ((d?.scale !== undefined && parseScale(d.scale) === null) || (d?.interval !== undefined && parseInterval(d.interval) === undefined));
  });
  let reason: string | null = null;
  if (mode === "existing" && assetId === null) reason = "Choose an asset to map to.";
  else if (target === null) reason = "Enter a name for the new asset.";
  else if (!rows.some((r) => r.checked)) reason = "Check at least one point to map.";
  else if (conflictIds.length > 0) {
    const named = rows.filter((r) => conflicting.has(r.pointId)).map((r) => `${r.name} (${r.metric})`).join(", ");
    reason = `Each metric can be mapped to an asset only once. Fix the conflict: ${named}.`;
  } else if (unusable.length > 0) {
    reason = `Enter a scale above 0 and a whole interval of at least 1 second (or leave the interval blank): ${unusable.map((r) => r.name).join(", ")}.`;
  }

  const commit = () => {
    if (target === null || reason !== null) return;
    void run(async () => {
      await api.post<AcceptResult>("/api/discovery/accept", acceptBody(payload.source.id, target, rows));
      // keys.sources also covers this source's points list (its key starts with it): naming both would fetch that list twice.
      await invalidate(keys.graph, keys.sources, keys.assets);
      onClose();
    });
  };

  // Focus moves into the dialog and stays there; when it goes away, focus goes back to what had it.
  useEffect(() => {
    const root = dialog.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = () => root.querySelector<HTMLElement>(FOCUSABLE);
    first()?.focus();
    const keepFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !root.contains(event.target)) first()?.focus();
    };
    document.addEventListener("focusin", keepFocus);
    return () => {
      document.removeEventListener("focusin", keepFocus);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  // Escape is Cancel, except while the request is in flight.
  useEffect(() => {
    if (busy) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const count = payload.points.length;
  return (
    <div className="dialog-backdrop">
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Review mappings" className="dialog">
        <h2>Review mappings</h2>
        <p className="muted">{`${count} unmapped point${count === 1 ? "" : "s"} from ${payload.source.name}`}</p>

        <fieldset className="dialog-target">
          <legend>Map to</legend>
          <div className="row">
            <label className="inline">
              <input type="radio" name="review-target" checked={mode === "existing"} onChange={() => retarget("existing", assetId)} />
              Existing asset
            </label>
            <label className="inline">
              <input type="radio" name="review-target" checked={mode === "new"} onChange={() => retarget("new", assetId)} />
              New asset
            </label>
          </div>
          {mode === "existing" ? (
            <div className="field">
              <label htmlFor={assetSelectId}>Asset</label>
              <select id={assetSelectId} value={assetId ?? ""} onChange={(e) => retarget("existing", e.target.value === "" ? null : Number(e.target.value))}>
                <option value="">(choose)</option>
                {choices.map((a) => <option key={a.id} value={a.id}>{indent(a.depth) + a.name}</option>)}
              </select>
            </div>
          ) : (
            <>
              <label>New asset name
                <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
              </label>
              <div className="field">
                <label htmlFor={parentSelectId}>Parent asset</label>
                <select id={parentSelectId} value={parentId ?? ""} onChange={(e) => setParentId(e.target.value === "" ? null : Number(e.target.value))}>
                  <option value="">(root)</option>
                  {choices.map((a) => <option key={a.id} value={a.id}>{indent(a.depth) + a.name}</option>)}
                </select>
              </div>
            </>
          )}
        </fieldset>

        <div className="dialog-rows">
          <table>
            <thead>
              <tr><th>Map</th><th>Point</th><th>Metric</th><th>Scale</th><th>Interval (s)</th><th>Note</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.pointId} className={r.checked && conflicting.has(r.pointId) ? "conflict" : undefined}>
                  <td><input type="checkbox" aria-label={`Map ${r.name}`} checked={r.checked} onChange={(e) => patchRow(r.pointId, { checked: e.target.checked })} /></td>
                  <td>{r.name}</td>
                  <td>
                    <select
                      aria-label={`Metric for ${r.name}`}
                      aria-invalid={r.checked && conflicting.has(r.pointId) ? true : undefined}
                      value={r.metric}
                      onChange={(e) => {
                        const metric = e.target.value as Metric;
                        // The note explained the old metric, and a unit only means something for custom.
                        patchRow(r.pointId, { metric, note: null, customUnit: metric === "custom" ? r.customUnit : null });
                      }}
                    >
                      {METRICS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </td>
                  <td>
                    <input
                      type="number" step="any" min="0" aria-label={`Scale for ${r.name}`} value={scaleText(r)}
                      onChange={(e) => {
                        editDraft(r.pointId, { scale: e.target.value });
                        const scale = parseScale(e.target.value);
                        if (scale !== null) patchRow(r.pointId, { scale });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="number" step="1" min="1" aria-label={`Interval for ${r.name}`} value={intervalText(r)}
                      onChange={(e) => {
                        editDraft(r.pointId, { interval: e.target.value });
                        const intervalSeconds = parseInterval(e.target.value);
                        if (intervalSeconds !== undefined) patchRow(r.pointId, { intervalSeconds });
                      }}
                    />
                  </td>
                  <td className="muted">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {reason && <p className="muted">{reason}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button onClick={commit} disabled={busy || reason !== null}>Create mappings</button>
          <button onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
