import type { WidgetData } from "../../../api/types";
import { liveOrFetched } from "../../../lib/live";
import { figureOrNoData, NO_DATA, unitSuffix } from "../../../lib/widgetFormat";
import { Age } from "../Age";
import { Icon } from "../../Icon";
import { useLiveValue } from "../LiveValuesContext";

/**
 * One big figure for one asset. `live` (see isLiveWidget) lets the dashboard's stream override the fetched figure.
 * A stale reading, or one that recorded nothing (titled "no data"), is dimmed; a stale one also says how old it is.
 * The marker hint ("~ estimated ...") is the frame's footer, for every widget type.
 */
export function StatWidget({ data, live }: { data: WidgetData; live: boolean }) {
  const row = data.values[0];
  const stream = useLiveValue(live && row ? row.point_id : null);
  if (!row) return <div className="stat"><div className="big"><span className="stat-num">—</span></div></div>;
  const reading = liveOrFetched(stream, row);
  const text = figureOrNoData(reading.value, row, reading.noData, data.source);
  const words = text === NO_DATA;
  const unit = words ? "" : unitSuffix(data.unit);
  const classes = ["big", ...(reading.stale || reading.noData ? ["muted"] : []), ...(words ? ["none"] : [])];
  return (
    <div className="stat">
      <div className={classes.join(" ")} title={reading.noData ? NO_DATA : undefined}>
        <span className="stat-num">{text}</span>{unit && <small className="stat-unit">{unit}</small>}
      </div>
      <div className="stat-name" title={row.name}>{row.name}</div>
      {reading.stale && reading.ts && <div className="stat-age"><Icon name="clock" /><Age ts={reading.ts} /></div>}
    </div>
  );
}
