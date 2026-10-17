import type { RangePreset, SeriesTier, WidgetAggregation, WidgetConfig, WidgetData, WidgetPoint, WidgetSeries, WidgetType } from "../api/types";
import { RANGE_LABELS, isRolling } from "./ranges";
import { formatSiteClock, formatSiteDateTime, formatSiteTick, siteDay } from "./siteTime";
import { flagsOf, hasNoReading, uniqueLabels } from "./widgetFormat";

/*
 * Pure helpers for the Details panel and the chart's text alternative (w13). Every function says only what the response
 * proves (backend `core/widgets.py`): a figure that cannot be derived exactly is `null` or absent, never an estimate.
 * `now` is epoch milliseconds, `timezone` the site zone.
 *
 * What a response can prove:
 *  - A series point's `value` is the bucket AVERAGE for a metric time series, the saved aggregation of the hour or day
 *    for a metric bar over time, and the bucket SUM for energy and cost. Its `min` and `max` (metric only) are the true
 *    extremes of the stored readings, because the roll-ups keep them; energy and cost points have none.
 *  - A metric time series is always the average with a min-max band, whatever the saved aggregation says, and its
 *    bucket width is chosen by the backend and NOT in the response: only the data tier (which stored table served it)
 *    is known. So no helper ever states a width for it.
 *  - Buckets hold different numbers of samples, so an average over buckets is not exact: nothing here computes one.
 */

type AggregationConfig = Pick<WidgetConfig, "source" | "aggregation">;

const TIER_WORDS: Record<SeriesTier, string> = { raw: "the raw readings", "1m": "the 1-minute roll-up", "1h": "the hourly roll-up" };
const tierParens = (tier: SeriesTier | null): string => (tier ? ` (${TIER_WORDS[tier]})` : "");
const bucketNoun = (bucket: WidgetData["bucket"]): string => bucket ?? "bucket";
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** The words of each saved aggregation for a figure over a whole window. */
const VALUE_WORDS: Record<WidgetAggregation, string> = { avg: "Average", min: "Lowest", max: "Highest", last: "Latest reading", sum: "Total" };
/** The same for the figure drawn per hour or per day in a metric bar over time (`last` is the last value of the latest hour). */
const BUCKET_WORDS: Record<WidgetAggregation, string> = { avg: "Average", min: "Lowest", max: "Highest", last: "Latest", sum: "Total" };
const INSIDE_WORDS: Record<WidgetAggregation, string> = { avg: "average", min: "lowest", max: "highest", last: "last value", sum: "total" };

/** How long ago `ts` was, to the second under a minute: "just now", "9 s ago", "5 min ago", "1 h 5 min ago", "3 d ago"; empty when `ts` is not a time. */
export function preciseAge(ts: string, now: number): string {
  const then = Date.parse(ts);
  if (Number.isNaN(then)) return "";
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 5) return "just now"; // also a reading a little ahead of this clock
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes === 0 ? `${hours} h ago` : `${hours} h ${minutes} min ago`;
  }
  return `${Math.floor(seconds / 86_400)} d ago`;
}

/**
 * Whether the backend answered with the latest stored reading of each asset: a metric `last` over a range that ends now
 * (`LIVE_LAST` in `core/widgets.py`). It does so for every widget TYPE, so a table row carries a real reading time too;
 * `isLiveWidget` in `lib/live.ts` is narrower (stat and gauge: the types that follow the stream) and must not be used for
 * what the TIME of a figure means. For a finished range the backend gives the last hourly roll-up value instead.
 */
export function isLatestReading(data: Pick<WidgetData, "source" | "range">, config: AggregationConfig): boolean {
  const { preset } = data.range;
  return data.source === "metric" && config.aggregation === "last" && (isRolling(preset) || preset === "today" || preset === "this_month");
}

/**
 * When the figure was read. `live` is `isLatestReading`. A live reading has a real time: "Last reading 12:04:31 (9 s ago)",
 * with the date when it is not the site's today, and a stale sentence. For a finished range `ts` is the START OF THE HOUR
 * of the roll-up row the last value belongs to, so only that hour is claimed: its date and hour ("10-16 23:00", for a last
 * month that hour could be any day of it), no seconds, no age, never stale.
 */
