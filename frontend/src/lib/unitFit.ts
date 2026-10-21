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

/**
 * w31. The units the SERVER takes for a metric and the factor that turns a value in that unit into the metric's base unit (a mapping's `scale`): exactly
 * `UNITS` of backend/dcdash/ingest/normalise.py, pinned for both languages by backend/tests/fixtures/unit_samples.json (unitFit.samples.test.ts). The keys are
 * lower case with blanks removed. It is not the table above: that one also knows scaled spellings (kV, kA, var, kHz) so that it can say "this is a unit of
 * ANOTHER metric", and the server refuses them for the metric they scale. `custom` has no entry: it takes any unit, with scale 1.
 */
export const UNIT_SCALES: Record<Exclude<Metric, "custom">, Readonly<Record<string, number>>> = {
  active_power_kw: { w: 0.001, kw: 1, mw: 1000 },
  energy_kwh: { wh: 0.001, kwh: 1, mwh: 1000 },
  voltage_v: { v: 1 },
  current_a: { a: 1 },
  power_factor: { pf: 1, cosphi: 1, "cosφ": 1 },
  frequency_hz: { hz: 1 },
  reactive_power_kvar: { kvar: 1 },
  apparent_power_kva: { kva: 1 },
};

/** The spellings of `UNIT_SCALES` as a person writes them, for a help text ("W, kW, MW"). */
export const UNIT_LABELS: Record<Exclude<Metric, "custom">, string> = {
  active_power_kw: "W, kW, MW",
  energy_kwh: "Wh, kWh, MWh",
  voltage_v: "V",
  current_a: "A",
  power_factor: "PF, cosphi, cosφ",
  frequency_hz: "Hz",
  reactive_power_kvar: "kvar",
  apparent_power_kva: "kVA",
};

/**
 * The factor the server would use for `unit` read as a unit of `metric`, or null when it refuses the pair (no unit, a unit of another metric, a scaled
 * spelling such as kV). Case and blanks do not matter; only the ASCII space and tab count as blanks, because JavaScript and Python disagree about the rest.
 * `custom` accepts anything, a missing unit included.
 */
export function scaleForUnit(metric: Metric, unit: string | null | undefined): number | null {
  if (metric === "custom") return 1;
  const table = UNIT_SCALES[metric] as Readonly<Record<string, number>> | undefined; // undefined for a metric this build does not know
  if (table === undefined || unit === null || unit === undefined) return null;
  const spelling = unit.toLowerCase().replace(/[ \t]/g, "");
  return Object.hasOwn(table, spelling) ? table[spelling] : null; // hasOwn: "constructor" is not a unit
}
