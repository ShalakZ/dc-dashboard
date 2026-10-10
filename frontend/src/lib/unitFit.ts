import type { Metric } from "../api/types";

// Lower-case spellings (no blanks) of the units each metric is read in. `custom` has none: anything fits it.
const UNITS: Record<Exclude<Metric, "custom">, readonly string[]> = {
  active_power_kw: ["kw", "w", "mw"],
  energy_kwh: ["kwh", "wh", "mwh"],
  voltage_v: ["v", "kv"],
  current_a: ["a", "ka", "ma"],
  power_factor: ["pf", "cosphi", "cosφ"],
  frequency_hz: ["hz", "khz"],
  reactive_power_kvar: ["kvar", "var", "mvar"],
  apparent_power_kva: ["kva", "va", "mva"],
};

const METRIC_OF_UNIT = new Map<string, Metric>(
  (Object.entries(UNITS) as [Metric, readonly string[]][]).flatMap(([metric, units]) => units.map((u) => [u, metric] as const)),
);

/** A warning when `unitHint` is a known unit of a different metric than `metric`; null otherwise (blank, unknown, `custom`, or a fitting unit). */
export function unitMismatch(metric: Metric, unitHint: string | null | undefined): string | null {
  if (metric === "custom" || !unitHint) return null;
  const other = METRIC_OF_UNIT.get(unitHint.toLowerCase().replace(/\s+/g, ""));
  if (other === undefined || other === metric) return null;
  return `The point's unit hint is "${unitHint.trim()}", which is a ${other} unit, not ${metric}. Check the metric before saving.`;
}