export function freshnessLine(ts: string | null, now: number, timezone: string, stale: boolean, live: boolean): string {
  const known = ts !== null && !Number.isNaN(Date.parse(ts));
  if (!live) return known ? `Last value of the hour from ${formatSiteTick(ts, timezone, "hour")} (hourly roll-up)` : "No reading time recorded";
  const sentence = stale ? " Stale: older than three polling intervals of its meter (and at least a minute)." : "";
  if (!known) return `No reading time recorded${sentence}`;
  const sameDay = siteDay(new Date(ts), timezone) === siteDay(new Date(now), timezone);
  const when = sameDay ? formatSiteClock(ts, timezone) : formatSiteDateTime(ts, timezone);
  return `Last reading ${when} (${preciseAge(ts, now)})${sentence}`;
}

/** `2026-10-07 13:00` in the site zone (the seconds of `formatSiteDateTime` cut off). */
function toMinutes(iso: string, timezone: string): string {
  const text = formatSiteDateTime(iso, timezone);
  return text.length === 19 ? text.slice(0, 16) : text;
}

/** The real window of the response: "2026-10-17 10:46 to 2026-10-18 10:46 (Asia/Qatar)". */
export function windowText(range: WidgetData["range"], timezone: string): string {
  return `${toMinutes(range.start, timezone)} to ${toMinutes(range.end, timezone)} (${timezone})`;
}

/** "Last 24 hours", "Yesterday": the preset's own words. */
export const rangeWords = (preset: RangePreset): string => RANGE_LABELS[preset] ?? preset;

/**
 * What the figures of the response are, in the response's own terms. Keyed on (type, source, mode), never on the tier or on
 * the saved aggregation alone: a metric time series ignores the saved aggregation and is always averages.
 */
export function figuresText(data: WidgetData, config: AggregationConfig): string {
  if (data.mode === "values") {
    if (data.source === "metric" && config.aggregation === "last") {
      return isLatestReading(data, config) ? "The latest reading of each asset" : "One figure per asset: the last value in the window (hourly roll-up)";
    }
    return "One figure per asset over the whole window";
  }
  if (data.source !== "metric") return `One value per ${bucketNoun(data.bucket)}`;
  if (data.type === "timeseries") return `Averages of the stored readings${tierParens(data.tier)}`;
  return `One value per ${bucketNoun(data.bucket)}: the ${INSIDE_WORDS[config.aggregation]} inside each${tierParens(data.tier)}`;
}

/** What one figure is, as a short phrase ("Total per hour", "Latest reading"). Same keys as `figuresText`; `type` is the widget's. */
export function aggregationWords(type: WidgetType, data: WidgetData, config: AggregationConfig): string {
  if (data.mode === "series") {
    if (data.source !== "metric") return `Total per ${bucketNoun(data.bucket)}`;
    if (type === "timeseries") return "Average of each bucket, with the lowest and highest as a band";
    return `${BUCKET_WORDS[config.aggregation]} per ${bucketNoun(data.bucket)}`;
  }
  if (data.source !== "metric") return "Total";
  if (config.aggregation === "last" && !isLatestReading(data, config)) return "Last value in the window";
  return VALUE_WORDS[config.aggregation];
}

/** The metric with its unit ("active_power_kw (kW)"), or "Energy (kWh)" and "Cost (QAR)". No unit, no parentheses. */
export function sourceWords(data: Pick<WidgetData, "source" | "metric" | "unit">): string {
  const name = data.source === "energy" ? "Energy" : data.source === "cost" ? "Cost" : (data.metric ?? "Metric");
  return data.unit ? `${name} (${data.unit})` : name;
}

/** A bucket with no figure at all: nothing was recorded in it. */
const recordedNothing = (series: WidgetSeries): boolean => series.points.every((p) => p.no_data);
/** A cost bucket that was recorded but has no rate (`value === null && !no_data`); same rule as `flagsOf`. */
const hasNoRateBucket = (series: WidgetSeries): boolean => series.points.some((p) => p.value === null && !p.no_data);

/**
 * One sentence for each marker THIS response uses, in a fixed order (~, *, the dash, no data). Nothing for an absent marker.
 * "No data" is said only for a row or a whole series that recorded nothing: a series with a gap but some data did record.
 * (The stale state is `freshnessLine`'s.)
 */
