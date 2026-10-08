import type { WidgetData } from "../api/types";
import { formatSiteTick } from "./siteTime";

export interface Flags { estimated: boolean; partial: boolean }

/** Two decimals, the precision the asset page shows. */
export const formatValue = (value: number | null | undefined): string => (value == null ? "—" : value.toFixed(2));

/** "12.30", with "~" in front when estimated and "*" behind when partial; a dash (no markers) when there is no figure. */
export function figureText(value: number | null | undefined, flags: Flags): string {
  if (value == null) return "—";
  return `${flags.estimated ? "~" : ""}${value.toFixed(2)}${flags.partial ? "*" : ""}`;
}

/** The markers of `Flags`, and whether a dash stands in for a cost that has no rate (see `flagsOf`). */
export interface HintFlags extends Flags { noRate?: boolean }

/** Explains the markers that appear in a figure, and the dash of a missing rate; empty when there are none. */
export function markerHint(flags: HintFlags): string {
  const parts: string[] = [];
  if (flags.estimated) parts.push("~ estimated");
  if (flags.partial) parts.push("* partial, some hours have no rate");
  if (flags.noRate) parts.push("— no rate");
  return parts.join(", ");
}

/**
 * Which markers a response uses anywhere: the series-level flags of a series response, the per-asset flags of a values
 * one. `noRate` is a cost bucket or asset that is null although something was recorded (`value === null && !no_data`):
 * it is drawn as a dash, or, in a line, not drawn at all, so a chart whose every bucket lacks a rate would otherwise
 * look like one with no data.
 */
export function flagsOf(data: Pick<WidgetData, "series" | "values" | "source">): Required<HintFlags> {
  const rows = [...data.series, ...data.values];
  const cells = [...data.series.flatMap((s) => s.points), ...data.values];
  return {
    estimated: rows.some((r) => r.estimated),
    partial: rows.some((r) => r.partial),
    noRate: data.source === "cost" && cells.some((c) => c.value === null && !c.no_data),
  };
}

const plural = (count: number): string => (count === 1 ? "" : "s");
export const removedText = (count: number): string => `${count} asset${plural(count)} removed`;
export const noMetricText = (count: number): string => `${count} asset${plural(count)} without this metric`;
export const unitSuffix = (unit: string | null): string => (unit ? ` ${unit}` : "");

/** How long ago `ts` was, as "just now", "12 min ago", "3 h ago" or "2 d ago"; empty when `ts` is not a time. `now` is epoch milliseconds. */
export function ageText(ts: string, now: number): string {
  const then = Date.parse(ts);
  if (Number.isNaN(then)) return "";
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now"; // also a reading a little ahead of this clock
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

const DAY_MS = 86_400_000;
const longerThanADay = (range: { start: string; end: string }): boolean => Date.parse(range.end) - Date.parse(range.start) > DAY_MS;

/**
 * The label style for a chart's time axis. Energy and cost responses name their bucket; metric ones do not, so a window
 * longer than a day gets dates on its labels (a bare "03:00" repeated seven times would not say which day).
 */
export function labelBucket(data: Pick<WidgetData, "bucket" | "range">): "hour" | "day" | null {
  return data.bucket ?? (longerThanADay(data.range) ? "hour" : null);
}

/** "since 10:00" for the first hour an energy or cost window really covers (with the date when it spans more than a day). */
export function sinceText(start: string, end: string, timezone: string): string {
  return `since ${formatSiteTick(start, timezone, longerThanADay({ start, end }) ? "hour" : null)}`;
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

interface Labelled { asset_id: number; name: string }

/** Names as shown; a name used by several assets gets "(#id)" so legends and axes stay unambiguous. */
export function uniqueLabels(rows: readonly Labelled[]): string[] {
  const count = new Map<string, number>();
  for (const row of rows) count.set(row.name, (count.get(row.name) ?? 0) + 1);
  return rows.map((row) => ((count.get(row.name) ?? 0) > 1 ? `${row.name} (#${row.asset_id})` : row.name));
}

/** `uniqueLabels` plus a trailing " ~" (estimated) and " *" (partial), for chart legends and axes. */
export function chartLabels(rows: readonly (Labelled & Flags)[]): string[] {
  return uniqueLabels(rows).map((label, i) => `${label}${rows[i].estimated ? " ~" : ""}${rows[i].partial ? " *" : ""}`);
}
