import type { WidgetData } from "../../../api/types";
import { liveOrFetched } from "../../../lib/live";
import { figureOrNoData, markerHint, NO_DATA, unitSuffix } from "../../../lib/widgetFormat";
import { Age } from "../Age";
import { useLiveValue } from "../LiveValuesContext";

/**
 * One big figure for one asset. `live` (see isLiveWidget) lets the dashboard's stream override the fetched figure.
 * A stale reading, or one that recorded nothing (titled "no data"), is dimmed; a stale one also says how old it is.
 */
export function StatWidget({ data, live }: { data: WidgetData; live: boolean }) {
  const row = data.values[0];
  const stream = useLiveValue(live && row ? row.point_id : null);
  if (!row) return <div className="stat"><div className="big">—</div></div>;
  const reading = liveOrFetched(stream, row);
  const hint = markerHint(row);
  const text = figureOrNoData(reading.value, row, reading.noData, data.source);
  return (
    <div className="stat">
      <div className={reading.stale || reading.noData ? "big muted" : "big"} title={reading.noData ? NO_DATA : undefined}>
        {text}{text !== NO_DATA && <small>{unitSuffix(data.unit)}</small>}
      </div>
      <div className="muted">{row.name}</div>
      {reading.stale && reading.ts && <div><Age ts={reading.ts} /></div>}
      {hint && <div className="muted"><small>{hint}</small></div>}
    </div>
  );
}
