import { METRICS } from "../api/types";
import { ICONS } from "../components/Icon";
import { point } from "../test/graphFixtures";
import { clusterIcon, metricIcon, pointMetric, protocolIcon } from "./graphIcons";

describe("protocolIcon", () => {
  it.each([
    ["opcua", "protoOpcua"],
    ["modbus", "protoModbus"],
    ["simulator", "protoSimulator"],
  ] as const)("%s draws %s", (type, icon) => {
    expect(protocolIcon(type)).toBe(icon);
  });

  it.each(["http", "", "OPCUA", "constructor", "__proto__", "toString"])("a type the page does not know (%j) is the generic sources icon", (type) => {
    expect(protocolIcon(type)).toBe("sources");
  });
});

describe("metricIcon", () => {
  it.each([
    ["active_power_kw", "rate"],
    ["reactive_power_kvar", "rate"],
    ["apparent_power_kva", "rate"],
    ["energy_kwh", "energy"],
    ["voltage_v", "metricVoltage"],
    ["current_a", "metricCurrent"],
    ["power_factor", "metricOther"],
    ["frequency_hz", "metricOther"],
    ["custom", "metricOther"],
  ] as const)("%s draws %s", (metric, icon) => {
    expect(metricIcon(metric)).toBe(icon);
  });

  it("covers every metric the server knows with an icon that exists", () => {
    for (const metric of METRICS) expect(Object.keys(ICONS), metric).toContain(metricIcon(metric));
  });

  it.each([null, undefined, "", "bogus", "constructor", "__proto__"])("%j is metricOther", (metric) => {
    expect(metricIcon(metric)).toBe("metricOther");
  });
});

describe("pointMetric", () => {
  it("prefers the metric the point is mapped to", () => {
    expect(pointMetric(point(1, "P", { mapped_metric: "voltage_v" }))).toBe("voltage_v");
  });

  it("falls back to the suggestion's metric for a point that is not mapped", () => {
    const p = point(1, "P", { suggestion: { metric: "current_a", scale: 1, interval_seconds: 5, custom_unit: null } });
    expect(p.mapped_metric).toBeNull();
    expect(pointMetric(p)).toBe("current_a");
  });

  it("gives the mapped metric even when the suggestion says something else", () => {
    const p = point(1, "P", { mapped_metric: "energy_kwh", suggestion: { metric: "current_a", scale: 1, interval_seconds: 5, custom_unit: null } });
    expect(pointMetric(p)).toBe("energy_kwh");
  });
});

describe("clusterIcon", () => {
  it("is the layers icon", () => {
    expect(clusterIcon).toBe("layers");
  });
});
