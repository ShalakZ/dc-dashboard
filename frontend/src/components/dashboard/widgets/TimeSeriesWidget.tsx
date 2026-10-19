import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { memo } from "react";
import type { WidgetData } from "../../../api/types";
import { compareChartDescription, compareLineNames, dayOfMonthLabel, measureOf, NOTHING_YET } from "../../../lib/compare";
import { chartDescription } from "../../../lib/widgetDetails";
import { formatSiteDateTime, formatSiteTick } from "../../../lib/siteTime";
import { chartLabels, figureText, formatValue, labelBucket, shortLabel, shortLabels, unitSuffix } from "../../../lib/widgetFormat";
import { axisParts, chartBase, legendParts, LIGHT_CHART, seriesLook, tipHead, tipRow, useChartTheme, type ChartTheme } from "./chartTheme";
import { useLegendSelection } from "./legendSelection";

type Point = WidgetData["series"][number]["points"][number];
type Row = [string, number | null];
/** A row, or a row with a symbol of its own (see markIsolated). */
type ChartRow = Row | { value: Row; symbol: string; symbolSize: number };

/** Characters a legend entry shows; the full name is in the chart tooltip and in the legend's own tooltip (S7-3). */
const LEGEND_CHARS = 24;

/**
 * Spacing between buckets, which decides what counts as a hole in the data. Energy and cost series name their bucket
 * (hour or day), and that is checked first. A metric series does not: the backend cuts every window into at most 300
 * buckets whatever the tier (24 h gives 288 s, 30 d gives 8640 s), and the tier only names the table that served them
 * (raw below 60 s, 1m below an hour, 1h above), so it says nothing about the width. The width is therefore an estimate
 * read from the data: the MEDIAN positive step. For a meter that reports at least once per bucket that is the bucket
 * width, and the median is not thrown off by one close pair of samples or a mapping interval changed inside the window
 * (the smallest step would be, and would turn every normal step into a "gap"). The median is never the meter's polling
 * interval, only the step most often seen in this window. A meter that reports less often than the buckets are wide is
 * drawn right only when the median lands on its common step and its other step is at most 1.5 times that median; with
 * steps further apart it is drawn as dots or flips between a line and dots (see withGaps). Null when no two points are apart.
 */
export function bucketMs(bucket: WidgetData["bucket"], points: readonly { ts: string }[]): number | null {
  if (bucket === "hour") return 3_600_000;
  if (bucket === "day") return 86_400_000;
  const steps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const step = Date.parse(points[i].ts) - Date.parse(points[i - 1].ts);
    if (step > 0) steps.push(step);
  }
  steps.sort((a, b) => a - b);
  return steps.length === 0 ? null : steps[Math.floor(steps.length / 2)];
}

/**
 * Chart rows with a `[ts, null]` row wherever two consecutive points are more than 1.5 buckets apart, so the line
 * breaks instead of bridging an outage (the same idea as TrendChart.withGaps). A null value is a gap too.
 */
export function withGaps(points: readonly Point[], width: number | null, pick: (p: Point) => number | null): Row[] {
  const rows: Row[] = [];
  let previous: number | null = null;
  for (const p of points) {
    const t = Date.parse(p.ts);
    if (previous !== null && width !== null && t - previous > width * 1.5) rows.push([new Date(previous + width).toISOString(), null]);
    rows.push([p.ts, pick(p)]);
    previous = t;
  }
  return rows;
}

/**
 * The line series draws no symbols (`symbol: "none"`), so a point whose neighbours are both null or absent (the only
 * bucket of a `1h` energy window, a priced hour between hours without a rate, a sample cut off by gaps) would have no
 * segment to be drawn as and the chart would look empty. Such a point gets a dot of its own.
 */
export function markIsolated(rows: readonly Row[]): ChartRow[] {
  return rows.map((row, i) => {
    if (row[1] === null) return row;
    const alone = (rows[i - 1]?.[1] ?? null) === null && (rows[i + 1]?.[1] ?? null) === null;
    return alone ? { value: row, symbol: "circle", symbolSize: 6 } : row;
  });
}

interface TipItem { seriesId?: string; seriesName?: string; value?: unknown; marker?: string }

