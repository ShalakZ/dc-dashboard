import { useState } from "react";
import { Link } from "react-router";
import { useScan } from "../api/queries";
import type { ScanDetail } from "../api/types";
import { checksText, outcomeLabel, scopeLine, statWords } from "../lib/scanText";
import { Drawer } from "./Drawer";
import { Skeleton, SkeletonRegion, TableSkeleton } from "./Skeleton";

/** The chip of a finding's outcome: read = ok, locked = warning, unidentified (or anything else) = hollow dot. */
const OUTCOME_CHIP: Record<string, string> = { claimed: "chip-ok", needs_credentials: "chip-warn" };

const STAT_COUNT = 6; // the checks and the five figures after it

/** The same shape as the loaded body (scope line, the row of figures, a findings table), so nothing moves when the scan arrives. */
function ScanSkeleton() {
  return (
    <SkeletonRegion label="Loading the scan" className="scan-drawer-body">
      <p className="scan-scope"><Skeleton width="38ch" /></p>
      <div className="row scan-stats" aria-hidden="true">
        {Array.from({ length: STAT_COUNT }, (_, i) => <span key={i}><Skeleton width={i === 0 ? "26ch" : "9ch"} /></span>)}
      </div>
      <TableSkeleton columns={5} rows={3} />
    </SkeletonRegion>
  );
}

/** What the scan covered, how much it checked, and what it found. Live for a scan that is still running (the page polls once a second). */
function ScanView({ scan }: { scan: ScanDetail }) {
  const inProgress = scan.status === "queued" || scan.status === "running";
  // The live line stays empty until the status or stage changes: the first state is read out as the dialog itself is, and the figures
  // are never in it (it would speak every second). From the first change on it says each new state, also the end.
  const state = inProgress && scan.stage ? `${scan.status}, stage ${scan.stage}` : scan.status;
  const [firstState] = useState(state);
  const [changed, setChanged] = useState(false);
  if (!changed && state !== firstState) setChanged(true);

  return (
    <div className="scan-drawer-body">
      <p className="sr-only" aria-live="polite" aria-atomic="true">{changed ? state : ""}</p>
      <p className="scan-scope">{scopeLine(scan.scope_name, scan.targets ?? [], scan.ports ?? [])}</p>
      <div className="row scan-stats">
        {[checksText(scan.progress, scan.status !== "done"), ...statWords(scan.progress)].map((text, i) => <span key={i}>{text}</span>)}
      </div>
      {inProgress && (
        <>
          <p className="muted">stage: {scan.stage ?? "starting"}. The findings appear here when the scan is done.</p>
          <TableSkeleton columns={5} rows={3} />
        </>
      )}
      {scan.status === "failed" && <p className="error" role="alert">{scan.error ?? "scan failed"}</p>}
      {scan.status === "done" && (scan.findings.length === 0 ? (
        <p className="muted">No open ports were found.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Host</th><th>Port</th><th>Type</th><th>Outcome</th><th>Detail</th></tr></thead>
            <tbody>
              {scan.findings.map((f) => (
                <tr key={`${f.host}:${f.port}`}>
                  <td>{f.host}</td><td>{f.port}</td><td>{f.connector_type ?? "—"}</td>
                  <td><span className={`chip ${OUTCOME_CHIP[f.outcome] ?? "chip-stale"}`}>{outcomeLabel(f.outcome)}</span></td>
                  <td>{f.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/**
 * One scan, opened from its row on the Scans page (or by starting it): a right-hand Drawer that closes with Escape, the x or a click
 * outside, and gives the focus back to `returnFocus` (that scan's Details button). Closing it never stops the scan; a running one keeps
 * updating while it is open.
 *
 * A failing poll. With a scan on show the content stays and the footer says what went wrong (a reserved slot: the footer is always
 * there); with none, the alert takes the skeleton's place. `errorUpdateCount` says a fetch really failed, not that a query is retrying.
 */
export function ScanDrawer({ scanId, onClose, returnFocus }: { scanId: number; onClose: () => void; returnFocus?: () => HTMLElement | null }) {
  const { data: scan, error, errorUpdateCount } = useScan(scanId);
  const pollFailed = scan !== undefined && error !== null && errorUpdateCount > 0;
  return (
    <Drawer
      title={scan ? `Scan #${scan.id} — ${scan.status}` : `Scan #${scanId}`}
      onClose={onClose}
      returnFocus={returnFocus}
      footer={
        <div className="scan-drawer-foot">
          {pollFailed && <p className="error" role="alert">{error.message}</p>}
          <Link to="/discovery">Open the discovery graph</Link>
        </div>
      }
    >
      {scan ? <ScanView scan={scan} /> : error ? <p className="error" role="alert">{error.message}</p> : <ScanSkeleton />}
    </Drawer>
  );
}
