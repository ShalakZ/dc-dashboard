import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useCreateDisplay } from "../../api/queries";
import type { PlaylistRow } from "../../api/types";
import { useAction } from "../../hooks/useAction";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { copyText } from "../../lib/diagnostics";
import { Icon } from "../Icon";

/** The warning above the link: it is shown once, and it is the whole credential. */
export const LINK_WARNING = "Anyone who has this link can see these dashboards without signing in. It is shown only now: copy it before you close this window.";

/**
 * New display, in two steps (w28). Step 1 asks for the Name and the Playlist; the answer to creating it carries the link secret, which step 2 shows ONCE in a
 * read-only field with Copy link and Done. The secret lives in one `useState` of this dialog (`link`) and nowhere else: the create mutation is made with
 * `gcTime: 0` and is `reset()` the moment its answer is read and again when the dialog closes, so neither the mutation cache nor any query holds it, and
 * closing the dialog (which unmounts this state) drops it. Escape in step 2 does what Done does; nothing in this dialog ever sends the link anywhere.
 * Focus: the Name field on step 1, Copy link on step 2, back to the opener on close. The buttons that can hold the focus are not natively disabled.
 */
export function NewDisplayDialog({ playlists, onClose }: { playlists: readonly PlaylistRow[]; onClose: () => void }) {
  const create = useCreateDisplay();
  const { run, busy, error } = useAction();
  const root = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const nameId = useId();
  const playlistId = useId();
  const linkId = useId();
  const [name, setName] = useState("");
  const [playlist, setPlaylist] = useState<number>(playlists[0]?.id ?? 0);
  const [link, setLink] = useState<string | null>(null); // the secret, as the whole link: the only copy this page holds
  const [note, setNote] = useState(""); // the one live region: "Copied", or how to copy by hand

  const finish = () => {
    create.reset();
    setLink(null);
    onClose();
  };
  const cancel = () => {
    if (!busy) onClose();
  };
  useDialogFocus(root, link === null ? cancel : finish, { busy, initial: nameInput });

  // Step 2 replaces the form the focus was in: Copy link takes it.
  const second = link !== null;
  useEffect(() => {
    if (second) copyButton.current?.focus();
  }, [second]);

  const trimmed = name.trim();
  const blocked = busy || trimmed === "" || playlist === 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    void run(async () => {
      const made = await create.mutateAsync({ name: trimmed, playlist_id: playlist });
      setLink(`${window.location.origin}/display#${made.link_secret}`);
      create.reset(); // the answer is in the state above now; the mutation cache gives it up at once (gcTime 0)
    });
  };

  const copy = async () => {
    if (link === null) return;
    const done = await copyText(link, area.current);
    setNote(done ? "Copied" : "Press Ctrl+C to copy");
  };

  return createPortal(
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-label="New display" className="dialog displays-dialog">
        <h2>New display</h2>
        {link === null ? (
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor={nameId}>Name</label>
              <input id={nameId} ref={nameInput} value={name} maxLength={100} autoComplete="off" onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={playlistId}>Playlist</label>
              <select id={playlistId} value={playlist} onChange={(e) => setPlaylist(Number(e.target.value))}>
                {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <p className="error displays-error" role="alert">{error}</p>
            <div className="row">
              <button type="button" aria-disabled={busy ? true : undefined} onClick={cancel}>Cancel</button>
              <button type="submit" className="primary" aria-disabled={blocked ? true : undefined}>Create display</button>
            </div>
          </form>
        ) : (
          <>
            <div className="field">
              <label htmlFor={linkId}>Display link</label>
              <textarea id={linkId} ref={area} className="displays-link" readOnly rows={3} spellCheck={false} autoComplete="off" value={link} onFocus={(e) => e.currentTarget.select()} />
            </div>
            <div className="displays-copy-row">
              <button type="button" ref={copyButton} onClick={() => void copy()}>Copy link</button>
              <p className="muted displays-copied" role="status">{note}</p>
            </div>
            <p className="displays-warning"><Icon name="alert" /><span>{LINK_WARNING}</span></p>
            <div className="row">
              <button type="button" className="primary" onClick={finish}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