/** The state of a point in words, beside its ~ or * marker: what the marker or the dash means. */
function stateWords(data: WidgetData, point: Point): string {
  const words: string[] = [];
  if (point.estimated) words.push("estimated");
  if (point.partial) words.push("partial");
  if (data.source === "cost" && point.value === null && !point.no_data) words.push("no rate");
  return words.join(", ");
}

/**
 * Axis tooltip: the time, then one row per asset (average with its min and max, the state in words), without the helper series
 * that draw the band. A bucket with no rate shows a dash; a bucket nothing was recorded in (and the filler rows that break the
 * line) shows no row. The figure carries its bucket's own ~ and * markers. Names are user-typed, so they are escaped.
 */
export function tooltipFormatter(data: WidgetData, timezone: string, theme: ChartTheme = LIGHT_CHART) {
  const points = new Map<string, Map<number, Point>>();
  for (const s of data.series) points.set(`avg-${s.asset_id}`, new Map(s.points.map((p) => [Date.parse(p.ts), p])));
  const stamp = (item: TipItem) => (Array.isArray(item.value) ? Date.parse(String(item.value[0])) : NaN);
  return (params: unknown): string => {
    const lines = ((Array.isArray(params) ? params : [params]) as TipItem[])
      .filter((item) => String(item.seriesId ?? "").startsWith("avg-"))
      .flatMap((item) => {
        const point = points.get(String(item.seriesId))?.get(stamp(item));
        return point && !point.no_data ? [{ item, point }] : [];
      });
    if (lines.length === 0) return "";
    const head = tipHead(formatSiteDateTime(new Date(stamp(lines[0].item)).toISOString(), timezone), theme);
    return head + lines.map(({ item, point }) => {
      const figure = point.value === null ? "—" : `${figureText(point.value, point)}${unitSuffix(data.unit)}`;
      const spread = point.value !== null && point.min !== null && point.max !== null ? ` (min ${formatValue(point.min)}, max ${formatValue(point.max)})` : "";
      return tipRow(item.marker ?? "", String(item.seriesName ?? ""), `${figure}${spread}`, stateWords(data, point), theme);
    }).join("");
  };
}

/** Room left either side of the bounded axis, as a share of its span, so a symbol on an edge is not half-clipped. */
const AXIS_PAD = 0.03;

/**
 * The bounds of the time axis of an energy or cost series (`bucket` hour or day); null for a metric series, whose many
 * points let the chart choose. Left alone, one bucket (the `1h` preset) is stretched by the chart over about 42 hours,
 * whose labels run together while the dot floats in the middle. The axis covers the response's range, widened to the
 * first bucket (a day bucket is labelled by the local midnight, which can come before `range.start`) and to the whole
 * of the last bucket, then padded a little on both sides.
 */
export function timeAxisBounds(data: WidgetData): { min: number; max: number } | null {
  const step = data.bucket === "hour" ? 3_600_000 : data.bucket === "day" ? 86_400_000 : null;
  if (step === null) return null;
  const stamps = data.series.flatMap((s) => s.points.map((p) => Date.parse(p.ts))).filter(Number.isFinite);
  const start = Date.parse(data.range.start);
  const end = Date.parse(data.range.end);
  const from = [start, ...stamps].filter(Number.isFinite);
  const to = [end, ...stamps.map((t) => t + step)].filter(Number.isFinite);
  if (from.length === 0 || to.length === 0) return null;
  const min = Math.min(...from);
  const max = Math.max(...to);
  const pad = (max - min) * AXIS_PAD;
  return { min: min - pad, max: max + pad };
}

/**
 * The chart's option. Each asset is one legend entry: its line comes FIRST (the legend draws its icon from the first series of a name, and a
 * hidden band first would give an invisible icon), and the two band series that follow carry the line's name and colour, so one click on the
 * legend switches the line and its band together. The line has the higher z, so it stays on top of its band.
 */
