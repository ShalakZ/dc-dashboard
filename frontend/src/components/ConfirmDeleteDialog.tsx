import { useEffect, useRef } from "react";
import { useAction } from "../hooks/useAction";

interface Props {
  title: string;
  message: string;
  /** Runs the confirmed request. If it rejects the dialog stays open and shows the error; the opener closes it on success. */
  onConfirm: () => Promise<unknown>;
  onCancel: () => void;
}

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Ask whether to go ahead with a delete that takes more than the one row. Focus conventions as in ReviewDialog. */
export function ConfirmDeleteDialog({ title, message, onConfirm, onCancel }: Props) {
  const { run, busy, error } = useAction();
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  // Focus moves into the dialog (onto the harmless button) and stays there; when it goes away, focus goes back to what had it.
  useEffect(() => {
    const root = dialog.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = () => root.querySelector<HTMLElement>(FOCUSABLE);
    (cancel.current ?? first())?.focus();
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
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div className="dialog-backdrop">
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={title} className="dialog confirm">
        <h2>{title}</h2>
        <p>{message}</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button ref={cancel} onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="danger" onClick={() => void run(onConfirm)} disabled={busy}>Delete anyway</button>
        </div>
      </div>
    </div>
  );
}
