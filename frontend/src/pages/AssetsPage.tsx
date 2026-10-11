import { useMemo, useState, type ReactNode } from "react";
import { Outlet, useMatch, useNavigate, useOutletContext } from "react-router";
import { api } from "../api/client";
import { keys, useAssets, useInvalidate } from "../api/queries";
import type { Asset, AssetImpact, AssetIn } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { AssetForm } from "../components/AssetForm";
import { AssetTree } from "../components/AssetTree";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { Modal } from "../components/Modal";
import { useAction } from "../hooks/useAction";
import { assetImpact, assetLoss } from "../lib/impact";
import { buildTree, descendantIds, parseAssetId } from "../lib/tree";

/** Inline SVG, 24-unit viewBox, drawn with the 1.7 stroke of `svg.i`; decoration only (the text beside it is the name). */
function Icon({ children }: { children: ReactNode }) {
  return <svg className="i" viewBox="0 0 24 24" aria-hidden="true">{children}</svg>;
}

/** What the workspace layout hands to the page in its pane (the fleet summary and the asset page). */
export interface AssetsContext {
  admin: boolean;
  /** A delete is running or awaiting its confirmation: no form may open next to it. */
  locked: boolean;
  /** The Add asset dialog; null = top level. */
  openAdd: (parentId: number | null) => void;
  /** Edits the asset in the URL. */
  openEdit: () => void;
  /** Deletes the asset in the URL: the confirmation, the API's impact check, then back to /assets. */
  remove: () => void;
}

/** Null when a page renders outside the workspace (a test that mounts it alone). */
export function useAssetsContext(): AssetsContext | null {
  return useOutletContext<AssetsContext | null>() ?? null;
}

/**
 * The admin's buttons for a page header, Add asset (the page's one primary) last; nothing for anyone else. `assetId` is the asset the
 * page shows: Edit and Delete exist only then, and Add asset adds under it. Null on the fleet summary: Add asset adds a top-level asset.
 */
export function assetActions(ctx: AssetsContext | null, assetId: number | null): ReactNode {
  if (!ctx?.admin) return undefined;
  return (
    <>
      {assetId !== null && <button type="button" onClick={ctx.openEdit} disabled={ctx.locked}><Icon><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" /><path d="m14 7 3 3" /></Icon>Edit</button>}
      {assetId !== null && <button type="button" className="danger-quiet" onClick={ctx.remove} disabled={ctx.locked}>Delete</button>}
      <button type="button" className="primary" onClick={() => ctx.openAdd(assetId)} disabled={ctx.locked}><Icon><path d="M12 5v14M5 12h14" /></Icon>Add asset</button>
    </>
  );
}

/**
 * The layout route of the Assets workspace: the tree column beside the pane, which shows `/assets` (the index) or `/assets/:id` (an
 * asset). The selected asset is the one in the URL, so a click in the tree is a navigation and the tree never remounts between pages.
 * The dialogs live here, and the pages open them through the outlet context.
 */
export function AssetsPage() {
  const { hasRole } = useAuth();
  const { data: assets = [], error, isLoading } = useAssets();
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const selectedId = parseAssetId(useMatch("/assets/:id")?.params.id); // null for a URL that cannot be an asset's: nothing is selected
  const [dialog, setDialog] = useState<{ kind: "add"; parentId: number | null } | { kind: "edit" } | null>(null);
  const [confirming, setConfirming] = useState<{ asset: Asset; impact: AssetImpact } | null>(null);
  const tree = useMemo(() => buildTree(assets), [assets]);
  const selected = assets.find((a) => a.id === selectedId) ?? null;
  const { run, busy, error: actionError } = useAction();
  // While a delete runs or its confirmation is open, no form may open next to it (two dialogs would share Escape and the focus trap).
  const locked = busy || confirming !== null;
  const openAdd = (parentId: number | null) => { if (!locked) setDialog({ kind: "add", parentId }); };
  const openEdit = () => { if (!locked) setDialog({ kind: "edit" }); };

  const closeDialog = () => setDialog(null);
  // The fleet figures (counts, sums, the attention list) change with every asset change.
  const finish = async () => { await invalidate(keys.assets, keys.fleet); setDialog(null); };
  const create = async (body: AssetIn) => { await api.post("/api/assets", body); await finish(); };
  const update = async (body: AssetIn) => { await api.patch(`/api/assets/${selected!.id}`, body); await finish(); };
  const removed = async (asset: Asset, confirm: boolean) => {
    await api.del(`/api/assets/${asset.id}${confirm ? "?confirm=true" : ""}`);
    setConfirming(null);
    // Leave the page first: refreshing the asset list refetches every asset query that is still mounted, including this asset's summary, which would flash a 404.
    navigate("/assets");
    // Its sums, its widgets' figures and its rate overrides (deleted with it) are on other pages' caches too.
    await Promise.all([finish(), invalidate(keys.billing, keys.widgetData, keys.tariffs)]);
  };
  const remove = () => run(async () => {
    if (!selected || !window.confirm(`Delete "${selected.name}" and its mappings?`)) return;
    try {
      await removed(selected, false);
    } catch (e) {
      // The API refuses to delete more than this one row without being told to: ask, then repeat the request with confirm.
      const impact = assetImpact(e);
      if (!impact) throw e;
      setConfirming({ asset: selected, impact });
    }
  });

  if (isLoading) return <p className="muted">loading…</p>;
  if (error) return <p className="error" role="alert">{error.message}</p>;
  const admin = hasRole("admin");
  const context: AssetsContext = { admin, locked, openAdd, openEdit, remove };
  return (
    <>
      <div className="assets-layout">
        <AssetTree
          nodes={tree}
          selectedId={selectedId}
          onAddChild={admin ? openAdd : undefined}
          onAddTop={admin ? () => openAdd(null) : undefined}
          disabled={locked}
        />
        <div className="assets-detail">
          {actionError && <p className="error" role="alert">{actionError}</p>}
          <Outlet context={context} />
        </div>
      </div>
      {confirming && (
        <ConfirmDeleteDialog
          title={`Delete "${confirming.asset.name}"?`}
          message={assetLoss(confirming.impact)}
          onConfirm={() => removed(confirming.asset, true)}
          onCancel={() => setConfirming(null)}
        />
      )}
      {dialog?.kind === "add" && (
        <Modal title="Add asset" onClose={closeDialog}>
          <AssetForm key={dialog.parentId ?? "none"} assets={assets} initial={{ parent_id: dialog.parentId }} excludeIds={new Set()} onSubmit={create} onCancel={closeDialog} />
        </Modal>
      )}
      {dialog?.kind === "edit" && selected && (
        <Modal title="Edit asset" onClose={closeDialog}>
          <AssetForm assets={assets} initial={selected} excludeIds={descendantIds(tree, selected.id)} onSubmit={update} onCancel={closeDialog} />
        </Modal>
      )}
    </>
  );
}
