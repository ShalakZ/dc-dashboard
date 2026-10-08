import type { RangePreset, WidgetConfig, WidgetData, WidgetType, WidgetValue } from "../api/types";
import { isRolling } from "./ranges";
import type { LiveValue } from "./stream";

const LIVE_TYPES: ReadonlySet<WidgetType> = new Set<WidgetType>(["stat", "gauge"]);

/** A widget follows the stream when it shows the latest metric reading of a range that ends now (spec 10.5). */
export function isLiveWidget(type: WidgetType, config: Pick<WidgetConfig, "source" | "aggregation">, preset: RangePreset): boolean {
  return LIVE_TYPES.has(type) && config.source === "metric" && config.aggregation === "last"
    && (isRolling(preset) || preset === "today" || preset === "this_month");
}

/** The mapping points a values response can be updated from (energy and cost values have none). */
export function pointIdsOf(data: WidgetData | undefined): number[] {
  return (data?.values ?? []).flatMap((v) => (v.point_id === null ? [] : [v.point_id]));
}

/** What a stat or gauge shows: the figure, when it was read, whether that is stale, and whether nothing was recorded at all. */
export interface Reading { value: number | null; ts: string | null; stale: boolean; noData: boolean }

/**
 * A stream entry wins over the fetched row, even a null one (the reading went bad, and bad quality counts as no value);
 * no entry yet means the fetched row stands. The stream knows no staleness, so a streamed value is fresh by definition
 * and its age comes from the entry's own time. Instants are compared, never the strings (`live.ts` is "...Z" with
 * milliseconds, `row.ts` carries the site offset and microseconds). When the fetched reading is the newer one the stream
 * missed it, or the entry is left over from before a reconnect, so the row wins as a whole.
 */
export function liveOrFetched(live: LiveValue | undefined, row: Pick<WidgetValue, "value" | "ts" | "stale" | "no_data">): Reading {
  const fetched: Reading = { value: row.value, ts: row.ts, stale: row.stale, noData: row.no_data };
  if (!live) return fetched;
  if (row.ts !== null && !(Date.parse(live.ts) > Date.parse(row.ts))) return fetched;
  // A bad read is a reading that recorded nothing, as the fetched row of a failing meter says (`no_data`), so a widget
  // reads the same whether the figure comes from the fetch or from the stream.
  return { value: live.quality === 0 ? live.value : null, ts: live.ts, stale: false, noData: live.quality !== 0 || live.value === null };
}
