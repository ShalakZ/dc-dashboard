import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useState } from "react";
import { useSeries } from "../api/queries";
import type { Metric, Series, SummaryMetric } from "../api/types";
import type { Range } from "../lib/timeRange";
import { RangePicker } from "./RangePicker";

export function seriesToOption(series: Series, range: Range): EChartsOption {
  const ts = (p: { ts: string }) => p.ts;
  return {
    animation: false,
    tooltip: { trigger: "axis" },
    grid: { left: 60, right: 20, top: 30, bottom: 40 },
    xAxis: { type: "time", name: range },
    yAxis: { type: "value", name: series.unit, scale: true },
    series: [
      { name: "min", type: "line", data: series.points.map((p) => [ts(p), p.min]), lineStyle: { opacity: 0 }, symbol: "none", stack: "band", connectNulls: false },
      { name: "max", type: "line", data: series.points.map((p) => [ts(p), p.max - p.min]), lineStyle: { opacity: 0 }, symbol: "none", stack: "band", areaStyle: { color: "#000", opacity: 0.1 }, connectNulls: false },
      { name: "avg", type: "line", data: series.points.map((p) => [ts(p), p.avg]), symbol: "none", color: "#000", connectNulls: false },
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
