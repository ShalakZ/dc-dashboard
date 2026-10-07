import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useState } from "react";
import { useSeries } from "../api/queries";
import type { Metric, Series, SummaryMetric } from "../api/types";
import { rangeToQuery, type Range } from "../lib/timeRange";
import { RangePicker } from "./RangePicker";

type SeriesPoint = Series["points"][number];
type Query = { start: string; end: string; buckets: number };

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
  const { data, error, isFetching } = useSeries(assetId, metric, range);
  if (metric === null) return <p className="muted">No metric to chart.</p>;
  return (
    <section>
      <div className="row">
        <label>Metric
          <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            {available.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <RangePicker value={range} onChange={setRange} />
        {isFetching && <span className="muted">updating…</span>}
      </div>
      {error && <p className="error" role="alert">{error.message}</p>}
      {data && (data.points.length === 0 ? <p className="muted">No data in this range.</p> : <ReactECharts option={seriesToOption(data, range)} style={{ height: 320 }} notMerge />)}
    </section>
  );
}
