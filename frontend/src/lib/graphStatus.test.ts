import type { GraphSource } from "../api/types";
import { isLive, protocolLabel, sourceStatus } from "./graphStatus";
import { source } from "../test/graphFixtures";

const make = (over: Partial<GraphSource>): GraphSource => ({ ...source(1), ...over }) as GraphSource;

describe("sourceStatus", () => {
  // [name, enabled, status, needs_credentials, key, label]
  it.each([
    ["online and enabled", true, "online", false, "online", "online"],
    ["offline and enabled", true, "offline", false, "offline", "offline"],
    ["never polled (unknown status) and enabled", true, "unknown", false, "idle", "not polled"],
    ["a status the page does not know, enabled", true, "degraded", false, "idle", "not polled"],
    ["online but not enabled (the collector does not poll it)", false, "online", false, "idle", "disabled"],
    ["offline and not enabled", false, "offline", false, "idle", "disabled"],
    ["unknown and not enabled", false, "unknown", false, "idle", "disabled"],
    ["credentials beat online", true, "online", true, "credentials", "needs credentials"],
    ["credentials beat offline", true, "offline", true, "credentials", "needs credentials"],
    ["credentials beat disabled", false, "unknown", true, "credentials", "needs credentials"],
  ] as const)("%s", (_name, enabled, status, needs_credentials, key, label) => {
    expect(sourceStatus(make({ enabled, status, needs_credentials }))).toEqual({ key, label });
  });
});

describe("protocolLabel", () => {
  it.each([
    ["opcua", "OPC UA"],
    ["modbus", "Modbus"],
    ["simulator", "Simulator"],
    ["http", "http"], // no HTTP connector yet: an unknown type shows its raw name
    ["", ""],
  ])("%j reads %j", (type, label) => {
    expect(protocolLabel(type)).toBe(label);
  });

  it("names OPC UA and Modbus the way the Scans page does", async () => {
    const { portName } = await import("./ports");
    expect(protocolLabel("opcua")).toBe(portName(4840));
    expect(protocolLabel("modbus")).toBe(portName(502));
  });
});

describe("isLive", () => {
  it.each([
    [true, "online", false, true],
    [true, "offline", false, false],
    [true, "unknown", false, false],
    [false, "online", false, false],
    [false, "offline", false, false],
    // the data says it is polled and online: the edges flow even beside an amber dot (the dot is about what needs attention)
    [true, "online", true, true],
  ] as const)("enabled %s, status %s, needs credentials %s -> %s", (enabled, status, needs_credentials, expected) => {
    expect(isLive(make({ enabled, status, needs_credentials }))).toBe(expected);
  });
});
