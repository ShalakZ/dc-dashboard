import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api/client";
import { keys, useAssets, useInvalidate } from "../api/queries";
import type { AssetIn } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { AssetForm } from "../components/AssetForm";
import { AssetTree } from "../components/AssetTree";
import { buildTree, descendantIds } from "../lib/tree";

export function AssetsPage() {
  const { hasRole } = useAuth();
  const { data: assets = [], error, isLoading } = useAssets();
  const invalidate = useInvalidate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("selected") ? Number(params.get("selected")) : null;
  const [mode, setMode] = useState<"none" | "add" | "edit">("none");
  const tree = useMemo(() => buildTree(assets), [assets]);
  const selected = assets.find((a) => a.id === selectedId) ?? null;

  const finish = async () => { await invalidate(keys.assets); setMode("none"); };
  const create = async (body: AssetIn) => { await api.post("/api/assets", body); await finish(); };
  const update = async (body: AssetIn) => { await api.patch(`/api/assets/${selected!.id}`, body); await finish(); };
  const remove = async () => {
    if (!selected || !window.confirm(`Delete "${selected.name}" and its mappings?`)) return;
    await api.del(`/api/assets/${selected.id}`);
    setParams({});
    await finish();
  };

  if (isLoading) return <p className="muted">loading…</p>;
  if (error) return <p className="error" role="alert">{error.message}</p>;
  return (
    <>
      <h1>Assets</h1>
      {assets.length === 0 && <p className="muted">No assets yet.</p>}
      <AssetTree nodes={tree} selectedId={selectedId} onSelect={(id) => setParams({ selected: String(id) })} />
      {selected && <p>Selected: <Link to={`/assets/${selected.id}`}>{selected.name}</Link> (open page)</p>}
      {hasRole("admin") && mode === "none" && (
        <div className="row">
          <button onClick={() => setMode("add")}>Add asset</button>
          {selected && <button onClick={() => setMode("edit")}>Edit</button>}
          {selected && <button onClick={remove}>Delete</button>}
        </div>
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