export function markerMeanings(data: WidgetData): string[] {
  const flags = flagsOf(data);
  const noData = data.values.some((v) => v.no_data) || data.series.some(recordedNothing);
  const out: string[] = [];
  if (flags.estimated) out.push("~ estimated from power, not measured");
  if (flags.partial) out.push("* partial: some energy in the period had no rate, so the cost is incomplete");
  if (flags.noRate) out.push("— no rate: no tariff applies to this figure");
  if (noData) out.push("no data: nothing was recorded in the window");
  return out;
}

export interface AssetRow { assetId: number; name: string; states: string[] }

/** The assets of a response with their states in words: estimated, partial, no rate, no data, stale. */
export function assetRows(data: WidgetData): AssetRow[] {
  if (data.mode === "series") {
    const names = uniqueLabels(data.series);
    return data.series.map((s, i) => {
      const states: string[] = [];
      if (s.estimated) states.push("estimated");
      if (s.partial) states.push("partial");
      if (data.source === "cost" && hasNoRateBucket(s)) states.push("no rate");
      if (recordedNothing(s)) states.push("no data");
      return { assetId: s.asset_id, name: names[i], states };
    });
  }
  const names = uniqueLabels(data.values);
  return data.values.map((v, i) => {
    const states: string[] = [];
    if (v.estimated) states.push("estimated");
    if (v.partial) states.push("partial");
    // A cost with a dash is "no rate" whether or not it also recorded nothing: the card shows the same dash and hint.
    if (data.source === "cost" && v.value === null) states.push("no rate");
    if (hasNoReading(v.value, v.no_data, data.source)) states.push("no data");
    if (v.stale) states.push("stale");
    return { assetId: v.asset_id, name: names[i], states };
  });
}

/** Assets of the widget that no longer exist. */
export const removedCount = (data: Pick<WidgetData, "missing">): number => data.missing.length;
/** Assets of the widget that have no mapping of their own for the metric. */
export const noMetricIds = (data: Pick<WidgetData, "no_metric">): number[] => data.no_metric;

/** One figure of a summary: the number and the flags of the bucket (or buckets) it comes from; draw it with `figureText(value, figure)`. */
export interface DetailFigure { value: number; estimated: boolean; partial: boolean }

export interface SeriesSummaryRow {
  assetId: number;
  name: string;
  /** The least bucket minimum (metric series only: energy and cost buckets carry no minimum). */
  lowest: DetailFigure | null;
  /** Metric: the greatest bucket maximum. Energy and cost: the greatest bucket value. */
  highest: DetailFigure | null;
  /** The START of the bucket `highest` belongs to (a bucket width is never claimed). */
  highestFrom: string | null;
  /** The value of the last bucket that has one. */
  last: DetailFigure | null;
  /** The start of that bucket (it is not the window's last bucket when that one is empty). */
  lastFrom: string | null;
  /** Energy and cost only, and only when every bucket has a value: the sum of the bucket values. */
  total: DetailFigure | null;
}

export type SummaryKey = "lowest" | "highest" | "highestFrom" | "last" | "total";
export interface SummaryColumn { key: SummaryKey; heading: string }
export interface SeriesSummary { columns: SummaryColumn[]; rows: SeriesSummaryRow[] }

const figureOf = (value: number, flags: { estimated: boolean; partial: boolean }): DetailFigure => ({ value, estimated: flags.estimated, partial: flags.partial });
const hasValue = (p: WidgetPoint): p is WidgetPoint & { value: number } => !p.no_data && p.value !== null;

/** The point with the greatest (or least) `pick`ed number; on a tie the earlier bucket. */
function extreme(points: WidgetPoint[], pick: (p: WidgetPoint) => number | null, greatest: boolean): { point: WidgetPoint; value: number } | null {
  let best: { point: WidgetPoint; value: number } | null = null;
  for (const point of points) {
    const value = point.no_data ? null : pick(point);
    if (value === null) continue;
    if (best === null || (greatest ? value > best.value : value < best.value)) best = { point, value };
  }
  return best;
}

