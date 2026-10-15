import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { deleteAssetsOneByOne, type RemoveItem } from "../api/assetsBulk";
import { keys, useInvalidate } from "../api/queries";
import type { Asset } from "../api/types";
import type { AssetTreeRemove } from "../components/AssetTree";
import { BulkDeleteAssetsDialog } from "../components/BulkDeleteAssetsDialog";
import { useToast } from "../components/Toasts";
import { MAX_ROOTS, bulkRemoveToast, capMessage, leaveTo, planDelete, type DeletePlan, type RemoveResult } from "../lib/assetsBulk";
import type { Timers } from "../lib/progress";
import { buildTree } from "../lib/tree";
import { indexTree, type TreeIndex } from "../lib/treeMove";

/** The confirmation that is open: what was picked (a frozen snapshot), the button that opened it, the row to focus when the picks are gone, and the tree as it was. */
interface Open { plan: DeletePlan; opener: HTMLElement | null; focusAfter: number | null; index: TreeIndex }
/** Where the focus goes once the dialog has left. */
interface Refocus { opener: HTMLElement | null; focusAfter: number | null }

/** How long the one-shot check after a refocus waits for the next list of assets: past this, a list that lands later is not about the refocus. */
export const FOCUS_CHECK_MS = 3000;

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Takes the focus without scrolling the page (an unscrolled `focus()` jumped the page to the top); true when it took it. */
function take(el: HTMLElement | null): boolean {
  if (!el || !el.isConnected) return false;
  el.focus({ preventScroll: true });
  return document.activeElement === el;
}

/**
 * Where the focus goes when the dialog is gone, in this order, always without scrolling: the button that opened it (if it is still on the page),
 * the row after the deleted ones, the tree's filter, the page's main area (Layout's `#main` has tabIndex -1). Never the body.
 */
function focusChain({ opener, focusAfter }: Refocus) {
  if (take(opener)) return;
  if (focusAfter !== null && take(document.querySelector<HTMLElement>(`ul.tree a[href="/assets/${focusAfter}"]`))) return;
  if (take(document.getElementById("asset-tree-filter"))) return;
  take(document.getElementById("main"));
}

/**
 * Deleting the assets picked in the Assets Tree, for the page that owns the tree (W7s). `remove` is what the tree is given (undefined without
 * assets.delete: no Delete in the pick bar); `dialog` goes anywhere in the page's markup; `busy` is true while the confirmation is open, and the
 * page counts it into its `locked` so that no Add, Edit or Move opens beside it. `locked` is the page's own lock: nothing opens while it holds.
 *
 * Delete in the bar -> `onDelete` -> the dialog (which asks the server what the top-level picks take with it) -> `run`: the roots are deleted one
 * after the other with the route a single delete uses. The page leaves the open asset as soon as the root that holds it is gone, the lists are
 * refreshed once at the end (also after a failure), and the focus ends on a named element whichever way the dialog ends. `timers` is the clock of
 * the focus check's expiry (tests hand in a manual one).
 */
