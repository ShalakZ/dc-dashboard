import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { memo } from "react";
import type { WidgetData } from "../../../api/types";
import { chartDescription } from "../../../lib/widgetDetails";
import { formatSiteDateTime, formatSiteTick } from "../../../lib/siteTime";
import { chartLabels, figureText, hasNoReading, labelBucket, NO_DATA, shortLabel, shortLabels, unitSuffix } from "../../../lib/widgetFormat";
import { axisParts, chartBase, legendParts, LIGHT_CHART, seriesLook, tipHead, tipRow, useChartTheme, type ChartTheme } from "./chartTheme";
import { useLegendSelection } from "./legendSelection";

const DASH = "—";
/** Characters a legend entry or a category label shows; the full name is in the tooltip and in the legend's own tooltip (S7-3). */
const LEGEND_CHARS = 24;
const AXIS_CHARS = 18;

/**
 * A bar chart of one value per asset has ONE series, so a null bar has no shape to put a label on. Each slot with no figure
 * therefore gets a point mark on the axis, with the dash as its label (a missing value must never look like a bar of zero).
 * (The grouped chart cannot do this: a mark sits at the category centre, between the bars. It uses `dashItem`.)
 */
function dashMarks(indexes: readonly number[], theme: ChartTheme) {
  if (indexes.length === 0) return {};
  return {
    markPoint: {
      silent: true, symbol: "circle", symbolSize: 0,
      label: { show: true, formatter: DASH, position: "top", color: theme.axisText },
      data: indexes.map((index) => ({ coord: [index, 0] })),
    },
  };
}

/**
 * The dash of a bucket with no rate in a grouped chart: a bar of zero height that draws nothing (a transparent colour, not an opacity
 * of 0, which would hide its label too) and whose label is the dash. A bar belongs to its series' slot of the category, so the dash
 * sits where that asset's bar would be, not at the middle of the group.
 */
function dashItem(theme: ChartTheme) {
  return {
    value: 0, itemStyle: { color: "transparent" }, emphasis: { disabled: true },
    label: { show: true, formatter: DASH, position: "top" as const, color: theme.axisText },
  };
}

interface TipItem { name?: string; dataIndex?: number; seriesIndex?: number; seriesName?: string; marker?: string }

/** The round marker ECharts puts before a tooltip row, for a colour of our own. */
const dotMarker = (color: string): string => `<span style="display:inline-block;margin-right:4px;border-radius:10px;width:10px;height:10px;background-color:${color};"></span>`;
/** One figure of the tooltip: the text as shown, and the state in words (estimated, partial, no rate). `dash` marks a bucket with no rate in a grouped chart. */
interface TipCell { text: string; state: string; dash?: boolean }

/** The states of a value in words, beside its ~ or * marker. A missing figure of a cost is a missing rate. */
const stateOf = (flags: { estimated: boolean; partial: boolean }, noRate: boolean): string =>
  [flags.estimated ? "estimated" : "", flags.partial ? "partial" : "", noRate ? "no rate" : ""].filter(Boolean).join(", ");

/**
 * Axis tooltip from precomputed text: `cells[series][category]` is the figure as shown (null = nothing recorded, no
 * row), `headers[category]` the heading. Names are user-typed and ECharts renders tooltips as HTML, so they are escaped.
 */
function tooltipFor(cells: readonly (readonly (TipCell | null)[])[], headers: readonly string[], named: boolean, theme: ChartTheme, colors: readonly string[] = []) {
  return (params: unknown): string => {
    const items = (Array.isArray(params) ? params : [params]) as TipItem[];
    const rows = items.flatMap((item) => {
      const cell = cells[item.seriesIndex ?? 0]?.[item.dataIndex ?? -1];
      if (cell == null) return [];
      // The dash bar is transparent, so the marker ECharts builds from its colour would be invisible: draw the series' own.
      const marker = cell.dash && colors[item.seriesIndex ?? 0] ? dotMarker(colors[item.seriesIndex ?? 0]) : (item.marker ?? "");
      return [tipRow(marker, named ? String(item.seriesName ?? "") : "", cell.text, cell.state, theme)];
    });
    if (rows.length === 0) return "";
    return tipHead(headers[items[0]?.dataIndex ?? -1] ?? String(items[0]?.name ?? ""), theme) + rows.join("");
  };
}

