import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ApiError } from "../api/client";
import { keys, loadMovePreview, useInvalidate, useMoveAssets } from "../api/queries";
import type { Asset, MovePreview, MoveResult } from "../api/types";
import type { AssetTreeMove } from "../components/AssetTree";
import { MoveDialog, moveFailure, nothingChanges } from "../components/MoveDialog";
import { useToast } from "../components/Toasts";
import { movedToast, rateText, rateWarning } from "../lib/moveText";
import { buildTree } from "../lib/tree";
import { indexTree, moveGroup, toRoots, type DropTarget } from "../lib/treeMove";
import { useConfirm } from "./useConfirm";

/** How long the Undo toast stays (the toast's own hover and focus hold apply). */
const UNDO_MS = 8000;
const ALREADY = "Already there";
const STALE_DRAG = "The tree changed; try again";
const STALE_UNDO = "Something moved since; the move could not be undone";
const UNDO_TITLE = "Undo (Ctrl+Z)";

/**
 * The latest move that can still be undone, for both routes to it: the toast's Undo button and Ctrl+Z on a row. `used` is shared by the two, so
 * whichever comes second does nothing (the toast of an undone move may still be on screen). `until` is when the toast's own 8 seconds are up.
 */
interface UndoEntry { result: MoveResult; until: number; used: boolean }

/** The tree is on screen (not folded away to its strip): a move's own focus handling takes care of the focus there. */
const treeOnScreen = () => Array.from(document.querySelectorAll("ul.tree")).some((tree) => !tree.closest("[hidden]"));

/** Where the focus goes once a dialog or a failed drag has left: an element (the opener), or the link of an asset row. */
interface Refocus {
  el?: HTMLElement | null;
  rowId?: number;
  /** Take the focus even from an element that has it (an Undo button that is about to go away). */
  force?: boolean;
}

/**
 * Moving assets in the Assets Tree, for the page that owns the tree (W7p). `move` is what the tree is given (undefined without assets.edit:
 * no picking, no dragging); `dialogs` goes anywhere in the page's markup; `busy` is true while a preview, a confirmation, a move or the
 * Move to... dialog is open, and the page counts it into its `locked` so that no Add or Edit dialog opens beside it. `locked` is the page's
 * own lock (a delete confirmation, a list still loading): nothing starts while it holds.
 *
 * A drag: preview -> (the rate warning, if a rate changes) -> move -> a toast with Undo -> `moved` tells the tree. Move to... does the same inside
 * its dialog (components/MoveDialog.tsx). Undo sends the server's own undo request.
 */
