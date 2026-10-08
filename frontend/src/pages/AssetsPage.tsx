import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api/client";
import { keys, useAssets, useInvalidate } from "../api/queries";
import type { Asset, AssetImpact, AssetIn } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { AssetForm } from "../components/AssetForm";
import { AssetTree } from "../components/AssetTree";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { useAction } from "../hooks/useAction";
import { assetImpact, assetLoss } from "../lib/impact";
import { buildTree, descendantIds } from "../lib/tree";

export function AssetsPage() {
  const { hasRole } = useAuth();
  const { data: assets = [], error, isLoading } = useAssets();
  const invalidate = useInvalidate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("selected") ? Number(params.get("selected")) : null;
  const [mode, setMode] = useState<"none" | "add" | "edit">("none");
  const [confirming, setConfirming] = useState<{ asset: Asset; impact: AssetImpact } | null>(null);
  const tree = useMemo(() => buildTree(assets), [assets]);
  const selected = assets.find((a) => a.id === selectedId) ?? null;
  const { run, error: actionError } = useAction();

  const finish = async () => { await invalidate(keys.assets); setMode("none"); };
  const create = async (body: AssetIn) => { await api.post("/api/assets", body); await finish(); };
  const update = async (body: AssetIn) => { await api.patch(`/api/assets/${selected!.id}`, body); await finish(); };
  const removed = async (asset: Asset, confirm: boolean) => {
    await api.del(`/api/assets/${asset.id}${confirm ? "?confirm=true" : ""}`);
    setConfirming(null);
    setParams({});
    await finish();
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
  return (
    <>
      <h1>Assets</h1>
      {assets.length === 0 && <p className="muted">No assets yet.</p>}
      <AssetTree nodes={tree} selectedId={selectedId} onSelect={(id) => setParams({ selected: String(id) })} />
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {selected && <p>Selected: <Link to={`/assets/${selected.id}`}>{selected.name}</Link> (open page)</p>}
      {hasRole("admin") && mode === "none" && (
        <div className="row">
          <button onClick={() => setMode("add")}>Add asset</button>
          {selected && <button onClick={() => setMode("edit")}>Edit</button>}
          {selected && <button onClick={remove}>Delete</button>}
        </div>
      )}
      {confirming && (
        <ConfirmDeleteDialog
          title={`Delete "${confirming.asset.name}"?`}
          message={assetLoss(confirming.impact)}
          onConfirm={() => removed(confirming.asset, true)}
          onCancel={() => setConfirming(null)}
        />
      )}
      {mode === "add" && (
        <AssetForm assets={assets} initial={{ parent_id: selectedId }} excludeIds={new Set()} onSubmit={create} onCancel={() => setMode("none")} />
      )}
      {mode === "edit" && selected && (
        <AssetForm assets={assets} initial={selected} excludeIds={descendantIds(tree, selected.id)} onSubmit={update} onCancel={() => setMode("none")} />
      )}
    </>
  );
}
