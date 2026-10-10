import { unitMismatch } from "./unitFit";

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