export function useTreeMove({ assets, canEdit, locked }: { assets: Asset[]; canEdit: boolean; locked: boolean }): {
  move: AssetTreeMove | undefined;
  dialogs: ReactNode;
  busy: boolean;
} {
  const toast = useToast();
  const [ask, confirmDialog] = useConfirm();
  const { mutateAsync } = useMoveAssets();
  const invalidate = useInvalidate();
  // The whole tree, unfiltered: a filter hides siblings, and "after R" means after R among all of R's siblings.
  const index = useMemo(() => indexTree(buildTree(assets)), [assets]);
  const [dialog, setDialog] = useState<{ ids: number[]; opener: HTMLElement | null } | null>(null);
  const [working, setWorking] = useState(false);
  const [moved, setMoved] = useState<{ firstId: number; ids: number[]; line?: string } | null>(null);
  const lastUndo = useRef<UndoEntry | null>(null);
  const [refocus, setRefocus] = useState<Refocus | null>(null);
  const inFlight = useRef(0); // a ref besides the state: two drops in the same tick must see the first as running before React has rendered it
  const begin = () => { inFlight.current += 1; setWorking(true); };
  const end = () => { inFlight.current -= 1; if (inFlight.current === 0) setWorking(false); };

  /**
   * The toast with Undo, and the signal that tells the tree to unpick the moved roots and focus the first one. The tree's live line says the
   * same words and how to undo from the keyboard: the toast's button is far from the row in the tab order.
   */
  function announce(result: MoveResult) {
    const first = result.moved[0];
    if (!first) { // the server answers "already there" with a 422, so this is only a surprise: say so instead of "Moved nothing" with an Undo
      toast.info(ALREADY);
      return;
    }
    const text = movedToast(result.moved);
    const entry: UndoEntry = { result, until: Date.now() + UNDO_MS, used: false };
    lastUndo.current = entry; // a newer move replaces the older one: Ctrl+Z undoes the latest
    toast.success(text, { action: { label: "Undo", title: UNDO_TITLE, onAction: () => { void latest.current.undo(entry); } }, durationMs: UNDO_MS });
    setMoved({ firstId: first.id, ids: result.moved.map((root) => root.id), line: `${text}. Press Ctrl+Z to undo.` }); // a NEW object every time: a second move to the same first root is still a signal
  }

  /** A drag or an Undo that failed: the words for the person, and the focus somewhere named. */
  function failedDrag(error: unknown, rootId: number, from: "preview" | "move") {
    const failure = moveFailure(error);
    if (failure.kind === "already") toast.info(ALREADY);
    else if (failure.kind === "stale") {
      toast.error(STALE_DRAG);
      if (from === "preview") void invalidate(keys.assets, keys.fleet); // a refused move has refreshed the lists itself; a refused preview has not
    } else toast.error(failure.text);
    setRefocus({ rowId: rootId });
  }

  async function drop(ids: number[], target: DropTarget): Promise<void> {
    const roots = toRoots(ids, index);
    if (!canEdit || locked || dialog !== null || inFlight.current > 0 || roots.length === 0) return;
    begin();
    try {
      const group = moveGroup(roots, target);
      let preview: MovePreview;
      try {
        preview = await loadMovePreview({ moves: [group] });
      } catch (error) {
        failedDrag(error, roots[0], "preview");
        return;
      }
      if (nothingChanges(preview, roots)) {
        toast.info(ALREADY);
        setRefocus({ rowId: roots[0] });
        return;
      }
      if (preview.rate_changes) {
        const { title, message } = rateWarning(preview.roots, (rate) => rateText(rate, preview.currency));
        // No Modal is open now, so the confirmation may be one; Cancel moves nothing and keeps the picks.
        if (!(await ask({ title, message, confirmLabel: "Move anyway", tone: "primary" }))) {
          setRefocus({ rowId: roots[0] });
          return;
        }
      }
      let result: MoveResult;
      try {
        result = await mutateAsync({ moves: [group], expect: preview.expect });
      } catch (error) {
        failedDrag(error, roots[0], "move");
        return;
      }
      announce(result);
    } finally {
      end();
    }
  }

  /**
   * After an Undo the focus is on something named. Pressed on another page (this page and its tree are gone) the toast's Undo button holds the
   * focus and is about to leave with its toast, which would drop it on the body: it goes to the page's main area instead. Where the tree is on
   * screen its own reveal (or `refocus` below) puts the focus on the assets.
   */
  function keepFocus() {
    if (treeOnScreen()) return;
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest(".toast-stack")) return;
    (document.getElementById("main") ?? document.querySelector<HTMLElement>("h1"))?.focus({ preventScroll: true });
  }

  async function undo(entry: UndoEntry): Promise<void> {
    if (entry.used) return;
    entry.used = true;
    if (lastUndo.current === entry) lastUndo.current = null; // only its own: an older toast's button must not wipe a newer move's entry
    const { result } = entry;
    begin();
    try {
      const undone = await mutateAsync({ moves: result.undo.moves, expect: result.undo.expect, undo_of: result.request_id });
      toast.success("Undone"); // no second Undo
      const ids = undone.moved.length > 0 ? undone.moved.map((root) => root.id) : result.undo.moves.flatMap((group) => group.ids);
      if (ids.length > 0) setMoved({ firstId: ids[0], ids }); // no words: the toast says "Undone", and a line from the move itself is out of date
    } catch (error) {
      const failure = moveFailure(error);
      if (failure.kind === "already") toast.info(ALREADY);
      else if (failure.kind === "stale" || (error instanceof ApiError && error.status === 409)) toast.error(STALE_UNDO);
      else toast.error(failure.text);
      // The Undo button is about to leave with its toast: the focus goes to where the assets are.
      setRefocus({ rowId: result.moved[0]?.id, force: true });
    } finally {
      end();
      keepFocus();
    }
  }

  /** Ctrl+Z on a row of the tree: the latest move's Undo, while its toast is still up. False when it did not start one. */
  function undoLatest(): boolean {
    const entry = lastUndo.current;
    if (!entry) return false;
    if (entry.used || Date.now() > entry.until) {
      lastUndo.current = null;
      return false;
    }
    if (!canEdit || locked || dialog !== null || inFlight.current > 0) return false;
    void undo(entry);
    return true;
  }

  function openDialog(ids: number[], opener: HTMLElement | null) {
    if (!canEdit || locked || dialog !== null || inFlight.current > 0 || toRoots(ids, index).length === 0) return;
    setDialog({ ids: [...ids], opener });
  }

  // The handlers the tree is given never change (its rows are memoised on them); they call the latest version of the functions above.
  const latest = useRef({ drop, openDialog, undo, undoLatest });
  useEffect(() => { latest.current = { drop, openDialog, undo, undoLatest }; });
  const onDrop = useCallback((ids: number[], target: DropTarget) => latest.current.drop(ids, target), []);
  const onMoveTo = useCallback((ids: number[], opener: HTMLElement | null) => latest.current.openDialog(ids, opener), []);
  const onUndo = useCallback(() => latest.current.undoLatest(), []);

  // Focus is placed after the render that removed the dialog, so that nothing the dialog's own clean-up does can undo it.
  useEffect(() => {
    if (!refocus) return;
    setRefocus(null);
    if (refocus.el) {
      if (refocus.el.isConnected) refocus.el.focus();
      return;
    }
    const active = document.activeElement;
    if (refocus.rowId !== undefined && (refocus.force || !active || active === document.body)) {
      // Inside the tree: the breadcrumbs and the attention list of the pane carry the same hrefs.
      document.querySelector<HTMLElement>(`ul.tree a[href="/assets/${refocus.rowId}"]`)?.focus();
    }
  }, [refocus]);

  const cancelDialog = () => {
    setRefocus({ el: dialog?.opener ?? null });
    setDialog(null);
  };
  const dialogMoved = (result: MoveResult) => {
    // The dialog is gone (and its clean-up, which gives the focus back to its opener, has run) BEFORE the signal reaches the tree: the tree's focus on the first moved root wins.
    flushSync(() => setDialog(null));
    announce(result);
  };

  const move = useMemo<AssetTreeMove | undefined>(() => (canEdit ? { onDrop, onMoveTo, onUndo, moved } : undefined), [canEdit, onDrop, onMoveTo, onUndo, moved]);
  const dialogs = (
    <>
      {confirmDialog}
      {dialog && <MoveDialog assets={assets} index={index} ids={dialog.ids} move={mutateAsync} onCancel={cancelDialog} onMoved={dialogMoved} />}
    </>
  );
  return { move, dialogs, busy: working || dialog !== null };
}
