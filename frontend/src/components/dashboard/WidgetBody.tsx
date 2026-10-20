import { lazy, Suspense } from "react";
import type { WidgetConfig, WidgetData, DataWidgetType } from "../../api/types";
import { skeletonShape, type ParentNames } from "../../lib/widgetFormat";
import { WidgetSkeleton } from "../Skeleton";
import { GaugeWidget } from "./widgets/GaugeWidget";
import { StatWidget } from "./widgets/StatWidget";
import { TableWidget } from "./widgets/TableWidget";

// The two chart widgets pull in ECharts: they load only when a dashboard actually shows one. The gauge is plain markup and loads with the page.
const TimeSeriesWidget = lazy(() => import("./widgets/TimeSeriesWidget").then((m) => ({ default: m.TimeSeriesWidget })));
const BarWidget = lazy(() => import("./widgets/BarWidget").then((m) => ({ default: m.BarWidget })));

interface Props {
  type: DataWidgetType; data: WidgetData; config: WidgetConfig; timezone: string; live: boolean;
  /** A breakdown by kind: what the "Split by" select calls (a stable function), and whether it is shown but unusable (the editor's grid and preview). */
  onKind?: (kind: string) => void;
  splitDisabled?: boolean;
  /** The parent names of the asset list (w27 R6) that tell a repeated asset name apart on a table, a bar chart or a line chart; undefined = the old "Rack 04 (#12)". Keep it stable. */
  parents?: ParentNames;
}

export function WidgetBody({ type, data, config, timezone, live, onKind, splitDisabled, parents }: Props) {
  if (type === "stat") return <StatWidget data={data} live={live} />;
  if (type === "table") return <TableWidget data={data} parents={parents} />;
  if (type === "gauge") return <GaugeWidget data={data} config={config} live={live} />;
  return (
    // The same shape the card showed while the data loaded, as a bare body: the chart chunk's wait is not a second status.
    <Suspense fallback={<WidgetSkeleton type={type} shape={skeletonShape(type, config)} tip={!splitDisabled} />}>
      {type === "timeseries" && <TimeSeriesWidget data={data} timezone={timezone} parents={parents} />}
      {type === "bar" && <BarWidget data={data} timezone={timezone} kind={config.kind} onKind={onKind} splitDisabled={splitDisabled} parents={parents} />}
    </Suspense>
  );
}
