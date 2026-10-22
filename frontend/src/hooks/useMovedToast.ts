import { useInvalidate } from "../api/queries";
import type { SourceMoveDone } from "../api/types";
import { useToast, type ToastApi, type ToastOptions } from "../components/Toasts";
import { UNDO_MS } from "../lib/mappingActions";
import { MOVE_REFRESHED, movedSentence, undoMove, undoMoveSentence, undoRefusal } from "../lib/moves";

type Invalidate = ReturnType<typeof useInvalidate>;

/**
 * The Undo of the toast. Module level on purpose, as the tag list's: it runs up to 10 seconds after the dialog (and maybe the page) has gone, so it holds the toast
 * api, the refresh function and the ids, never component state. The server decides whether it still can (24 hours, nothing changed since): its refusals
 * ("already undone", "changed since ...", "older than 24 hours") are shown as they are. The lists are read again after a refusal too.
 */
async function undoFromToast(auditId: number, toast: ToastApi, invalidate: Invalidate): Promise<void> {
  try {
    toast.success(undoMoveSentence(await undoMove(auditId)));
  } catch (error) {
    toast.error(undoRefusal(error));
  } finally {
    try { await invalidate(...MOVE_REFRESHED); } catch { /* the lists fetch themselves again on their next visit */ }
  }
}

/**
 * The toast leaves with its Undo button, and a focus that was on the button would fall to the body. It goes to the source's row menu button, as long as the page
 * still shows the row (the Sources page's `tr[data-source]`), else to the page's heading. Only a focus that is on the toast moves: a person who has gone elsewhere
 * in the 10 seconds keeps their place. Run while the button still has the focus, before the toast fades.
 */
function keepFocusAfterUndo(sourceId: number): void {
  const at = document.activeElement;
  if (!(at instanceof HTMLElement) || at.closest(".toast") === null) return;
  const target = document.querySelector<HTMLElement>(`tr[data-source="${sourceId}"] .row-menu-btn`) ?? document.querySelector<HTMLElement>("h1");
  target?.focus({ preventScroll: true });
}

function undoOptions(done: SourceMoveDone, toast: ToastApi, invalidate: Invalidate): ToastOptions {
  return {
    durationMs: UNDO_MS,
    // No Ctrl+Z here: that shortcut belongs to the mapping Undo of the pages that mount useMappingActions, and a second listener could race it.
    action: { label: "Undo", title: "Undo this move", onAction: () => { keepFocusAfterUndo(done.source.id); void undoFromToast(done.audit_id, toast, invalidate); } },
  };
}

/**
 * w33: what to call when a move has finished (from the Sources page and from Discovery): one toast, `Moved "..." to 172.20.0.5:4840. 12 mappings kept.`, with an
 * **Undo** for 10 seconds (`UNDO_MS`) that calls `POST /api/sources/moves/{audit_id}/undo`. `mappings` is what the dialog's preview showed; leave it out when unknown.
 */
export function useMovedToast(): (done: SourceMoveDone, mappings?: number | null) => void {
  const toast = useToast();
  const invalidate = useInvalidate();
  return (done, mappings) => toast.success(movedSentence(done, mappings), undoOptions(done, toast, invalidate));
}
