import { useEffect, useId, useRef, useState } from "react";
import { useBulkDeleteAssetKinds, type BulkDeleteResult } from "../api/queries";
import type { AssetKind } from "../api/types";
import { kindKey } from "../lib/kinds";
import { blockedMessage, deleteTitle, firstReason, removedIds, unusedMessage, usedMessage } from "../lib/kindsBulk";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

// Code-point comparison, as lib/kinds.ts: deterministic across runtimes.
const compare = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

interface Props {
  /** The kinds being deleted, looked up in the live list by the page: after a refused request their counts are the new ones, and the message follows. */
  rows: readonly AssetKind[];
  /** Every kind there is (the live list): the select offers the ones that are not in `rows`. */
  all: readonly AssetKind[];
  /** The request is over and at least one kind is gone (or the loop stopped after some were): the page closes the dialog and says what happened. */
  onDone: (result: BulkDeleteResult) => void;
  onCancel: () => void;
}

/**
 * The delete confirmation of several kinds at once (the Delete in the bar of the Asset kinds page). None in use: the names, and Delete. Some in
 * use: where do their assets go (one labelled select of the kinds that are NOT being deleted, empty to start with; Delete waits for a choice);
 * every kind picked and some in use: blocked, with the reason. One ConfirmDeleteDialog throughout, so a refusal only changes its props and the
 * focus rules stay. The single-kind dialog on the page is another component with the same rules.
 *
 * It runs the deletions itself (`useBulkDeleteAssetKinds`): when ANY kind went (or was already gone) it hands the result to the page and does
 * not close; when none did, it throws the first reason, so the dialog stays and says it. WHILE they run it shows the kinds as they were at the
 * press: the hook waits for the refetch, so the live list loses the deleted kinds before the request is over, and the title must not turn into
 * "Delete 0 kinds?" under the person's eyes.
 */
export function BulkDeleteKindsDialog({ rows, all, onDone, onCancel }: Props) {
  const bulk = useBulkDeleteAssetKinds();
  const pickerId = useId();
  // Where the assets go: the id the person chose. Only a kind still in the list counts, so one that vanished from a refreshed list is no choice any more.
  const [target, setTarget] = useState<number | null>(null);
  // The kinds as they were when Delete was pressed, for as long as the request runs. Cleared when it failed (the live list is then the truth again);
  // kept when it succeeded, because the page unmounts the dialog on onDone and a render in between must not show an empty selection.
  const [frozen, setFrozen] = useState<{ rows: readonly AssetKind[]; all: readonly AssetKind[] } | null>(null);
  const finished = useRef(false);

  const shownRows = frozen?.rows ?? rows;
  const shownAll = frozen?.all ?? all;
  const picked = new Set(shownRows.map((row) => row.id));
  const others = shownAll.filter((k) => !picked.has(k.id)).sort((a, b) => compare(kindKey(a.name), kindKey(b.name)));
  const chosen = others.find((k) => k.id === target) ?? null;
  const used = shownRows.filter((row) => row.asset_count > 0);
  const assets = used.reduce((sum, row) => sum + row.asset_count, 0);
  const total = shownRows.length;
  const blocked = used.length > 0 && others.length === 0;
  const name = shownRows[0]?.name ?? "";

  // The kinds were deleted somewhere else, all of them: nothing is left to ask about.
  useEffect(() => {
    if (frozen === null && rows.length === 0 && !finished.current) onCancel();
  }, [frozen, rows.length, onCancel]);

  const confirm = async () => {
    if (used.length > 0 && chosen === null) return; // Delete is off until a kind is chosen
    setFrozen({ rows, all });
    let result: BulkDeleteResult;
    try {
      result = await bulk.mutateAsync({
        items: rows.map((row) => ({ id: row.id, name: row.name, assetCount: row.asset_count })),
        moveTo: chosen ? { id: chosen.id, name: chosen.name } : null,
      });
    } catch (e) {
      setFrozen(null);
      throw e;
    }
    if (removedIds(result).length === 0) {
      setFrozen(null);
      throw new Error(firstReason(result)); // shown in the dialog; the list has been refetched, so the counts in the message are the new ones
    }
    finished.current = true;
    onDone(result);
  };

  return (
    <ConfirmDeleteDialog
      title={deleteTitle(total)}
      message={blocked ? "" : used.length > 0 ? usedMessage({ total, used: used.length, assets, name }) : unusedMessage(shownRows.map((row) => row.name))}
      loadError={blocked ? blockedMessage({ total, assets, name }) : undefined}
      blocked={blocked}
      confirmLabel="Delete"
      confirmDisabled={used.length > 0 && chosen === null}
      onConfirm={confirm}
      onCancel={onCancel}
    >
      {used.length > 0 && !blocked && (
        <label htmlFor={pickerId}>Move the assets to
          <select id={pickerId} value={chosen?.id ?? ""} onChange={(e) => setTarget(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">Choose a kind…</option>
            {others.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </label>
      )}
    </ConfirmDeleteDialog>
  );
}