export function timeSeriesOption(data: WidgetData, timezone: string, theme: ChartTheme = LIGHT_CHART): EChartsOption {
  const labels = chartLabels(data.series);
  const legendShort = shortLabels(labels, LEGEND_CHARS);
  const bucket = labelBucket(data);
  const band = data.source === "metric";
  const base = chartBase(theme);
  const axis = axisParts(theme);
  const series = data.series.flatMap((s, i): object[] => {
    const { color, type } = seriesLook(theme, i, data.series.length);
    const width = bucketMs(data.bucket, s.points);
    const line = {
      id: `avg-${s.asset_id}`, name: labels[i], type: "line" as const, color, z: 3, symbol: "none", lineStyle: { width: 2, type }, connectNulls: false,
      data: markIsolated(withGaps(s.points, width, (p) => p.value)),
    };
    if (!band) return [line];
    // The band is two stacked invisible-line series: min, then max - min with a filled area.
    const hidden = { type: "line" as const, name: labels[i], color, z: 2, symbol: "none", lineStyle: { opacity: 0 }, stack: `band-${s.asset_id}`, connectNulls: false };
    return [
      line,
      { ...hidden, id: `band-min-${s.asset_id}`, data: withGaps(s.points, width, (p) => p.min) },
      { ...hidden, id: `band-span-${s.asset_id}`, areaStyle: { color, opacity: theme.bandOpacity }, data: withGaps(s.points, width, (p) => (p.min === null || p.max === null ? null : p.max - p.min)) },
    ];
  });
  return {
    ...base,
    useUTC: true, // tick positions on whole UTC hours; labels below are formatted in the site zone, not the browser's
    tooltip: { ...base.tooltip, formatter: tooltipFormatter(data, timezone, theme) },
    // The legend still selects by the full series name; only the text shown is shortened.
    legend: {
      ...legendParts(theme, "line"), show: data.series.length > 1, data: labels,
      formatter: (name: string) => legendShort.get(name) ?? shortLabel(name, LEGEND_CHARS),
    },
    grid: { left: 60, right: 20, top: 30, bottom: data.series.length > 1 ? 50 : 30 },
    xAxis: {
      type: "time",
      ...timeAxisBounds(data),
      ...axis,
      // hideOverlap: labels that would run together are dropped, whatever the width of the widget or the span of the axis
      axisLabel: { ...axis.axisLabel, hideOverlap: true, formatter: (value: number | string) => formatSiteTick(new Date(Number(value)).toISOString(), timezone, bucket) },
    },
    yAxis: { type: "value", name: data.unit ?? undefined, scale: band, ...axis },
    series,
  } as EChartsOption;
}

/** The values of a list of day points on a category axis: day i is slot i; a day with no readings is a gap (null), never a zero. */
function dayValues(points: readonly Point[], length: number): (number | null)[] {
  return Array.from({ length }, (_, i) => {
    const point = points[i];
    return point && !point.no_data ? point.value : null;
  });
}

type DayItem = number | null | { value: number; symbol: string; symbolSize: number };

/** A day whose neighbours both have no figure (the 2nd of the month has ONE day) would have no segment to be drawn as: it gets a dot, as `markIsolated` does on a time axis. */
function markIsolatedDays(values: readonly (number | null)[]): DayItem[] {
  return values.map((value, i) => {
    if (value === null) return null;
    const alone = (values[i - 1] ?? null) === null && (values[i + 1] ?? null) === null;
    return alone ? { value, symbol: "circle", symbolSize: 6 } : value;
  });
}

const dot = (color: string): string => `<span style="display:inline-block;margin-right:4px;border-radius:10px;width:10px;height:10px;background-color:${color};"></span>`;

/**
 * The chart of a comparison (w24): this month's days 1 to N and last month's days 1 to D as two lines on a CATEGORY axis by day of the month (a time
 * axis cannot put the 17th of two months on one slot). The lines are named by their months, with the side's `~` / `*`; last month's is dashed, so
 * colour is not the only difference. The tooltip names BOTH dates of the day, each with its figure, marks and state in words; a day with no readings is a
 * gap with no row. Day labels come from the windows' months and the slot number, never from a timestamp, so no time zone is involved.
 */
