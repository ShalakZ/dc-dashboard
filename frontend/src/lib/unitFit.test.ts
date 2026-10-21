import { scaleForUnit, unitMismatch } from "./unitFit";

describe("scaleForUnit", () => {
  it("gives the factor to the metric's base unit, whatever the case and the blanks", () => {
    expect(scaleForUnit("active_power_kw", "W")).toBe(0.001);
    expect(scaleForUnit("active_power_kw", " k W\t")).toBe(1);
    expect(scaleForUnit("energy_kwh", "MWH")).toBe(1000);
    expect(scaleForUnit("power_factor", "cos phi")).toBe(1);
  });

  it("is null (refused) for no unit, a unit of another metric and a scaled spelling that the server refuses, although unitMismatch treats it as fitting", () => {
    for (const unit of [null, undefined, "", "   "]) expect(scaleForUnit("energy_kwh", unit), String(unit)).toBeNull();
    expect(scaleForUnit("energy_kwh", "kW")).toBeNull();
    expect(scaleForUnit("voltage_v", "kV")).toBeNull();
    expect(unitMismatch("voltage_v", "kV")).toBeNull();
  });

  it("takes any unit for custom, a missing one included, and refuses a metric it does not know", () => {
    for (const unit of ["furlongs", "kW", "", null, undefined]) expect(scaleForUnit("custom", unit)).toBe(1);
    expect(scaleForUnit("torque" as never, "Nm")).toBeNull();
  });

  it("treats only the ASCII space and tab as blanks, and never reads a unit as a property of the table", () => {
    expect(scaleForUnit("active_power_kw", "k\u00a0W")).toBeNull(); // a no-break space is not a blank here, as the fixture's _about says
    for (const unit of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(scaleForUnit("active_power_kw", unit), unit).toBeNull();
  });
});

describe("unitMismatch", () => {
  it("warns when the hint is a known unit of another metric, and names that metric", () => {
    expect(unitMismatch("energy_kwh", "V")).toBe(
      `The point's unit hint is "V", which is a voltage_v unit, not energy_kwh. Check the metric before saving.`,
    );
    expect(unitMismatch("active_power_kw", "kWh")).toContain("energy_kwh unit, not active_power_kw");
    expect(unitMismatch("voltage_v", " kw ")).toBe(
      `The point's unit hint is "kw", which is a active_power_kw unit, not voltage_v. Check the metric before saving.`,
    );
  });

  it("does not warn for a unit of the chosen metric, whatever its case or blanks", () => {
    expect(unitMismatch("active_power_kw", "W")).toBeNull();
    expect(unitMismatch("energy_kwh", "KWH")).toBeNull();
    expect(unitMismatch("energy_kwh", " k Wh ")).toBeNull();
    expect(unitMismatch("power_factor", "cosφ")).toBeNull();
  });

  it("does not warn for metric custom", () => {
    expect(unitMismatch("custom", "V")).toBeNull();
  });

  it("does not warn for a blank, missing or unknown hint", () => {
    expect(unitMismatch("energy_kwh", "")).toBeNull();
    expect(unitMismatch("energy_kwh", "   ")).toBeNull();
    expect(unitMismatch("energy_kwh", null)).toBeNull();
    expect(unitMismatch("energy_kwh", undefined)).toBeNull();
    expect(unitMismatch("energy_kwh", "degC")).toBeNull();
    expect(unitMismatch("energy_kwh", "%")).toBeNull();
  });

  it("tells reactive, apparent and active power apart", () => {
    expect(unitMismatch("active_power_kw", "kvar")).toContain("reactive_power_kvar");
    expect(unitMismatch("active_power_kw", "kVA")).toContain("apparent_power_kva");
    expect(unitMismatch("reactive_power_kvar", "kVAr")).toBeNull();
    expect(unitMismatch("current_a", "Hz")).toContain("frequency_hz");
  });
});
