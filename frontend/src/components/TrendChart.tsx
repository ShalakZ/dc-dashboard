import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useState } from "react";
import { useSeries } from "../api/queries";
import type { Metric, Series, SeriesTier, SummaryMetric } from "../api/types";
import { rangeToQuery, type Range } from "../lib/timeRange";
import { RangePicker } from "./RangePicker";

type SeriesPoint = Series["points"][number];
type Query = { start: string; end: string; buckets: number };

const TIER_LABEL: Record<SeriesTier, string> = { raw: "raw samples", "1m": "1-minute rollup", "1h": "1-hour rollup" };

/**
 * Build chart rows, inserting a `[ts, null]` row wherever two consecutive buckets are more than one
 * bucket width apart. time_bucket omits empty buckets, so without this the line would bridge outages.
 */
export function withGaps(points: SeriesPoint[], query: Query, pick: (p: SeriesPoint) => number): [string, number | null][] {
  const width = (Date.parse(query.end) - Date.parse(query.start)) / query.buckets;
  const rows: [string, number | null][] = [];
  let previous: number | null = null;
  for (const p of points) {
    const t = Date.parse(p.ts);
    if (previous !== null && t - previous > width * 1.5) rows.push([new Date(previous + width).toISOString(), null]);
    rows.push([p.ts, pick(p)]);
    previous = t;
  }
  return rows;
}

export function seriesToOption(series: Series, range: Range, query: Query = rangeToQuery(range)): EChartsOption {
  return {
    animation: false,
    tooltip: { trigger: "axis" },
    grid: { left: 60, right: 20, top: 30, bottom: 40 },
    xAxis: { type: "time" },
    yAxis: { type: "value", name: series.unit, scale: true },
    series: [
      { name: "min", type: "line", data: withGaps(series.points, query, (p) => p.min), lineStyle: { opacity: 0 }, symbol: "none", stack: "band", connectNulls: false },
      { name: "max", type: "line", data: withGaps(series.points, query, (p) => p.max - p.min), lineStyle: { opacity: 0 }, symbol: "none", stack: "band", areaStyle: { color: "#000", opacity: 0.1 }, connectNulls: false },
      { name: "avg", type: "line", data: withGaps(series.points, query, (p) => p.avg), symbol: "none", color: "#000", connectNulls: false },
    ],
  };
}

export function TrendChart({ assetId, metrics }: { assetId: number; metrics: SummaryMetric[] }) {
  const available = metrics.map((m) => m.metric);
  const [metric, setMetric] = useState<Metric | null>(
    available.includes("active_power_kw") ? "active_power_kw" : (available[0] ?? null),
  );
  const [range, setRange] = useState<Range>("1h");
  const [mappingId, setMappingId] = useState<number | undefined>(undefined);
  const mappings = metrics.filter((m) => m.metric === metric);
  const chosenMapping = mappings.some((m) => m.mapping_id === mappingId) ? mappingId : undefined;
  const { data, error, isFetching } = useSeries(assetId, metric, range, mappings.length > 1 ? chosenMapping : undefined);
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
              <option value="">all</option>
              {mappings.map((m) => <option key={m.mapping_id} value={m.mapping_id}>point {m.point_id}</option>)}
            </select>
          </label>
        )}
        <RangePicker value={range} onChange={setRange} />
        {data && <span className="muted">{TIER_LABEL[data.tier ?? "raw"]}</span>}
        {isFetching && <span className="muted">updating…</span>}
      </div>
      {error && <p className="error" role="alert">{error.message}</p>}
      {data && (data.points.length === 0 ? <p className="muted">No data in this range.</p> : <ReactECharts option={seriesToOption(data, range)} style={{ height: 320 }} notMerge />)}
    </section>
  );
}
