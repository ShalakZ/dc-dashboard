import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAssets } from "../../../api/queries";
import type { WidgetData } from "../../../api/types";
import {
  breakdownDescription, breakdownLine, drillAction, drillTip, emptyBreakdownText, hasNoBars, isNoDataBar, kindOptions, parentIds, selectedKind, type DrillAction,
} from "../../../lib/breakdown";
import { chartDescription } from "../../../lib/widgetDetails";
import { formatSiteDateTime, formatSiteTick } from "../../../lib/siteTime";
import { chartLabels, escapeHtml, figureText, hasNoReading, labelBucket, NO_DATA, shortLabel, shortLabels, uniqueLabels, unitSuffix } from "../../../lib/widgetFormat";
import { useFocus } from "../FocusContext";
import { AXIS_CHARS, barAxisLayout, DEFAULT_CHART_WIDTH, LABEL_LINE_PX, steppedWidth } from "./barAxis";
import { axisParts, chartBase, legendParts, LIGHT_CHART, seriesLook, tipHead, tipRow, useChartTheme, type ChartTheme } from "./chartTheme";
import { useLegendSelection } from "./legendSelection";

const DASH = "—";
/** Characters a legend entry shows; the full name is in the tooltip and in the legend's own tooltip (S7-3). The axis labels are laid out by barAxis.ts. */
const LEGEND_CHARS = 24;

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
 * `notes[category]`, when given, is one last line under the rows (what a click on this category does, w25).
 */
function tooltipFor(
  cells: readonly (readonly (TipCell | null)[])[], headers: readonly string[], named: boolean, theme: ChartTheme, colors: readonly string[] = [], notes?: readonly string[],
) {
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
    const note = notes?.[items[0]?.dataIndex ?? -1];
    const tail = note ? `<div style="color:${theme.axisText};margin-top:4px">${escapeHtml(note)}</div>` : "";
    return tipHead(headers[items[0]?.dataIndex ?? -1] ?? String(items[0]?.name ?? ""), theme) + rows.join("") + tail;
  };
}

/**
 * `chartWidth` is the width of the chart's box in px (BarWidget measures it); the value-mode category axis is laid out for it (barAxis.ts): the
 * names wrap inside their slots, or turn by 40 degrees when the slots are too narrow to hold a wrapped name.
 * `drill` (w25) is what a click on each bar of a breakdown by kind does, in the bars' order: it adds the last line of the tooltip, makes the axis names emit
 * events and gives the bars the pointer. With none, a breakdown's bars say with their cursor that a click does nothing.
 */
