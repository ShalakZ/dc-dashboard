import { useSite } from "../api/queries";
import type { SummaryMetric } from "../api/types";
import { formatSiteClock } from "../lib/siteTime";
import type { LiveValue } from "../lib/stream";

export const fmt = (value: number | null | undefined) => (value == null ? "—" : value.toFixed(2));
export const when = (ts: string | null | undefined, timezone: string | undefined) =>
  ts && timezone ? formatSiteClock(ts, timezone) : "—";

export function MetricsTable({ metrics, live }: { metrics: SummaryMetric[]; live: Map<number, LiveValue> }) {
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
        <thead><tr><th>Metric</th><th className="num">Value</th><th>Unit</th><th className="num">Updated</th></tr></thead>
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
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
