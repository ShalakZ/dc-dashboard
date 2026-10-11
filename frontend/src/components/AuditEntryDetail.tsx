import { Link } from "react-router";
import type { AuditEntry } from "../api/types";
import { describeAudit } from "../lib/auditText";

/** One audit entry: the friendly account of it (a sentence, what changed, the stored fields, a link) or the raw stored JSON. Text only. */
export function AuditEntryDetail({ entry, view }: { entry: AuditEntry; view: "friendly" | "raw" }) {
  if (view === "raw") {
    return (
      <div>
        <p>{entry.action}</p>
        <code>{JSON.stringify(entry.detail)}</code>
      </div>
    );
  }
  const { summary, changes, unchanged, facts, link } = describeAudit(entry);
  return (
    <div>
      <p>{summary}</p>
      {changes.length > 0 && (
        <table>
          <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
          <tbody>
            {changes.map((change, i) => (
              <tr key={`${change.field}-${i}`}>
                <td>{change.field}</td>
                <td>{change.before}</td>
                <td>{change.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {unchanged > 0 && <p className="muted">{`${unchanged} unchanged ${unchanged === 1 ? "value" : "values"} not shown`}</p>}
      {facts.length > 0 && (
        <dl>
          {facts.map((fact, i) => (
            <div key={`${fact.label}-${i}`}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {link && <p><Link to={link.to}>{link.label}</Link></p>}
    </div>
  );
}
