import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAction } from "../hooks/useAction";

interface Props {
  title: string;
  message: string;
  /** Runs the confirmed request. If it rejects the dialog stays open and shows the error; the opener closes it on success. */
  onConfirm: () => Promise<unknown>;
  onCancel: () => void;
  /** Text of the confirming button. */
  confirmLabel?: string;
  /** The server is still being asked what this takes with it: "Checking what this deletes…" replaces the message and the confirm button is off. */
  loading?: boolean;
  /** The question could not be answered: shown as an error line, and the confirm button stays off (only Cancel is usable). */
  loadError?: string;
  /** Red for a delete (default); `primary` for a confirmation that destroys nothing, such as relabelling the currency. */
  tone?: "danger" | "primary";
  /** The delete can never go ahead from here (something still depends on it): no confirm button at all, and Cancel reads "Close". The message and `loadError` stay to say why. */
  blocked?: boolean;
  /**
   * A choice the confirmation needs (where the assets of a deleted kind go): drawn between the message and the buttons, OUTSIDE the polite
   * region (that region is the dialog's description, and a select inside it would be announced again with every change).
   */
  children?: ReactNode;
  /** The confirm button is off until the choice in `children` is made. Native `disabled` is fine: the first focus is Cancel, and the one case where the focus was on the confirm button is handled below. */
  confirmDisabled?: boolean;
}

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The one styled confirmation every delete goes through (the browser's own box is gone everywhere). Focus conventions as in ReviewDialog.
 * Rendered into the body, like SignOutDialog, so a caller may keep it inside a form or a table row: the backdrop would be invalid markup in a
 * row, and the buttons (plain `type="button"`) would otherwise submit the form they sit in.
 */
export function ConfirmDeleteDialog({ title, message, onConfirm, onCancel, confirmLabel = "Delete anyway", loading = false, loadError, tone = "danger", blocked = false, children, confirmDisabled = false }: Props) {
  const { run, busy, error } = useAction();
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
  // What had focus when the dialog was asked for, read while rendering: by the time an effect runs, the opener may already be disabled (a page
  // locks its controls while a dialog is open) and the browser has then moved the focus to the body, so there would be nothing to go back to.
  const [previous] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  // Focus moves into the dialog (onto the harmless button) and stays there; when it goes away, focus goes back to what had it.
  useEffect(() => {
    const root = dialog.current;
    if (!root) return;
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
  }, [previous]);
  // A dialog that turns blocked while open (the server refused the confirmed request) loses the button the focus was on: Close takes it, once the
  // request is over (Close is off while it runs).
  useEffect(() => {
    if (blocked && !busy) cancel.current?.focus();
  }, [blocked, busy]);
  // A dialog that turns into one that needs a choice while open (the server said "assets joined" to a confirmed delete) loses the confirm button the
  // focus was on (it was off while the request ran, and is off again until the choice is made): once the request is over, the first control, the
  // choice, takes it. Nothing happens while the focus is still on an enabled control inside, such as the choice somebody is using.
  useEffect(() => {
    if (!confirmDisabled || busy) return;
    const root = dialog.current;
    const at = document.activeElement;
    const lost = !(at instanceof Node) || !root?.contains(at) || (at instanceof HTMLElement && at.matches(":disabled"));
    if (lost) root?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [confirmDisabled, busy]);
  // Tab and Shift+Tab wrap round inside the dialog, as in Modal. The dialog is the last thing in the body, so without this the browser would
  // take the focus on to its own chrome (and back in on the next Tab); keepFocus stays as the backstop for a click or a script. The controls
  // are read at each keypress, so a disabled confirm button is skipped and one that comes alive counts as the last.
  useEffect(() => {
    const root = dialog.current;
    if (!root) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (controls.length === 0) { // both buttons are off while the request runs: there is nowhere to go, and the page behind is not an option
        event.preventDefault();
        return;
      }
      const [firstControl, lastControl] = [controls[0], controls[controls.length - 1]];
      const at = document.activeElement;
      const outside = !(at instanceof Node) || !root.contains(at); // a button that was disabled under the focus left it on the body
      if (event.shiftKey ? at === firstControl || outside : at === lastControl || outside) {
        event.preventDefault();
        (event.shiftKey ? lastControl : firstControl).focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // Escape is Cancel, except while the request is in flight.
  useEffect(() => {
    if (busy) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return createPortal(
    <div className="dialog-backdrop">
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={title} aria-describedby={bodyId} className="dialog confirm">
        <h2>{title}</h2>
        {/* One polite region for the checking line and the sentence that replaces it, so the sentence is announced when it arrives (no role: a status here would join every status lookup on the page). */}
        <div id={bodyId} aria-live="polite" className="confirm-body">
          {loading ? <p className="confirm-checking">Checking what this deletes…</p> : message !== "" && <p>{message}</p>}
        </div>
        {children}
        {loadError && <p className="error" role="alert">{loadError}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button type="button" ref={cancel} onClick={onCancel} disabled={busy}>{blocked ? "Close" : "Cancel"}</button>
          {!blocked && <button type="button" className={tone} onClick={() => void run(onConfirm)} disabled={busy || loading || !!loadError || confirmDisabled}>{confirmLabel}</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
