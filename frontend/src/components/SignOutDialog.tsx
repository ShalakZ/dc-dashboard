import { useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { useAction } from "../hooks/useAction";
import { useDialogFocus } from "../hooks/useDialogFocus";

const TITLE = "Sign out of DC Dashboard?";

/**
 * Asks before ending the session. Cancel is where the focus starts, and Cancel and Escape both leave the session alone.
 * If the request fails the message shows here and the dialog stays; the opener closes it on Cancel, and a success leaves the page.
 * Rendered into the body, out of the top bar: its stacking context would cap this dialog's z-index at the bar's, and the bar is a banner landmark.
 */
export function SignOutDialog({ onCancel }: { onCancel: () => void }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { run, busy, error } = useAction();
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useDialogFocus(dialog, onCancel, { busy, initial: cancel });

  return createPortal(
    <div className="dialog-backdrop">
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={TITLE} className="dialog confirm">
        <h2>{TITLE}</h2>
        <p>You will need to sign in again.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button type="button" ref={cancel} onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="primary" onClick={() => void run(() => logout().then(() => navigate("/login")))} disabled={busy}>Sign out</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
