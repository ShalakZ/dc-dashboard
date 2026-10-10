import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api/client";
import { keys, useAssets, useInvalidate, usePoints, useSources } from "../api/queries";
import type { PointRow } from "../api/types";
import { assetLabels } from "../components/dashboard/AssetPicker";
import { JobStatus } from "../components/JobStatus";
import { MappingForm, type MappingBody } from "../components/MappingForm";
import { Modal } from "../components/Modal";
import { useAction } from "../hooks/useAction";
import { DEFAULT_POINT_VIEW, sortBy, viewPoints, type PointSortKey } from "../lib/points";

const NO_POINTS: PointRow[] = [];
const COLUMNS: ReadonlyArray<readonly [PointSortKey, string]> = [
  ["address", "Address"], ["name", "Name"], ["data_type", "Type"], ["unit_hint", "Unit hint"], ["mapped", "Mapped to"],
];
// A header that sorts is a plain button that looks like the header text.
const HEADER_BUTTON = { border: "none", background: "none", padding: 0, font: "inherit", fontWeight: 700, textAlign: "left" } as const;
const CHECK_LABEL = { display: "flex", gap: 6, alignItems: "center" } as const;

export function SourcePointsPage() {
  const sourceId = Number(useParams().id);
  const { data, error, isLoading } = usePoints(sourceId);
  const points = data ?? NO_POINTS;
  const { data: assets = [] } = useAssets();
  const { data: sources } = useSources();
  const sourceName = sources?.find((s) => s.id === sourceId)?.name ?? `source ${sourceId}`;
  const invalidate = useInvalidate();
  const [browseJob, setBrowseJob] = useState<number | null>(null);
  const [editing, setEditing] = useState<PointRow | null>(null);
  const [view, setView] = useState(DEFAULT_POINT_VIEW);
  const labels = useMemo(() => assetLabels(assets), [assets]);
  const assetName = useCallback((id: number) => labels.get(id) ?? `#${id}`, [labels]);
  const rows = useMemo(() => viewPoints(points, assetName, view), [points, assetName, view]);
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
  // A failed refetch keeps the table (and an open form) and shows the error above it; only a failed first load has nothing to show.
  if (error && !data) return <p className="error" role="alert">{error.message}</p>;
  return (
    <>
      <p><Link to="/sources">Sources</Link> / {sourceName}</p>
      <h1>Points</h1>
      <div className="row">
        <button onClick={browse}>Browse points</button>
        <JobStatus jobId={browseJob} />
        {browseJob !== null && <button onClick={() => invalidate(keys.points(sourceId))}>Refresh list</button>}
      </div>
      {error && <p className="error" role="alert">{error.message}</p>}
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {points.length === 0 && <p className="muted">No points yet. Browse the source to discover them.</p>}
      {points.length > 0 && (
        <div className="row">
          <label style={CHECK_LABEL}>
            <input type="checkbox" checked={view.unmappedOnly} onChange={(e) => setView({ ...view, unmappedOnly: e.target.checked })} />
            Unmapped only
          </label>
          <input type="search" aria-label="Search points" placeholder="Search points" value={view.query}
            onChange={(e) => setView({ ...view, query: e.target.value })} />
          <span className="muted">{`Showing ${rows.length} of ${points.length} point${points.length === 1 ? "" : "s"}`}</span>
        </div>
      )}
      {points.length > 0 && rows.length === 0 && <p className="muted">No points match the filters.</p>}
      <table>
        <thead>
          <tr>
            {COLUMNS.map(([key, label]) => (
              <th key={key} aria-sort={view.sort === key ? (view.dir === "asc" ? "ascending" : "descending") : undefined}>
                <button type="button" style={HEADER_BUTTON} onClick={() => setView(sortBy(view, key))}>
                  {label}{view.sort === key && <span aria-hidden="true"> {view.dir === "asc" ? "▲" : "▼"}</span>}
                </button>
              </th>
            ))}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
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
        <Modal title={`${editing.mapping ? "Edit mapping" : "Map"} ${editing.address}`} onClose={() => setEditing(null)}>
          <MappingForm key={editing.id} assets={assets} initial={editing.mapping ?? undefined} unitHint={editing.unit_hint}
            onSubmit={save} onCancel={() => setEditing(null)} />
        </Modal>
      )}
    </>
  );
}
