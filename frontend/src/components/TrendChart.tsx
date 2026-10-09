import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useState } from "react";
import { useSeries, useSite } from "../api/queries";
import type { Metric, Series, SeriesTier, SummaryMetric } from "../api/types";
import { formatSiteDateTime, formatSiteTick } from "../lib/siteTime";
import { rangeToQuery, type Range } from "../lib/timeRange";
import { bucketMs, markIsolated } from "./dashboard/widgets/TimeSeriesWidget";
import { RangePicker } from "./RangePicker";

type SeriesPoint = Series["points"][number];
type Query = { start: string; end: string; buckets: number };

const TIER_LABEL: Record<SeriesTier, string> = { raw: "raw samples", "1m": "1-minute rollup", "1h": "1-hour rollup" };

/**
 * Build chart rows, inserting a `[ts, null]` row wherever two consecutive points are more than 1.5 steps apart.
 * time_bucket omits empty buckets, so without this the line would bridge outages. The step is the query's bucket
 * width, or the series' own median step when that is larger (a metric sampled every 60 s on a 12 s grid has steps of 60 s;
 * judged against 12 s every point would sit alone, which is how the 1h energy chart drew nothing), the way the dashboard
 * widgets read it.
 */
export function withGaps(points: SeriesPoint[], query: Query, pick: (p: SeriesPoint) => number): [string, number | null][] {
  const grid = (Date.parse(query.end) - Date.parse(query.start)) / query.buckets;
  const width = Math.max(Number.isFinite(grid) ? grid : 0, bucketMs(null, points) ?? 0);
  const rows: [string, number | null][] = [];
  let previous: number | null = null;
  for (const p of points) {
    const t = Date.parse(p.ts);
    if (previous !== null && width > 0 && t - previous > width * 1.5) rows.push([new Date(previous + width).toISOString(), null]);
    rows.push([p.ts, pick(p)]);
    previous = t;
  }
  return rows;
}

type TooltipItem = { axisValue?: number; marker?: string; seriesName?: string; value?: [string | number, number | null] };

/**
 * Axis tooltip: the header time in the site zone (ECharts would print the browser's), then one row per series. The "max"
 * series is stacked on "min" and holds the width of the band (max - min), so its row adds the min back to print the max.
 */
export function tooltipHtml(raw: unknown, timezone: string): string {
  const items = (Array.isArray(raw) ? raw : [raw]) as TooltipItem[];
  const at = items[0]?.axisValue;
  const header = typeof at === "number" && Number.isFinite(at) ? formatSiteDateTime(new Date(at).toISOString(), timezone) : "";
  const min = items.find((item) => item.seriesName === "min")?.value?.[1];
  const rows = items.map((item) => {
    const stored = item.value?.[1];
    const v = item.seriesName === "max" && stored != null ? (min == null ? null : Number(stored) + Number(min)) : stored;
    return `${item.marker ?? ""}${item.seriesName ?? ""}: ${v == null ? "—" : Number(v.toFixed(3))}`;
  });
  return [header, ...rows].join("<br/>");
}

export function seriesToOption(series: Series, range: Range, query: Query = rangeToQuery(range), timezone = "UTC"): EChartsOption {
  const bucket = range === "7d" ? "hour" : null; // a week needs dates on the ticks, a day does not
  return {
    animation: false,
    useUTC: true, // tick positions on whole UTC hours; labels below are formatted in the site zone, not the browser's
    tooltip: { trigger: "axis", formatter: (raw: unknown) => tooltipHtml(raw, timezone) },
    grid: { left: 60, right: 20, top: 30, bottom: 40 },
    xAxis: {
      type: "time",
      axisLabel: { formatter: (value: number) => (Number.isFinite(value) ? formatSiteTick(new Date(value).toISOString(), timezone, bucket) : "") },
    },
    yAxis: { type: "value", name: series.unit, scale: true },
    series: [
      { name: "min", type: "line", data: withGaps(series.points, query, (p) => p.min), lineStyle: { opacity: 0 }, symbol: "none", stack: "band", connectNulls: false },
      { name: "max", type: "line", data: withGaps(series.points, query, (p) => p.max - p.min), lineStyle: { opacity: 0 }, symbol: "none", stack: "band", areaStyle: { color: "#000", opacity: 0.1 }, connectNulls: false },
      { name: "avg", type: "line", data: markIsolated(withGaps(series.points, query, (p) => p.avg)), symbol: "none", color: "#000", connectNulls: false },
    ],
  };
}

export function TrendChart({ assetId, metrics }: { assetId: number; metrics: SummaryMetric[] }) {
  const available = [...new Set(metrics.map((m) => m.metric))]; // two mappings of one metric are one entry in the picker
  const [metric, setMetric] = useState<Metric | null>(
    available.includes("active_power_kw") ? "active_power_kw" : (available[0] ?? null),
  );
  const [range, setRange] = useState<Range>("1h");
  const [mappingId, setMappingId] = useState<number | undefined>(undefined);
  const mappings = metrics.filter((m) => m.metric === metric);
  const chosenMapping = mappings.some((m) => m.mapping_id === mappingId) ? mappingId : undefined;
  const { data, error, isFetching } = useSeries(assetId, metric, range, mappings.length > 1 ? chosenMapping : undefined);
  const site = useSite();
  if (metric === null) return <p className="muted">No metric to chart.</p>;
  return (
    <section>
      <div className="row">
        <label>Metric
          <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            {available.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        {mappings.length > 1 && (
          <label>Mapping
            <select aria-label="Mapping" value={chosenMapping ?? ""} onChange={(e) => setMappingId(e.target.value ? Number(e.target.value) : undefined)}>
              <option value="">default</option>
              {mappings.map((m) => <option key={m.mapping_id} value={m.mapping_id}>point {m.point_id}</option>)}
            </select>
          </label>
        )}
        <RangePicker value={range} onChange={setRange} />
        {data && <span className="muted">{TIER_LABEL[data.tier ?? "raw"]}</span>}
        {isFetching && <span className="muted">updating…</span>}
      </div>
      {error && <p className="error" role="alert">{error.message}</p>}
      {site.error && <p className="error" role="alert">Could not load the site time zone: {site.error.message}</p>}
      {data && data.points.length === 0 && <p className="muted">No data in this range.</p>}
      {/* The axis is drawn in the site's zone: wait for it rather than showing UTC for a moment, or for good. */}
      {data && data.points.length > 0 && !site.data && !site.error && <p className="muted">loading…</p>}
      {data && data.points.length > 0 && site.data && (
        <ReactECharts option={seriesToOption(data, range, undefined, site.data.timezone)} style={{ height: 320 }} notMerge />
      )}
    </section>
  );
}
