import type { WidgetConfig, WidgetData } from "../../../api/types";
import type { Scale } from "../../../lib/figures";
import { cardFigure, exactText, familyOf, pickScale, tickText } from "../../../lib/figures";
import { liveOrFetched } from "../../../lib/live";
import { hasNoReading, NO_DATA, unitSuffix } from "../../../lib/widgetFormat";
import { Age } from "../Age";
import { useLiveValue } from "../LiveValuesContext";

/** The half circle, left end to right end, in the 100 x 52 box of the svg (radius 44, centre at the bottom middle). */
const ARC = "M 6 50 A 44 44 0 0 1 94 50";
const round = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * An end of the scale as the config states it, in the gauge's unit (`divisor` is the scale's): "0", "100", "0.5", "1,000" (the tick face: at most two decimals, none
 * when whole, separators). It is a setting, not a reading, and "100.00" would not fit the ends of the smallest card.
 */
export const scaleText = (end: number, divisor = 1): string => tickText(end, divisor);

/**
 * The filled part of the arc: the same circle from the left end to the point `share` (0 to 1) of the way round. It is a path
 * of its own and not a dash of the whole arc, because the stroke is `vector-effect: non-scaling-stroke` (a constant width
 * on every card size) and a browser then reads a dash length in screen pixels, not in `pathLength` units. A share of 0 is
 * a hair long, so its round cap still shows: a measured minimum is not the same as no value (which draws no fill at all).
 */
export function gaugeFillPath(share: number): string {
  const angle = Math.PI * Math.min(1, Math.max(share, 0.001));
  return `M 6 50 A 44 44 0 0 1 ${round(50 - 44 * Math.cos(angle))} ${round(50 - 44 * Math.sin(angle))}`;
}

/** The filled share of the scale, 0 to 1. A value outside the scale is clamped, and a scale with no width (max <= min) is empty. */
export function gaugeShare(value: number, min: number, max: number): number {
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, (value - min) / span));
}

interface FigureArgs {
  value: number | null; unit: string | null;
  estimated?: boolean; partial?: boolean;
  /** A missing value says "no data" (a metric that recorded nothing) instead of the dash, which means a missing rate. */
  noData?: boolean;
  /** The scale the gauge reads in (one over its value, min and max); the figure's own size picks one when it is left out. */
  scale?: Scale;
}

/**
 * The two texts of the figure on the card face: the number (with its markers and scale letter, "no data", or the dash) and the unit after it, which only a number has.
 * A figure that is not a finite number (NaN, infinite) is the dash, with no unit.
 */
export function gaugeFigure({ value, unit, estimated = false, partial = false, noData = false, scale }: FigureArgs): { num: string; unit: string } {
  if (value !== null && Number.isFinite(value)) {
    const at = scale ?? pickScale(familyOf(unit, "metric"), unit, [value]);
    return { num: cardFigure(value, at, { estimated, partial }), unit: unitSuffix(at.unit) };
  }
  return { num: noData ? NO_DATA : "—", unit: "" };
}

/**
 * A gauge for one asset: a 180 degree arc (SVG, so it follows the theme and fits any card without measuring), the ends
 * of the scale, the figure and the name as plain text below it. `min`/`max` come from the widget config and `live` lets
 * the stream move the arc. A missing value draws the track only: an arc parked at zero would read as a measured zero.
 */
export function GaugeWidget({ data, config, live }: { data: WidgetData; config: WidgetConfig; live: boolean }) {
  const row = data.values[0];
  const stream = useLiveValue(live && row ? row.point_id : null);
  const reading = row ? liveOrFetched(stream, row) : null;
  const { min } = config;
  const max = config.max ?? config.min + 100;
  const fetched = reading?.value ?? null;
  const value = fetched !== null && Number.isFinite(fetched) ? fetched : null; // NaN or infinite is a missing figure: the dash, no fill
  const muted = reading ? reading.stale || reading.noData : false;
  const noData = hasNoReading(value, reading?.noData ?? false, data.source);
  const name = row?.name ?? "";
  // ONE scale over the value, min and max, so the figure, the two ends of the scale and the spoken values all read in the same unit.
  const scale = pickScale(familyOf(data.unit, data.source), data.unit, [value, min, max]);
  const { num, unit } = gaugeFigure({ value, unit: data.unit, estimated: row?.estimated, partial: row?.partial, noData, scale });
  const share = value === null ? 0 : gaugeShare(value, min, max);
  const out = value === null ? "" : value > max ? ", above the scale" : value < min ? ", below the scale" : "";
  // A meter needs a scale with a width: with max <= min its aria-valuemax would sit below its aria-valuemin, so the figure is spoken as an image instead.
  // The numbers of a meter are in the scale's unit (like the ends drawn on the dial), the spoken text says the figure with its unit.
  const meaning = value === null
    ? { role: "img", "aria-label": `${name || "Gauge"}: ${noData ? NO_DATA : "no value"}` }
    : !(max > min)
    ? { role: "img", "aria-label": `${name || "Gauge"}: ${num}${unit}` }
    : {
      role: "meter", "aria-label": name || "Gauge", "aria-valuemin": min / scale.divisor, "aria-valuemax": max / scale.divisor,
      "aria-valuenow": Math.min(Math.max(value, min), max) / scale.divisor, "aria-valuetext": `${num}${unit}${out}`,
    };
  const figureClasses = ["gauge-figure", ...(muted ? ["muted"] : []), ...(num === NO_DATA ? ["none"] : [])];
  // The card shows the figure compactly; its title is the exact value with its marks and unit (a figure that recorded nothing says "no data").
  const title = noData ? NO_DATA : value !== null ? exactText(value, data.unit, { estimated: row?.estimated ?? false, partial: row?.partial ?? false }) : undefined;
  return (
    <div className="gauge" {...meaning}>
      <div className="gauge-arc">
        <svg className="gauge-svg" viewBox="0 0 100 52" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">
          <path className="gauge-track" d={ARC} />
          {value !== null && <path className="gauge-fill" d={gaugeFillPath(share)} />}
        </svg>
        <div className="gauge-scale"><span>{scaleText(min, scale.divisor)}</span><span>{scaleText(max, scale.divisor)}{unitSuffix(scale.unit)}</span></div>
      </div>
      <div className={figureClasses.join(" ")} title={title}>
        <span className="stat-num">{num}</span>{unit && <small className="stat-unit">{unit}</small>}
      </div>
      <div className="gauge-name" title={name || undefined}>
        <span>{name}</span>{reading?.stale && reading.ts && <> · <Age ts={reading.ts} /></>}
      </div>
    </div>
  );
}
