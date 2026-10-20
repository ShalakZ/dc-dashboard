import { useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useCreatePlaylist, useDashboards, useUpdatePlaylist } from "../../api/queries";
import type { DisplayLimits, PlaylistIn, PlaylistRow } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { useAction } from "../../hooks/useAction";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { Icon } from "../Icon";
import { InfoTip } from "../InfoTip";
import { useToast } from "../Toasts";
import { HIDDEN, skipSentence } from "./displayText";
import { FocusPickDialog } from "./FocusPickDialog";

/**
 * One item of the playlist being edited. It holds what the server sent until the person changes it: an item that comes back with its own `id` and the
 * `dashboardId` / `focusId` it came with is kept as stored (a dashboard that was deleted stays null and a vanished focus stays set), so a playlist with a skipped
 * item can be saved untouched. `skip` is the sentence for the stored state; any change to the item's dashboard or focus drops it (it no longer describes the item).
 */
interface Draft {
  key: number;
  id?: number;
  dashboardId: number | null;
  /** The name the answer carried (live, or kept when the dashboard went), for an id the dashboards list does not hold. */
  dashboardName: string | null;
  focusId: number | null;
  focusName: string | null;
  seconds: string;
  skip: string | null;
}

type Aim = { key: number; act: "up" | "down" | "remove" | "dashboard" } | { act: "add" };

/** The fewest and most seconds, with a sentence for the Seconds field's tip. */
const secondsTip = (limits: DisplayLimits) => `How long this dashboard stays on screen before the next one. ${limits.min_seconds} to ${limits.max_seconds}.`;

/**
 * New playlist / Edit playlist (w28): a Name and up to `limits.items` items, each with a Dashboard (a select), a Focus (the dashboard's asset picker in a dialog
 * of its own, only for a role with `assets.view`), "Seconds on screen" with its tip, and Move up, Move down and Remove buttons (keyboard only, no dragging).
 * Without `assets.view` there is no Focus field at all, but each item's stored focus is sent back as it was (stripping it would change data behind the person's
 * back): the server refuses that save with its own sentence, which is shown here, never swallowed.
 * Built on `useDialogFocus`: Escape and Tab belong to the top-most dialog (the focus picker), and focus goes back to the opener on close. A server refusal
 * (403, 409 name taken, 422) stays in the dialog's one message slot; a client problem (no name, a new item with no dashboard, seconds out of range) is the hint in the same slot.
 */
