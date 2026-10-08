import type { EChartsOption } from "echarts";
import { useMemo, useRef } from "react";

type Selected = Record<string, boolean>;

/** The entries of the legend `option` shows, or null when it shows none: the names in `legend.data`, else the series names. */
function legendNames(option: EChartsOption): string[] | null {
  const legend = option.legend as { show?: boolean; data?: unknown[] } | undefined;
  if (!legend || legend.show === false) return null;
  if (Array.isArray(legend.data)) return legend.data.map(String);
  return ((option.series ?? []) as { name?: string }[]).flatMap((s) => (s.name === undefined ? [] : [s.name]));
}

/**
 * Whether a remembered `selected` still describes the legend of `option`: the legend is shown, and its entries are exactly
 * the ones the viewer chose from. Otherwise it is stale (an asset was deleted or replaced), and applying it could leave a
 * series hidden with no legend left to switch it back on.
 */
export function selectionFits(option: EChartsOption, selected: Selected): boolean {
  const names = legendNames(option);
  const chosen = Object.keys(selected);
  return names !== null && names.length === chosen.length && names.every((name) => name in selected);
}

/** `option` with the legend entries as the viewer left them; unchanged when nothing was switched or the choice is stale. */
export function withLegendSelection(option: EChartsOption, selected: Selected): EChartsOption {
  if (Object.keys(selected).length === 0 || !selectionFits(option, selected)) return option;
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
  const apply = (option: EChartsOption) => {
    // A choice that no longer fits is dropped for good, not just skipped: it must not come back when the names do.
    if (Object.keys(selected.current).length > 0 && !selectionFits(option, selected.current)) selected.current = {};
    return withLegendSelection(option, selected.current);
  };
  return { onEvents, apply };
}