export function barOption(data: WidgetData, timezone: string, theme: ChartTheme = LIGHT_CHART, chartWidth: number = DEFAULT_CHART_WIDTH, drill?: readonly DrillAction[]): EChartsOption {
  const unit = unitSuffix(data.unit);
  const base = chartBase(theme);
  const axis = axisParts(theme);
  if (data.mode === "values") {
    const labels = chartLabels(data.values);
    const layout = barAxisLayout(labels, chartWidth);
    // A metric that recorded nothing is "no data", with no dash mark: the dash means a missing rate and nothing else. A cost
    // without a rate keeps its dash whether or not anything was recorded, like the stat, the table and Billing.
    // A breakdown by kind (w24) is the exception: there a bar that recorded nothing (no figure, or the zero of a meter silent for the whole range,
    // a cost too) is an empty slot among bars that have figures, so it gets the dash mark and the words "no data" in its tooltip, never a bar.
    const noReading = (v: WidgetData["values"][number]) => hasNoReading(v.value, v.no_data, data.source);
    const silent = (v: WidgetData["values"][number]) => data.breakdown != null && isNoDataBar(v);
    const cells = data.values.map((v): TipCell => {
      if (silent(v)) return { text: NO_DATA, state: "" };
      if (v.value === null) return noReading(v) ? { text: NO_DATA, state: "" } : { text: DASH, state: stateOf(v, data.source === "cost") };
      return { text: `${figureText(v.value, v)}${unit}${v.no_data ? ` (${NO_DATA})` : ""}`, state: stateOf(v, false) };
    });
    const names = uniqueLabels(data.values);
    const notes = drill && data.breakdown ? drill.map((action, i) => drillTip(action, names[i], isNoDataBar(data.values[i]))) : undefined;
    return {
      ...base,
      tooltip: { ...base.tooltip, formatter: tooltipFor([cells], labels, false, theme, [], notes) },
      // Wrapped: every name is drawn in its own slot, in as many lines as the layout found (grid.bottom is their room); the width and the
      // truncation only catch a line that is wider than the estimate. Rotated (a crowded axis): hideOverlap may still drop some names (the
      // tooltip and the Details panel have every one), and containLabel keeps the first rotated name from being cut at the left edge. With
      // containLabel the names and the y numbers sit INSIDE the rectangle that left and bottom describe, so those two are plain margins there.
      grid: { left: layout.left, right: 20, top: 30, bottom: layout.bottom, ...(layout.mode === "rotate" ? { containLabel: true } : {}) },
      xAxis: {
        type: "category", data: labels, ...axis, ...(notes ? { triggerEvent: true } : {}),
        axisLabel: {
          ...axis.axisLabel, interval: 0, formatter: (v: string) => layout.labels.get(String(v)) ?? shortLabel(String(v), AXIS_CHARS),
          ...(layout.mode === "wrap"
            ? { width: layout.slot - 4, overflow: "truncate", ellipsis: "…", lineHeight: LABEL_LINE_PX }
            : { rotate: 40, hideOverlap: true }),
        },
      },
      yAxis: { type: "value", name: data.unit ?? undefined, ...axis },
      series: [{
        type: "bar", color: theme.accent, data: data.values.map((v) => (silent(v) ? null : v.value)),
        // A bar shows the pointer (zrender's default for every shape) only when a click on it does something.
        ...(data.breakdown ? { cursor: notes ? "pointer" : "default" } : {}),
        ...dashMarks(data.values.flatMap((v, i) => (silent(v) || (v.value === null && !noReading(v)) ? [i] : [])), theme),
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

/**
 * The row under a breakdown's chart: "Split by" and the kinds present under the root, as "Rack (117)". `current` is the kind shown (the viewer's choice
 * for this visit, which the card already holds while a new answer loads); one the list does not hold is added first. It is `disabled` (still shown, so the
 * card keeps its shape) where the card is not a live one: the editor's grid and its preview.
 */
function SplitBy({ data, current, onKind, disabled }: { data: WidgetData; current: string; onKind?: (kind: string) => void; disabled: boolean }) {
  const id = useId();
  const options = kindOptions(data.breakdown!, current);
  return (
    <div className="bars-split">
      <label htmlFor={id}>Split by</label>
      <select id={id} value={selectedKind(options, current)} disabled={disabled} onChange={(e) => onKind?.(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

interface BarsProps { data: WidgetData; timezone: string; theme: ChartTheme; chartWidth: number }
const BREAKDOWN_CHART_STYLE = { height: "100%", width: "100%", minHeight: 120 };

/**
 * The chart of a breakdown by kind where a click does nothing: the editor's grid and preview, a role without the Assets Tree, or no signed-in user yet.
 * Memoised on its own because BreakdownBars, its parent, re-renders whenever the dashboard's focus changes (it reads the focus context), and a fresh option
 * would make echarts-for-react set it again (see TimeSeriesWidget).
 */
const PlainBars = memo(function PlainBars({ data, timezone, theme, chartWidth }: BarsProps) {
  return <ReactECharts option={barOption(data, timezone, theme, chartWidth)} style={BREAKDOWN_CHART_STYLE} notMerge />;
});

/** What ECharts hands a click handler: the part that was clicked and, for a bar, its index, for an axis name, the category as it was given (not as it is drawn). */
interface ClickParams { componentType?: string; dataIndex?: number; value?: unknown }

/**
 * The index of the bar a click was on, or -1. A click on a bar reports its index; a click on an axis name reports the whole category text (`labels`, the
 * list the axis was given), never the wrapped or shortened text that is drawn, so a name that is cut or turned still maps.
 */
export function clickedBar(params: ClickParams, labels: readonly string[]): number {
  if (params.componentType === "series") return params.dataIndex ?? -1;
  if (params.componentType === "xAxis") return labels.indexOf(String(params.value));
  return -1;
}

/**
 * The chart of a breakdown by kind in the viewer (w25, R10): a click on a bar, or on its name, narrows the dashboard to an asset that has children and opens the
 * page of one that has none; the tooltip says which. Where no card follows the focus (`anyFollowing`) narrowing would change nothing, so every click opens the page.
 * It waits for the asset list (children are read from it), and until then behaves like PlainBars. Only this component asks for the list and for the router, so a
 * card that cannot drill needs neither.
 */
const DrillBars = memo(function DrillBars({ data, timezone, theme, chartWidth }: BarsProps) {
  const assets = useAssets().data;
  const { setFocus, anyFollowing } = useFocus();
  const navigate = useNavigate();
  const actions = useMemo(() => {
    if (!assets) return undefined;
    const parents = parentIds(assets);
    return data.values.map((bar) => drillAction(bar.asset_id, parents, anyFollowing));
  }, [assets, data.values, anyFollowing]);
  const option = useMemo(() => barOption(data, timezone, theme, chartWidth, actions), [data, timezone, theme, chartWidth, actions]);
  // The handler ECharts holds never changes (a new one would be bound again on every refetch); it calls whatever the latest render decided.
  const click = useRef<(params: ClickParams) => void>(() => {});
  click.current = (params) => {
    const index = clickedBar(params, chartLabels(data.values));
    const bar = data.values[index];
    if (!bar || !actions) return;
    if (actions[index] === "narrow") setFocus(bar.asset_id);
    else navigate(`/assets/${bar.asset_id}`);
  };
  const onEvents = useMemo(() => ({ click: (params: ClickParams) => click.current(params) }), []);
  return <ReactECharts option={option} onEvents={actions ? onEvents : undefined} style={BREAKDOWN_CHART_STYLE} notMerge />;
});

/** The breakdown's chart: one that drills where the viewer can open assets and the card is a live one, else the plain one. */
function BreakdownBars({ splitDisabled, ...bars }: BarsProps & { splitDisabled: boolean }) {
  const { allowed } = useFocus();
  return allowed && !splitDisabled ? <DrillBars {...bars} /> : <PlainBars {...bars} />;
}

interface BarWidgetProps {
  data: WidgetData;
  timezone: string;
  /** A breakdown by kind: the kind being shown (the visit's choice, else the stored one), and what the "Split by" select calls when the viewer picks another. Keep `onKind` stable (the card is memoised). */
  kind?: string;
  onKind?: (kind: string) => void;
  /** The select is shown but cannot be used (the editor's grid and preview). */
  splitDisabled?: boolean;
}

/** Bars per asset (the aggregation over the range) or per time bucket, grouped by asset. Memoised for the reason given at TimeSeriesWidget. A breakdown by kind (`data.breakdown`) adds its line and the "Split by" select. */
export const BarWidget = memo(function BarWidget({ data, timezone, kind, onKind, splitDisabled = false }: BarWidgetProps) {
  const legend = useLegendSelection();
  const theme = useChartTheme();
  // The width of the chart's box, in steps of 8 px, for the axis layout. The box is held in state (a callback ref) so that the observer follows it
  // when the data arrives after an empty first render. A box with no width (jsdom, a server render) or no ResizeObserver leaves the default 480 px.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [chartWidth, setChartWidth] = useState(DEFAULT_CHART_WIDTH);
  useLayoutEffect(() => {
    if (!box || typeof ResizeObserver !== "function") return undefined;
    const measure = () => setChartWidth(steppedWidth(box.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);
  const breakdown = data.mode === "values" ? data.breakdown : null;
  if (breakdown) {
    // The chart (or the sentence that stands in its place), the one reserved line, and the select: the same three children in every state, so the select
    // never remounts (it keeps the focus the viewer gave it) and a line appearing moves nothing.
    const sentence = hasNoBars(data.values) ? emptyBreakdownText(breakdown, data.source) : null;
    const line = breakdownLine(breakdown, data.unit);
    return (
      <div className="widget-bars">
        {sentence !== null ? (
          <p className="widget-empty">{sentence}</p>
        ) : (
          <div ref={setBox} className="widget-chart" role="img" aria-label={breakdownDescription(data, breakdown)}>
            <BreakdownBars data={data} timezone={timezone} theme={theme} chartWidth={chartWidth} splitDisabled={splitDisabled} />
          </div>
        )}
        <p className="bars-note" title={line}>{line}</p>
        <SplitBy data={data} current={kind ?? breakdown.kind} onKind={onKind} disabled={splitDisabled} />
      </div>
    );
  }
  // Nothing to draw: no assets, or (metric) every asset recorded nothing, which would be empty axes without even a dash.
  const empty = data.mode === "values"
    ? data.values.every((v) => hasNoReading(v.value, v.no_data, data.source))
    : data.series.every((s) => s.points.every((p) => p.no_data));
  if (empty) return <p className="widget-empty">No data in this range.</p>;
  // The canvas is a picture: the box around it is the chart's text alternative (the figures themselves are in the Details panel).
  return (
    <div ref={setBox} className="widget-chart" role="img" aria-label={chartDescription("bar", data)}>
      <ReactECharts
        option={legend.apply(barOption(data, timezone, theme, chartWidth), data.mode === "series" ? data.series.map((s) => s.asset_id) : [])} onEvents={legend.onEvents}
        style={{ height: "100%", width: "100%", minHeight: 140 }} notMerge
      />
    </div>
  );
});
