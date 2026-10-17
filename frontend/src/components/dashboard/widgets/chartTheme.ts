import { useSyncExternalStore } from "react";
import { escapeHtml } from "../../../lib/widgetFormat";

/**
 * What a chart needs from the theme, read from the `--chart-*` tokens (and `--accent`) of the page. A canvas cannot use
 * `var(--x)`, so the option is built from these resolved colours and rebuilt when the look changes (`useChartTheme`).
 */
export interface ChartTheme {
  /** The eight series colours, in the order chosen by simulating colour blindness (series 6 to 8 are also drawn dashed). */
  palette: readonly string[];
  /** The colour of a chart with one series: it follows the look's accent. */
  accent: string;
  axisText: string;
  axisLine: string;
  grid: string;
  tipBg: string;
  tipText: string;
  tipBorder: string;
  /** How much of its line's colour the min-max band takes. */
  bandOpacity: number;
}

/**
 * The light values of those tokens: what a server render, a test with no stylesheet and a token the page does not give fall back
 * to. `chartTheme.test.ts` reads app.css and fails if one of them differs from its token.
 */
export const LIGHT_CHART: ChartTheme = {
  palette: ["#2563eb", "#c2570c", "#0f8a5f", "#c2307a", "#0e7f9a", "#7c5cd6", "#a16207", "#64748b"],
  accent: "#1d5bd8",
  axisText: "#596579",
  axisLine: "#cdd3dd",
  grid: "#e1e5ec",
  tipBg: "#ffffff",
  tipText: "#172033",
  tipBorder: "#cdd3dd",
  bandOpacity: 0.14,
};

/** The theme the page gives `el` (a custom property arrives with its `var()` references already resolved). An empty value keeps the light one. */
export function readChartTheme(el: Element = document.documentElement): ChartTheme {
  const css = getComputedStyle(el);
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const opacity = Number.parseFloat(read("--chart-band-opacity", ""));
  return {
    palette: LIGHT_CHART.palette.map((light, i) => read(`--chart-${i + 1}`, light)),
    accent: read("--accent", LIGHT_CHART.accent),
    axisText: read("--chart-axis-text", LIGHT_CHART.axisText),
    axisLine: read("--chart-axis-line", LIGHT_CHART.axisLine),
    grid: read("--chart-grid", LIGHT_CHART.grid),
    tipBg: read("--chart-tip-bg", LIGHT_CHART.tipBg),
    tipText: read("--chart-tip-text", LIGHT_CHART.tipText),
    tipBorder: read("--chart-tip-border", LIGHT_CHART.tipBorder),
    bandOpacity: Number.isFinite(opacity) ? opacity : LIGHT_CHART.bandOpacity,
  };
}

const sameTheme = (a: ChartTheme, b: ChartTheme): boolean =>
  a.accent === b.accent && a.axisText === b.axisText && a.axisLine === b.axisLine && a.grid === b.grid && a.tipBg === b.tipBg
  && a.tipText === b.tipText && a.tipBorder === b.tipBorder && a.bandOpacity === b.bandOpacity
  && a.palette.length === b.palette.length && a.palette.every((color, i) => color === b.palette[i]);

// One observer on <html> serves every chart. The theme is read once per change, here, and cached: a render only reads the cache.
// Nothing runs at import (TrendChart imports this module's neighbour), and the cache is dropped when no chart is shown, because
// the page may change look meanwhile.
let cached: ChartTheme | null = null;
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

/** Reads the page into the cache; true when the theme is not the one the charts already hold (so the same object is kept while nothing differs). */
function refresh(): boolean {
  const next = readChartTheme();
  if (cached && sameTheme(cached, next)) return false;
  cached = next;
  return true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (observer === null && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => {
      if (refresh()) for (const notify of [...listeners]) notify();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-theme"] });
  }
  refresh(); // the look may have changed since the last chart left; React checks the snapshot again right after subscribing
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
      cached = null;
    }
  };
}

const getSnapshot = (): ChartTheme => (cached ??= readChartTheme());
const getServerSnapshot = (): ChartTheme => LIGHT_CHART;

