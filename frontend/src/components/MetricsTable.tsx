import { useSite } from "../api/queries";
import type { SummaryMetric } from "../api/types";
import { formatSiteClock } from "../lib/siteTime";
import type { LiveValue } from "../lib/stream";
import { RowActions } from "./RowActions";

export const fmt = (value: number | null | undefined) => (value == null ? "—" : value.toFixed(2));
export const when = (ts: string | null | undefined, timezone: string | undefined) =>
  ts && timezone ? formatSiteClock(ts, timezone) : "—";

/**
 * What a row is called on its menu and in the sentences about it: the metric, but a `custom` one with its unit (an asset can have several
 * custom rows), and the point's number as well when two rows would still read the same. The summary has no point name, so this is the name.
 */
export function metricName(m: SummaryMetric, all: readonly SummaryMetric[]): string {
  const base = (x: SummaryMetric) => (x.metric === "custom" && x.unit ? `custom (${x.unit})` : x.metric);
  const clash = all.some((other) => other.mapping_id !== m.mapping_id && base(other) === base(m));
  return clash ? `${base(m)} #${m.point_id}` : base(m);
}

/** The row menu of a table that may change mappings (a person with assets.edit): without it the table is the read-only one. */
export interface MetricActions {
  onUnmap(metric: SummaryMetric): void;
  onMove(metric: SummaryMetric): void;
}

export function MetricsTable({ metrics, live, actions }: { metrics: SummaryMetric[]; live: Map<number, LiveValue>; actions?: MetricActions }) {
  const site = useSite();
  if (metrics.length === 0) {
    return (
      <div className="empty">
        <span className="empty-icon"><svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10" /></svg></span>
        <p>No metrics are mapped to this asset.</p>
      </div>
    );
  }
  return (
    <div className="table-wrap metrics-table">
      <table>
        <thead><tr><th>Metric</th><th className="num">Value</th><th>Unit</th><th className="num">Updated</th>{actions && <th className="row-actions"></th>}</tr></thead>
        <tbody>
          {metrics.map((m) => {
            const current = live.get(m.point_id);
            const value = current ? current.value : m.value;
            const quality = current ? current.quality : m.quality;
            return (
              <tr key={m.mapping_id}>
                <td>{m.metric}</td>
                <td className="num">{quality !== null && quality !== 0 ? <span className="chip chip-bad">bad quality</span> : fmt(value)}</td>
                <td>{m.unit}</td>
                <td className="num">{when(current ? current.ts : m.ts, site.data?.timezone)}</td>
                {actions && (
                  <td className="row-actions">
                    <RowActions label={`Actions for ${metricName(m, metrics)}`} items={[
                      { label: "Unmap…", onSelect: () => actions.onUnmap(m), tone: "danger" },
                      { label: "Move to another asset…", onSelect: () => actions.onMove(m) },
                    ]} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
