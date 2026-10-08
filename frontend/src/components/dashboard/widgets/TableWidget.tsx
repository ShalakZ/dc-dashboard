import type { WidgetData } from "../../../api/types";
import { figureOrNoData, markerHint, NO_DATA, uniqueLabels } from "../../../lib/widgetFormat";
import { Age } from "../Age";

/** One row per asset with the aggregation over the range. A figure that recorded nothing (titled "no data"), or a stale one, is dimmed. */
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
              <td className={row.no_data || row.stale ? "muted" : undefined} title={row.no_data ? NO_DATA : undefined}>
                {figureOrNoData(row.value, row, row.no_data, data.source)}
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
