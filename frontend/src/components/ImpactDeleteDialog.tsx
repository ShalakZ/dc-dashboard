import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

interface Props<I> {
  title: string;
  /** Names the preview in the query cache: one per thing being deleted (["impact", "asset", 5]). */
  queryKey: readonly unknown[];
  /** The read-only question to the server: what does this delete take with it? */
  load: () => Promise<I>;
  /** The sentence for a delete that takes more than the row itself (assetLoss, sourceLoss). */
  loss: (impact: I) => string;
  /** Only the row itself goes. */
  isPlain: (impact: I) => boolean;
  /** What a plain delete says (everything that is lost is the row itself). */
  plainMessage: string;
  /** The counts in the server's refusal "more than you were shown would go now" (assetImpact, sourceImpact), otherwise null. */
  grown: (error: unknown) => I | null;
  /** Sends the confirmed request with the counts that were shown. A rejection stays in the dialog; the opener closes it on success. */
  onConfirm: (seen: I) => Promise<unknown>;
  onCancel: () => void;
}

/**
 * The delete confirmation for things that own other things (assets, sources). It opens at once and asks the server what the delete takes
 * with it; nothing can be confirmed before the answer is in, or when it could not be had. The confirmed request carries the counts the
 * person read, so a child added meanwhile is refused by the server instead of deleted unseen, and the dialog then shows the new numbers.
 */
export function ImpactDeleteDialog<I extends object>({ title, queryKey, load, loss, isPlain, plainMessage, grown, onConfirm, onCancel }: Props<I>) {
  // Fresh at every open and kept to itself: no cache between two openings, no retry (a failure is shown), and no refetch under the
  // person's eyes when the window regains focus (the numbers they read are the ones the delete is checked against).
  const preview = useQuery({ queryKey, queryFn: load, gcTime: 0, staleTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  // The newer counts from a refusal; they replace the preview for the rest of this dialog's life.
  const [refused, setRefused] = useState<I | null>(null);
  const seen = refused ?? preview.data ?? null;

  const confirm = async () => {
    if (seen === null) return;
    try {
      await onConfirm(seen);
    } catch (error) {
      const now = grown(error);
      if (now === null) throw error;
      setRefused(now);
      throw new Error("More was added while this was open. The numbers above are updated; delete again to confirm.");
    }
  };

  const plain = seen !== null && isPlain(seen);
  return (
    <ConfirmDeleteDialog
      title={title}
      message={seen === null ? "" : plain ? plainMessage : loss(seen)}
      // "Anyway" is for a delete that takes more than the row; until that is known (or if it never is) the button reads plain Delete, so it does not
      // change width, and does not alarm on a leaf, when the answer arrives.
      confirmLabel={seen === null || plain ? "Delete" : "Delete anyway"}
      loading={preview.isPending}
      // The server's words alone ("Internal Server Error", "asset not found") say nothing about what failed.
      loadError={preview.isError ? `Could not check what this deletes: ${preview.error.message}` : undefined}
      onConfirm={confirm}
      onCancel={onCancel}
    />
  );
}
