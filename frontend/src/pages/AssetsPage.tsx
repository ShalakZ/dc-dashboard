import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
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
import { buildTree, descendantIds } from "../lib/tree";

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
          <header className="page-head"><h1>Assets</h1></header>
          {assets.length === 0 && <p className="muted">No assets yet.</p>}
          {actionError && <p className="error" role="alert">{actionError}</p>}
          {selected && (
            <dl className="detail-meta">
              <div><dt>Kind</dt><dd>{selected.kind}</dd></div>
              <div><dt>Parent</dt><dd>{parent ? parent.name : "None"}</dd></div>
              <div><dt>Children</dt><dd>{assets.filter((a) => a.parent_id === selected.id).length}</dd></div>
            </dl>
          )}
          {selected && <p>Selected: <Link to={`/assets/${selected.id}`}>{selected.name}</Link> (open page)</p>}
          {admin && (
            <div className="row">
              <button onClick={() => openAdd(selectedId)} disabled={locked}>Add asset</button>
              {selected && <button onClick={openEdit} disabled={locked}>Edit</button>}
              {selected && <button onClick={remove} disabled={locked}>Delete</button>}
            </div>
          )}
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
