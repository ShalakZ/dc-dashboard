import type { WidgetData } from "../../../api/types";
import { figureOrNoData, NO_DATA, uniqueLabels } from "../../../lib/widgetFormat";
import { Age } from "../Age";

/**
 * One row per asset with the aggregation over the range. A figure that recorded nothing (titled "no data"), or a stale one,
 * is dimmed. The marker hint ("~ estimated ...") is the frame's footer, for every widget type.
 */
export function TableWidget({ data }: { data: WidgetData }) {
  if (data.values.length === 0) return <p className="widget-empty">No assets.</p>;
  const labels = uniqueLabels(data.values);
  return (
    <table className="widget-table">
      <thead><tr><th>Asset</th><th className="num">{data.unit ? `Value (${data.unit})` : "Value"}</th></tr></thead>
      <tbody>
        {data.values.map((row, i) => (
          <tr key={row.asset_id}>
            <td>{labels[i]}</td>
            <td className={row.no_data || row.stale ? "num muted" : "num"} title={row.no_data ? NO_DATA : undefined}>
              {figureOrNoData(row.value, row, row.no_data, data.source)}
              {row.stale && row.ts && <span className="cell-age"><Age ts={row.ts} /></span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
