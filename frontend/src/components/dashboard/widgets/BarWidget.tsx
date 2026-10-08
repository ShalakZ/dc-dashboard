import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { memo } from "react";
import type { WidgetData } from "../../../api/types";
import { formatSiteDateTime, formatSiteTick } from "../../../lib/siteTime";
import { chartLabels, escapeHtml, figureText, hasNoReading, labelBucket, NO_DATA, unitSuffix } from "../../../lib/widgetFormat";
import { useLegendSelection } from "./legendSelection";

const DASH = "—";

/**
 * A null bar has no shape, so ECharts draws no label for it. Each slot with no figure therefore gets a point mark on
 * the axis, with the dash as its label (a missing value must never look like a bar of zero).
 */
function dashMarks(indexes: readonly number[]) {
  if (indexes.length === 0) return {};
  return {
    markPoint: {
      silent: true, symbol: "circle", symbolSize: 0,
      label: { show: true, formatter: DASH, position: "top", color: "#555" },
      data: indexes.map((index) => ({ coord: [index, 0] })),
    },
  };
}

interface TipItem { name?: string; dataIndex?: number; seriesIndex?: number; seriesName?: string; marker?: string }

/**
 * Axis tooltip from precomputed text: `lines[series][category]` is the figure as shown (null = nothing recorded, no
 * line), `headers[category]` the heading. Names are user-typed and ECharts renders tooltips as HTML, so they are escaped.
 */
function tooltipFor(lines: readonly (readonly (string | null)[])[], headers: readonly string[], named: boolean) {
  return (params: unknown): string => {
    const items = (Array.isArray(params) ? params : [params]) as TipItem[];
    const rows = items.flatMap((item) => {
      const text = lines[item.seriesIndex ?? 0]?.[item.dataIndex ?? -1];
      if (text == null) return [];
      const name = named ? `${escapeHtml(String(item.seriesName ?? ""))}: ` : "";
      return [`${item.marker ?? ""} ${name}${escapeHtml(text)}`];
    });
    if (rows.length === 0) return "";
    return [escapeHtml(headers[items[0]?.dataIndex ?? -1] ?? String(items[0]?.name ?? "")), ...rows].join("<br/>");
  };
}

export function barOption(data: WidgetData, timezone: string): EChartsOption {
  const unit = unitSuffix(data.unit);
  if (data.mode === "values") {
    const labels = chartLabels(data.values);
    // A metric that recorded nothing is "no data", with no dash mark: the dash means a missing rate and nothing else. A cost
    // without a rate keeps its dash whether or not anything was recorded, like the stat, the table and Billing.
    const noReading = (v: WidgetData["values"][number]) => hasNoReading(v.value, v.no_data, data.source);
    const lines = data.values.map((v) => (v.value === null ? (noReading(v) ? NO_DATA : DASH) : `${figureText(v.value, v)}${unit}${v.no_data ? ` (${NO_DATA})` : ""}`));
    return {
      animation: false,
      tooltip: { trigger: "axis", formatter: tooltipFor([lines], labels, false) },
      grid: { left: 60, right: 20, top: 30, bottom: 40 },
      xAxis: { type: "category", data: labels },
      yAxis: { type: "value", name: data.unit ?? undefined },
      series: [{
        type: "bar", data: data.values.map((v) => v.value),
        ...dashMarks(data.values.flatMap((v, i) => (v.value === null && !noReading(v) ? [i] : []))),
      }],
    } as EChartsOption;
  }
  // One category per bucket (the union over all assets), one bar series per asset: ECharts groups them side by side.
  const stamps = new Map<number, string>();
  for (const s of data.series) for (const p of s.points) stamps.set(Date.parse(p.ts), p.ts);
  const times = [...stamps.keys()].sort((a, b) => a - b);
  const labels = chartLabels(data.series);
  const bucket = labelBucket(data);
  // A bucket nobody recorded is a gap (null, no line); a bucket recorded without a rate is a dash.
  const cells = data.series.map((s) => {
    const byTime = new Map(s.points.map((p) => [Date.parse(p.ts), p]));
    return times.map((t) => {
      const point = byTime.get(t);
      if (!point || point.no_data) return { value: null, text: null };
      if (point.value === null) return { value: null, text: DASH };
      return { value: point.value, text: `${figureText(point.value, point)}${unit}` };
    });
  });
  return {
    animation: false,
    tooltip: { trigger: "axis", formatter: tooltipFor(cells.map((row) => row.map((c) => c.text)), times.map((t) => formatSiteDateTime(stamps.get(t)!, timezone)), true) },
    legend: { show: data.series.length > 1, bottom: 0, type: "scroll" },
    grid: { left: 60, right: 20, top: 30, bottom: data.series.length > 1 ? 50 : 30 },
    xAxis: { type: "category", data: times.map((t) => formatSiteTick(stamps.get(t)!, timezone, bucket)) },
    yAxis: { type: "value", name: data.unit ?? undefined },
    series: data.series.map((_, i) => ({
      name: labels[i], type: "bar" as const, data: cells[i].map((c) => c.value),
      ...dashMarks(cells[i].flatMap((c, k) => (c.text === DASH ? [k] : []))),
    })),
  } as EChartsOption;
}

/** Bars per asset (the aggregation over the range) or per time bucket, grouped by asset. Memoised for the reason given at TimeSeriesWidget. */
export const BarWidget = memo(function BarWidget({ data, timezone }: { data: WidgetData; timezone: string }) {
  const legend = useLegendSelection();
  // Nothing to draw: no assets, or (metric) every asset recorded nothing, which would be empty axes without even a dash.
  const empty = data.mode === "values"
    ? data.values.every((v) => hasNoReading(v.value, v.no_data, data.source))
    : data.series.every((s) => s.points.every((p) => p.no_data));
  if (empty) return <p className="muted">No data in this range.</p>;
  return (
    <ReactECharts
      option={legend.apply(barOption(data, timezone))} onEvents={legend.onEvents}
      style={{ height: "100%", width: "100%", minHeight: 140 }} notMerge
    />
  );
});
