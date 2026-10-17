import type { WidgetConfig, WidgetData } from "../../../api/types";
import { liveOrFetched } from "../../../lib/live";
import { figureText, hasNoReading, NO_DATA, unitSuffix } from "../../../lib/widgetFormat";
import { Age } from "../Age";
import { useLiveValue } from "../LiveValuesContext";

/** The half circle, left end to right end, in the 100 x 52 box of the svg (radius 44, centre at the bottom middle). */
const ARC = "M 6 50 A 44 44 0 0 1 94 50";
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** An end of the scale as the config states it: "0", "100", "0.5" (at most two decimals, none when whole). It is a setting, not a reading, and "100.00" would not fit the ends of the smallest card. */
export const scaleText = (end: number): string => String(+end.toFixed(2));

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
}

/** The two texts of the figure: the number (with its markers, "no data", or the dash) and the unit after it, which only a number has. */
export function gaugeFigure({ value, unit, estimated = false, partial = false, noData = false }: FigureArgs): { num: string; unit: string } {
  if (value !== null) return { num: figureText(value, { estimated, partial }), unit: unitSuffix(unit) };
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
  const value = reading?.value ?? null;
  const muted = reading ? reading.stale || reading.noData : false;
  const noData = hasNoReading(value, reading?.noData ?? false, data.source);
  const name = row?.name ?? "";
  const { num, unit } = gaugeFigure({ value, unit: data.unit, estimated: row?.estimated, partial: row?.partial, noData });
  const share = value === null ? 0 : gaugeShare(value, min, max);
  const out = value === null ? "" : value > max ? ", above the scale" : value < min ? ", below the scale" : "";
  const meaning = value === null
    ? { role: "img", "aria-label": `${name || "Gauge"}: ${noData ? NO_DATA : "no value"}` }
    : {
      role: "meter", "aria-label": name || "Gauge", "aria-valuemin": min, "aria-valuemax": max,
      "aria-valuenow": Math.min(Math.max(value, min), Math.max(max, min)), "aria-valuetext": `${num}${unit}${out}`,
    };
  const figureClasses = ["gauge-figure", ...(muted ? ["muted"] : []), ...(num === NO_DATA ? ["none"] : [])];
  return (
    <div className="gauge" {...meaning}>
      <div className="gauge-arc">
        <svg className="gauge-svg" viewBox="0 0 100 52" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">
          <path className="gauge-track" d={ARC} />
          {value !== null && <path className="gauge-fill" d={gaugeFillPath(share)} />}
        </svg>
      </div>
      <div className="gauge-scale"><span>{scaleText(min)}</span><span>{scaleText(max)}{unitSuffix(data.unit)}</span></div>
      <div className={figureClasses.join(" ")} title={noData ? NO_DATA : undefined}>
        <span className="stat-num">{num}</span>{unit && <small className="stat-unit">{unit}</small>}
      </div>
      <div className="gauge-name" title={name || undefined}>
        <span>{name}</span>{reading?.stale && reading.ts && <> · <Age ts={reading.ts} /></>}
      </div>
    </div>
  );
}
