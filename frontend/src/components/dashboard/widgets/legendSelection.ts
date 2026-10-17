import type { EChartsOption } from "echarts";
import { useMemo, useRef } from "react";

/** What the viewer chose, by ASSET id (a legend name carries " ~" and " *" flags that come and go on a refetch). true = shown. */
type Remembered = Record<number, boolean>;
/** What ECharts reports and takes: by legend name. */
type ByName = Record<string, boolean>;

/** The entries of the legend `option` shows, or null when it shows none: the names in `legend.data`, else the series names. */
function legendNames(option: EChartsOption): string[] | null {
  const legend = option.legend as { show?: boolean; data?: unknown[] } | undefined;
  if (!legend || legend.show === false) return null;
  if (Array.isArray(legend.data)) return legend.data.map(String);
  return ((option.series ?? []) as { name?: string }[]).flatMap((s) => (s.name === undefined ? [] : [s.name]));
}

/**
 * The remembered choice written against the entries `option`'s legend has now, or null when it cannot be applied: the legend is not
 * shown (a hidden series would have nothing left to switch it back on), `ids` does not line up with the entries, no remembered asset is
 * in the legend any more, or the choice would hide every series. An asset in the legend that was never chosen from is shown; an id that
 * is gone is ignored. `ids[i]` is the asset behind the legend's entry i.
 */
export function selectionFor(option: EChartsOption, ids: readonly number[], remembered: Remembered): ByName | null {
  const names = legendNames(option);
  if (names === null || names.length !== ids.length) return null;
  if (!ids.some((id) => id in remembered)) return null;
  const selected: ByName = {};
  names.forEach((name, i) => { selected[name] = remembered[ids[i]] ?? true; });
  return Object.values(selected).some(Boolean) ? selected : null;
}

/** `option` with the legend entries as the viewer left them; unchanged when nothing was switched or the choice cannot be applied. */
export function withLegendSelection(option: EChartsOption, ids: readonly number[], remembered: Remembered): EChartsOption {
  const selected = selectionFor(option, ids, remembered);
  return selected === null ? option : ({ ...option, legend: { ...(option.legend as object), selected } } as EChartsOption);
}

/**
 * A chart's option is rebuilt whenever its data is refetched (every 30 s on a rolling range), and echarts-for-react then
 * calls setOption with notMerge, which would switch a legend entry the viewer had turned off back on. This remembers the
 * selection ECharts reports in `legendselectchanged` (in a ref: ECharts already shows it, so there is nothing to
 * re-render) and writes it into the next option. Pass `onEvents` to the chart and the option through `apply`, with the asset
 * id behind each legend entry: the choice is kept by asset, so an entry that gains a " ~" or a " *" keeps it.
 */
export function useLegendSelection() {
  const remembered = useRef<Remembered>({});
  const idOf = useRef<Map<string, number>>(new Map());
  const onEvents = useMemo(() => ({
    legendselectchanged: (event: { selected?: ByName }) => {
      if (!event.selected) return;
      const next: Remembered = {};
      for (const [name, shown] of Object.entries(event.selected)) {
        const id = idOf.current.get(name);
        if (id !== undefined) next[id] = shown;
      }
      remembered.current = next;
    },
  }), []);
  const apply = (option: EChartsOption, ids: readonly number[]) => {
    const names = legendNames(option);
    idOf.current = names !== null && names.length === ids.length ? new Map(names.map((name, i) => [name, ids[i]] as const)) : new Map();
    const selected = selectionFor(option, ids, remembered.current);
    if (selected === null) {
      // A choice that cannot be applied is dropped for good, not just skipped: it must not come back when the legend does.
      remembered.current = {};
      return option;
    }
    // Assets that are gone are forgotten, so one that returns later is shown.
    remembered.current = Object.fromEntries(ids.filter((id) => id in remembered.current).map((id) => [id, remembered.current[id]]));
    return withLegendSelection(option, ids, remembered.current);
  };
  return { onEvents, apply };
}
