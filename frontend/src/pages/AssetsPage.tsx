import { useMemo, useState, type ReactNode } from "react";
import { Outlet, useMatch, useNavigate, useOutletContext } from "react-router";
import { api } from "../api/client";
import { keys, loadAssetImpact, useAssetKinds, useAssets, useCreateAssetKind, useInvalidate } from "../api/queries";
import type { Asset, AssetImpact, AssetIn, AssetKind } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { AssetForm } from "../components/AssetForm";
import { AssetTree } from "../components/AssetTree";
import { ImpactDeleteDialog } from "../components/ImpactDeleteDialog";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { TrashButton } from "../components/TrashButton";
import { kindIconId } from "../lib/assetIcons";
import { assetDeletePath, assetImpact, assetLoss } from "../lib/impact";
import { buildTree, descendantIds, parseAssetId } from "../lib/tree";

/** Inline SVG, 24-unit viewBox, drawn with the 1.7 stroke of `svg.i`; decoration only (the text beside it is the name). */
function Icon({ children }: { children: ReactNode }) {
  return <svg className="i" viewBox="0 0 24 24" aria-hidden="true">{children}</svg>;
}

/** The registry while it is not there (loading, or failed to load): the dialog then offers the default kind and the asset's own. */
const NO_KINDS: AssetKind[] = [];

/** What the workspace layout hands to the page in its pane (the fleet summary and the asset page). */
export interface AssetsContext {
  /** assets.edit: Add asset, Edit and the tree's +. */
  canEdit: boolean;
  /** assets.delete: the trash. */
  canDelete: boolean;
  /** A delete confirmation is open, or the asset list or the kinds registry has not arrived: no form may open next to it, and none without the lists it shows. */
  locked: boolean;
  /** The Add asset dialog; null = top level. */
  openAdd: (parentId: number | null) => void;
  /** Edits the asset in the URL. */
  openEdit: () => void;
  /** Deletes the asset in the URL: the confirmation (which first asks the server what goes with it), then back to /assets. */
  remove: () => void;
}

/** Null when a page renders outside the workspace (a test that mounts it alone). */
export function useAssetsContext(): AssetsContext | null {
  return useOutletContext<AssetsContext | null>() ?? null;
}

/**
 * The buttons a person may use in a page header, Add asset (the page's one primary) last; nothing when there is none. `asset` is the asset
 * the page shows: Edit (assets.edit) and Delete (assets.delete, the labelled trash, named for the asset) exist only then, and Add asset (assets.edit)
 * adds under it. Null on the fleet summary: Add asset adds a top-level asset.
 */