export function barOption(data: WidgetData, timezone: string, theme: ChartTheme = LIGHT_CHART): EChartsOption {
  const unit = unitSuffix(data.unit);
  const base = chartBase(theme);
  const axis = axisParts(theme);
  if (data.mode === "values") {
    const labels = chartLabels(data.values);
    const axisShort = shortLabels(labels, AXIS_CHARS);
    // A metric that recorded nothing is "no data", with no dash mark: the dash means a missing rate and nothing else. A cost
    // without a rate keeps its dash whether or not anything was recorded, like the stat, the table and Billing.
    const noReading = (v: WidgetData["values"][number]) => hasNoReading(v.value, v.no_data, data.source);
    const cells = data.values.map((v): TipCell => {
      if (v.value === null) return noReading(v) ? { text: NO_DATA, state: "" } : { text: DASH, state: stateOf(v, data.source === "cost") };
      return { text: `${figureText(v.value, v)}${unit}${v.no_data ? ` (${NO_DATA})` : ""}`, state: stateOf(v, false) };
    });
    return {
      ...base,
      tooltip: { ...base.tooltip, formatter: tooltipFor([cells], labels, false, theme) },
      grid: { left: 60, right: 20, top: 30, bottom: 40 },
      // interval 0: every name is drawn (hideOverlap may still drop some of a crowded axis; the tooltip has the full name)
      xAxis: {
        type: "category", data: labels, ...axis,
        axisLabel: { ...axis.axisLabel, interval: 0, hideOverlap: true, formatter: (v: string) => axisShort.get(String(v)) ?? shortLabel(String(v), AXIS_CHARS) },
      },
      yAxis: { type: "value", name: data.unit ?? undefined, ...axis },
      series: [{
        type: "bar", color: theme.accent, data: data.values.map((v) => v.value),
        ...dashMarks(data.values.flatMap((v, i) => (v.value === null && !noReading(v) ? [i] : [])), theme),
      }],
    } as EChartsOption;
  }
  // One category per bucket (the union over all assets), one bar series per asset: ECharts groups them side by side.
  const stamps = new Map<number, string>();
  for (const s of data.series) for (const p of s.points) stamps.set(Date.parse(p.ts), p.ts);
  const times = [...stamps.keys()].sort((a, b) => a - b);
  const labels = chartLabels(data.series);
  const legendShort = shortLabels(labels, LEGEND_CHARS);
  const bucket = labelBucket(data);
  // A bucket nobody recorded is a gap (null, no bar); a bucket recorded without a rate is a dash.
  const cells = data.series.map((s) => {
    const byTime = new Map(s.points.map((p) => [Date.parse(p.ts), p]));
    return times.map((t): { value: number | null; cell: TipCell | null; noRate: boolean } => {
      const point = byTime.get(t);
      if (!point || point.no_data) return { value: null, cell: null, noRate: false };
      if (point.value === null) return { value: null, cell: { text: DASH, state: stateOf(point, data.source === "cost"), dash: true }, noRate: true };
      return { value: point.value, cell: { text: `${figureText(point.value, point)}${unit}`, state: stateOf(point, false) }, noRate: false };
    });
  });
  return {
    ...base,
    tooltip: {
      ...base.tooltip,
      formatter: tooltipFor(cells.map((row) => row.map((c) => c.cell)), times.map((t) => formatSiteDateTime(stamps.get(t)!, timezone)), true, theme, data.series.map((_, i) => seriesLook(theme, i, data.series.length).color)),
    },
    // The legend still selects by the full series name; only the text shown is shortened.
    legend: {
      ...legendParts(theme, "bar"), show: data.series.length > 1,
      formatter: (name: string) => legendShort.get(name) ?? shortLabel(name, LEGEND_CHARS),
    },
    grid: { left: 60, right: 20, top: 30, bottom: data.series.length > 1 ? 50 : 30 },
    xAxis: { type: "category", data: times.map((t) => formatSiteTick(stamps.get(t)!, timezone, bucket)), ...axis },
    yAxis: { type: "value", name: data.unit ?? undefined, ...axis },
    series: data.series.map((_, i) => ({
      name: labels[i], type: "bar" as const, color: seriesLook(theme, i, data.series.length).color,
      data: cells[i].map((c) => (c.noRate ? dashItem(theme) : c.value)),
    })),
  } as EChartsOption;
}

/** Bars per asset (the aggregation over the range) or per time bucket, grouped by asset. Memoised for the reason given at TimeSeriesWidget. */
export const BarWidget = memo(function BarWidget({ data, timezone }: { data: WidgetData; timezone: string }) {
  const legend = useLegendSelection();
  const theme = useChartTheme();
  // Nothing to draw: no assets, or (metric) every asset recorded nothing, which would be empty axes without even a dash.
  const empty = data.mode === "values"
    ? data.values.every((v) => hasNoReading(v.value, v.no_data, data.source))
    : data.series.every((s) => s.points.every((p) => p.no_data));
  if (empty) return <p className="widget-empty">No data in this range.</p>;
  // The canvas is a picture: the box around it is the chart's text alternative (the figures themselves are in the Details panel).
  return (
    <div className="widget-chart" role="img" aria-label={chartDescription("bar", data, timezone)}>
      <ReactECharts
        option={legend.apply(barOption(data, timezone, theme), data.mode === "series" ? data.series.map((s) => s.asset_id) : [])} onEvents={legend.onEvents}
        style={{ height: "100%", width: "100%", minHeight: 140 }} notMerge
      />
    </div>
  );
});
