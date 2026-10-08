import { lazy, Suspense } from "react";
import type { WidgetConfig, WidgetData, WidgetType } from "../../api/types";
import { StatWidget } from "./widgets/StatWidget";
import { TableWidget } from "./widgets/TableWidget";

// The chart widgets pull in ECharts: they load only when a dashboard actually shows one.
const TimeSeriesWidget = lazy(() => import("./widgets/TimeSeriesWidget").then((m) => ({ default: m.TimeSeriesWidget })));
const BarWidget = lazy(() => import("./widgets/BarWidget").then((m) => ({ default: m.BarWidget })));
const GaugeWidget = lazy(() => import("./widgets/GaugeWidget").then((m) => ({ default: m.GaugeWidget })));

interface Props { type: WidgetType; data: WidgetData; config: WidgetConfig; timezone: string; live: boolean }

export function WidgetBody({ type, data, config, timezone, live }: Props) {
  if (type === "stat") return <StatWidget data={data} live={live} />;
  if (type === "table") return <TableWidget data={data} />;
  return (
    <Suspense fallback={<p className="muted">loading chart…</p>}>
      {type === "timeseries" && <TimeSeriesWidget data={data} timezone={timezone} />}
      {type === "bar" && <BarWidget data={data} timezone={timezone} />}
      {type === "gauge" && <GaugeWidget data={data} config={config} live={live} />}
    </Suspense>
  );
}
