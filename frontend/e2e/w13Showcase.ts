// The w13 widget showcase: one dashboard with every widget type and every state the card has to draw (a fresh and a stale reading, no data, a cost with no
// rate, an estimated and a partial figure, a removed asset, a metric bar over time), and the mocked answer of POST /api/widget-data for each, keyed by the
// widget's config so the same config always gets the same answer. The e2e seed has none of these states on demand, so w13.spec.ts saves the dashboard
// through the API on REAL asset ids and answers the widget queries from here (page.route). It is the typed port of .waves/w13/showcase.mjs (the gallery's
// copy); the one deliberate difference is that every answer is built from the clock at the moment of the request (`now` is an argument), so a reading that
// is "4 seconds old" is still 4 seconds old when the page asks, and a stale one is still 47 minutes old.

export const H = 3_600_000;
export const M = 60_000;

export type WidgetType = "stat" | "gauge" | "table" | "timeseries" | "bar";
export type Source = "metric" | "energy" | "cost";
export type Aggregation = "avg" | "min" | "max" | "last" | "sum";

/** The widget config the API stores (backend core/widgets.py `WidgetConfig`, `extra="forbid"`: exactly these keys). */
export interface ShowcaseConfig {
  assets: number[];
  source: Source;
  metric: string | null;
  aggregation: Aggregation;
  range: string | null;
  bars: "asset" | "time";
  min: number;
  max: number | null;
}

/** The body the page POSTs to /api/widget-data. */
export interface WidgetRequest { type: WidgetType; config: ShowcaseConfig; range: string }

interface Flags { estimated: boolean; partial: boolean; no_data: boolean }
export interface Point extends Flags { ts: string; value: number | null; min: number | null; max: number | null }
export interface Series { asset_id: number; name: string; points: Point[]; estimated: boolean; partial: boolean }
export interface Row extends Flags { asset_id: number; name: string; value: number | null; point_id: number | null; ts: string | null; stale: boolean }

/** What the API answers (frontend/src/api/types.ts `WidgetData`). */
export interface WidgetAnswer {
  type: WidgetType;
  mode: "series" | "values";
  source: Source;
  metric: string | null;
  unit: string | null;
  range: { preset: string; start: string; end: string };
  tier: "raw" | "1m" | "1h" | null;
  bucket: "hour" | "day" | null;
  series: Series[];
  values: Row[];
  missing: number[];
  no_metric: number[];
}

/** The part of an answer a definition states; `answer` fills the rest (the range from the request, empty lists). */
export type AnswerBody = Partial<Omit<WidgetAnswer, "type" | "range">> & Pick<WidgetAnswer, "mode">;

export interface ShowcaseWidget {
  title: string;
  type: WidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
  config: ShowcaseConfig;
  /** The answer at the moment `now` (epoch ms). */
  data: (now: number) => AnswerBody;
}

/** The six asset names every showcase table and bar uses (the first three are also the lines of the charts). */
export const SIX = ["Rack A01", "Rack A02", "UPS-1 output", "CRAH-3 supply fan", "Chiller plant 2 condenser loop", "PDU B07"] as const;

const iso = (ms: number): string => new Date(ms).toISOString();

/** The key a widget request is matched by: the type and the parts of the config that decide the answer. */
export const key = (config: ShowcaseConfig, type: string): string =>
  [type, config.source, config.metric, config.aggregation, config.bars, config.assets.join(",")].join("|");

const cfg = (assets: number[], source: Source, metric: string | null, aggregation: Aggregation, extra: Partial<ShowcaseConfig> = {}): ShowcaseConfig => ({
  assets, source, metric, aggregation, range: null, bars: "asset", min: 0, max: null, ...extra,
});
const flags = (o: Partial<Flags> = {}): Flags => ({ estimated: false, partial: false, no_data: false, ...o });
/** A bucket of a METRIC series: its value and the true extremes of the readings inside it (the band). Energy and cost buckets carry no min or max. */
const pt = (ts: number, value: number | null, o: Partial<Flags> = {}, extremes = true): Point => ({
  ts: iso(ts), value,
  min: value === null || !extremes ? null : +(value * 0.93).toFixed(3),
  max: value === null || !extremes ? null : +(value * 1.07).toFixed(3),
  ...flags(o),
});
const row = (asset_id: number, name: string, value: number | null, o: Partial<Flags & { ts: string; stale: boolean }> = {}): Row => ({
  asset_id, name, value, point_id: null, ts: o.ts ?? null, stale: o.stale ?? false, ...flags(o),
});
const seriesOf = (asset_id: number, name: string, points: Point[], o: Partial<Pick<Series, "estimated" | "partial">> = {}): Series => ({
  asset_id, name, points, estimated: false, partial: false, ...o,
});