/** The page's chart theme; a chart that calls it is rendered again when `data-mode` or `data-theme` on <html> changes the tokens. */
export function useChartTheme(): ChartTheme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** One series' colour and line type. A chart of one series uses the accent; 1 to 5 are solid, 6 to 8 dashed, 9 and later reuse 1 to 5 dotted. */
export function seriesLook(theme: ChartTheme, index: number, count: number): { color: string; type: "solid" | "dashed" | "dotted" } {
  if (count <= 1) return { color: theme.accent, type: "solid" };
  if (index < 5) return { color: theme.palette[index], type: "solid" };
  if (index < 8) return { color: theme.palette[index], type: "dashed" };
  return { color: theme.palette[(index - 8) % 5], type: "dotted" };
}

/** The parts of an option both charts share: no animation, and a tooltip in the theme's colours that stays inside the chart. */
export function chartBase(theme: ChartTheme) {
  return {
    animation: false,
    tooltip: {
      trigger: "axis" as const,
      confine: true,
      backgroundColor: theme.tipBg,
      borderColor: theme.tipBorder,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: theme.tipText, fontSize: 13 },
      // The tooltip is HTML inside the page, so the app's own corner and shadow tokens apply.
      extraCssText: "border-radius:var(--radius);box-shadow:var(--shadow-pop);",
      axisPointer: { lineStyle: { color: theme.axisText, width: 1 } },
    },
  };
}

/** What every axis of both charts takes: 12px labels and unit name in the axis ink, the axis line and ticks, solid 1px grid lines. Spread it into an axis. */
export function axisParts(theme: ChartTheme) {
  return {
    axisLabel: { color: theme.axisText, fontSize: 12 },
    axisLine: { lineStyle: { color: theme.axisLine } },
    axisTick: { lineStyle: { color: theme.axisLine } },
    nameTextStyle: { color: theme.axisText, fontSize: 12 },
    splitLine: { lineStyle: { color: theme.grid, width: 1, type: "solid" as const } },
  };
}

/** The legend, at the bottom, scrolling when it is long: a 12x3 line for a line chart, a 10x10 square for bars. The caller adds `show`, `data` and `formatter`. */
export function legendParts(theme: ChartTheme, kind: "line" | "bar") {
  return {
    bottom: 0,
    type: "scroll" as const,
    textStyle: { color: theme.axisText, fontSize: 12 },
    inactiveColor: theme.axisLine, // an entry switched off: faded (ECharts' own grey would shine on a dark card)
    pageTextStyle: { color: theme.axisText },
    pageIconColor: theme.axisText,
    pageIconInactiveColor: theme.axisLine,
    icon: kind === "line" ? "rect" : "roundRect",
    itemWidth: kind === "line" ? 12 : 10,
    itemHeight: kind === "line" ? 3 : 10,
    tooltip: { show: true },
  };
}

/** The first line of a tooltip: the time (or the bar's name), in the axis ink. */
export const tipHead = (text: string, theme: ChartTheme): string =>
  `<div style="color:${theme.axisText};margin-bottom:4px">${escapeHtml(text)}</div>`;

/**
 * One row of a tooltip: the marker and the name on the left, the value (with its unit) on the right, then the state in words
 * (estimated, partial, no rate) in the axis ink. `marker` is the HTML ECharts hands over; everything else is escaped here, names being user-typed.
 */
export function tipRow(marker: string, name: string, value: string, state: string, theme: ChartTheme): string {
  const label = name === ""
    ? marker
    : `${marker} <span title="${escapeHtml(name)}" style="display:inline-block;max-width:180px;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom">${escapeHtml(name)}</span>`;
  const words = state === "" ? "" : ` <span style="color:${theme.axisText}">${escapeHtml(state)}</span>`;
  return `<div style="display:flex;justify-content:space-between;gap:16px;line-height:1.5"><span>${label}</span><span style="text-align:right;font-variant-numeric:tabular-nums">${escapeHtml(value)}${words}</span></div>`;
}