function summariseSeries(series: WidgetSeries, name: string, source: WidgetData["source"]): SeriesSummaryRow {
  const row: SeriesSummaryRow = { assetId: series.asset_id, name, lowest: null, highest: null, highestFrom: null, last: null, lastFrom: null, total: null };
  const latest = series.points.filter(hasValue).at(-1);
  if (latest) { row.last = figureOf(latest.value, latest); row.lastFrom = latest.ts; }
  if (source === "metric") {
    // `min` and `max` are the true extremes of the stored readings of the bucket
    const low = extreme(series.points, (p) => p.min, false);
    const high = extreme(series.points, (p) => p.max, true);
    if (low) row.lowest = figureOf(low.value, low.point);
    if (high) { row.highest = figureOf(high.value, high.point); row.highestFrom = high.point.ts; }
    return row;
  }
  // Energy and cost: only the bucket values exist. A cost bucket with no rate may have been the highest, so then nothing is claimed.
  if (!(source === "cost" && hasNoRateBucket(series))) {
    const high = extreme(series.points, (p) => p.value, true);
    if (high) { row.highest = figureOf(high.value, high.point); row.highestFrom = high.point.ts; }
  }
  // The total is exact only when no bucket is missing; it is estimated or partial when any bucket (or the series) is.
  if (series.points.length > 0 && series.points.every(hasValue)) {
    const sum = series.points.reduce((acc, p) => acc + (p.value as number), 0);
    row.total = figureOf(sum, {
      estimated: series.estimated || series.points.some((p) => p.estimated),
      partial: series.partial || series.points.some((p) => p.partial),
    });
  }
  return row;
}

/**
 * Lowest, highest (and from when), last and, for energy and cost, the exact total of the buckets shown. `null` unless the
 * response is a series. There is no average over buckets: they hold different numbers of samples, so it would not be exact.
 * The last column is named by what the figure is: "average" for a metric time series, else the aggregation in lower case.
 */
export function seriesSummary(data: WidgetData, config: AggregationConfig): SeriesSummary | null {
  if (data.mode !== "series") return null;
  const metric = data.source === "metric";
  const lastWords = metric && data.type === "timeseries" ? "average" : lowerFirst(aggregationWords(data.type, data, config));
  const columns: SummaryColumn[] = [
    ...(metric ? [{ key: "lowest" as const, heading: "Lowest" }] : []),
    { key: "highest", heading: "Highest" },
    { key: "highestFrom", heading: "Highest in the bucket from" },
    { key: "last", heading: `Last bucket (${lastWords})` },
    ...(metric ? [] : [{ key: "total" as const, heading: "Total of the buckets shown" }]),
  ];
  const names = uniqueLabels(data.series);
  return { columns, rows: data.series.map((s, i) => summariseSeries(s, names[i], data.source)) };
}

/**
 * The start of a bucket in words: to the second for a metric time series (its buckets start between minutes), to the
 * minute for an hour bucket, the date for a day bucket. It is a start, never a range.
 */
export function bucketStartText(iso: string, timezone: string, data: Pick<WidgetData, "bucket">): string {
  const text = formatSiteDateTime(iso, timezone);
  if (text.length !== 19) return text;
  return data.bucket === "day" ? text.slice(0, 10) : data.bucket === "hour" ? text.slice(0, 16) : text;
}

/**
 * The accessible name of a chart (the canvas is a picture): type, assets, metric and unit, window. A gauge is a `meter`
 * and a stat or table is text, so they get "". The preset words need no time zone.
 */
export function chartDescription(type: WidgetType, data: WidgetData): string {
  if (type !== "timeseries" && type !== "bar") return "";
  const kind = type === "timeseries" ? "Line chart" : "Bar chart";
  const rows = data.mode === "series" ? data.series : data.values;
  if (rows.length === 0) return `${kind} with no data. Open Details for the figures.`;
  const names = uniqueLabels(rows);
  const shown = names.slice(0, 3).join(", ");
  const rest = names.length > 3 ? ` and ${names.length - 3} more` : "";
  const name = data.source === "energy" ? "Energy" : data.source === "cost" ? "Cost" : (data.metric ?? "Metric");
  const measure = data.unit ? `${name} in ${data.unit}` : name;
  return `${kind} of ${names.length} asset${names.length === 1 ? "" : "s"}: ${shown}${rest}. ${measure}, ${rangeWords(data.range.preset)}. Open Details for the figures.`;
}
