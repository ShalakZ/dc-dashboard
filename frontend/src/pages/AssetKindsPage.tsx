import { useState, type ReactNode } from "react";
import { useAssetKinds, useCreateAssetKind, useDeleteAssetKind, usePatchAssetKind } from "../api/queries";
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
import { upperFirst } from "../lib/upperFirst";

const CRUMBS = [{ label: "Assets Tree", to: "/assets" }, { label: "Asset kinds" }];

const countText = (n: number) => (n === 0 ? "No assets" : n === 1 ? "1 asset" : `${n} assets`);
const renamedText = (n: number) => (n === 0 ? "Kind renamed" : n === 1 ? "Kind renamed, 1 asset follows" : `Kind renamed, ${n} assets follow`);
const inUseText = ({ name, asset_count: n }: AssetKind) =>
  n === 1 ? `1 asset uses "${name}", so it can't be deleted. Change its kind first.` : `${n} assets use "${name}", so it can't be deleted. Change their kind first.`;

/** The server's words with a capital (its 404 is written in lower case); the form and the confirmation show a thrown message as it is. */
async function worded<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (e) {
    throw e instanceof Error ? new Error(upperFirst(e.message)) : e;
  }
}

/**
 * Asset kinds: what each kind of asset looks like. An asset with no icon of its own shows its kind's icon, so changing one here changes
 * every asset of that kind. A child of the Assets workspace (the tree stays beside it). Everyone who may open Assets reads the list;
 * assets.edit adds New kind and the row menu (Edit, Delete). A kind that assets still use cannot be deleted: the dialog says why.
 */
export function AssetKindsPage() {
  const { can } = useAuth();
  const canEdit = can("assets.edit");
  // No `enabled` flag: the route is behind assets.view, so a role that gets here may read the list.
  const { data, error, isLoading } = useAssetKinds();
  const createKind = useCreateAssetKind();
  const patchKind = usePatchAssetKind();
  const deleteKind = useDeleteAssetKind();
  const toast = useToast();
  // The kind as it was when Edit or Delete was chosen, not a lookup into the list: a refetch gives the list new objects, and the open form must not change under the person typing.
  const [dialog, setDialog] = useState<{ kind: "new" } | { kind: "edit"; row: AssetKind } | null>(null);
  const [deleting, setDeleting] = useState<AssetKind | null>(null);
  const locked = deleting !== null; // no second dialog next to the confirmation (two would share Escape and the focus trap)
  const closeDialog = () => setDialog(null);

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
  const removed = async (row: AssetKind) => {
    await worded(deleteKind.mutateAsync(row.id));
    toast.success(`Kind "${row.name}" deleted`);
    setDeleting(null);
  };

  const header = (actions: ReactNode) => (
    <PageHeader
      title="Asset kinds"
      crumbs={CRUMBS}
      sub={<>The icon an asset shows when it has none of its own <InfoTip>An asset without an icon of its own shows its kind's icon. Change a kind's icon here and every asset of that kind follows.</InfoTip></>}
      actions={actions}
    />
  );

  if (isLoading) {
    return (
      <div className="kinds-page">
        {header(canEdit ? <ActionsSpace /> : undefined)}
        <TableSkeleton columns={canEdit ? 3 : 2} rows={5} label="Loading asset kinds" />
      </div>
    );
  }
  if (error && data === undefined) {
    return <div className="kinds-page">{header(undefined)}<p className="error" role="alert">{error.message}</p></div>;
  }
  const kinds = data ?? [];
  const actionsOf = (row: AssetKind): RowAction[] => [
    { label: "Edit", disabled: locked, onSelect: () => setDialog({ kind: "edit", row }) },
    { label: "Delete", tone: "danger", disabled: locked, onSelect: () => setDeleting(row) },
  ];
  return (
    <div className="kinds-page">
      {header(canEdit ? <button type="button" className="primary" disabled={locked} onClick={() => setDialog({ kind: "new" })}>New kind</button> : undefined)}
      {error && <p className="error" role="alert">{error.message}</p>}
      {kinds.length === 0 ? (
        <EmptyNote icon="layers">No kinds yet.</EmptyNote>
      ) : (
        <div className="table-wrap">
          <table className="kinds-table">
            <thead><tr><th>Name</th><th>Assets</th>{canEdit && <th className="kind-actions"></th>}</tr></thead>
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
                  {canEdit && <td className="kind-actions"><RowActions label={`Actions for ${row.name}`} items={actionsOf(row)} /></td>}
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
        <ConfirmDeleteDialog
          title={`Delete the kind "${deleting.name}"?`}
          message={deleting.asset_count === 0 ? "Assets that carry the name later get an automatic icon." : ""}
          loadError={deleting.asset_count > 0 ? inUseText(deleting) : undefined}
          confirmLabel="Delete"
          onConfirm={() => removed(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
