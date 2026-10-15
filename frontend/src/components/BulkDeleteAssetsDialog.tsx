import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadImpacts, type RemoveItem } from "../api/assetsBulk";
import type { AssetImpact } from "../api/types";
import { deleteConfirmLabel, deleteMessage, deleteTitle, sumImpacts, type DeletePlan, type RemoveResult } from "../lib/assetsBulk";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

interface Props {
  /** What was picked, frozen when Delete was pressed: the live asset list loses the deleted assets before the request is over, and the title must not turn into "Delete 0 assets?". */
  plan: DeletePlan;
  /** Deletes the roots one after the other and refreshes what the screen shows (the hook's: the dialog knows neither the router nor the cache). It never rejects for a refused delete. */
  run: (items: RemoveItem[]) => Promise<RemoveResult>;
  /** A pick turned out to be gone already: the page refreshes the asset list so the vanished pick drops out of the picks. Called once. */
  onStale: () => void;
  /** At least one asset went (or every root was gone already): the page closes the dialog and says what happened. */
  onDone: (result: RemoveResult) => void;
  onCancel: () => void;
}

const BLOCKED = "Some of the picked assets were already deleted by someone else. The tree has been refreshed; pick again.";
const GREW = "More was added while this was open. The numbers above are updated; delete again to confirm.";

/**
 * The delete confirmation of the assets picked in the Assets Tree (the Delete in the pick bar). It opens at once, asks the server what each
 * top-level pick takes with it, and says it in one sentence: the names, the picks that sit inside another pick, what else goes (the existing
 * billing warning) and that it cannot be undone. One ConfirmDeleteDialog throughout, so the focus rules stay.
 *
 * The numbers are read once and kept: the query key is outside the `["assets"]` prefix, so the refresh the delete itself causes (and a window
 * that regains focus) never replaces what the person read. Each root is then deleted with the counts that were shown; one that grew meanwhile is
 * refused by the server, and when that happens before anything was deleted the dialog shows the new numbers and asks again.
 */
export function BulkDeleteAssetsDialog({ plan, run, onStale, onDone, onCancel }: Props) {
  const rootIds = useMemo(() => plan.roots.map((root) => root.id), [plan]);
  const preview = useQuery({
    queryKey: ["impact", "assets-bulk", ...rootIds],
    queryFn: () => loadImpacts(rootIds),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  // The newer counts from a refusal; they replace that root's preview for the rest of this dialog's life.
  const [newer, setNewer] = useState<ReadonlyMap<number, AssetImpact>>(new Map());
  const inFlight = useRef(false);

  // What each root takes with it. A root the server no longer knows (null) makes the whole thing stale: nothing can be confirmed.
  const impacts = useMemo(() => {
    if (!preview.data) return null;
    return plan.roots.map((root) => ({ root, impact: newer.get(root.id) ?? preview.data.get(root.id) ?? null }));
  }, [plan, preview.data, newer]);
  const vanished = impacts !== null && impacts.some((entry) => entry.impact === null);
  const sum = impacts !== null && !vanished ? sumImpacts(impacts.map((entry) => entry.impact as AssetImpact)) : null;

  // Once: the page refreshes the asset list, and the vanished pick drops out of the picks.
  const told = useRef(false);
  const latestStale = useRef(onStale);
  latestStale.current = onStale;
  useEffect(() => {
    if (!vanished || told.current) return;
    told.current = true;
    latestStale.current();
  }, [vanished]);

  const confirm = async () => {
    if (inFlight.current || impacts === null || vanished) return;
    inFlight.current = true;
    try {
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
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <ConfirmDeleteDialog
      title={deleteTitle(plan.picked.length)}
      message={vanished ? "" : deleteMessage(plan, sum)}
      confirmLabel={deleteConfirmLabel(plan, sum)}
      loading={preview.isPending}
      // The server's words alone ("Internal Server Error") say nothing about what failed.
      loadError={vanished ? BLOCKED : preview.isError ? `Could not check what this deletes: ${preview.error.message}` : undefined}
      blocked={vanished}
      onConfirm={confirm}
      onCancel={onCancel}
    />
  );
}
