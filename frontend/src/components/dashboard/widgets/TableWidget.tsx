import type { WidgetData } from "../../../api/types";
import { figureText, markerHint, uniqueLabels } from "../../../lib/widgetFormat";
import { Age } from "../Age";

/** One row per asset with the aggregation over the range. A figure that recorded nothing, or a stale one, is dimmed. */
export function TableWidget({ data }: { data: WidgetData }) {
  if (data.values.length === 0) return <p className="muted">No assets.</p>;
  const labels = uniqueLabels(data.values);
  const hint = markerHint({ estimated: data.values.some((v) => v.estimated), partial: data.values.some((v) => v.partial) });
  return (
    <>
      <table>
        <thead><tr><th>Asset</th><th>{data.unit ? `Value (${data.unit})` : "Value"}</th></tr></thead>
        <tbody>
          {data.values.map((row, i) => (
            <tr key={row.asset_id}>
              <td>{labels[i]}</td>
              <td className={row.no_data || row.stale ? "muted" : undefined}>
                {figureText(row.value, row)}
                {row.stale && row.ts && <> <Age ts={row.ts} /></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hint && <p className="muted"><small>{hint}</small></p>}
    </>
  );
}
