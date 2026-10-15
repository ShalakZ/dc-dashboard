import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadAssetList, loadImpacts, type RemoveItem } from "../api/assetsBulk";
import type { AssetImpact } from "../api/types";
import { deleteConfirmLabel, deleteMessage, deleteTitle, sumImpacts, treeDrift, type DeletePlan, type RemoveResult } from "../lib/assetsBulk";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

interface Props {
  /** What was picked, frozen when Delete was pressed: the live asset list loses the deleted assets before the request is over, and the title must not turn into "Delete 0 assets?". */
  plan: DeletePlan;
  /** Deletes the roots one after the other and refreshes what the screen shows (the hook's: the dialog knows neither the router nor the cache). It never rejects for a refused delete. */
  run: (items: RemoveItem[]) => Promise<RemoveResult>;
  /** The picture was wrong (a pick is gone already, or the tree changed since the list was cached): the page refreshes the asset list so the picks follow it. Called once. */
  onStale: () => void;
  /** At least one asset went (or every root was gone already): the page closes the dialog and says what happened. */
  onDone: (result: RemoveResult) => void;
  onCancel: () => void;
}

const BLOCKED = "Some of the picked assets were already deleted by someone else. The tree has been refreshed; pick again.";
const GREW = "More was added while this was open. The numbers above are updated; delete again to confirm.";
const CHANGED = "The tree changed while you were picking. It has been refreshed; pick again.";

/**
 * The delete confirmation of the assets picked in the Assets Tree (the Delete in the pick bar). It opens at once, asks the server what each
 * top-level pick takes with it, and says it in one sentence: the names, the picks that sit inside another pick, what else goes (the existing
 * billing warning) and that it cannot be undone. One ConfirmDeleteDialog throughout, so the focus rules stay.
 *
 * The plan was made from the page's cached asset list, which may be minutes old, and the numbers come from the server. So the same load also
 * reads the asset list fresh and checks the two against each other (`treeDrift`): if a pick is gone, moved, or the server counts another
 * number of assets under a root than the fresh list shows, the sentence "these are the assets that go" would be false, and the dialog is
 * blocked (only Close) while the page refreshes its list. A root the server no longer has keeps its own sentence and goes first.
 *
 * The numbers are read once and kept: the query key is outside the `["assets"]` prefix, so the refresh the delete itself causes (and a window
 * that regains focus) never replaces what the person read. Each root is then deleted with the counts that were shown; one that grew meanwhile is
 * refused by the server, and when that happens before anything was deleted the dialog shows the new numbers and asks again.
 */
export function BulkDeleteAssetsDialog({ plan, run, onStale, onDone, onCancel }: Props) {
  const rootIds = useMemo(() => plan.roots.map((root) => root.id), [plan]);
  const preview = useQuery({
    queryKey: ["impact", "assets-bulk", ...rootIds],
    // The comparison is made here, on what this load read, and kept with it: the newer counts of a later refusal never take part in it.
    queryFn: async () => {
      const [impacts, fresh] = await Promise.all([loadImpacts(rootIds), loadAssetList()]);
      return { impacts, drift: treeDrift(plan, fresh, impacts) };
    },
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  // The newer counts from a refusal; they replace that root's preview for the rest of this dialog's life.
  const [newer, setNewer] = useState<ReadonlyMap<number, AssetImpact>>(new Map());
  // The press that is running: a second press (a double click in one tick) gets the same promise back, so the dialog's busy state ends when the
  // work does and not at once (Cancel and Escape would come back while the roots are still being deleted).
  const inFlight = useRef<Promise<void> | null>(null);

  // What each root takes with it. A root the server no longer knows (null) makes the whole thing stale: nothing can be confirmed.
  const impacts = useMemo(() => {
    if (!preview.data) return null;
    return plan.roots.map((root) => ({ root, impact: newer.get(root.id) ?? preview.data.impacts.get(root.id) ?? null }));
  }, [plan, preview.data, newer]);
  const vanished = impacts !== null && impacts.some((entry) => entry.impact === null);
  const changed = !vanished && preview.data?.drift != null;
  const blocked = vanished || changed;
  const sum = impacts !== null && !blocked ? sumImpacts(impacts.map((entry) => entry.impact as AssetImpact)) : null;

  // Once: the page refreshes the asset list, and the vanished or moved picks drop out of the picks.
  const told = useRef(false);
  const latestStale = useRef(onStale);
  latestStale.current = onStale;
  useEffect(() => {
    if (!blocked || told.current) return;
    told.current = true;
    latestStale.current();
  }, [blocked]);

  const confirm = (): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    if (impacts === null || blocked) return Promise.resolve();
    const job = (async () => {
      const result = await run(impacts.map(({ root, impact }) => ({ id: root.id, name: root.name, seen: impact as AssetImpact })));
      const { deleted, failed } = result;
      if (deleted.length === 0 && failed) {
        // Nothing was deleted by this press, so there is nothing to report: the dialog stays and says why.
        if (failed.now) {
          setNewer((before) => new Map(before).set(failed.id, failed.now as AssetImpact));
          throw new Error(GREW);
        }
        throw new Error(`"${failed.name}" could not be deleted: ${failed.reason}`);
      }
      onDone(result);
    })().finally(() => { inFlight.current = null; }); // a callback of a promise always runs after this line has stored it
    inFlight.current = job;
    return job;
  };

  return (
    <ConfirmDeleteDialog
      title={deleteTitle(plan.picked.length)}
      message={blocked ? "" : deleteMessage(plan, sum)}
      confirmLabel={deleteConfirmLabel(plan, sum)}
      loading={preview.isPending}
      // The server's words alone ("Internal Server Error") say nothing about what failed.
      loadError={vanished ? BLOCKED : changed ? CHANGED : preview.isError ? `Could not check what this deletes: ${preview.error.message}` : undefined}
      blocked={blocked}
      onConfirm={confirm}
      onCancel={onCancel}
    />
  );
}
