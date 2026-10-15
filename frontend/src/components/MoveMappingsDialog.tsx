import { useId, useMemo, useState } from "react";
import type { Asset, AssetKind, Metric } from "../api/types";
import { assetChoices } from "../lib/drop";
import { containerNote, moveConflictText, moveMessage, moveTitle } from "../lib/mappingActions";
import { assetLabels } from "./dashboard/AssetPicker";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

/** A mapping to move: what a sentence calls it, its metric (for a clash on the target) and the asset it is on now. */
export interface MoveRow { id: number; name: string; metric: Metric; assetId: number }

interface Props {
  assets: readonly Pick<Asset, "id" | "parent_id" | "name" | "kind">[];
  /** The kinds registry, for the note about a place (a room, a hall) that equipment does not usually belong to. */
  kinds?: readonly Pick<AssetKind, "name" | "icon">[];
  rows: readonly MoveRow[];
  /** What the title calls the rows when it is not their count or their one name: `the group "LVP01"`. */
  what?: string;
  /** The metrics an asset has now (Discovery knows them; the asset page does not and relies on the server's 409). */
  takenFor?: (assetId: number) => ReadonlySet<Metric>;
  /** Runs the move. The opener closes the dialog and reports the outcome in toasts, so a request error never shows in here. */
  onConfirm: (assetId: number) => void | Promise<void>;
  onCancel: () => void;
}

const NONE: ReadonlySet<Metric> = new Set();
const indent = (depth: number) => "  ".repeat(depth); // as ReviewDialog does; a browser collapses the leading spaces of an option, the label (parent path) is what tells equal names apart

/**
 * Move mappings to another asset: a confirmation (ConfirmDeleteDialog: Cancel has the focus, Escape closes, Tab wraps) with an asset select.
 * Move stays off until an asset is chosen and while the choice would put a metric on it twice (the sentence says which). A place that holds
 * equipment, such as a room, gets a note that never blocks. Both live in one reserved two-line slot, so nothing moves when they appear.
 */
export function MoveMappingsDialog({ assets, kinds, rows, what, takenFor, onConfirm, onCancel }: Props) {
  const selectId = useId();
  const noteId = useId();
  const [target, setTarget] = useState<number | null>(null);
  const choices = useMemo(() => {
    const shared = new Set(rows.map((r) => r.assetId));
    // All rows on one asset: moving them there is no move, so it is not offered.
    return assetChoices(assets).filter((a) => !(shared.size === 1 && shared.has(a.id)));
  }, [assets, rows]);
  const labels = useMemo(() => assetLabels(assets.map((a) => ({ ...a, sort_order: 0 }))), [assets]);

  const asset = target === null ? undefined : assets.find((a) => a.id === target);
  // A row that is on the target already does not move, so it is not checked against the target; its metric still counts as taken.
  const moving = target === null ? [] : rows.filter((r) => r.assetId !== target);
  const clash = target === null || asset === undefined ? null : moveConflictText(moving, takenFor?.(target) ?? NONE, labels.get(asset.id) ?? asset.name);
  const note = clash === null && asset ? containerNote({ name: labels.get(asset.id) ?? asset.name, kind: asset.kind }, kinds, "Move") : null;

  return (
    <ConfirmDeleteDialog
      title={moveTitle(rows.length, rows[0]?.name ?? "", what)}
      message={moveMessage(rows.length)}
      confirmLabel="Move"
      tone="primary"
      confirmDisabled={target === null || clash !== null}
      onConfirm={async () => { if (target !== null) await onConfirm(target); }}
      onCancel={onCancel}
    >
      <div className="field">
        <label htmlFor={selectId}>Move to</label>
        <select
          id={selectId}
          value={target ?? ""}
          aria-describedby={note ? noteId : undefined}
          onChange={(event) => setTarget(event.target.value === "" ? null : Number(event.target.value))}
        >
          <option value="">(choose)</option>
          {choices.map((a) => <option key={a.id} value={a.id}>{indent(a.depth) + (labels.get(a.id) ?? a.name)}</option>)}
        </select>
      </div>
      {/* Always there, two lines tall: a clash or a note arriving moves nothing. The clash is an alert (it is why Move is off); the note is only
          the select's description, so a screen reader reads it when it reaches the select and the page has no second announcer. */}
      <div className="mapmove-slot">
        {clash !== null ? <p className="error" role="alert">{clash}</p> : note !== null && <p id={noteId} className="muted">{note}</p>}
      </div>
    </ConfirmDeleteDialog>
  );
}
