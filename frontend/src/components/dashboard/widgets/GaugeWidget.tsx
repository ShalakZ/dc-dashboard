import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useMemo } from "react";
import type { WidgetConfig, WidgetData } from "../../../api/types";
import { liveOrFetched } from "../../../lib/live";
import { figureText, unitSuffix } from "../../../lib/widgetFormat";
import { Age } from "../Age";
import { useLiveValue } from "../LiveValuesContext";

interface GaugeArgs {
  value: number | null; min: number; max: number; unit: string | null; name: string;
  estimated?: boolean; partial?: boolean;
  /** Dim the figure (stale, or nothing recorded). */
  muted?: boolean;
}

/** A missing value draws no needle and no progress, only a dash: a gauge parked at zero would read as a measured zero. */
export function gaugeOption({ value, min, max, unit, name, estimated = false, partial = false, muted = false }: GaugeArgs): EChartsOption {
  const present = value !== null;
  return {
    animation: false,
    series: [{
      type: "gauge", min, max,
      pointer: { show: present },
      progress: { show: present },
      axisLine: { lineStyle: { width: 10 } },
      detail: {
        valueAnimation: false, fontSize: 22, offsetCenter: [0, "70%"],
        ...(muted ? { color: "#999" } : {}),
        formatter: () => (present ? `${figureText(value, { estimated, partial })}${unitSuffix(unit)}` : "—"),
      },
      data: [{ value: value ?? min, name }],
    }],
  };
}

/** A gauge for one asset; `min`/`max` come from the widget config and `live` lets the stream move the needle. */
export function GaugeWidget({ data, config, live }: { data: WidgetData; config: WidgetConfig; live: boolean }) {
  const row = data.values[0];
  const stream = useLiveValue(live && row ? row.point_id : null);
  const reading = row ? liveOrFetched(stream, row) : null;
  const max = config.max ?? config.min + 100;
  const value = reading?.value ?? null;
  const muted = reading ? reading.stale || reading.noData : false;
  const name = row?.name ?? "";
  const { min } = config;
  const { unit } = data;
  const estimated = row?.estimated;
  const partial = row?.partial;
  // A gauge re-renders on every stream batch that moves any point of the dashboard; only a changed figure may reach
  // setOption (a new option object resets the chart), so the option is rebuilt from its primitive inputs only.
  const option = useMemo(
    () => gaugeOption({ value, min, max, unit, name, estimated, partial, muted }),
    [value, min, max, unit, name, estimated, partial, muted],
  );
  return (
    <div className="gauge">
      <ReactECharts option={option} style={{ flex: 1, width: "100%", minHeight: 140 }} notMerge />
      {reading?.stale && reading.ts && <div><Age ts={reading.ts} /></div>}
    </div>
  );
}
