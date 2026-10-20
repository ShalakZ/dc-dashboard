import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAssets } from "../../api/queries";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { AssetPicker } from "../dashboard/AssetPicker";

const PICKER_TIP = "Cards that follow the focus show this asset on the screen. Whole site clears it.";

/**
 * "Focus for ..." (w28): the asset one playlist item's following widgets look at. A nested dialog above the playlist editor, built like the dashboard's
 * FocusDialog (same classes, same picker in its single mode): the choice is a DRAFT, Choose hands it back and Cancel and Escape leave everything as it was.
 * Built on `useDialogFocus`, whose stack makes Escape and Tab belong to this dialog alone while it is open. `current` that the asset list no longer holds
 * (a deleted asset) is not offered as picked.
 */
export function FocusPickDialog({ title, current, onChoose, onClose }: {
  title: string;
  current: number | null;
  onChoose: (assetId: number | null, name: string | null) => void;
  onClose: () => void;
}) {
  const list = useAssets(true);
  const root = useRef<HTMLDivElement>(null);
  const loading = useRef<HTMLParagraphElement>(null);
  const known = list.data?.some((a) => a.id === current) ?? false;
  const [draft, setDraft] = useState<number | null>(current);
  useDialogFocus(root, onClose, { initial: loading });
  // The Loading line is where the focus starts; the search box takes it once the list is here, unless the person has moved on.
  const ready = list.data !== undefined;
  useEffect(() => {
    const at = document.activeElement;
    if (ready && (at === null || at === document.body)) root.current?.querySelector<HTMLElement>('input[type="search"]')?.focus();
  }, [ready]);
  const selected = useMemo(() => (draft !== null && (draft !== current || known) ? [draft] : []), [draft, current, known]);
  const wholeSite = draft === null;

  const choose = () => {
    const name = draft === null ? null : list.data?.find((a) => a.id === draft)?.name ?? null;
    onChoose(draft, name);
    onClose();
  };

  return createPortal(
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-label={title} className="dialog narrow focus-dialog">
        <h2>{title}</h2>
        <div className="focus-body">
          {list.data ? (
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
          <button type="button" className="primary" onClick={choose}>Choose</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
