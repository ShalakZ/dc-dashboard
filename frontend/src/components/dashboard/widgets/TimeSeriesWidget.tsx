import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import type { WidgetData } from "../../../api/types";
import { formatSiteDateTime, formatSiteTick } from "../../../lib/siteTime";
import { chartLabels, escapeHtml, figureText, formatValue, labelBucket, unitSuffix } from "../../../lib/widgetFormat";

type Point = WidgetData["series"][number]["points"][number];
type Row = [string, number | null];

const PALETTE = ["#1f6feb", "#cf222e", "#1a7f37", "#9a6700", "#8250df", "#bf3989", "#0a7d8c", "#57606a"];

/** Typical spacing between buckets: fixed for hour and day buckets, else the smallest step in the series (null with fewer than two points). */
export function bucketMs(bucket: WidgetData["bucket"], points: readonly Point[]): number | null {
  if (bucket === "hour") return 3_600_000;
  if (bucket === "day") return 86_400_000;
  let smallest: number | null = null;
  for (let i = 1; i < points.length; i++) {
    const step = Date.parse(points[i].ts) - Date.parse(points[i - 1].ts);
    if (step > 0 && (smallest === null || step < smallest)) smallest = step;
  }
  return smallest;
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
    const line = { id: `avg-${s.asset_id}`, name: labels[i], type: "line" as const, color, symbol: "none", connectNulls: false, data: withGaps(s.points, width, (p) => p.value) };
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

/** One line per asset (average, with a min-max band for metrics); gaps are drawn as gaps. */
export function TimeSeriesWidget({ data, timezone }: { data: WidgetData; timezone: string }) {
  if (data.series.every((s) => s.points.every((p) => p.no_data))) return <p className="muted">No data in this range.</p>;
  return <ReactECharts option={timeSeriesOption(data, timezone)} style={{ height: "100%", width: "100%", minHeight: 140 }} notMerge />;
}