export function compareOption(data: WidgetData, timezone: string, theme: ChartTheme = LIGHT_CHART): EChartsOption {
  void timezone; // the labels are site-local dates already; kept in the signature so the two option builders are called alike
  const compare = data.compare!;
  const asset = compare.assets[0];
  const measure = measureOf(data.source);
  const now = data.series[0]?.points ?? [];
  const before = asset?.last_points ?? [];
  const days = Math.max(now.length, before.length);
  const names = compareLineNames(compare, asset, measure);
  const sides = [now, before];
  const months = [compare.this_window?.from ?? "", compare.last_month.month];
  const labels = months.map((month) => Array.from({ length: days }, (_, i) => dayOfMonthLabel(month, i + 1)));
  const unit = unitSuffix(data.unit);
  const cells = sides.map((points) => Array.from({ length: days }, (_, i) => {
    const point = points[i];
    if (!point || point.no_data) return null;
    const figure = point.value === null ? "—" : `${figureText(point.value, point)}${unit}`;
    return { text: figure, state: stateWords(data, point) };
  }));
  const colors = [0, 1].map((i) => seriesLook(theme, i, 2).color);
  const base = chartBase(theme);
  const axis = axisParts(theme);
  return {
    ...base,
    tooltip: {
      ...base.tooltip,
      formatter: (params: unknown): string => {
        const items = (Array.isArray(params) ? params : [params]) as { dataIndex?: number; seriesIndex?: number; marker?: string }[];
        const index = items[0]?.dataIndex ?? -1;
        return [0, 1].flatMap((i) => {
          const cell = cells[i][index];
          if (!cell) return [];
          const marker = items.find((item) => item.seriesIndex === i)?.marker ?? dot(colors[i]);
          return [tipRow(marker, labels[i][index], cell.text, cell.state, theme)];
        }).join("");
      },
    },
    legend: { ...legendParts(theme, "line"), show: true, data: names },
    grid: { left: 60, right: 20, top: 30, bottom: 50 },
    xAxis: { type: "category", data: Array.from({ length: days }, (_, i) => String(i + 1)), ...axis },
    yAxis: { type: "value", name: data.unit ?? undefined, ...axis },
    series: [0, 1].map((i) => ({
      id: i === 0 ? "this-month" : "last-month", name: names[i], type: "line" as const, color: colors[i], z: i === 0 ? 3 : 2, symbol: "none",
      lineStyle: { width: 2, type: i === 0 ? "solid" as const : "dashed" as const }, connectNulls: false,
      data: markIsolatedDays(dayValues(sides[i], days)),
    })),
  } as EChartsOption;
}

/**
 * One line per asset (average, with a min-max band for metrics); gaps are drawn as gaps. Memoised on its props: a
 * stream batch re-renders every widget of the dashboard, and a new option object (its formatters are new closures)
 * makes echarts-for-react call setOption with notMerge, which resets the legend and closes an open tooltip.
 */
export const TimeSeriesWidget = memo(function TimeSeriesWidget({ data, timezone }: { data: WidgetData; timezone: string }) {
  const legend = useLegendSelection();
  const theme = useChartTheme();
  const compare = data.compare;
  if (compare?.state === "nothing_yet") return <p className="widget-empty">{NOTHING_YET}</p>;
  if (compare && compare.assets.length > 0) {
    const days = [...(data.series[0]?.points ?? []), ...compare.assets[0].last_points];
    if (days.every((p) => p.no_data)) return <p className="widget-empty">No data in this range.</p>;
    return (
      <div className="widget-chart" role="img" aria-label={compareChartDescription(data, compare)}>
        {/* Two lines, one legend entry each: the viewer's choice is kept by the entry's place (0 this month, 1 last month), not by an asset. */}
        <ReactECharts option={legend.apply(compareOption(data, timezone, theme), [0, 1])} onEvents={legend.onEvents} style={{ height: "100%", width: "100%", minHeight: 140 }} notMerge />
      </div>
    );
  }
  if (data.series.every((s) => s.points.every((p) => p.no_data))) return <p className="widget-empty">No data in this range.</p>;
  // The canvas is a picture: the box around it is the chart's text alternative (the figures themselves are in the Details panel).
  return (
    <div className="widget-chart" role="img" aria-label={chartDescription("timeseries", data)}>
      <ReactECharts
        option={legend.apply(timeSeriesOption(data, timezone, theme), data.series.map((s) => s.asset_id))} onEvents={legend.onEvents}
        style={{ height: "100%", width: "100%", minHeight: 140 }} notMerge
      />
    </div>
  );
});
