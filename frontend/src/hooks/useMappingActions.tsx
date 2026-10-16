import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keys, useInvalidate } from "../api/queries";
import type { Asset, AssetKind, Mapping, Metric } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { assetLabels } from "../components/dashboard/AssetPicker";
import { MoveMappingsDialog } from "../components/MoveMappingsDialog";
import { useToast, type ToastOptions } from "../components/Toasts";
import {
  BUSY_TEXT, UNDO_MS, deleteMappings, enqueue, isBusy, moveBack, moveMappings, moveOutcome, reasonOf, restoreMappings, undoOutcome,
  unmapMappings, unmapOutcome, unmapPrompt, type MappingRef, type Outcome,
} from "../lib/mappingActions";
import { afterPaint } from "../lib/afterPaint";
import { isUndoKey } from "../lib/undoKey";
import { useConfirm } from "./useConfirm";

type AssetLike = Pick<Asset, "id" | "parent_id" | "name" | "kind">;
type MoveRef = MappingRef & { metric: Metric };
interface MoveRequest { refs: readonly MoveRef[]; what?: string; after?: () => void }

/**
 * What a dialog that has just made mappings tells the page (it unmounts at once, so the page owns the toast): the sentence, the mappings it made
 * (and which asset each is on, for the Undo's check) and the names of the assets it made on the way. `kind: "error"` is a batch that made only
 * part of what was asked: the toast says so and still carries the Undo for the part that went. `after` runs once the Undo has refreshed the lists,
 * and only if the focus is lost by then (the caller puts the focus somewhere named: the Undo's button leaves with its toast); `undoTitle` is the Undo button's description (the
 * default tells about Ctrl+Z; a caller whose Undo does less than the toast's words suggest says what it does instead).
 */
export interface MappedInfo {
  text: string;
  mappings: readonly { id: number; assetId: number; name?: string }[];
  newAssets: readonly string[];
  kind?: "success" | "error";
  after?: () => void;
  undoTitle?: string;
}

interface Options {
  /** Every asset (Discovery's graph carries them; the asset page passes its own list): the names in the sentences and the choices of the Move dialog. */
  assets: readonly AssetLike[];
  /** The kinds registry, for the note about a room or a hall. */
  kinds?: readonly AssetKind[];
  /** The metrics an asset has now, so the Move dialog can refuse a clash before asking. Discovery has them; the asset page leaves it out and the server's 409 speaks. */
  takenFor?: (assetId: number) => ReadonlySet<Metric>;
}

/** Every list a mapping write moves: the graph, the sources' counts, the assets (their summaries), the fleet, the audit log, billing and the widgets' figures. */
const REFRESHED = [keys.graph, keys.sources, keys.assets, keys.fleet, keys.auditAll, keys.billing, keys.widgetData] as const;

/** The Undo button's description (its name stays "Undo"): where the keyboard way to it is told. The toast's own live region announces the toast. */
const UNDO_TITLE = "Undo (Ctrl+Z)";

/**
 * The latest Undo of any action of this hook, for both routes to it: the toast's button and Ctrl+Z. It lives at module level, not in a hook
 * instance: an Undo outlives the page that raised it, and a newer Undo (from any page) replaces it. `used` is shared by the two routes, so
 * whichever comes second does nothing, and the shortcut takes the toast away (`toastGone`: no Undo button may stay on screen that does
 * nothing). `until` is when the toast's own 10 seconds are up. The model is useTreeMove's `lastUndo`.
 */
interface UndoEntry { run: () => void; until: number; used: boolean; toastGone: AbortController }
let lastUndo: UndoEntry | null = null;

/** Makes `run` the latest Undo and gives the toast its button and the signal that takes the toast away when the shortcut was used instead. */
function undoOptions(run: () => void, title: string = UNDO_TITLE): ToastOptions {
  const entry: UndoEntry = { run, until: Date.now() + UNDO_MS, used: false, toastGone: new AbortController() };
  lastUndo = entry;
  return {
    durationMs: UNDO_MS,
    signal: entry.toastGone.signal,
    action: {
      label: "Undo",
      title,
      onAction: () => {
        if (entry.used) return; // Ctrl+Z was first
        entry.used = true;
        if (lastUndo === entry) lastUndo = null; // only its own: an older toast's button must not wipe a newer action's entry
        run(); // the toast is leaving by itself
      },
    },
  };
}

/** Ctrl+Z: the latest Undo, while its toast is still up. False when there was nothing to start. */
function startLatestUndo(): boolean {
  const entry = lastUndo;
  if (!entry) return false;
  if (entry.used || Date.now() > entry.until) {
    lastUndo = null;
    return false;
  }
  entry.used = true;
  lastUndo = null;
  entry.toastGone.abort();
  entry.run(); // through the same queue as the toast's button: see execute()
  return true;
}

