import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { keys } from "../../api/queries";
import type { GraphSource } from "../../api/types";
import { useAction } from "../../hooks/useAction";
import { useJob } from "../../hooks/useJob";
import { JobStatus } from "../JobStatus";

interface Props {
  source: GraphSource;
  /** Admins only: saving credentials and browsing change the source. */
  canEdit: boolean;
  onClose: () => void;
}

/** Facts about one source, and for admins the way to give it credentials (or browse it again). Never shows a stored secret. */
export function SourcePanel({ source, canEdit, onClose }: Props) {
  const queryClient = useQueryClient();
  const { run, busy, error } = useAction();
  const [secret, setSecret] = useState("");
  const [username, setUsername] = useState(typeof source.config.username === "string" ? source.config.username : "");
  const [jobId, setJobId] = useState<number | null>(null);
  // JobStatus polls the same query, so this adds no requests; it only lets us react once the browse has ended.
  const { job } = useJob(jobId);
  const finished = job !== null && (job.status === "done" || job.status === "failed");
  useEffect(() => {
    if (jobId === null || !finished) return;
    void Promise.all([keys.graph, keys.sources].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  }, [jobId, finished, queryClient]);

  const browse = () => run(async () => {
    const { job_id } = await api.post<{ job_id: number }>(`/api/sources/${source.id}/browse`);
    setJobId(job_id);
  });
  const saveAndBrowse = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const config = { ...source.config, ...(username ? { username } : {}) };
      // An empty secret is left out: sending "" would erase the stored one.
      await api.patch(`/api/sources/${source.id}`, { ...(secret ? { secret } : {}), config });
      setSecret("");
      const { job_id } = await api.post<{ job_id: number }>(`/api/sources/${source.id}/browse`);
      setJobId(job_id);
    });
  };

  return (
    <aside className="panel gpanel" aria-label="Source details">
      <div className="row">
        <h2>{source.name}</h2>
        <span className="spacer" />
        <button onClick={onClose}>Close</button>
      </div>
      <p className="muted">{source.connector_type} · {source.origin} · {source.status} · {source.point_count} points</p>
      {source.last_error && <p className="error">Last error: {source.last_error}</p>}
      {source.needs_credentials && <p>This source needs credentials.</p>}
      {canEdit && source.needs_credentials && (
        <form onSubmit={saveAndBrowse}>
          <label>Secret<input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
          {source.connector_type === "opcua" && (
            <label>Username<input autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
          )}
          <div className="row"><button type="submit" disabled={busy}>Save and browse</button></div>
        </form>
      )}
      {canEdit && !source.needs_credentials && (
        <div className="row"><button onClick={browse} disabled={busy}>Browse again</button></div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {jobId !== null && <p><JobStatus jobId={jobId} /></p>}
    </aside>
  );
}
