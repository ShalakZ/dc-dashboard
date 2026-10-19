import type { WidgetData } from "../../../api/types";
import { changeLine, changeMarks, compareNotes, measureOf, measureUnit, NOTHING_YET, noteLine, sideFigure, windowLabel } from "../../../lib/compare";
import { liveOrFetched } from "../../../lib/live";
import { figureOrNoData, NO_DATA, unitSuffix } from "../../../lib/widgetFormat";
import { Age } from "../Age";
import { Icon } from "../../Icon";
import { useLiveValue } from "../LiveValuesContext";

/** The rows a comparison adds under the headline: the window, last month's same days and their change, and ONE reserved line for the notes. */
function CompareRows({ data }: { data: WidgetData }) {
  const compare = data.compare!;
  const asset = compare.assets[0];
  const measure = measureOf(data.source);
  const unit = measureUnit(measure, compare.currency);
  const notes = compareNotes(compare, asset, measure);
  const last = sideFigure(asset.last, measure, compare.days, compare.currency);
  const lastWindow = compare.last_window ? windowLabel(compare.last_window) : "";
  const change = changeLine(asset[measure], unit, changeMarks(asset, measure));
  return (
    <>
      {compare.this_window && <div className="stat-window" title={windowLabel(compare.this_window)}>{windowLabel(compare.this_window)}</div>}
      <div className="stat-last">
        <span className="stat-last-label" title="Same days last month">Same days last month</span>
        <span className="stat-last-fig" title={last}>{last}</span>
      </div>
      <div className="stat-window" title={lastWindow}>{lastWindow}</div>
      <div className="stat-change" title={change}>{change}</div>
      {/* One line, always there: a note appearing or going moves nothing. The whole text is its title and the Details panel lists every note. */}
      <div className="stat-note" title={notes.join(" ")}>{noteLine(notes)}</div>
    </>
  );
}

/**
 * One big figure for one asset. `live` (see isLiveWidget) lets the dashboard's stream override the fetched figure.
 * A stale reading, or one that recorded nothing (titled "no data"), is dimmed; a stale one also says how old it is.
 * The marker hint ("~ estimated ...") is the frame's footer, for every widget type.
 * With a comparison (w24) the headline is the same figure, for days 1 to D of this month, and the rows under it set last month's same days beside it.
 */
export function StatWidget({ data, live }: { data: WidgetData; live: boolean }) {
  const row = data.values[0];
  const stream = useLiveValue(live && row ? row.point_id : null);
  const compare = data.compare;
  if (compare?.state === "nothing_yet") return <div className="stat stat-compare"><p className="stat-nothing">{NOTHING_YET}</p></div>;
  if (!row) return <div className="stat"><div className="big"><span className="stat-num">—</span></div></div>;
  const reading = liveOrFetched(stream, row);
  const text = figureOrNoData(reading.value, row, reading.noData, data.source);
  const words = text === NO_DATA;
  const unit = words ? "" : unitSuffix(data.unit);
  const classes = ["big", ...(reading.stale || reading.noData ? ["muted"] : []), ...(words ? ["none"] : [])];
  const compared = compare !== null && compare !== undefined && compare.assets.length > 0;
  return (
    <div className={compared ? "stat stat-compare" : "stat"}>
      <div className={classes.join(" ")} title={reading.noData ? NO_DATA : undefined}>
        <span className="stat-num">{text}</span>{unit && <small className="stat-unit">{unit}</small>}
      </div>
      <div className="stat-name" title={row.name}>{row.name}</div>
      {reading.stale && reading.ts && <div className="stat-age"><Icon name="clock" /><Age ts={reading.ts} /></div>}
      {compared && <CompareRows data={data} />}
    </div>
  );
}
