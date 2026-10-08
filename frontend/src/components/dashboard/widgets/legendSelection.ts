import type { EChartsOption } from "echarts";
import { useMemo, useRef } from "react";

type Selected = Record<string, boolean>;

/** `option` with the legend entries as the viewer left them; unchanged when nothing was switched. */
export function withLegendSelection(option: EChartsOption, selected: Selected): EChartsOption {
  if (Object.keys(selected).length === 0) return option;
  return { ...option, legend: { ...(option.legend as object), selected } } as EChartsOption;
}

/**
 * A chart's option is rebuilt whenever its data is refetched (every 30 s on a rolling range), and echarts-for-react then
 * calls setOption with notMerge, which would switch a legend entry the viewer had turned off back on. This remembers the
 * selection ECharts reports in `legendselectchanged` (in a ref: ECharts already shows it, so there is nothing to
 * re-render) and writes it into the next option. Pass `onEvents` to the chart and the option through `apply`.
 */
export function useLegendSelection() {
  const selected = useRef<Selected>({});
  const onEvents = useMemo(() => ({
    legendselectchanged: (event: { selected?: Selected }) => {
      if (event.selected) selected.current = { ...event.selected };
    },
  }), []);
  return { onEvents, apply: (option: EChartsOption) => withLegendSelection(option, selected.current) };
}
