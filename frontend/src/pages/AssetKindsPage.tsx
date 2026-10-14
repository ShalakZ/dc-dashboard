import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { useAddStarterKinds, useAssetKinds, useCreateAssetKind, useDeleteAssetKind, usePatchAssetKind, type BulkDeleteResult } from "../api/queries";
import type { AssetKind, AssetKindIn, AssetKindPatch } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { BulkDeleteKindsDialog } from "../components/BulkDeleteKindsDialog";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { EmptyNote } from "../components/EmptyNote";
import { Icon } from "../components/Icon";
import { InfoTip } from "../components/InfoTip";
import { KindForm } from "../components/KindForm";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { RowActions, type RowAction } from "../components/RowActions";
import { ActionsSpace, TableSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toasts";
import { assetIcon } from "../lib/assetIcons";
import { kindKey } from "../lib/kinds";
import { bulkToast, removedIds } from "../lib/kindsBulk";
import { addRange, filterCounts, filterKinds, KIND_FILTERS, neighbourId, pickAll, pickUnused, type KindFilter } from "../lib/kindsView";
import { clear, EMPTY_PICK, prune, toggle, unpick, type PickState } from "../lib/treeSelect";
import { upperFirst } from "../lib/upperFirst";

const CRUMBS = [{ label: "Assets Tree", to: "/assets" }, { label: "Asset kinds" }];

const FILTER_LABEL: Record<KindFilter, string> = { all: "All", starter: "Starter", yours: "Yours", unused: "Unused" };
const NO_KINDS: AssetKind[] = []; // one array for "no answer yet", so the memos below keep their identity between renders
const NO_PICKS: ReadonlySet<number> = new Set();

/** What a reader sees where New kind and the row menu would be: the permission is its own, so ReadOnlyNote's words ("change assets") would name the wrong thing. */
const NEED_KINDS = 'Managing asset kinds needs the "Manage asset kinds" permission.';

const countText = (n: number) => (n === 0 ? "No assets" : n === 1 ? "1 asset" : `${n} assets`);
const renamedText = (n: number) => (n === 0 ? "Kind renamed" : n === 1 ? "Kind renamed, 1 asset follows" : `Kind renamed, ${n} assets follow`);
type PackSet = "common" | "all";
const packText = (added: number, set: PackSet) =>
  added > 0 ? `Added ${added} ${added === 1 ? "kind" : "kinds"}` : set === "all" ? "All the data-centre kinds are already there" : "All the common data-centre kinds are already there";
/** What the delete dialog says about a kind in use: the count, and what to do (`move` there is a kind to move to; otherwise one must be created first). */
const usedText = ({ name, asset_count: n }: AssetKind, move: boolean) => {
  const uses = n === 1 ? `1 asset uses "${name}".` : `${n} assets use "${name}".`;
  const them = n === 1 ? "it" : "them";
  return move ? `${uses} Move ${them} to another kind, then delete "${name}".` : `${uses} Create another kind to move ${them} to first.`;
};
const deletedText = ({ name, asset_count: n }: AssetKind, movedTo: string | null) => (movedTo === null ? `Kind "${name}" deleted` : `Kind "${name}" deleted, ${countText(n)} moved to ${movedTo}`);

/**
 * How many assets the server's 409 for a delete says use the kind now (`assets` in the body): the count the dialog showed was out of date,
 * either because assets joined the kind or, when it was asked to move them, because the number changed (0 is possible then). 1 when the
 * answer does not say: it refused for at least one.
 */
const assetsIn = (body: unknown): number => {
  const n = (body as { assets?: unknown } | null | undefined)?.assets;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 1;
};
/** The line the dialog shows when a 409 changed what it asked: the server's own words ("14 assets use this kind now. Check the new count and try again."), with a capital. */
const changedText = (e: ApiError) => (typeof e.detail === "string" && e.detail !== "" ? upperFirst(e.detail) : "The count changed while this was open. Check the new count and try again.");

// Code-point comparison, as lib/kinds.ts: deterministic across runtimes.
const compare = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
/** The kinds the assets of `id` may move to: every other kind, sorted by key. */
const movable = (kinds: readonly AssetKind[], id: number) => kinds.filter((k) => k.id !== id).sort((a, b) => compare(kindKey(a.name), kindKey(b.name)));

/**
 * The delete confirmation of one kind. Unused: the plain question. In use: where do its assets go (a labelled select of the other kinds, empty
 * to start with, and Delete waits for a choice); with no other kind it is the blocked dialog, which says to create one. The select is the dialog's
 * `children`, so it sits outside the region the dialog is described by. One ConfirmDeleteDialog throughout: a refusal of the server only changes
 * its props (the same instance keeps the focus rules), such as the plain question turning into the move form.
 */
function DeleteKindDialog({ row, others, target, notice, onTarget, onConfirm, onCancel }: {
  row: AssetKind; others: readonly AssetKind[]; target: number | null; notice: string | null; onTarget: (id: number | null) => void;
  onConfirm: () => Promise<unknown>; onCancel: () => void;
}) {
  const used = row.asset_count > 0;
  const blocked = used && others.length === 0;
  const pickerId = useId();
  return (
    <ConfirmDeleteDialog
      title={`Delete the kind "${row.name}"?`}
      message={!used ? "Assets that carry the name later get an automatic icon." : blocked ? "" : usedText(row, true)}
      loadError={blocked ? usedText(row, false) : undefined}
      notice={blocked ? undefined : notice ?? undefined} // the blocked dialog already says why, in its own line
      blocked={blocked}
      confirmLabel="Delete"
      confirmDisabled={used && target === null}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {used && !blocked && (
        <label htmlFor={pickerId}>Move the assets to
          <select id={pickerId} value={target ?? ""} onChange={(e) => onTarget(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">Choose a kind…</option>
            {others.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </label>
      )}
    </ConfirmDeleteDialog>
  );
}

/** The server's words with a capital (its 404 is written in lower case); the form and the confirmation show a thrown message as it is. */
const reworded = (e: unknown) => (e instanceof Error ? new Error(upperFirst(e.message)) : e);
async function worded<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (e) {
    throw reworded(e);
  }
}

/**
 * Asset kinds: what each kind of asset looks like. An asset with no icon of its own shows its kind's icon, so changing one here changes
 * every asset of that kind. A child of the Assets workspace (the tree stays beside it). Everyone who may open Assets reads the list;
 * assets.kinds ("Manage asset kinds", not assets.edit: a rename or a move changes the kind of every asset that uses it) adds New kind, the
 * starter pack button and the row menu (Edit, Delete); everybody else gets one line that says what is missing. A kind that assets still
 * use is deleted by moving its assets to another kind: the delete dialog asks which.
 */
export function AssetKindsPage() {
  const { can } = useAuth();
  const canManage = can("assets.kinds");
  // No `enabled` flag: the route is behind assets.view, so a role that gets here may read the list.
  const { data, error, isLoading } = useAssetKinds();
  const kinds = data ?? NO_KINDS;
  const createKind = useCreateAssetKind();
  const patchKind = usePatchAssetKind();
  const deleteKind = useDeleteAssetKind();
  // One mutation per pack: the hook takes the pack as its argument, and the header and the toolbar choose theirs when they are pressed.
  const addCommon = useAddStarterKinds("common");
  const addAll = useAddStarterKinds("all");
  const packPending = addCommon.isPending || addAll.isPending;
  const toast = useToast();
  // The kind as it was when Edit or Delete was chosen, not a lookup into the list: a refetch gives the list new objects, and the open form must not change under the person typing.
  const [dialog, setDialog] = useState<{ kind: "new" } | { kind: "edit"; row: AssetKind } | null>(null);
  const [deleting, setDeleting] = useState<AssetKind | null>(null);
  // Where the assets of the kind being deleted go: the id the person chose. Only kinds still in the list count, so one that vanished from a refreshed list is no choice any more.
  const [target, setTarget] = useState<number | null>(null);
  // What the server's last 409 said about the count: one line in the dialog, so a second press of Delete is a conscious one. Gone when the person
  // chooses another kind and when the next request starts.
  const [changed, setChanged] = useState<string | null>(null);
  // The kinds the bar's Delete was pressed for: their ids as they were at that moment, not what is ticked now. The dialog is open exactly while this
  // is set, so ticking or unticking never opens or closes it, and its rows are looked up in the CURRENT list (a refetch changes their counts).
  const [bulk, setBulk] = useState<number[] | null>(null);
  const others = deleting ? movable(kinds, deleting.id) : [];
  const chosen = others.find((k) => k.id === target) ?? null;
  // No second dialog next to a confirmation (two would share Escape and the focus trap), and no pack button under a form either.
  const locked = deleting !== null || bulk !== null || dialog !== null;
  // New kind is the opener of its own form: natively disabled while that form is open, the browser would drop its focus before the form recorded it
  // as the place to go back to. It is off for every other dialog.
  const newKindLocked = deleting !== null || bulk !== null || dialog?.kind === "edit";
  const closeDialog = () => setDialog(null);
  const closeBulk = useCallback(() => setBulk(null), []);
  const bulkRows = bulk === null ? [] : bulk.flatMap((id) => kinds.find((k) => k.id === id) ?? []);

  // The list tools. `picks` is what the person ticked; what the page acts on is `picked`, the picks that are on screen: a kind that left the
  // shown rows (renamed, got an asset, a refetch) stops counting at once, and the effect below forgets it for good.
  const [filter, setFilter] = useState<KindFilter>("all");
  const [picks, setPicks] = useState<PickState>(EMPTY_PICK);
  const counts = useMemo(() => filterCounts(kinds), [kinds]);
  const shown = useMemo(() => filterKinds(kinds, filter), [kinds, filter]);
  const order = useMemo(() => shown.map((k) => k.id), [shown]); // the table's row order, which a Shift range goes by
  const picked = useMemo(() => (canManage ? new Set(order.filter((id) => picks.ids.has(id))) : NO_PICKS), [canManage, order, picks]);
  useEffect(() => {
    setPicks((state) => prune(state, new Set(order)));
  }, [order]);
  const allPicked = shown.length > 0 && picked.size === shown.length;
  const nothingUnused = !shown.some((k) => k.asset_count === 0);
  // Choosing ANOTHER filter forgets the picks: a pick must never hide in a row the filter took away and then be deleted from there.
  const chooseFilter = (next: KindFilter) => {
    if (next === filter) return;
    setFilter(next);
    setPicks((state) => clear(state));
  };
  const onRowClick = (id: number, event: MouseEvent<HTMLInputElement>) => {
    // A mouse click with Shift adds a range. A click that came from the keyboard (detail 0: Space) is a plain toggle; Shift+Space is onRowKey's.
    const range = event.shiftKey && event.detail !== 0;
    setPicks((state) => (range ? addRange(state, order, id) : toggle(state, id)));
  };
  const onRowKey = (id: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== " " || !event.shiftKey) return;
    event.preventDefault(); // the browser does not click the box, so the range is the whole effect
    setPicks((state) => addRange(state, order, id));
  };
  const onRowMouseDown = (event: MouseEvent<HTMLInputElement>) => {
    if (event.shiftKey) event.preventDefault(); // a Shift-click between two boxes would otherwise select the text between them
  };
  const toggleAll = () => {
    if (shown.length === 0) return; // aria-disabled, not native: the guard is here
    setPicks((state) => (allPicked ? clear(state) : pickAll(order)));
  };
  const pickUnusedRows = () => {
    if (nothingUnused) return;
    setPicks((state) => pickUnused(state, shown));
  };

  // Escape clears the picks, unless a layer of the page is open: that layer's own Escape comes first (a dialog is portaled but its key events
  // still bubble through the React tree to this root). A row menu needs no check here: usePopover stops its Escape in the capture phase.
  const modalOpen = dialog !== null || deleting !== null || bulk !== null;
  const onPageKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || modalOpen || picked.size === 0) return;
    setPicks((state) => clear(state));
  };

  // When the last pick goes (Clear, Escape, the header box, a refetch) the bar goes with it, and a button of the bar that had the focus takes it
  // along to the body. The focus then goes to the slot's idle button, else to the filter in use: always somewhere named, and with
  // preventScroll so a page scrolled far down stays where it is. In an effect, after the commit: the bar is gone by then and so is its button.
  const slot = useRef<HTMLDivElement>(null);
  const idleButton = useRef<HTMLButtonElement>(null);
  const activeFilter = useRef<HTMLButtonElement>(null);
  const hadPicks = useRef(false);
  useEffect(() => {
    const had = hadPicks.current;
    hadPicks.current = picked.size > 0;
    if (!had || picked.size > 0 || !canManage) return;
    const active = document.activeElement;
    if (active && active !== document.body && !slot.current?.contains(active)) return; // the focus is somewhere that still exists: leave it
    (idleButton.current ?? activeFilter.current)?.focus({ preventScroll: true });
  }, [picked.size, canManage]);

  // After a confirmed delete the row, its menu and the dialog's opener are gone, so the dialog has nothing to give the focus back to. It goes to a
  // place that is named and already on screen: after one kind, the menu button of the row that moves up into its place (the next shown row, else the
  // previous one: `neighbour`, read when Delete was chosen, because by now the list has changed); after several, or when no such row is left, the
  // filter in use. Never the body and never New kind (the page must not jump to the top to reach it), and always preventScroll. Declared after the
  // effect above and run in the commit that closes the dialog: React runs the dialog's cleanup first (it gives the focus back to an opener that
  // still exists), so this one has the last word.
  const table = useRef<HTMLTableElement>(null);
  const neighbour = useRef<number | null>(null);
  const [deletions, setDeletions] = useState(0);
  const [bulkDeletions, setBulkDeletions] = useState(0);
  useEffect(() => {
    if (deletions === 0) return;
    const next = neighbour.current === null ? null : table.current?.querySelector<HTMLElement>(`tr[data-kind-id="${neighbour.current}"] .row-menu-btn`);
    (next ?? activeFilter.current)?.focus({ preventScroll: true });
  }, [deletions]);
  useEffect(() => {
    if (bulkDeletions > 0) activeFilter.current?.focus({ preventScroll: true });
  }, [bulkDeletions]);

  const create = async (body: AssetKindIn) => {
    await worded(createKind.mutateAsync(body));
    toast.success("Kind created");
    setDialog(null);
  };
  const edit = async (row: AssetKind, body: AssetKindPatch) => {
    const saved = await worded(patchKind.mutateAsync({ id: row.id, body }));
    toast.success(body.name !== undefined ? renamedText(saved.asset_count) : "Kind saved");
    setDialog(null);
  };
  // A failure is a toast, not a line under the header: a line that arrives late would push the table down. The button waits with aria-disabled and
  // a click guard, never the native attribute: the button has the focus, and a disabled one drops it to the page body.
  // `set`: the header's button adds the common kinds (the server's default), the toolbar's quiet one the whole catalogue.
  const addPack = async (set: PackSet) => {
    if (packPending) return;
    try {
      const { added } = await (set === "all" ? addAll : addCommon).mutateAsync();
      toast.success(packText(added.length, set));
    } catch (e) {
      toast.error(e instanceof Error ? upperFirst(e.message) : String(e));
    }
  };
  // A kind in use goes with `move_to` and the count the dialog showed. An unused one goes with no query at all.
  const removed = async (row: AssetKind) => {
    const to = row.asset_count > 0 ? chosen : null;
    if (row.asset_count > 0 && to === null) return; // Delete is off until a kind is chosen; nothing to ask
    setChanged(null);
    try {
      await deleteKind.mutateAsync(to ? { id: row.id, moveTo: to.id, expectAssets: row.asset_count } : { id: row.id });
    } catch (e) {
      // 409: the count is not what the dialog showed (assets joined the kind; or, when moving, the number changed). The dialog it was asked in shows the
      // server's count and so turns into the move form (the plain question), or the blocked dialog (no other kind): the choice stays if that kind still exists.
      if (e instanceof ApiError && e.status === 409) {
        setChanged(changedText(e));
        setDeleting({ ...row, asset_count: assetsIn(e.body) });
        return;
      }
      throw reworded(e); // a 422 (the target is gone, or is the kind itself) is shown in the dialog in the server's words
    }
    toast.success(deletedText(row, to?.name ?? null));
    setDeleting(null);
    setDeletions((n) => n + 1);
  };

  // The bar's Delete: the dialog gets the ids of this moment. aria-disabled with a guard here (never native `disabled`: the button has the focus, and
  // the dialog goes back to it on Cancel).
  const askBulk = () => {
    if (locked || picked.size === 0) return;
    setBulk(order.filter((id) => picked.has(id)));
  };
  // The dialog ran the deletions and at least one kind is gone: say what happened (an error toast when anything was refused or left untried), forget
  // the kinds that left the registry, keep the others ticked so they can be tried again, and close. The focus move is the effect above.
  const onBulkDone = (result: BulkDeleteResult) => {
    const { tone, text } = bulkToast(result);
    toast[tone](text);
    setPicks((state) => unpick(state, removedIds(result)));
    setBulk(null);
    setBulkDeletions((n) => n + 1);
  };

  const header = (actions: ReactNode) => (
    <PageHeader
      title="Asset kinds"
      crumbs={CRUMBS}
      sub={<>The icon an asset shows when it has none of its own <InfoTip>An asset without an icon of its own shows its kind's icon. Change a kind's icon here and every asset of that kind follows.</InfoTip></>}
      actions={actions}
    />
  );

  // Known from the first render (the account is loaded before any page), so drawn in the skeleton too: the table never moves down when the list arrives.
  const needNote = !canManage && <p className="muted kinds-note">{NEED_KINDS}</p>;
  if (isLoading) {
    return (
      <div className="kinds-page">
        {header(canManage ? <ActionsSpace /> : undefined)}
        {needNote}
        {/* The toolbar's room, empty: a grey block outside the region would show before the skeleton's fade-in delay (as ActionsSpace). The same CSS,
            so the same height at every width, and the table does not move when the real toolbar replaces it. */}
        <div className="kinds-toolbar" aria-hidden="true"><div className="kinds-filter-room" />{canManage && <div className="kinds-slot" />}</div>
        <TableSkeleton columns={canManage ? 4 : 2} widths={canManage ? [40, null, 120, 56] : undefined} rows={5} label="Loading asset kinds" />
      </div>
    );
  }
  if (error && data === undefined) {
    return <div className="kinds-page">{header(undefined)}<p className="error" role="alert">{error.message}</p></div>;
  }
  const actionsOf = (row: AssetKind): RowAction[] => [
    { label: "Edit", disabled: locked, onSelect: () => setDialog({ kind: "edit", row }) },
    { label: "Delete", tone: "danger", disabled: locked, onSelect: () => { setTarget(null); setChanged(null); neighbour.current = neighbourId(order, row.id); setDeleting(row); } },
  ];
  // The toolbar is drawn once the list has loaded, empty or not, for somebody who manages kinds (Add all is then always within reach, and an empty answer
  // moves nothing); a reader gets it when there is something to filter.
  const toolbar = canManage || kinds.length > 0;
  return (
    <div className="kinds-page" onKeyDown={onPageKey}>
      {header(canManage ? (
        <>
          <button type="button" aria-disabled={packPending || undefined} disabled={locked} onClick={() => void addPack("common")}>Add common data-centre kinds</button>
          <button type="button" className="primary" disabled={newKindLocked} onClick={() => setDialog({ kind: "new" })}>New kind</button>
        </>
      ) : undefined)}
      {needNote}
      {error && <p className="error" role="alert">{error.message}</p>}
      {toolbar && (
        <div className="kinds-toolbar">
          <div className="seg-switch kinds-filter" role="group" aria-label="Show">
            {KIND_FILTERS.map((f) => (
              <button key={f} type="button" ref={f === filter ? activeFilter : undefined} aria-pressed={f === filter} onClick={() => chooseFilter(f)}>{`${FILTER_LABEL[f]} ${counts[f]}`}</button>
            ))}
          </div>
          {canManage && (
            // ONE slot at the right with a fixed size, so that picking a row changes its words and never the height of the toolbar. The live span is
            // there from the start (a region that appears with its text is often not read) and is the only announcer on the page: no role="status".
            <div className="kinds-slot" ref={slot}>
              <span className="kinds-selected" aria-live="polite" aria-atomic="true">{picked.size > 0 ? `${picked.size} selected` : ""}</span>
              {picked.size === 0 ? (
                <button type="button" className="quiet" ref={idleButton} aria-disabled={packPending || undefined} disabled={locked} onClick={() => void addPack("all")}>Add all 39 data-centre kinds</button>
              ) : (
                <div className="kinds-bar">
                  <button type="button" className="quiet" aria-disabled={nothingUnused || undefined} onClick={pickUnusedRows}>Select all unused</button>
                  <button type="button" className="danger-quiet" aria-disabled={locked || undefined} onClick={askBulk}>Delete</button>
                  <button type="button" className="quiet" onClick={() => setPicks((state) => clear(state))}>Clear</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {kinds.length === 0 ? (
        <EmptyNote icon="layers">No kinds yet.</EmptyNote>
      ) : (
        <div className="table-wrap">
          <table className="kinds-table" ref={table}>
            <thead>
              <tr>
                {canManage && (
                  <th className="kind-check">
                    <input
                      type="checkbox"
                      aria-label="Select all shown kinds"
                      aria-disabled={shown.length === 0 || undefined}
                      checked={allPicked}
                      ref={(box) => { if (box) box.indeterminate = picked.size > 0 && !allPicked; }} // no attribute for it: a property, set on every render
                      onChange={toggleAll}
                    />
                  </th>
                )}
                <th>Name</th><th>Assets</th>{canManage && <th className="kind-actions"></th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.id} data-kind-id={row.id} className={picked.has(row.id) ? "is-picked" : undefined}>
                  {canManage && (
                    <td className="kind-check">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.name}`}
                        checked={picked.has(row.id)}
                        onChange={() => undefined} // the click is read in onClick, which knows the Shift key
                        onClick={(event) => onRowClick(row.id, event)}
                        onKeyDown={(event) => onRowKey(row.id, event)}
                        onMouseDown={onRowMouseDown}
                      />
                    </td>
                  )}
                  <td>
                    <span className="kind-cell">
                      <span className="kind-tile" aria-hidden="true"><Icon name={assetIcon({ kind: row.name, kind_icon: row.icon })} /></span>
                      <span className="kind-label" title={row.name}>{row.name}</span>
                      {/* Beside the label, not in it: the label's whole text is the kind's name (the e2e rows are found by it). The server decides who is a starter. */}
                      {row.starter && <span className="role-badge kind-starter">Starter</span>}
                    </span>
                  </td>
                  <td className={row.asset_count === 0 ? "kind-assets muted" : "kind-assets"}>{countText(row.asset_count)}</td>
                  {canManage && <td className="kind-actions"><RowActions label={`Actions for ${row.name}`} items={actionsOf(row)} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <p className="muted kinds-none">No kinds match this filter.</p>}
        </div>
      )}
      {dialog?.kind === "new" && (
        <Modal title="New kind" onClose={closeDialog}>
          <KindForm kinds={kinds} onSubmit={(body) => create(body as AssetKindIn)} onCancel={closeDialog} />
        </Modal>
      )}
      {dialog?.kind === "edit" && (
        <Modal title="Edit kind" onClose={closeDialog}>
          <KindForm initial={dialog.row} kinds={kinds} onSubmit={(body) => edit(dialog.row, body)} onCancel={closeDialog} />
        </Modal>
      )}
      {bulk !== null && <BulkDeleteKindsDialog rows={bulkRows} all={kinds} onDone={onBulkDone} onCancel={closeBulk} />}
      {deleting && (
        <DeleteKindDialog row={deleting} others={others} target={chosen?.id ?? null} notice={changed} onTarget={(id) => { setChanged(null); setTarget(id); }} onConfirm={() => removed(deleting)} onCancel={() => setDeleting(null)} />
      )}
    </div>
  );
}
