import type { JsonSchema } from "../api/types";
import { coerceValues, fieldsFromSchema, initialValues, valuesFromConfig } from "./schemaForm";

// Exactly what pydantic emits for SimulatorConfig (backend/dcdash/connectors/simulator.py).
const simulator: JsonSchema = {
  type: "object",
  title: "SimulatorConfig",
  properties: {
    url: { type: "string", format: "uri", minLength: 1, title: "Url", default: "http://simulator:9000" } as never,
    timeout_seconds: { type: "number", title: "Timeout Seconds", default: 5.0 },
  },
};

const mixed: JsonSchema = {
  type: "object",
  required: ["host", "port"],
  properties: {
    host: { type: "string", title: "Host" },
    port: { type: "integer", title: "Port", default: 502 },
    tls: { type: "boolean", title: "Tls", default: false },
    note: { anyOf: [{ type: "string" }, { type: "null" }], title: "Note", default: null },
  },
};

describe("fieldsFromSchema", () => {
  it("keeps property order, labels, kinds and defaults", () => {
    expect(fieldsFromSchema(simulator)).toEqual([
      { name: "url", label: "Url", kind: "string", required: false, default: "http://simulator:9000", description: undefined },
      { name: "timeout_seconds", label: "Timeout Seconds", kind: "number", required: false, default: 5.0, description: undefined },
    ]);
  });

  it("marks required fields and unwraps anyOf-with-null as optional", () => {
    const fields = fieldsFromSchema(mixed);
    expect(fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["host", "string", true], ["port", "integer", true], ["tls", "boolean", false], ["note", "string", false],
    ]);
  });
});

describe("initialValues / coerceValues", () => {
  it("pre-fills defaults as strings and booleans", () => {
    expect(initialValues(fieldsFromSchema(mixed))).toEqual({ host: "", port: "502", tls: false, note: "" });
  });

  it("coerces number, integer and boolean", () => {
    const fields = fieldsFromSchema(mixed);
    expect(coerceValues(fields, { host: "10.0.0.1", port: "503", tls: true, note: "x" })).toEqual({
      host: "10.0.0.1", port: 503, tls: true, note: "x",
    });
  });

  it("drops empty optional strings but keeps empty required ones", () => {
    const fields = fieldsFromSchema(mixed);
    expect(coerceValues(fields, { host: "", port: "502", tls: false, note: "" })).toEqual({
      host: "", port: 502, tls: false,
    });
  });

  it("passes a non-numeric number field through as a string so the API rejects it", () => {
    expect(coerceValues(fieldsFromSchema(simulator), { url: "http://x", timeout_seconds: "abc" })).toEqual({
      url: "http://x", timeout_seconds: "abc",
    });
  });
});

describe("valuesFromConfig", () => {
  it("turns stored strings, numbers and booleans into form values (booleans stay booleans)", () => {
    expect(valuesFromConfig(fieldsFromSchema(mixed), { host: "10.0.0.1", port: 503, tls: true, note: "x" })).toEqual({
      host: "10.0.0.1", port: "503", tls: true, note: "x",
    });
  });

  it("falls back to the field's default for a key the stored config lacks", () => {
    expect(valuesFromConfig(fieldsFromSchema(mixed), { host: "10.0.0.1" })).toEqual({ host: "10.0.0.1", port: "502", tls: false, note: "" });
  });

  it("falls back to the default for a stored null", () => {
    expect(valuesFromConfig(fieldsFromSchema(mixed), { host: "h", port: null, tls: null, note: null })).toEqual({
      host: "h", port: "502", tls: false, note: "",
    });
  });

  it("round-trips: the stored config comes back out of coerceValues unchanged", () => {
    const fields = fieldsFromSchema(mixed);
    const stored = { host: "10.0.0.1", port: 503, tls: true, note: "x" };
    expect(coerceValues(fields, valuesFromConfig(fields, stored))).toEqual(stored);
  });
});