export function PlaylistDialog({ playlist, limits, onClose }: { playlist: PlaylistRow | null; limits: DisplayLimits; onClose: () => void }) {
  const { can } = useAuth();
  const canFocus = can("assets.view");
  const dashboards = useDashboards();
  const create = useCreatePlaylist();
  const update = useUpdatePlaylist();
  const toast = useToast();
  const { run, busy, error, clear } = useAction();
  const root = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const ids = useId();
  const nextKey = useRef(0);
  const aim = useRef<Aim | null>(null); // where the focus goes after the list changes under it
  const [name, setName] = useState(playlist?.name ?? "");
  const [items, setItems] = useState<Draft[]>(() =>
    (playlist?.items ?? []).map((item) => ({
      key: nextKey.current++, id: item.id, dashboardId: item.dashboard_id, dashboardName: item.dashboard_name,
      focusId: item.focus_asset_id, focusName: item.focus_name, seconds: String(item.seconds), skip: skipSentence(item),
    })),
  );
  const [picking, setPicking] = useState<Draft | null>(null); // the item whose focus is being chosen
  useDialogFocus(root, onClose, { busy, initial: nameInput });

  const dashboardsById = useMemo(() => new Map((dashboards.data ?? []).map((d) => [d.id, d.name])), [dashboards.data]);
  const dashboardText = (d: Draft): string | null => (d.dashboardId === null ? null : dashboardsById.get(d.dashboardId) ?? d.dashboardName ?? HIDDEN);
  const itemLabel = (d: Draft, index: number) => dashboardText(d) ?? `item ${index + 1}`;
  const focusText = (d: Draft) => (d.focusId === null ? "Whole site" : d.focusName ?? HIDDEN);

  const edit = (next: Draft[]) => {
    clear(); // a refusal is about the playlist as it was sent
    setItems(next);
  };
  const change = (key: number, patch: Partial<Draft>) => edit(items.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  // After the list changes under the focus (a button moved, an item left), the focus goes where `aim` says, once the new list is in the page.
  useLayoutEffect(() => {
    const target = aim.current;
    aim.current = null;
    if (!target) return;
    const where = "key" in target ? `[data-item="${target.key}"] [data-act="${target.act}"]` : '[data-act="add"]';
    root.current?.querySelector<HTMLElement>(where)?.focus();
  });

  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= items.length) return; // aria-disabled, not disabled: the button may hold the focus
    const next = items.slice();
    [next[index], next[to]] = [next[to], next[index]];
    aim.current = { key: items[index].key, act: by === -1 ? "up" : "down" };
    edit(next);
  };
  const remove = (index: number) => {
    const neighbour = items[index + 1] ?? items[index - 1];
    aim.current = neighbour ? { key: neighbour.key, act: "remove" } : { act: "add" };
    edit(items.filter((_, i) => i !== index));
  };
  const atCap = items.length >= limits.items;
  const add = () => {
    if (atCap) return;
    const key = nextKey.current++;
    aim.current = { key, act: "dashboard" };
    edit([...items, { key, dashboardId: null, dashboardName: null, focusId: null, focusName: null, seconds: "60", skip: null }]);
  };

  // The first thing wrong with what is typed, as a sentence; null when it can be saved.
  const problem = (): string | null => {
    if (name.trim() === "") return "Enter a name.";
    for (const [index, d] of items.entries()) {
      if (d.id === undefined && d.dashboardId === null) return `Choose a dashboard for item ${index + 1}.`;
      const seconds = Number(d.seconds);
      if (!/^\d+$/.test(d.seconds.trim()) || seconds < limits.min_seconds || seconds > limits.max_seconds) {
        return `Seconds on screen for item ${index + 1} must be a whole number from ${limits.min_seconds} to ${limits.max_seconds}.`;
      }
    }
    return null;
  };
  const hint = problem();
  const blocked = busy || hint !== null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    const body: PlaylistIn = {
      name: name.trim(),
      items: items.map((d) => ({
        ...(d.id === undefined ? {} : { id: d.id }),
        dashboard_id: d.dashboardId,
        focus_asset_id: d.focusId,
        seconds: Number(d.seconds),
      })),
    };
    void run(async () => {
      if (playlist) await update.mutateAsync({ id: playlist.id, body });
      else await create.mutateAsync(body);
      toast.success("Playlist saved");
      onClose();
    });
  };

  return createPortal(
    <>
      <div className="dialog-backdrop">
        <div ref={root} role="dialog" aria-modal="true" aria-label={playlist ? "Edit playlist" : "New playlist"} className="dialog playlist-dialog">
          <h2>{playlist ? "Edit playlist" : "New playlist"}</h2>
          <form className="playlist-pane" onSubmit={submit}>
            <div className="playlist-body">
              <div className="field">
                <label htmlFor={nameId}>Name</label>
                <input id={nameId} ref={nameInput} value={name} maxLength={100} autoComplete="off" onChange={(e) => { clear(); setName(e.target.value); }} />
              </div>
              {dashboards.error && <p className="error" role="alert">Could not load the dashboards: {dashboards.error.message}</p>}
              {items.length === 0 ? (
                <p className="muted playlist-none">No dashboards yet. Add one to show it on a screen.</p>
              ) : (
                <ol className="playlist-items">
                  {items.map((d, index) => {
                    const label = itemLabel(d, index);
                    const dashId = `${ids}-dash-${d.key}`;
                    const secondsId = `${ids}-sec-${d.key}`;
                    const focusLabelId = `${ids}-focus-${d.key}`;
                    const focusButtonId = `${ids}-focusbtn-${d.key}`;
                    const listed = d.dashboardId === null || dashboardsById.has(d.dashboardId);
                    return (
                      <li key={d.key} className="playlist-row"><div className="playlist-item" data-item={d.key} role="group" aria-label={`Item ${index + 1}: ${label}`}>
                        <div className="playlist-item-head">
                          <span className="playlist-item-number" aria-hidden="true">{index + 1}</span>
                          <div className="playlist-item-tools">
                            <button type="button" className="icon-btn" data-act="up" aria-label={`Move up ${label}`} title="Move up" aria-disabled={index === 0 ? true : undefined} onClick={() => move(index, -1)}><Icon name="caretUp" /></button>
                            <button type="button" className="icon-btn" data-act="down" aria-label={`Move down ${label}`} title="Move down" aria-disabled={index === items.length - 1 ? true : undefined} onClick={() => move(index, 1)}><Icon name="caret" /></button>
                            <button type="button" className="icon-btn" data-act="remove" aria-label={`Remove ${label}`} title="Remove" onClick={() => remove(index)}><Icon name="close" /></button>
                          </div>
                        </div>
                        <div className="playlist-item-fields">
                          <div className="field">
                            <label htmlFor={dashId}>Dashboard</label>
                            <select
                              id={dashId} data-act="dashboard" value={d.dashboardId === null ? "" : String(d.dashboardId)}
                              onChange={(e) => change(d.key, { dashboardId: e.target.value === "" ? null : Number(e.target.value), dashboardName: null, skip: null })}
                            >
                              {d.dashboardId === null && <option value="">Choose a dashboard</option>}
                              {!listed && <option value={String(d.dashboardId)}>{dashboardText(d)}</option>}
                              {(dashboards.data ?? []).map((dash) => <option key={dash.id} value={String(dash.id)}>{dash.name}</option>)}
                            </select>
                          </div>
                          {canFocus && (
                            <div className="field">
                              <span id={focusLabelId} className="playlist-field-label">Focus</span>
                              <button type="button" id={focusButtonId} className="playlist-focus" aria-labelledby={`${focusLabelId} ${focusButtonId}`} onClick={() => setPicking(d)}>{focusText(d)}</button>
                            </div>
                          )}
                          <div className="field has-tip">
                            <label htmlFor={secondsId}>Seconds on screen</label>
                            <input
                              id={secondsId} type="number" inputMode="numeric" min={limits.min_seconds} max={limits.max_seconds} step={1} value={d.seconds}
                              onChange={(e) => change(d.key, { seconds: e.target.value })}
                            />
                            <InfoTip>{secondsTip(limits)}</InfoTip>
                          </div>
                        </div>
                        {d.skip && <p className="playlist-skip"><Icon name="alert" /><span>{d.skip}</span></p>}
                      </div></li>
                    );
                  })}
                </ol>
              )}
              <div className="playlist-add">
                <button type="button" className="quiet" data-act="add" aria-disabled={atCap ? true : undefined} onClick={add}>Add a dashboard</button>
                <span className="muted">{items.length} of {limits.items} dashboards</span>
              </div>
              {/* One slot for the server's refusal and for the hint, so the footer does not move when either appears. */}
              <div className="playlist-status">
                {error ? <p className="error" role="alert">{error}</p> : <p className="muted">{hint ?? ""}</p>}
              </div>
            </div>
            <div className="row playlist-foot">
              <button type="button" aria-disabled={busy ? true : undefined} onClick={() => { if (!busy) onClose(); }}>Cancel</button>
              <button type="submit" className="primary" aria-disabled={blocked ? true : undefined}>Save</button>
            </div>
          </form>
        </div>
      </div>
      {picking && (
        <FocusPickDialog
          title={`Focus for ${itemLabel(picking, items.findIndex((d) => d.key === picking.key))}`}
          current={picking.focusId}
          onChoose={(assetId, assetName) => {
            if (assetId !== picking.focusId) change(picking.key, { focusId: assetId, focusName: assetName, skip: null });
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </>,
    document.body,
  );
}
