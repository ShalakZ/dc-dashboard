import { useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useUpdateDisplay } from "../../api/queries";
import type { DisplayRow, PlaylistRow } from "../../api/types";
import { useAction } from "../../hooks/useAction";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { useToast } from "../Toasts";

/**
 * Rename display / Change playlist (w28): one field, Save and Cancel. The server's refusal (a name already taken, a 403, a 422) is shown here and the dialog
 * stays open. Built on `useDialogFocus` (focus on the field, Tab wraps, Escape cancels unless a save is running, focus back to the row menu's button on close).
 */
export function DisplayFieldDialog({ display, field, playlists, onClose }: {
  display: DisplayRow;
  field: "name" | "playlist";
  playlists: readonly PlaylistRow[];
  onClose: () => void;
}) {
  const update = useUpdateDisplay();
  const toast = useToast();
  const { run, busy, error, clear } = useAction();
  const root = useRef<HTMLDivElement>(null);
  const control = useRef<HTMLInputElement & HTMLSelectElement>(null);
  const fieldId = useId();
  const [name, setName] = useState(display.name);
  const [playlist, setPlaylist] = useState(display.playlist_id);
  useDialogFocus(root, onClose, { busy, initial: control });

  const trimmed = name.trim();
  const unchanged = field === "name" ? trimmed === display.name : playlist === display.playlist_id;
  const blocked = busy || (field === "name" && trimmed === "");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    if (unchanged) { // nothing to send
      onClose();
      return;
    }
    void run(async () => {
      await update.mutateAsync({ id: display.id, body: field === "name" ? { name: trimmed } : { playlist_id: playlist } });
      toast.success(field === "name" ? "Display renamed" : "Playlist changed");
      onClose();
    });
  };

  const title = field === "name" ? "Rename display" : "Change playlist";
  return createPortal(
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-label={title} className="dialog displays-dialog">
        <h2>{title}</h2>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor={fieldId}>{field === "name" ? "Name" : "Playlist"}</label>
            {field === "name" ? (
              <input id={fieldId} ref={control} value={name} maxLength={100} autoComplete="off" onChange={(e) => { clear(); setName(e.target.value); }} />
            ) : (
              <select id={fieldId} ref={control} value={playlist} onChange={(e) => { clear(); setPlaylist(Number(e.target.value)); }}>
                {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
          </div>
          <p className="error displays-error" role="alert">{error}</p>
          <div className="row">
            <button type="button" aria-disabled={busy ? true : undefined} onClick={() => { if (!busy) onClose(); }}>Cancel</button>
            <button type="submit" className="primary" aria-disabled={blocked ? true : undefined}>Save</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