export function assetActions(ctx: AssetsContext | null, asset: { id: number; name: string } | null): ReactNode {
  if (!ctx) return undefined;
  const edit = ctx.canEdit;
  const del = ctx.canDelete && asset !== null;
  if (!edit && !del) return undefined; // no empty actions slot
  return (
    <>
      {asset && edit && <button type="button" onClick={ctx.openEdit} disabled={ctx.locked}><Icon><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" /><path d="m14 7 3 3" /></Icon>Edit</button>}
      {asset && del && <TrashButton labelled label={`Delete ${asset.name}`} onClick={ctx.remove} disabled={ctx.locked} />}
      {edit && <button type="button" className="primary" onClick={() => ctx.openAdd(asset?.id ?? null)} disabled={ctx.locked}><Icon><path d="M12 5v14M5 12h14" /></Icon>Add asset</button>}
    </>
  );
}

/**
 * The layout route of the Assets workspace: the tree column beside the pane, which shows `/assets` (the index) or `/assets/:id` (an
 * asset). The selected asset is the one in the URL, so a click in the tree is a navigation and the tree never remounts between pages.
 * The dialogs live here, and the pages open them through the outlet context.
 */
export function AssetsPage() {
  const { can } = useAuth();
  const { data: assets = [], error, isLoading } = useAssets();
  // The Kind select lists the registry. A failure is not fatal (the dialog opens with NO_KINDS); only the wait is, like the asset list's.
  const { data: kinds = NO_KINDS, isLoading: kindsLoading } = useAssetKinds(can("assets.view"));
  const createKind = useCreateAssetKind();
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const toast = useToast();
  const selectedId = parseAssetId(useMatch("/assets/:id")?.params.id); // null for a URL that cannot be an asset's: nothing is selected
  const [dialog, setDialog] = useState<{ kind: "add"; parentId: number | null } | { kind: "edit" } | null>(null);
  // The asset whose delete confirmation is open. It opens at once (the trash is the only way in) and asks the server what goes with it.
  const [deleting, setDeleting] = useState<Asset | null>(null);
  const tree = useMemo(() => buildTree(assets), [assets]);
  const selected = assets.find((a) => a.id === selectedId) ?? null;
  // While the delete confirmation is open, no form may open next to it (two dialogs would share Escape and the focus trap);
  // and none opens before the lists are there: the form's parent picker needs the assets and its Kind select the registry
  // (`isLoading`, not `isPending`: a query that is not enabled stays pending for ever).
  const locked = deleting !== null || isLoading || kindsLoading;
  const openAdd = (parentId: number | null) => { if (!locked) setDialog({ kind: "add", parentId }); };
  const openEdit = () => { if (!locked) setDialog({ kind: "edit" }); };

  const closeDialog = () => setDialog(null);
  // The fleet figures (counts, sums, the attention list) change with every asset change.
  // `newKind`: the kind the dialog said it would add to the registry. That happens after the asset is saved (never a kind with no asset
  // behind it) and before the lists are refreshed, so the first refetch already carries the kind's icon. Best effort: the asset is saved
  // either way and falls back to the keyword guess, so every failure (a 409 from a race included) is swallowed. The kind request refreshes
  // the assets, the fleet and the audit log itself, whether it worked or not; asking again here would only repeat it.
  const finish = async (newKind: string | null = null) => {
    if (newKind === null) {
      await invalidate(keys.assets, keys.fleet);
    } else {
      try { await createKind.mutateAsync({ name: newKind, icon: kindIconId(newKind) }); } catch { /* see above */ }
    }
    setDialog(null);
  };
  const create = async (body: AssetIn, registerKind: boolean) => {
    await api.post("/api/assets", body);
    toast.success("Asset created"); // right after the request: the dialog closes and the tree is the only other sign (an edit needs no word)
    await finish(registerKind ? body.kind : null);
  };
  const update = async (body: AssetIn, registerKind: boolean) => {
    await api.patch(`/api/assets/${selected!.id}`, body);
    await finish(registerKind ? body.kind : null);
  };
  // `seen`: the counts the dialog showed; the server refuses (and the dialog shows the new numbers) if more would go now.
  const removed = async (asset: Asset, seen: AssetImpact) => {
    await api.del(assetDeletePath(asset.id, seen));
    // Right after the request, before the bookkeeping: a failing refresh must not swallow the one confirmation the person gets.
    toast.success(`Asset "${asset.name}" deleted`);
    setDeleting(null);
    // Leave the page first: refreshing the asset list refetches every asset query that is still mounted, including this asset's summary, which would flash a 404.
    navigate("/assets");
    // Its sums, its widgets' figures and its rate overrides (deleted with it) are on other pages' caches too.
    await Promise.all([finish(), invalidate(keys.billing, keys.widgetData, keys.tariffs)]);
  };
  const remove = () => { if (selected && !locked) setDeleting(selected); };

  if (error) return <p className="error" role="alert">{error.message}</p>;
  const canEdit = can("assets.edit");
  const context: AssetsContext = { canEdit, canDelete: can("assets.delete"), locked, openAdd, openEdit, remove };
  return (
    <>
      <div className="assets-layout">
        <AssetTree
          nodes={tree}
          selectedId={selectedId}
          onAddChild={canEdit ? openAdd : undefined}
          onAddTop={canEdit ? () => openAdd(null) : undefined}
          disabled={locked}
          loading={isLoading}
        />
        <div className="assets-detail" id="asset-detail" tabIndex={-1}>
          <Outlet context={context} />
        </div>
      </div>
      {deleting && (
        <ImpactDeleteDialog<AssetImpact>
          title={`Delete "${deleting.name}"?`}
          queryKey={["impact", "asset", deleting.id]}
          load={() => loadAssetImpact(deleting.id)}
          loss={assetLoss}
          isPlain={(impact) => impact.assets === 1 && impact.mappings === 0 && impact.tariffs === 0}
          plainMessage="This can't be undone."
          grown={assetImpact}
          onConfirm={(seen) => removed(deleting, seen)}
          onCancel={() => setDeleting(null)}
        />
      )}
      {dialog?.kind === "add" && (
        <Modal title="Add asset" onClose={closeDialog}>
          <AssetForm key={dialog.parentId ?? "none"} assets={assets} kinds={kinds} initial={{ parent_id: dialog.parentId }} excludeIds={new Set()} onSubmit={create} onCancel={closeDialog} />
        </Modal>
      )}
      {dialog?.kind === "edit" && selected && (
        <Modal title="Edit asset" onClose={closeDialog}>
          <AssetForm assets={assets} kinds={kinds} initial={selected} excludeIds={descendantIds(tree, selected.id)} onSubmit={update} onCancel={closeDialog} />
        </Modal>
      )}
    </>
  );
}
