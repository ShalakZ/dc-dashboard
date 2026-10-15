import { useMemo, useState, type ReactNode } from "react";
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
import { useConfirm } from "./useConfirm";

type AssetLike = Pick<Asset, "id" | "parent_id" | "name" | "kind">;
type MoveRef = MappingRef & { metric: Metric };
interface MoveRequest { refs: readonly MoveRef[]; what?: string; after?: () => void }

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

const undoOptions = (run: () => void): ToastOptions => ({ durationMs: UNDO_MS, action: { label: "Undo", title: "Undo", onAction: run } });

/**
 * Taking mappings off an asset, moving them to another, and the Undo of both and of a mapping made in Discovery (W12a). One confirmation, one
 * toast with a 10 second Undo, the honest words when a request fails part-way. The requests are lib/mappingActions.ts's: one at a time, read
 * before written, stopped at the first failure, all through ONE queue.
 *
 * `unmap`/`move` do nothing without assets.edit and refuse (a toast) while an earlier change is still running; `mappedToast` raises the toast of
 * a mapping that Discovery made, with an Undo for people who hold assets.edit (discovery.accept alone maps but may not unmap). `dialogs` goes
 * anywhere in the page. After ANY write, whether it worked or not (the lists are out of date either way), every list is fetched again and then the
 * caller's `after()` runs (it puts the focus somewhere named).
 *
 * An Undo outlives the page that raised it: its closures hold the toast api, the invalidate function and plain values, never component state.
 */
export function useMappingActions({ assets, kinds, takenFor }: Options): {
  canEdit: boolean;
  unmap(refs: readonly MappingRef[], opts?: { what?: string; after?: () => void }): void;
  move(refs: readonly MoveRef[], opts?: { what?: string; after?: () => void }): void;
  mappedToast(info: { text: string; mappings: readonly { id: number; assetId: number; name?: string }[]; newAssets: readonly string[] }): void;
  dialogs: ReactNode;
} {
  const toast = useToast();
  const invalidate = useInvalidate();
  const canEdit = useAuth().can("assets.edit");
  const [ask, confirmDialog] = useConfirm();
  const [moving, setMoving] = useState<MoveRequest | null>(null);
  const labels = useMemo(() => assetLabels(assets.map((a) => ({ ...a, sort_order: 0 }))), [assets]);

  const say = (outcome: Outcome, options?: ToastOptions) => toast[outcome.kind](outcome.text, options);

  /** The one place all the work goes through: the queue, the toast, then (in a `finally`: a failure leaves the lists out of date too) the refresh and `after`. */
  async function execute<T>(work: () => Promise<T>, report: (result: T) => void, after?: () => void): Promise<void> {
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
      after?.();
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
      const names = new Map(refs.map((r) => [r.id, r.name]));
      const nameOf = (m: Mapping) => names.get(m.id) ?? "a mapping";
      await execute(() => unmapMappings(refs), (result) => {
        const putBack = () => { void execute(() => restoreMappings(result.removed, nameOf), (put) => say(undoOutcome("restore", put, result.removed.length))); };
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
    const target = labels.get(toAssetId) ?? "the asset";
    void execute(() => moveMappings(request.refs, toAssetId), (result) => {
      const back = () => { void execute(() => moveBack(result.moved), (put) => say(undoOutcome("moveBack", put, result.moved.length))); };
      const outcome = moveOutcome(result, request.refs.length, target, request.refs.length === 1 ? request.refs[0].metric : undefined);
      say(outcome, result.moved.length > 0 ? undoOptions(back) : undefined);
    }, request.after);
  }

  function mappedToast({ text, mappings, newAssets }: { text: string; mappings: readonly { id: number; assetId: number; name?: string }[]; newAssets: readonly string[] }) {
    if (!canEdit || mappings.length === 0) {
      toast.success(text);
      return;
    }
    const undo = () => { void execute(() => deleteMappings(mappings), (result) => say(undoOutcome("deleteMade", result, mappings.length, newAssets))); };
    toast.success(text, undoOptions(undo));
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
  return { canEdit, unmap, move, mappedToast, dialogs };
}
