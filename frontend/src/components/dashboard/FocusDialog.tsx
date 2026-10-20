import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAssets } from "../../api/queries";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { AssetPicker } from "./AssetPicker";
import { useFocus } from "./FocusContext";

/** The help beside the picker's label (w27). Made once, so the picker gets the same element on every render. */
const PICKER_TIP = "The cards that follow the focus show this asset. Whole site clears it.";

/**
 * "Choose a focus" (R8): the asset the dashboard's following widgets look at. The picker is only a DRAFT (the arrow keys of a radio group move its
 * check, and each move must not become a history entry): Show pushes the address once, Cancel and Escape leave everything as it was, and Whole site
 * picks "no focus" in the draft. The buttons are aria-disabled and not disabled, since one of them may hold the focus. Rendered into the body, like
 * the other dialogs that open from a page header; the asset list is the cache the focus provider and the quick find already fill.
 */
export function FocusDialog({ onClose }: { onClose: () => void }) {
  const { focus, setFocus } = useFocus();
  const list = useAssets(true);
  const root = useRef<HTMLDivElement>(null);
  const loading = useRef<HTMLParagraphElement>(null);
  const [draft, setDraft] = useState<number | null>(focus);
  // While the list loads, the focus starts on the Loading line (a screen reader reads it, and the dialog needs no live region for it).
  useDialogFocus(root, onClose, { initial: loading });
  const ready = list.data !== undefined;
  // That line goes away when the list lands, and the focus with it: the search box takes the focus then, unless the person has already moved on.
  useEffect(() => {
    const at = document.activeElement;
    if (ready && (at === null || at === document.body)) root.current?.querySelector<HTMLElement>('input[type="search"]')?.focus();
  }, [ready]);
  const selected = useMemo(() => (draft === null ? [] : [draft]), [draft]);
  const wholeSite = draft === null;

  const show = () => {
    setFocus(draft);
    onClose();
  };

  return createPortal(
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-label="Choose a focus" className="dialog narrow focus-dialog">
        <h2>Choose a focus</h2>
        <div className="focus-body">
          {list.data ? (
            // Mounted only once the list is here: the picker opens the branches above its first pick when it is made, and a list that grows later would miss them.
            <AssetPicker label="Focus asset" tip={PICKER_TIP} assets={list.data} selected={selected} single max={1} onChange={(ids) => setDraft(ids[0] ?? null)} />
          ) : list.error ? (
            <p className="error" role="alert">Could not load the assets: {list.error.message}</p>
          ) : (
            <p ref={loading} tabIndex={-1} className="muted focus-loading">Loading assets…</p>
          )}
          <div className="row">
            <button type="button" className="quiet focus-whole" aria-disabled={wholeSite ? true : undefined} onClick={() => { if (!wholeSite) setDraft(null); }}>
              Whole site
            </button>
          </div>
        </div>
        <div className="row">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" onClick={show}>Show</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