export function useTreeDelete({ assets, selectedId, canDelete, locked, timers = realTimers }: { assets: Asset[]; selectedId: number | null; canDelete: boolean; locked: boolean; timers?: Timers }): {
  remove: AssetTreeRemove | undefined;
  dialog: ReactNode;
  busy: boolean;
} {
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  // The whole tree, unfiltered: a pick hidden by the filter is still a pick.
  const index = useMemo(() => indexTree(buildTree(assets)), [assets]);
  const [open, setOpen] = useState<Open | null>(null);
  const [refocus, setRefocus] = useState<Refocus | null>(null);
  const running = useRef<Promise<RemoveResult> | null>(null);
  const mounted = useRef(true);
  /** Set when the focus was placed: the next list of assets (or a change of permission) checks that it did not fall to the body. `undefined` = not armed. */
  const armed = useRef<number | null | undefined>(undefined);
  /** Stops watching for a click or a focus move and clears the expiry timer; set while the check is armed. */
  const unwatch = useRef<(() => void) | null>(null);
  /** The result `run` already toasted because the page had left: the dialog's own report of it (it keeps running) must not toast it again. */
  const reported = useRef<RemoveResult | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      disarm();
    };
  }, []);

  /** Ends the one-shot check: no more waiting for a list, no listeners, no timer. */
  function disarm() {
    armed.current = undefined;
    unwatch.current?.();
    unwatch.current = null;
  }

  /**
   * Arms the one-shot check after a refocus. It ends at the next list of assets, at the first click or focus move anywhere (the person has
   * taken over, and a list that lands later must not move the focus), or after FOCUS_CHECK_MS. Called AFTER the focus was placed: the focus
   * event of that very call must not end the watch.
   */
  function arm(focusAfter: number | null) {
    disarm();
    armed.current = focusAfter;
    const end = () => disarm();
    document.addEventListener("pointerdown", end, true);
    document.addEventListener("focusin", end, true);
    const timer = timers.set(end, FOCUS_CHECK_MS);
    unwatch.current = () => {
      document.removeEventListener("pointerdown", end, true);
      document.removeEventListener("focusin", end, true);
      timers.clear(timer);
    };
  }

  function openDialog(ids: number[], opener: HTMLElement | null, focusAfter: number | null) {
    if (!canDelete || locked || open !== null) return;
    const plan = planDelete(ids, index, (id) => index.nameOf(id) ?? `Asset ${id}`);
    if (plan.roots.length === 0) return;
    if (plan.roots.length > MAX_ROOTS) { // the loop is one request each: an owner with more deletes in rounds
      toast.error(capMessage(plan.roots.length));
      return;
    }
    setOpen({ plan, opener, focusAfter, index });
  }

  /** The dialog's Delete: the loop, then one refresh of everything the deleted assets showed up in. Asked twice (a double press), it answers the same run. */
  function run(items: RemoveItem[]): Promise<RemoveResult> {
    if (running.current) return running.current;
    // The tree as it was when Delete was pressed: a refresh in the middle of the loop must not make the deleted roots unknown.
    const frozen = latest.current.open?.index ?? index;
    const names = new Map(items.map((item) => [item.id, item.name]));
    const onRemoved = (id: number) => {
      if (!mounted.current) return; // a 401 or Back can have taken the page away while the loop runs
      // Every time, not once: the roots are disjoint and the parent of a root lies inside none of them, so leaving one root cannot land in another.
      const to = leaveTo({ openId: latest.current.selectedId, removed: [id], index: frozen });
      // At once, not after the loop: the open asset's pages poll, and a poll for a deleted asset would show "not found" behind the dialog.
      if (to !== null) latest.current.navigate(to);
    };
    const job = (async () => {
      try {
        const result = await deleteAssetsOneByOne(items, { onRemoved });
        if (mounted.current) {
          // Back or Forward may have put the page on an asset that went earlier in this loop (no later root fires for it). Before the refresh below,
          // which would ask the server for it. `replace`: the id that was read may be a render behind, and the same place twice must stay one entry.
          const to = leaveTo({ openId: latest.current.selectedId, removed: [...result.deleted, ...result.gone], index: frozen });
          if (to !== null) latest.current.navigate(to, { replace: true });
        }
        return result;
      } finally {
        try {
          // The set a move refreshes, plus the sources: a point row carries its mapping, and the mappings went with the assets.
          await latest.current.invalidate(keys.assets, keys.fleet, keys.billing, keys.widgetData, keys.tariffs, keys.auditAll, keys.graph, keys.sources);
        } catch {
          // a failed refresh must not hide what the loop did
        }
        running.current = null;
      }
    })().then((result) => {
      if (!mounted.current) {
        // The page left while the loop ran, and the dialog went with it: its report (a refusal with nothing deleted is only thrown into it) would
        // never be seen. Whoever confirmed is told here, for every result; `done` skips this one.
        reported.current = result;
        const { tone, text } = bulkRemoveToast(result, (id) => names.get(id) ?? "");
        toast[tone](text);
      }
      return result;
    });
    running.current = job;
    return job;
  }

  /** A pick was found gone before anything was sent: the list is stale, and refreshing it drops the vanished pick from the picks. */
  function stale() {
    void invalidate(keys.assets, keys.fleet);
  }

  function done(result: RemoveResult) {
    const current = latest.current.open;
    if (reported.current !== result) {
      const names = new Map((current?.plan.roots ?? []).map((root) => [root.id, root.name]));
      // The names come from the plan: by now the assets are gone from the list.
      const { tone, text } = bulkRemoveToast(result, (id) => names.get(id) ?? "");
      toast[tone](text);
    }
    if (!mounted.current) return;
    // After a full success every pick is gone and so is the Delete button; after a partial result the failed and untried picks remain, and so does the button.
    setRefocus({ opener: result.failed === null ? null : current?.opener ?? null, focusAfter: current?.focusAfter ?? null });
    setOpen(null);
  }

  function cancel() {
    const current = latest.current.open;
    setRefocus({ opener: current?.opener ?? null, focusAfter: current?.focusAfter ?? null });
    setOpen(null);
  }

  // The handlers the tree and the dialog are given never change (the tree memoises its rows on them); they call the latest version of the functions above.
  const latest = useRef({ openDialog, run, stale, done, cancel, open, selectedId, navigate, invalidate });
  useEffect(() => { latest.current = { openDialog, run, stale, done, cancel, open, selectedId, navigate, invalidate }; });
  const onDelete = useCallback((ids: number[], opener: HTMLElement | null, focusAfter: number | null) => latest.current.openDialog(ids, opener, focusAfter), []);
  const onRun = useCallback((items: RemoveItem[]) => latest.current.run(items), []);
  const onStale = useCallback(() => latest.current.stale(), []);
  const onDone = useCallback((result: RemoveResult) => latest.current.done(result), []);
  const onCancel = useCallback(() => latest.current.cancel(), []);

  // The check (declared BEFORE the refocus so that a list landing in the same commit does not use it up): the Delete button the focus was given to
  // can go a tick later (the last pick pruned by a refresh, a 403 that turned `remove` off, every asset deleted so the filter went too).
  useEffect(() => {
    if (armed.current === undefined) return;
    const focusAfter = armed.current;
    disarm();
    const active = document.activeElement;
    if (!active || active === document.body) focusChain({ opener: null, focusAfter });
  }, [assets, canDelete]);

  // Focus is placed after the render that removed the dialog, so that nothing the dialog's own clean-up does (it gives the focus back to what had it) can undo it.
  useEffect(() => {
    if (!refocus) return;
    setRefocus(null);
    if (!mounted.current) return;
    focusChain(refocus);
    arm(refocus.focusAfter);
  }, [refocus]);

  const remove = useMemo<AssetTreeRemove | undefined>(() => (canDelete ? { onDelete } : undefined), [canDelete, onDelete]);
  const dialog = open && <BulkDeleteAssetsDialog plan={open.plan} run={onRun} onStale={onStale} onDone={onDone} onCancel={onCancel} />;
  return { remove, dialog, busy: open !== null };
}
