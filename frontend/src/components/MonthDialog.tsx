import { useId, useRef, useState, type FormEvent } from "react";
import { Modal, useModalBusy } from "./Modal";

/** What the server counts: characters (code points) after the blanks at both ends are cut off, as KindForm counts a name. */
const noteLength = (note: string) => [...note.trim()].length;

/**
 * The frame the Close month and Reopen month dialogs share: a sentence or two, one note field with a live count, a line for the server's
 * refusal, and Cancel with the confirming button. `minNote` is how many characters the note needs (0 = optional).
 * `onConfirm` gets the trimmed note and rejects to keep the dialog open with its message; the caller closes the dialog when it resolves.
 *
 * The confirming button and Cancel wait with `aria-disabled` and a guard, never native `disabled`: the button has the focus, and a disabled
 * one drops it to the page behind (a 409 would leave the person nowhere). The guard is a ref, because state arrives a render after the
 * first click and a double click would send two requests. The count and the error line have fixed rooms, so nothing moves while typing.
 * The field has no `maxLength`: the browser would count UTF-16 units of the untrimmed text, the server counts trimmed characters. A note over `maxNote`
 * is typed and pasted in full, the count reads e.g. 501/500 in the error colour, and the confirming button waits.
 * `extra` is a second paragraph under the intro (null or missing: none); the caller fixes it before the dialog opens, so nothing moves under the person.
 */
export function MonthDialog({ title, intro, extra, noteLabel, minNote, maxNote = 500, confirmLabel, onConfirm, onCancel }: {
  title: string;
  intro: string;
  extra?: string | null;
  noteLabel: string;
  minNote: number;
  maxNote?: number;
  confirmLabel: string;
  onConfirm: (note: string) => Promise<void>;
  onCancel: () => void;
}) {
  const noteId = useId();
  const countId = useId();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  useModalBusy(pending); // Escape must not close the dialog on a request that is still running

  const length = noteLength(note);
  const tooLong = length > maxNote;
  const ready = length >= minNote && !tooLong;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !ready) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await onConfirm(note.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  const cancel = () => { if (!inFlight.current) onCancel(); };

  return (
    <Modal title={title} onClose={cancel}>
      <form className="month-dialog" onSubmit={submit} noValidate>
        <p>{intro}</p>
        {extra && <p className="month-extra">{extra}</p>}
        <div className="field">
          <label htmlFor={noteId}>{noteLabel}</label>
          <textarea
            id={noteId} rows={3} value={note} aria-required={minNote > 0 || undefined} aria-invalid={tooLong || undefined} aria-describedby={countId}
            onChange={(e) => setNote(e.target.value)}
          />
          <div id={countId} className={tooLong ? "month-count month-over" : "muted month-count"}>{length}/{length < minNote ? minNote : maxNote}</div>
        </div>
        <div className="month-slot">{error && <p className="error" role="alert">{error}</p>}</div>
        <div className="row">
          <button type="button" className="month-cancel" aria-disabled={pending || undefined} onClick={cancel}>Cancel</button>
          <button type="submit" className="primary month-go" aria-disabled={pending || !ready || undefined} aria-describedby={countId}>{confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
