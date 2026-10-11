import { Link } from "react-router";
import { useScan } from "../api/queries";
import { claimedCount, outcomeLabel } from "../lib/scanText";

/** The chip of a finding's outcome: read = ok, locked = warning, unidentified (or anything else) = hollow dot. */
const OUTCOME_CHIP: Record<string, string> = { claimed: "chip-ok", needs_credentials: "chip-warn" };

export function ScanProgress({ scanId }: { scanId: number }) {
  const { data: scan, error } = useScan(scanId);
  if (error) return <p className="error" role="alert">{error.message}</p>;
  if (!scan) return <p className="muted">loading…</p>;
  const { progress } = scan;
  const inProgress = scan.status === "queued" || scan.status === "running";
  return (
    <section className="scan-detail">
      <h2 className="section-title">Scan #{scan.id} — {scan.status}</h2>
      {inProgress && scan.stage && <p className="muted">stage: {scan.stage}</p>}
      <p className="row scan-stats">
        <span>{progress.checked ?? 0}/{progress.pairs ?? 0} ports checked</span>
        <span>{progress.open ?? 0} open</span>
        <span>{claimedCount(progress)} claimed</span>
        <span>{progress.points ?? 0} points</span>
        <span>{progress.needs_credentials ?? 0} needs credentials</span>
        <span>{progress.unidentified ?? 0} unidentified</span>
      </p>
      {scan.status === "failed" && <p className="error" role="alert">{scan.error ?? "scan failed"}</p>}
      {scan.status === "done" && (
        <>
          {scan.findings.length === 0 ? (
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
          )}
          <p className="scan-link"><Link to="/discovery">Open the discovery graph</Link></p>
        </>
      )}
    </section>
  );
}
