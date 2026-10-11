import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api/client";
import { keys, useAssets, useInvalidate } from "../api/queries";
import type { Asset, AssetImpact, AssetIn } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { AssetForm } from "../components/AssetForm";
import { AssetTree } from "../components/AssetTree";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { useAction } from "../hooks/useAction";
import { assetImpact, assetLoss } from "../lib/impact";
import { buildTree, descendantIds } from "../lib/tree";

/** Inline SVG, 24-unit viewBox, drawn with the 1.7 stroke of `svg.i`; decoration only (the text beside it is the name). */
function Icon({ children }: { children: ReactNode }) {
  return <svg className="i" viewBox="0 0 24 24" aria-hidden="true">{children}</svg>;
}

export function AssetsPage() {
  const { hasRole } = useAuth();
  const { data: assets = [], error, isLoading } = useAssets();
  const invalidate = useInvalidate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("selected") ? Number(params.get("selected")) : null;
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
  const finish = async () => { await invalidate(keys.assets); setDialog(null); };
  const create = async (body: AssetIn) => { await api.post("/api/assets", body); await finish(); };
  const update = async (body: AssetIn) => { await api.patch(`/api/assets/${selected!.id}`, body); await finish(); };
  const removed = async (asset: Asset, confirm: boolean) => {
    await api.del(`/api/assets/${asset.id}${confirm ? "?confirm=true" : ""}`);
    setConfirming(null);
    setParams({});
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
  const parent = selected && assets.find((a) => a.id === selected.parent_id);
  // The admin's buttons sit in the page header's actions slot, Add asset (the page's one primary) last.
  const actions = admin ? (
    <>
      {selected && <button type="button" onClick={openEdit} disabled={locked}><Icon><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" /><path d="m14 7 3 3" /></Icon>Edit</button>}
      {selected && <button type="button" className="danger-quiet" onClick={remove} disabled={locked}>Delete</button>}
      <button type="button" className="primary" onClick={() => openAdd(selectedId)} disabled={locked}><Icon><path d="M12 5v14M5 12h14" /></Icon>Add asset</button>
    </>
  ) : undefined;
  return (
    <>
      <div className="assets-layout">
        <AssetTree
          nodes={tree}
          selectedId={selectedId}
          onSelect={(id) => setParams({ selected: String(id) })}
          onAddChild={admin ? openAdd : undefined}
          onAddTop={admin ? () => openAdd(null) : undefined}
          disabled={locked}
        />
        <div className="assets-detail">
          <PageHeader title="Assets" actions={actions} />
          {assets.length === 0 && (
            <div className="empty">
              <span className="empty-icon"><Icon><path d="M12 3 3 7.5 12 12l9-4.5L12 3Z" /><path d="m3 12 9 4.5 9-4.5" /><path d="m3 16.5 9 4.5 9-4.5" /></Icon></span>
              <p className="empty-title">No assets yet.</p>
            </div>
          )}
          {actionError && <p className="error" role="alert">{actionError}</p>}
          {!selected && assets.length > 0 && <p className="muted">Select an asset in the tree.</p>}
          {selected && (
            <dl className="detail-meta">
              <div><dt>Kind</dt><dd>{selected.kind}</dd></div>
              <div><dt>Parent</dt><dd>{parent ? parent.name : "None"}</dd></div>
              <div><dt>Children</dt><dd>{assets.filter((a) => a.parent_id === selected.id).length}</dd></div>
            </dl>
          )}
          {selected && <p className="detail-open">Selected: <Link to={`/assets/${selected.id}`}>{selected.name}</Link> (open page)</p>}
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
