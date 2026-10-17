import type { MappingLatest } from "../hooks/useMappingLatest";
import { formatAge } from "./age";
import { formatValue, unitSuffix } from "./widgetFormat";

export type ValueTipTone = "ok" | "stale" | "bad" | "none";

/**
 * The words of the last-value card: "12.40 kW, 3 s ago". `ageSeconds` is the age grown in the browser since the answer (`ageNow`), so the card keeps
 * counting; whether the reading is stale is the server's word, from the same clock as its age. A stale reading says "stale", a quality other than 0
 * says "bad reading", a point with no row yet says "No reading yet" and a failed read says so. The tone only colours the card; the words carry the meaning.
 *
 * "No reading yet" is for NO ROW only (`ts` is null). The collector writes a failed read as a row with a time, `value = NULL` and `quality = 1`, so a row with a
 * time and no value is not "never polled": it says "No value, 4 s ago, bad reading" (the same age, stale and bad words as a reading with a value).
 */
export function describeLatest(
  latest: MappingLatest | undefined,
  state: "loading" | "error" | "ok",
  ageSeconds: number | null,
): { text: string; tone: ValueTipTone } {
  if (state === "error") return { text: "Could not read the value", tone: "bad" };
  if (state === "loading") return { text: "Reading…", tone: "none" };
  if (!latest || latest.ts === null) return { text: "No reading yet", tone: "none" };
  const bad = latest.quality !== null && latest.quality !== 0;
  const parts = [latest.value === null ? "No value" : `${formatValue(latest.value)}${unitSuffix(latest.unit)}`];
  if (ageSeconds !== null) parts.push(formatAge(ageSeconds));
  if (latest.stale) parts.push("stale");
  if (bad) parts.push("bad reading");
  return { text: parts.join(", "), tone: bad ? "bad" : latest.stale ? "stale" : latest.value === null ? "none" : "ok" };
}