/**
 * Whether the keyboard focus has gone nowhere: on the page itself, on the toast area (the Undo's own button, which leaves with its toast), or on
 * something no longer in the page. A focus anywhere else is the person's own (a node they arrowed to, a field, a dialog they opened while the Undo
 * was still running) and an Undo must not take it away.
 */
function focusIsLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected || active.closest(".toast-stack") !== null;
}

/** For tests only: forgets the latest Undo, which is module state and would otherwise outlive the test that raised it (a younger-than-10-seconds entry runs on the next Ctrl+Z). */
export function resetUndoForTests(): void {
  lastUndo = null;
}

/**
 * Where Ctrl+Z is not ours: in a field (the browser's own undo of the text), on the Assets Tree (it undoes its own moves), and beside an open
 * dialog (the person is answering something else).
 */
const shortcutIgnored = (target: EventTarget | null): boolean =>
  (target instanceof Element && target.closest('input, textarea, select, ul.tree, [contenteditable]:not([contenteditable="false"])') !== null) ||
  document.querySelector('[role="dialog"]') !== null;

/**
 * Taking mappings off an asset, moving them to another, and the Undo of both and of a mapping made in Discovery (W12a). One confirmation, one
 * toast with a 10 second Undo, the honest words when a request fails part-way. The requests are lib/mappingActions.ts's: one at a time, read
 * before written, stopped at the first failure, all through ONE queue.
 *
 * `unmap`/`move` do nothing without assets.edit and refuse (a toast) while an earlier change is still running; `mappedToast` raises the toast of
 * a mapping that Discovery made, with an Undo for people who hold assets.edit (discovery.accept alone maps but may not unmap). `dialogs` goes
 * anywhere in the page. After ANY write, whether it worked or not (the lists are out of date either way), every list is fetched again and then the
 * caller's `after()` runs (it puts the focus somewhere named), unless the page that asked has gone by then (the toast and the refresh still happen).
 * The busy check is made twice, when the action is asked for and again when it is confirmed: an Undo may have been pressed in between.
 *
 * An Undo outlives the page that raised it: its closures hold the toast api, the invalidate function and plain values, never component state.
 * An Undo runs the SAME `after()` as the action it undoes (a mapping made in Discovery: `MappedInfo.after`): the Undo's button leaves with
 * its toast, which would drop the focus on the body, and the caller's target (the row, the node) is back by then. But only when the focus really
 * was lost, checked when `after()` is about to run (the Undo takes a second or more) and after the refreshed lists are drawn (see `execute`): a
 * focus on a node, in a field or in a dialog opened meanwhile is the person's own (Ctrl+Z is pressed with the focus somewhere real, always),
 * while a control the refresh itself took away leaves the focus lost. The action's own `after()` is unconditional (its opener is gone).
 * It also has a second way in:
 * Ctrl+Z (Cmd+Z), for the latest Undo of any action of this hook while its toast is up. Every mounted instance listens, the entry's `used` flag
 * lets only one act; `undoLatest()` is the same thing for a caller (and a test) that has no key event.
 */
