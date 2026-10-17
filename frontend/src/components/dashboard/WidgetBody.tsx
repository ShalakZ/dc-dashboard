import { lazy, Suspense } from "react";
import type { WidgetConfig, WidgetData, WidgetType } from "../../api/types";
import { WidgetSkeleton } from "../Skeleton";
import { GaugeWidget } from "./widgets/GaugeWidget";
import { StatWidget } from "./widgets/StatWidget";
import { TableWidget } from "./widgets/TableWidget";

// The two chart widgets pull in ECharts: they load only when a dashboard actually shows one. The gauge is plain markup and loads with the page.
const TimeSeriesWidget = lazy(() => import("./widgets/TimeSeriesWidget").then((m) => ({ default: m.TimeSeriesWidget })));
const BarWidget = lazy(() => import("./widgets/BarWidget").then((m) => ({ default: m.BarWidget })));

interface Props { type: WidgetType; data: WidgetData; config: WidgetConfig; timezone: string; live: boolean }

export function WidgetBody({ type, data, config, timezone, live }: Props) {
  if (type === "stat") return <StatWidget data={data} live={live} />;
  if (type === "table") return <TableWidget data={data} />;
  if (type === "gauge") return <GaugeWidget data={data} config={config} live={live} />;
  return (
    // The same shape the card showed while the data loaded, as a bare body: the chart chunk's wait is not a second status.
    <Suspense fallback={<WidgetSkeleton type={type} />}>
      {type === "timeseries" && <TimeSeriesWidget data={data} timezone={timezone} />}
      {type === "bar" && <BarWidget data={data} timezone={timezone} />}
    </Suspense>
  );
}
