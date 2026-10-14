import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { useAddStarterKinds, useAssetKinds, useCreateAssetKind, useDeleteAssetKind, usePatchAssetKind } from "../api/queries";
import type { AssetKind, AssetKindIn, AssetKindPatch } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
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
import { upperFirst } from "../lib/upperFirst";

const CRUMBS = [{ label: "Assets Tree", to: "/assets" }, { label: "Asset kinds" }];

/** What a reader sees where New kind and the row menu would be: the permission is its own, so ReadOnlyNote's words ("change assets") would name the wrong thing. */
const NEED_KINDS = 'Managing asset kinds needs the "Manage asset kinds" permission.';

const countText = (n: number) => (n === 0 ? "No assets" : n === 1 ? "1 asset" : `${n} assets`);
const renamedText = (n: number) => (n === 0 ? "Kind renamed" : n === 1 ? "Kind renamed, 1 asset follows" : `Kind renamed, ${n} assets follow`);
const packText = (added: number) => (added === 0 ? "All the data-centre kinds are already there" : `Added ${added} ${added === 1 ? "kind" : "kinds"}`);
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
  const kinds = data ?? [];
  const createKind = useCreateAssetKind();
  const patchKind = usePatchAssetKind();
  const deleteKind = useDeleteAssetKind();
  const addStarter = useAddStarterKinds();
  const toast = useToast();
  // The kind as it was when Edit or Delete was chosen, not a lookup into the list: a refetch gives the list new objects, and the open form must not change under the person typing.
  const [dialog, setDialog] = useState<{ kind: "new" } | { kind: "edit"; row: AssetKind } | null>(null);
  const [deleting, setDeleting] = useState<AssetKind | null>(null);
  // Where the assets of the kind being deleted go: the id the person chose. Only kinds still in the list count, so one that vanished from a refreshed list is no choice any more.
  const [target, setTarget] = useState<number | null>(null);
  // What the server's last 409 said about the count: one line in the dialog, so a second press of Delete is a conscious one. Gone when the person
  // chooses another kind and when the next request starts.
  const [changed, setChanged] = useState<string | null>(null);
  const others = deleting ? movable(kinds, deleting.id) : [];
  const chosen = others.find((k) => k.id === target) ?? null;
  const locked = deleting !== null; // no second dialog next to the confirmation (two would share Escape and the focus trap)
  const closeDialog = () => setDialog(null);
  // After a confirmed delete the row and its menu are gone, so the dialog has nothing to give the focus back to: it goes to New kind (to the
  // heading when this person can no longer add kinds), never to the body.
  const newKindButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [deletions, setDeletions] = useState(0);
  useEffect(() => {
    if (deletions > 0) (newKindButton.current ?? heading.current)?.focus();
  }, [deletions]);

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
  const addPack = async () => {
    if (addStarter.isPending) return;
    try {
      const { added } = await addStarter.mutateAsync();
      toast.success(packText(added.length));
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

  const header = (actions: ReactNode) => (
    <PageHeader
      title="Asset kinds"
      crumbs={CRUMBS}
      sub={<>The icon an asset shows when it has none of its own <InfoTip>An asset without an icon of its own shows its kind's icon. Change a kind's icon here and every asset of that kind follows.</InfoTip></>}
      actions={actions}
      headingRef={heading}
    />
  );

  // Known from the first render (the account is loaded before any page), so drawn in the skeleton too: the table never moves down when the list arrives.
  const needNote = !canManage && <p className="muted kinds-note">{NEED_KINDS}</p>;
  if (isLoading) {
    return (
      <div className="kinds-page">
        {header(canManage ? <ActionsSpace /> : undefined)}
        {needNote}
        <TableSkeleton columns={canManage ? 3 : 2} rows={5} label="Loading asset kinds" />
      </div>
    );
  }
  if (error && data === undefined) {
    return <div className="kinds-page">{header(undefined)}<p className="error" role="alert">{error.message}</p></div>;
  }
  const actionsOf = (row: AssetKind): RowAction[] => [
    { label: "Edit", disabled: locked, onSelect: () => setDialog({ kind: "edit", row }) },
    { label: "Delete", tone: "danger", disabled: locked, onSelect: () => { setTarget(null); setChanged(null); setDeleting(row); } },
  ];
  return (
    <div className="kinds-page">
      {header(canManage ? (
        <>
          <button type="button" aria-disabled={addStarter.isPending || undefined} disabled={locked} onClick={() => void addPack()}>Add data-centre kinds</button>
          <button type="button" className="primary" ref={newKindButton} disabled={locked} onClick={() => setDialog({ kind: "new" })}>New kind</button>
        </>
      ) : undefined)}
      {needNote}
      {error && <p className="error" role="alert">{error.message}</p>}
      {kinds.length === 0 ? (
        <EmptyNote icon="layers">No kinds yet.</EmptyNote>
      ) : (
        <div className="table-wrap">
          <table className="kinds-table">
            <thead><tr><th>Name</th><th>Assets</th>{canManage && <th className="kind-actions"></th>}</tr></thead>
            <tbody>
              {kinds.map((row) => (
                <tr key={row.id}>
                  <td>
                    <span className="kind-cell">
                      <span className="kind-tile" aria-hidden="true"><Icon name={assetIcon({ kind: row.name, kind_icon: row.icon })} /></span>
                      <span className="kind-label" title={row.name}>{row.name}</span>
                    </span>
                  </td>
                  <td className={row.asset_count === 0 ? "muted" : undefined}>{countText(row.asset_count)}</td>
                  {canManage && <td className="kind-actions"><RowActions label={`Actions for ${row.name}`} items={actionsOf(row)} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
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
      {deleting && (
        <DeleteKindDialog row={deleting} others={others} target={chosen?.id ?? null} notice={changed} onTarget={(id) => { setChanged(null); setTarget(id); }} onConfirm={() => removed(deleting)} onCancel={() => setDeleting(null)} />
      )}
    </div>
  );
}