export function useMappingActions({ assets, kinds, takenFor }: Options): {
  canEdit: boolean;
  unmap(refs: readonly MappingRef[], opts?: { what?: string; after?: () => void }): void;
  move(refs: readonly MoveRef[], opts?: { what?: string; after?: () => void }): void;
  mappedToast(info: MappedInfo): void;
  undoLatest(): boolean;
  dialogs: ReactNode;
} {
  const toast = useToast();
  const invalidate = useInvalidate();
  const canEdit = useAuth().can("assets.edit");
  const [ask, confirmDialog] = useConfirm();
  const [moving, setMoving] = useState<MoveRequest | null>(null);
  const labels = useMemo(() => assetLabels(assets.map((a) => ({ ...a, sort_order: 0 }))), [assets]);
  // False once the host has unmounted: the caller's `after()` would focus a node that is gone (the effect also sets it true again for Strict Mode's second mount).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // Ctrl+Z, on the document: the Undo toast is the last thing in the page, far from where the keyboard is. The entry is the module's, so any
  // instance may start it, and it keeps working after the page that raised it has gone as long as another instance (or none: the toast) is there.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isUndoKey(event)) return; // Ctrl+Shift+Z is redo; a layout with no Latin Z (Arabic, Cyrillic) is read by its physical key, one with another ASCII character there is not
      if (event.defaultPrevented || shortcutIgnored(event.target)) return;
      if (startLatestUndo()) event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const say = (outcome: Outcome, options?: ToastOptions) => toast[outcome.kind](outcome.text, options);

  /**
   * The one place all the work goes through: the queue, the toast, then (in a `finally`: a failure leaves the lists out of date too) the refresh and `after`.
   * `onlyIfFocusLost` is for an Undo: its `after()` runs only if, once the refreshed lists are DRAWN, the focus has gone nowhere. The refetch resolves
   * before the page shows its data (TanStack Query hands it over a tick later, then React and React Flow render), so a check made at once would see the
   * old page, and a control the refresh takes away (a node's "Mapping actions" button) would still look like a focus worth keeping.
   */
  async function execute<T>(work: () => Promise<T>, report: (result: T) => void, after?: () => void, onlyIfFocusLost = false): Promise<void> {
    try {
      report(await enqueue(work));
    } catch (error) {
      toast.error(reasonOf(error)); // the runners report their own failures; this is a throw from outside a request
    } finally {
      try {
        await invalidate(...REFRESHED);
      } catch {
        // the lists fetch themselves again on their next visit
      }
      if (after && onlyIfFocusLost) await afterPaint(); // before `mounted` is read: the page may go while the frames pass
      if (mounted.current && (!onlyIfFocusLost || focusIsLost())) after?.();
    }
  }

  /** Where the refs are: the one asset's name, else "N assets". */
  function whereOf(refs: readonly MappingRef[]): { one: string | null; text: string; count: number } {
    const ids = [...new Set(refs.map((r) => r.assetId))];
    if (ids.length === 1) {
      const name = labels.get(ids[0]) ?? "the asset";
      return { one: name, text: name, count: 1 };
    }
    return { one: null, text: `${ids.length} assets`, count: ids.length };
  }

  function unmap(refs: readonly MappingRef[], opts: { what?: string; after?: () => void } = {}) {
    if (!canEdit || refs.length === 0) return;
    if (isBusy()) {
      toast.info(BUSY_TEXT);
      return;
    }
    const where = whereOf(refs);
    const prompt = unmapPrompt({ count: refs.length, name: refs[0].name, asset: where.one, assetCount: where.count, what: opts.what });
    void (async () => {
      if (!(await ask({ ...prompt, confirmLabel: "Unmap", tone: "danger" }))) return;
      if (isBusy()) { // an Undo may have been pressed while the person was reading the question
        toast.info(BUSY_TEXT);
        return;
      }
      const names = new Map(refs.map((r) => [r.id, r.name]));
      const nameOf = (m: Mapping) => names.get(m.id) ?? "a mapping";
      await execute(() => unmapMappings(refs), (result) => {
        // A delete of unknown outcome keeps its mapping as the LAST of `removed`: the Undo needs to know it, to read a 409 for it as "still mapped".
        const unsureId = result.failed?.unknown ? result.removed[result.removed.length - 1]?.id : undefined;
        const putBack = () => { void execute(() => restoreMappings(result.removed, nameOf, unsureId), (put) => say(undoOutcome("restore", put, result.removed.length)), opts.after, true); };
        say(unmapOutcome(result, where.text, refs.length), result.removed.length > 0 ? undoOptions(putBack) : undefined);
      }, opts.after);
    })();
  }

  function move(refs: readonly MoveRef[], opts: { what?: string; after?: () => void } = {}) {
    if (!canEdit || refs.length === 0 || moving !== null) return;
    if (isBusy()) {
      toast.info(BUSY_TEXT);
      return;
    }
    setMoving({ refs, what: opts.what, after: opts.after });
  }

  /** The dialog is closed at once and the outcome comes as a toast: a request error never shows inside a dialog that has gone. */
  function confirmMove(request: MoveRequest, toAssetId: number) {
    setMoving(null);
    if (isBusy()) { // as in unmap: busy when it was asked for is checked at open, busy when it is confirmed here
      toast.info(BUSY_TEXT);
      return;
    }
    const target = labels.get(toAssetId) ?? "the asset";
    void execute(() => moveMappings(request.refs, toAssetId), (result) => {
      const back = () => { void execute(() => moveBack(result.moved), (put) => say(undoOutcome("moveBack", put, result.moved.length)), request.after, true); };
      const outcome = moveOutcome(result, request.refs.length, target, request.refs.length === 1 ? request.refs[0].metric : undefined);
      say(outcome, result.moved.length > 0 ? undoOptions(back) : undefined);
    }, request.after);
  }

  function mappedToast({ text, mappings, newAssets, kind = "success", after, undoTitle }: MappedInfo) {
    if (!canEdit || mappings.length === 0) {
      toast[kind](text);
      return;
    }
    const undo = () => { void execute(() => deleteMappings(mappings), (result) => say(undoOutcome("deleteMade", result, mappings.length, newAssets)), after, true); };
    toast[kind](text, undoOptions(undo, undoTitle));
  }

  const dialogs = (
    <>
      {confirmDialog}
      {moving && (
        <MoveMappingsDialog
          assets={assets} kinds={kinds} rows={moving.refs} what={moving.what} takenFor={takenFor}
          onConfirm={(assetId) => confirmMove(moving, assetId)} onCancel={() => setMoving(null)}
        />
      )}
    </>
  );
  return { canEdit, unmap, move, mappedToast, undoLatest: startLatestUndo, dialogs };
}
