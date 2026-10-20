import type { WidgetData } from "../../../api/types";
import {
  changeCard, changeLine, changeMarks, compareNotes, compareScale, measureOf, measureUnit, NOTHING_YET, noteLine, sideCardFigure, sideFigure, windowLabel,
} from "../../../lib/compare";
import type { Scale } from "../../../lib/figures";
import { exactText, familyOf, pickScale } from "../../../lib/figures";
import { liveOrFetched } from "../../../lib/live";
import { cardFigureOrNoData, NO_DATA, unitSuffix } from "../../../lib/widgetFormat";
import { Age } from "../Age";
import { Icon } from "../../Icon";
import { useLiveValue } from "../LiveValuesContext";
import { figureFit } from "./figureFit";

/**
 * The rows a comparison adds under the headline: the window, last month's same days and their change, and ONE reserved line for the notes. The figures are on the
 * card face and share the headline's `scale` (both sides of a comparison read in one unit); the change picks its own. The `title` of each is the exact face.
 */
function CompareRows({ data, scale }: { data: WidgetData; scale: Scale }) {
  const compare = data.compare!;
  const asset = compare.assets[0];
  const measure = measureOf(data.source);
  const unit = measureUnit(measure, compare.currency);
  const notes = compareNotes(compare, asset, measure);
  const last = sideCardFigure(asset.last, measure, compare.days, scale);
  const lastExact = sideFigure(asset.last, measure, compare.days, compare.currency);
  const lastWindow = compare.last_window ? windowLabel(compare.last_window) : "";
  const change = changeCard(asset[measure], measure, unit, changeMarks(asset, measure));
  const changeExact = changeLine(asset[measure], unit, changeMarks(asset, measure));
  return (
    <>
      {compare.this_window && <div className="stat-window" title={windowLabel(compare.this_window)}>{windowLabel(compare.this_window)}</div>}
      <div className="stat-last">
        <span className="stat-last-label" title="Same days last month">Same days last month</span>
        <span className="stat-last-fig" title={lastExact}>{last}</span>
      </div>
      <div className="stat-window" title={lastWindow}>{lastWindow}</div>
      <div className="stat-change" title={changeExact}>{change}</div>
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
  const compared = compare !== null && compare !== undefined && compare.assets.length > 0;
  // One scale for the headline and the rows under it: the larger of this month's and last month's figures decides (a comparison), else the figure's own size.
  const scale = compared
    ? compareScale(compare.assets[0], measureOf(data.source), compare.days, compare.currency, [reading.value])
    : pickScale(familyOf(data.unit, data.source), data.unit, [reading.value]);
  const text = cardFigureOrNoData(reading.value, row, reading.noData, data.source, scale);
  const words = text === NO_DATA;
  const measured = reading.value !== null && Number.isFinite(reading.value); // a missing figure is a dash with no unit and no scaling
  const unit = words || !measured ? "" : unitSuffix(scale.unit);
  // `none` is the class of a reading that recorded nothing (the words, or the dash of a cost): the stylesheet draws it small and grey. It is set here, never read off the title.
  const classes = ["big", ...(reading.stale || reading.noData ? ["muted"] : []), ...(words || reading.noData ? ["none"] : [])];
  // The card shows the figure compactly; its title is the exact value with its marks and unit (a figure that recorded nothing says "no data").
  const title = reading.noData ? NO_DATA : measured ? exactText(reading.value, data.unit, row) : undefined;
  return (
    <div className={compared ? "stat stat-compare" : "stat"} style={figureFit(text, unit)}>
      <div className={classes.join(" ")} title={title}>
        <span className="stat-num">{text}</span>{unit && <small className="stat-unit">{unit}</small>}
      </div>
      <div className="stat-name" title={row.name}>{row.name}</div>
      {reading.stale && reading.ts && <div className="stat-age"><Icon name="clock" /><Age ts={reading.ts} /></div>}
      {compared && <CompareRows data={data} scale={scale} />}
    </div>
  );
}
