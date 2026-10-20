import { useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useUpdateDisplay } from "../../api/queries";
import type { DisplayRow, PlaylistRow } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { useAction } from "../../hooks/useAction";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { upperFirst } from "../../lib/upperFirst";
import { useToast } from "../Toasts";
import { focusRefusal, namesFocus } from "./displayText";

/**
 * Rename display / Change playlist (w28): one field, Save and Cancel. The server's refusal (a name already taken, a 403, a 422) is shown here, starting with a
 * capital, and the dialog stays open. A 403 for a playlist that names a focus asset, from a role that may not see the assets, says why instead of the generic
 * "Your role does not allow this." Built on `useDialogFocus` (focus on the field, Tab wraps, Escape cancels unless a save is running, focus back to the row
 * menu's button on close).
 */
export function DisplayFieldDialog({ display, field, playlists, onClose }: {
  display: DisplayRow;
  field: "name" | "playlist";
  playlists: readonly PlaylistRow[];
  onClose: () => void;
}) {
  const { can } = useAuth();
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
      try {
        await update.mutateAsync({ id: display.id, body: field === "name" ? { name: trimmed } : { playlist_id: playlist } });
      } catch (e) {
        const chosen = playlists.find((p) => p.id === playlist);
        throw focusRefusal(e, field === "playlist" && !can("assets.view") && namesFocus((chosen?.items ?? []).map((item) => item.focus_asset_id)));
      }
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
          <p className="error displays-error" role="alert">{error ? upperFirst(error) : null}</p>
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
