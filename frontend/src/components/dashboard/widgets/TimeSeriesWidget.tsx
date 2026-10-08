import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { memo } from "react";
import type { WidgetData } from "../../../api/types";
import { formatSiteDateTime, formatSiteTick } from "../../../lib/siteTime";
import { chartLabels, escapeHtml, figureText, formatValue, labelBucket, unitSuffix } from "../../../lib/widgetFormat";
import { useLegendSelection } from "./legendSelection";

type Point = WidgetData["series"][number]["points"][number];
type Row = [string, number | null];
/** A row, or a row with a symbol of its own (see markIsolated). */
type ChartRow = Row | { value: Row; symbol: string; symbolSize: number };

const PALETTE = ["#1f6feb", "#cf222e", "#1a7f37", "#9a6700", "#8250df", "#bf3989", "#0a7d8c", "#57606a"];

/**
 * Spacing between buckets, which decides what counts as a hole in the data. Energy and cost series name their bucket
 * (hour or day), and that is checked first. A metric series does not: the backend cuts every window into at most 300
 * buckets whatever the tier (24 h gives 288 s, 30 d gives 8640 s), and the tier only names the table that served them
 * (raw below 60 s, 1m below an hour, 1h above), so it says nothing about the width. The width is read from the data as
 * the MEDIAN positive step: every normal step is one bucket (or a whole number of them, for a meter that reports less
 * often than the buckets are wide), while the smallest step would be thrown off by one close pair of samples or a mapping
 * interval changed inside the window, and would turn every normal step into a "gap". Null when no two points are apart.
 */
export function bucketMs(bucket: WidgetData["bucket"], points: readonly Point[]): number | null {
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

/**
 * Axis tooltip: one line per asset (average with its min and max), without the helper series that draw the band.
 * A bucket with no rate shows a dash; a bucket nothing was recorded in (and the filler rows that break the line) shows
 * no line. The figure carries its bucket's own ~ and * markers. Names are user-typed, so they are escaped.
 */
export function tooltipFormatter(data: WidgetData, timezone: string) {
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
    const head = `${escapeHtml(formatSiteDateTime(new Date(stamp(lines[0].item)).toISOString(), timezone))}<br/>`;
    return head + lines.map(({ item, point }) => {
      const figure = point.value === null ? "—" : `${figureText(point.value, point)}${escapeHtml(unitSuffix(data.unit))}`;
      const spread = point.value !== null && point.min !== null && point.max !== null ? ` (min ${formatValue(point.min)}, max ${formatValue(point.max)})` : "";
      return `${item.marker ?? ""} ${escapeHtml(String(item.seriesName ?? ""))}: ${figure}${spread}`;
    }).join("<br/>");
  };
}

export function timeSeriesOption(data: WidgetData, timezone: string): EChartsOption {
  const labels = chartLabels(data.series);
  const bucket = labelBucket(data);
  const band = data.source === "metric";
  const series = data.series.flatMap((s, i): object[] => {
    const color = PALETTE[i % PALETTE.length];
    const width = bucketMs(data.bucket, s.points);
    const line = { id: `avg-${s.asset_id}`, name: labels[i], type: "line" as const, color, symbol: "none", connectNulls: false, data: markIsolated(withGaps(s.points, width, (p) => p.value)) };
    if (!band) return [line];
    // The band is two stacked invisible-line series: min, then max - min with a filled area.
    const hidden = { type: "line" as const, symbol: "none", lineStyle: { opacity: 0 }, stack: `band-${s.asset_id}`, connectNulls: false };
    return [
      { ...hidden, id: `band-min-${s.asset_id}`, name: `${labels[i]} min`, data: withGaps(s.points, width, (p) => p.min) },
      { ...hidden, id: `band-span-${s.asset_id}`, name: `${labels[i]} range`, areaStyle: { color, opacity: 0.12 }, data: withGaps(s.points, width, (p) => (p.min === null || p.max === null ? null : p.max - p.min)) },
      line,
    ];
  });
  return {
    animation: false,
    useUTC: true, // tick positions on whole UTC hours; labels below are formatted in the site zone, not the browser's
    tooltip: { trigger: "axis", formatter: tooltipFormatter(data, timezone) },
    legend: { show: data.series.length > 1, bottom: 0, type: "scroll", data: labels },
    grid: { left: 60, right: 20, top: 30, bottom: data.series.length > 1 ? 50 : 30 },
    xAxis: { type: "time", axisLabel: { formatter: (value: number | string) => formatSiteTick(new Date(Number(value)).toISOString(), timezone, bucket) } },
    yAxis: { type: "value", name: data.unit ?? undefined, scale: band },
    series,
  } as EChartsOption;
}

/**
 * One line per asset (average, with a min-max band for metrics); gaps are drawn as gaps. Memoised on its props: a
 * stream batch re-renders every widget of the dashboard, and a new option object (its formatters are new closures)
 * makes echarts-for-react call setOption with notMerge, which resets the legend and closes an open tooltip.
 */
export const TimeSeriesWidget = memo(function TimeSeriesWidget({ data, timezone }: { data: WidgetData; timezone: string }) {
  const legend = useLegendSelection();
  if (data.series.every((s) => s.points.every((p) => p.no_data))) return <p className="muted">No data in this range.</p>;
  return (
    <ReactECharts
      option={legend.apply(timeSeriesOption(data, timezone))} onEvents={legend.onEvents}
      style={{ height: "100%", width: "100%", minHeight: 140 }} notMerge
    />
  );
});
