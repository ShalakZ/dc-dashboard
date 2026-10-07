import { useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api/client";
import { keys, useAssets, useInvalidate, usePoints } from "../api/queries";
import type { PointRow } from "../api/types";
import { JobStatus } from "../components/JobStatus";
import { MappingForm, type MappingBody } from "../components/MappingForm";
import { useAction } from "../hooks/useAction";

export function SourcePointsPage() {
  const sourceId = Number(useParams().id);
  const { data: points = [], error, isLoading } = usePoints(sourceId);
  const { data: assets = [] } = useAssets();
  const invalidate = useInvalidate();
  const [browseJob, setBrowseJob] = useState<number | null>(null);
  const [editing, setEditing] = useState<PointRow | null>(null);
  const assetName = (id: number) => assets.find((a) => a.id === id)?.name ?? `#${id}`;
  const { run, error: actionError } = useAction();

  const browse = () => run(async () => {
    const { job_id } = await api.post<{ job_id: number }>(`/api/sources/${sourceId}/browse`);
    setBrowseJob(job_id);
  });
  const refresh = async () => { await invalidate(keys.points(sourceId)); setEditing(null); };
  const save = async (body: MappingBody) => {
    if (editing!.mapping) await api.patch(`/api/mappings/${editing!.mapping.id}`, body);
    else await api.post("/api/mappings", { point_id: editing!.id, ...body });
    await refresh();
  };
  const unmap = (mappingId: number) => run(async () => { await api.del(`/api/mappings/${mappingId}`); await refresh(); });

  if (isLoading) return <p className="muted">loading…</p>;
  if (error) return <p className="error" role="alert">{error.message}</p>;
  return (
    <>
      <p><Link to="/sources">Sources</Link> / source {sourceId}</p>
      <h1>Points</h1>
      <div className="row">
        <button onClick={browse}>Browse points</button>
        <JobStatus jobId={browseJob} />
        {browseJob !== null && <button onClick={() => invalidate(keys.points(sourceId))}>Refresh list</button>}
      </div>
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {points.length === 0 && <p className="muted">No points yet. Browse the source to discover them.</p>}
      <table>
        <thead><tr><th>Address</th><th>Name</th><th>Type</th><th>Unit hint</th><th>Mapped to</th><th></th></tr></thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.id}>
              <td>{p.address}</td><td>{p.name}</td><td>{p.data_type}</td><td>{p.unit_hint ?? ""}</td>
              <td>{p.mapping ? `${assetName(p.mapping.asset_id)} · ${p.mapping.metric} · every ${p.mapping.interval_seconds}s · ×${p.mapping.scale}` : <span className="muted">unmapped</span>}</td>
              <td className="row">
                <button onClick={() => setEditing(p)}>{p.mapping ? "Edit" : "Map"}</button>
                {p.mapping && <button onClick={() => unmap(p.mapping!.id)}>Unmap</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <>
          <h2>{editing.mapping ? "Edit mapping" : "Map"} {editing.address}</h2>
          <MappingForm assets={assets} initial={editing.mapping ?? undefined} onSubmit={save} onCancel={() => setEditing(null)} />
        </>
      )}
    </>
  );
}
