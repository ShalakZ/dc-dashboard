import type { GraphSource } from "../api/types";
import { isLive, protocolLabel, sourceAddress, sourceStatus, sourceTitle } from "./graphStatus";
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

describe("sourceAddress (w12c)", () => {
  const cfg = (config: Record<string, unknown>) => ({ config });

  it("is host:port from the host and the port", () => {
    expect(sourceAddress(cfg({ host: "10.0.0.5", port: 502 }))).toBe("10.0.0.5:502");
  });

  it("is the host alone when there is no numeric port", () => {
    expect(sourceAddress(cfg({ host: "plc.lab" }))).toBe("plc.lab");
    expect(sourceAddress(cfg({ host: "plc.lab", port: "502" }))).toBe("plc.lab");
  });

  it("takes the host and port of an opc.tcp endpoint, without the scheme and the path", () => {
    expect(sourceAddress(cfg({ endpoint: "opc.tcp://172.20.0.2:4840/server" }))).toBe("172.20.0.2:4840");
  });

  it("takes the host and port of a url (the simulator)", () => {
    expect(sourceAddress(cfg({ url: "sim://lab:9000/x?y=1" }))).toBe("lab:9000");
  });

  it("host and port win over an endpoint", () => {
    expect(sourceAddress(cfg({ host: "10.0.0.5", port: 502, endpoint: "opc.tcp://other:1" }))).toBe("10.0.0.5:502");
  });

  it("is empty for an empty config", () => {
    expect(sourceAddress(cfg({}))).toBe("");
  });

  it("is empty, and never throws, for a malformed url or values of the wrong type", () => {
    expect(() => sourceAddress(cfg({ endpoint: "not a url" }))).not.toThrow();
    expect(sourceAddress(cfg({ endpoint: "not a url" }))).toBe("");
    expect(sourceAddress(cfg({ endpoint: 42, url: null, host: {}, port: 1 }))).toBe("");
  });
});

describe("sourceTitle (w12c, decision 11)", () => {
  const src = (name: string, config: Record<string, unknown>) => ({ name, config });

  it("drops the trailing address of the OPC UA auto name", () => {
    expect(sourceTitle(src("OPC UA server at 172.20.0.2:4840", { endpoint: "opc.tcp://172.20.0.2:4840/server" }))).toBe("OPC UA server");
  });

  it("drops the trailing address of the Modbus auto name", () => {
    expect(sourceTitle(src("Modbus device at 10.0.0.5:502", { host: "10.0.0.5", port: 502 }))).toBe("Modbus device");
  });

  it("drops the trailing address of a Modbus name with a vendor and a product", () => {
    expect(sourceTitle(src("Modbus Schneider PM5560 at 10.0.0.5:502", { host: "10.0.0.5", port: 502 }))).toBe("Modbus Schneider PM5560");
  });

  it("leaves a name somebody typed alone", () => {
    expect(sourceTitle(src("Main incomer meter", { host: "10.0.0.5", port: 502 }))).toBe("Main incomer meter");
  });

  it("leaves a name that ends in ' at x' where x is not the source's address", () => {
    expect(sourceTitle(src("Meter at the gate", { host: "10.0.0.5", port: 502 }))).toBe("Meter at the gate");
    expect(sourceTitle(src("Modbus device at 10.0.0.6:502", { host: "10.0.0.5", port: 502 }))).toBe("Modbus device at 10.0.0.6:502");
  });

  it("leaves the name alone when the source has no address", () => {
    expect(sourceTitle(src("OPC UA server at 172.20.0.2:4840", {}))).toBe("OPC UA server at 172.20.0.2:4840");
  });

  it("leaves a name that is only the address (nothing would be left)", () => {
    expect(sourceTitle(src(" at 10.0.0.5:502", { host: "10.0.0.5", port: 502 }))).toBe(" at 10.0.0.5:502");
    expect(sourceTitle(src("10.0.0.5:502", { host: "10.0.0.5", port: 502 }))).toBe("10.0.0.5:502");
  });

  it("does not throw on a malformed url", () => {
    expect(() => sourceTitle(src("X at nowhere", { endpoint: "::::" }))).not.toThrow();
    expect(sourceTitle(src("X at nowhere", { endpoint: "::::" }))).toBe("X at nowhere");
  });
});
