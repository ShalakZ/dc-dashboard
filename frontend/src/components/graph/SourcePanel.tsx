import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { keys } from "../../api/queries";
import type { GraphSource } from "../../api/types";
import { useAction } from "../../hooks/useAction";
import {
  certificateLine, DIFFERENT_SERVER, isDifferentServer, isMappedNotSeen, looksLikeSentence, MAPPED_NOT_SEEN, moveOfferFor, notSeenSentence, serverLine, twoServersLine,
} from "../../lib/graph";
import { useJob } from "../../hooks/useJob";
import { JobStatus } from "../JobStatus";

interface Props {
  source: GraphSource;
  /** Whoever holds sources.edit: saving credentials and browsing change the source. */
  canEdit: boolean;
  /** When a scan last found the source, worded by the page (`seenLine`): the time needs the site's clock, and the node shows the same line. */
  seen: string;
  /** (w33) The whole sentence for an offer (`looksLikeSentence` with the time it formatted in the site's zone); without it the panel words the offer without a time. */
  looks?: string;
  /** (w33) Open the move dialog for the old source this one looks like (the page gives it only to a person who may edit sources, and only while there is an offer). */
  onMoveSource?: () => void;
  onClose: () => void;
}

/** Facts about one source, and, for someone who may edit sources, the way to give it credentials (or browse it again). Never shows a stored secret. */
export function SourcePanel({ source, canEdit, seen, looks, onMoveSource, onClose }: Props) {
  const queryClient = useQueryClient();
  const { run, busy, error } = useAction();
  const heading = useRef<HTMLHeadingElement>(null);
  const [secret, setSecret] = useState("");
  const [username, setUsername] = useState(typeof source.config.username === "string" ? source.config.username : "");
  const [jobId, setJobId] = useState<number | null>(null);
  // JobStatus polls the same query, so this adds no requests; it only lets us react once the browse has ended.
  const { job } = useJob(jobId);
  const finished = job !== null && (job.status === "done" || job.status === "failed");
  useEffect(() => {
    if (jobId === null || !finished) return;
    void Promise.all([keys.graph, keys.sources, keys.secretKey].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  }, [jobId, finished, queryClient]);

  // Opening the panel (from a click or from a node's Details button) puts the keyboard where the new content is.
  useEffect(() => { heading.current?.focus(); }, []);

  const browse = () => run(async () => {
    const { job_id } = await api.post<{ job_id: number }>(`/api/sources/${source.id}/browse`);
    setJobId(job_id);
  });
  const saveAndBrowse = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const config = { ...source.config, ...(username ? { username } : {}) };
      // An empty secret is left out: sending "" would erase the stored one.
      // (w33) `config` replaces the stored one as a whole, so it carries `expect_config`, the masked config this panel was opened with (unchanged): the server answers
      // 409 "This source was changed since you opened it ..." (shown in the error line below) when the source was moved since, instead of writing the old address back.
      await api.patch(`/api/sources/${source.id}`, { ...(secret ? { secret } : {}), config, expect_config: source.config });
      setSecret("");
      const { job_id } = await api.post<{ job_id: number }>(`/api/sources/${source.id}/browse`);
      setJobId(job_id);
    });
  };

  // (w33) What the source's server said about itself, as the scan or a Test learned it: read-only, nothing at all while it is not known.
  const server = serverLine(source.identity);
  const certificate = certificateLine(source.identity);
  // (w33) What the scan and the checks learned about a move: the source looks like an old one that stopped answering (with the Move... button for a person who may edit sources),
  // two old ones could be it, or another server answers at its address. The name hint is not shown here: the move dialog offers the name when it moves.
  const offer = moveOfferFor(source);
  const two = twoServersLine(source);

  return (
    <aside
      className="panel gpanel"
      aria-label="Source details"
      onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
    >
      <div className="row">
        <h2 ref={heading} tabIndex={-1}>{source.name}</h2>
        <span className="spacer" />
        <button className="quiet" onClick={onClose}>Close</button>
      </div>
      <p className="muted">{source.connector_type} · {source.origin} · {source.status} · {source.point_count} points</p>
      <p className="muted gsrc-fact">{notSeenSentence(source, seen)}</p>
      {isMappedNotSeen(source) && <p className="muted">{MAPPED_NOT_SEEN}</p>}
      {server && <p className="muted gsrc-fact">{server}</p>}
      {certificate && <p className="muted gsrc-fact" title={certificate.title}>{certificate.text}</p>}
      {isDifferentServer(source) && <p className="warning gsrc-fact">{DIFFERENT_SERVER}</p>}
      {offer && <p className="muted gsrc-fact">{looks ?? looksLikeSentence(offer)}</p>}
      {offer && canEdit && onMoveSource && (
        <div className="row"><button type="button" aria-label={`Move ${offer.from_name} to this address...`} onClick={onMoveSource}>Move...</button></div>
      )}
      {two && <p className="muted gsrc-fact">{two}</p>}
      {source.last_error && <p className="error">Last error: {source.last_error}</p>}
      {source.needs_credentials && <p>This source needs credentials.</p>}
      {canEdit && source.needs_credentials && (
        <form onSubmit={saveAndBrowse}>
          <label>Secret<input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
          {source.connector_type === "opcua" && (
            <label>Username<input autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
          )}
          <div className="row"><button type="submit" className="primary" disabled={busy}>Save and browse</button></div>
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
