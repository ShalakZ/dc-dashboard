import { useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "../../hooks/useDialogFocus";

/**
 * "Discard your changes?" (w28), asked when the playlist editor is closed with edits that were not saved. Built like the dashboard editor's LeaveDialog on
 * `useDialogFocus`: the focus starts on Keep editing (the harmless button), Escape means Keep editing, and Tab wraps. It sits above the editor, which stops
 * answering Escape and Tab while this question is the top-most dialog.
 */
export function DiscardDialog({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  useDialogFocus(root, onKeep, { initial: keep });
  return createPortal(
    <div className="dialog-backdrop">
      <div ref={root} role="alertdialog" aria-modal="true" aria-label="Discard your changes?" className="dialog narrow">
        <h2>Discard your changes?</h2>
        <p>This playlist has changes that are not saved. If you close it now they are lost.</p>
        <div className="row">
          <button type="button" ref={keep} onClick={onKeep}>Keep editing</button>
          <button type="button" className="danger" onClick={onDiscard}>Discard</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
