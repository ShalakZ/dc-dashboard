import type { GraphPoint } from "../api/types";
import type { IconName } from "../components/Icon";

// Maps, not object indexes: a connector type or a metric that is "constructor" or "__proto__" must not find an inherited property.
const PROTOCOL_ICONS: ReadonlyMap<string, IconName> = new Map<string, IconName>([
  ["opcua", "protoOpcua"],
  ["modbus", "protoModbus"],
  ["simulator", "protoSimulator"],
]);

/** The icon of a source's connector. The connectors are opcua, modbus and simulator (there is no HTTP one); any other type draws the generic `sources` icon. */
export function protocolIcon(connectorType: string): IconName {
  return PROTOCOL_ICONS.get(connectorType) ?? "sources";
}

const METRIC_ICONS: ReadonlyMap<string, IconName> = new Map<string, IconName>([
  ["active_power_kw", "rate"],
  ["reactive_power_kvar", "rate"],
  ["apparent_power_kva", "rate"],
  ["energy_kwh", "energy"],
  ["voltage_v", "metricVoltage"],
  ["current_a", "metricCurrent"],
]);

/** The icon of a reading: the bolt for any power, the ringed bolt for energy, a V or an A in a ring for volts and amps, four small rings for the rest (power factor, frequency, custom, no metric, a metric this build does not know). */
export function metricIcon(metric: string | null | undefined): IconName {
  return (typeof metric === "string" ? METRIC_ICONS.get(metric) : undefined) ?? "metricOther";
}

/** What a point measures: the metric it is mapped to, else the one the scan suggested for it. */
export function pointMetric(point: GraphPoint): string {
  return point.mapped_metric ?? point.suggestion.metric;
}

/** The icon of a group of points. */
export const clusterIcon: IconName = "layers";