/**
 * The fifteen widgets, on the asset ids `A` (at least six). The layout has no gap, so the read-only grid and the editor's grid agree; the
 * smallest sizes of lib/layout.ts are in it: a 2 x 2 stat and gauge (170 px high) and 3 x 3 gauges.
 */
export function defs(A: readonly number[]): ShowcaseWidget[] {
  if (A.length < 6) throw new Error(`the showcase needs six asset ids, got ${A.length}`);
  const a = [...A];
  const hourly = (now: number, n: number, f: (i: number) => number | null, o: Partial<Flags> | ((i: number) => Partial<Flags>) = {}, extremes = false): Point[] =>
    Array.from({ length: n }, (_, i) => pt(now - (n - i) * H, f(i), typeof o === "function" ? o(i) : o, extremes));
  const five = (now: number, n: number, f: (i: number) => number, skip: number[] = []): Point[] =>
    Array.from({ length: n }, (_, i) => i).filter((i) => !skip.includes(i)).map((i) => pt(now - (n - i) * 5 * M, f(i)));
  return [
    { title: "Active power", type: "stat", x: 0, y: 0, w: 3, h: 2, config: cfg([a[0]], "metric", "active_power_kw", "last"),
      data: (now) => ({ unit: "kW", mode: "values", values: [row(a[0], "Rack A01", 12.34, { ts: iso(now - 4000) })] }) },
    { title: "Cost today", type: "stat", x: 3, y: 0, w: 3, h: 2, config: cfg([a[1]], "cost", null, "sum"),
      data: () => ({ unit: "QAR", mode: "values", values: [row(a[1], "Hall A", null)] }) },
    { title: "Energy 24 h", type: "stat", x: 6, y: 0, w: 3, h: 2, config: cfg([a[2]], "energy", null, "sum"),
      data: () => ({ unit: "kWh", mode: "values", values: [row(a[2], "UPS-1 output", 123.456, { estimated: true })] }) },
    { title: "Supply voltage", type: "stat", x: 9, y: 0, w: 3, h: 2, config: cfg([a[3]], "metric", "voltage_v", "last"),
      data: (now) => ({ unit: "V", mode: "values", values: [row(a[3], "CRAH-3 supply fan", 229.8, { ts: iso(now - 47 * M), stale: true })] }) },
    { title: "Load", type: "gauge", x: 0, y: 2, w: 3, h: 3, config: cfg([a[0]], "metric", "active_power_kw", "last", { min: 0, max: 100 }),
      data: (now) => ({ unit: "kW", mode: "values", values: [row(a[0], "Rack A01", 62.5, { ts: iso(now - 9000) })] }) },
    { title: "Load (2 rows)", type: "gauge", x: 3, y: 2, w: 2, h: 2, config: cfg([a[1]], "metric", "current_a", "last", { min: 0, max: 40 }),
      data: (now) => ({ unit: "A", mode: "values", values: [row(a[1], "Rack A02", 27.8, { ts: iso(now - 9000) })] }) },
    { title: "Stale gauge", type: "gauge", x: 6, y: 2, w: 3, h: 3, config: cfg([a[2]], "metric", "frequency_hz", "last", { min: 49, max: 51 }),
      data: (now) => ({ unit: "Hz", mode: "values", values: [row(a[2], "UPS-1 output", 50.02, { ts: iso(now - 3 * H), stale: true })] }) },
    { title: "No data gauge", type: "gauge", x: 9, y: 2, w: 3, h: 3, config: cfg([a[3]], "metric", "power_factor", "last", { min: 0, max: 1 }),
      data: () => ({ unit: null, mode: "values", values: [row(a[3], "CRAH-3 supply fan", null, { no_data: true })] }) },
    { title: "Power by rack", type: "timeseries", x: 0, y: 5, w: 6, h: 5, config: cfg([a[0], a[1], a[2]], "metric", "active_power_kw", "avg"),
      data: (now) => ({ unit: "kW", mode: "series", metric: "active_power_kw", tier: "1m", bucket: null, series: [
        seriesOf(a[0], "Rack A01", five(now, 72, (i) => 12 + 3 * Math.sin(i / 6))),
        seriesOf(a[1], "Rack A02", five(now, 72, (i) => 18 + 2 * Math.cos(i / 5), [30, 31, 32, 33, 34, 35, 36])),
        seriesOf(a[2], "UPS-1 output", five(now, 72, (i) => 40 + 5 * Math.sin(i / 9))),
      ] }) },
    { title: "Energy per hour", type: "timeseries", x: 6, y: 5, w: 6, h: 5, config: cfg([a[0], a[1], a[2]], "energy", null, "sum"),
      data: (now) => ({ unit: "kWh", mode: "series", tier: null, bucket: "hour", missing: [999], series: [
        seriesOf(a[0], "Rack A01", hourly(now, 24, (i) => 10 + (i % 7))),
        seriesOf(a[1], "Rack A02", hourly(now, 24, (i) => 14 + (i % 5)), { estimated: true }),
        seriesOf(a[2], "UPS-1 output", hourly(now, 24, (i) => 35 + (i % 9))), // the server never sends partial for energy (only a cost can be partial): Cost per hour has the partial case
      ] }) },
    { title: "Energy per asset", type: "bar", x: 0, y: 10, w: 6, h: 4, config: cfg(a.slice(0, 6), "energy", null, "sum"),
      data: () => ({ unit: "kWh", mode: "values", values: SIX.map((n, i) => row(a[i], n, i === 4 ? null : 20 + i * 11.5, i === 4 ? { no_data: true } : i === 1 ? { estimated: true } : {})) }) },
    { title: "Cost per hour", type: "bar", x: 6, y: 10, w: 6, h: 5, config: cfg([a[0], a[1], a[2]], "cost", null, "sum", { bars: "time" }),
      data: (now) => ({ unit: "QAR", mode: "series", tier: null, bucket: "hour", series: [
        seriesOf(a[0], "Rack A01", hourly(now, 8, (i) => 3 + i * 0.4)),
        seriesOf(a[1], "Rack A02", hourly(now, 8, (i) => (i === 2 || i === 5 ? null : 4 + i * 0.3)), { partial: true }),
        seriesOf(a[2], "UPS-1 output", hourly(now, 8, (i) => 9 + (i % 3))),
      ] }) },
    { title: "Power now", type: "table", x: 0, y: 14, w: 6, h: 4, config: cfg(a.slice(0, 6), "metric", "active_power_kw", "last"),
      data: (now) => ({ unit: "kW", mode: "values", values: SIX.map((n, i) => row(a[i], n, i === 4 ? null : 8 + i * 6.25, i === 4 ? { no_data: true } : i === 2 ? { ts: iso(now - 2 * H), stale: true } : { ts: iso(now - 5000) })) }) },
    { title: "Cost this month", type: "table", x: 6, y: 15, w: 6, h: 4, config: cfg(a.slice(0, 6), "cost", null, "sum"),
      data: () => ({ unit: "QAR", mode: "values", missing: [999], no_metric: [], values: SIX.map((n, i) => row(a[i], n, i === 3 ? null : 100 + i * 37.25, i === 1 ? { estimated: true } : i === 2 ? { partial: true } : {})) }) },
    { title: "Peak per hour", type: "bar", x: 0, y: 18, w: 6, h: 4, config: cfg([a[0], a[1]], "metric", "active_power_kw", "max", { bars: "time" }),
      data: (now) => ({ unit: "kW", mode: "series", metric: "active_power_kw", tier: "1h", bucket: "hour", series: [
        seriesOf(a[0], "Rack A01", hourly(now, 8, (i) => 14 + (i % 4) * 1.5, {}, true)),
        seriesOf(a[1], "Rack A02", hourly(now, 8, (i) => 20 + (i % 3) * 2.25, {}, true)),
      ] }) },
  ];
}

/** The window of each rolling preset; a calendar preset ("today") is answered with 24 hours, which is enough for a mock. */
const SPAN: Record<string, number> = { "1h": H, "6h": 6 * H, "24h": 24 * H, "7d": 168 * H, "30d": 720 * H };

/** The mocked answer of POST /api/widget-data for a request, or null when no showcase widget has that type and config. */
export function answer(definitions: readonly ShowcaseWidget[], body: WidgetRequest, now: number = Date.now()): WidgetAnswer | null {
  const found = definitions.find((d) => key(d.config, d.type) === key(body.config, body.type));
  if (!found) return null;
  const span = SPAN[body.range] ?? 24 * H;
  return {
    type: body.type,
    source: body.config.source,
    metric: body.config.metric,
    unit: null,
    tier: null,
    bucket: null,
    series: [],
    values: [],
    missing: [],
    no_metric: [],
    ...found.data(now),
    range: { preset: body.range, start: iso(now - span), end: iso(now) },
  };
}
