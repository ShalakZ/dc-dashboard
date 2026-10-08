import type { RangePreset } from "../api/types";
import { isRolling, RANGE_LABELS, RANGE_PRESETS } from "./ranges";

describe("ranges", () => {
  it("lists exactly the nine presets, rolling first", () => {
    expect(RANGE_PRESETS).toEqual(["1h", "6h", "24h", "7d", "30d", "today", "yesterday", "this_month", "last_month"]);
  });

  it("has a distinct label for every preset", () => {
    expect(RANGE_LABELS["1h"]).toBe("Last hour");
    expect(RANGE_LABELS.today).toBe("Today");
    expect(RANGE_LABELS.this_month).toBe("This month");
    expect(RANGE_LABELS.last_month).toBe("Last month");
    for (const preset of RANGE_PRESETS) expect(RANGE_LABELS[preset]).toBeTruthy();
    expect(new Set(Object.values(RANGE_LABELS)).size).toBe(RANGE_PRESETS.length);
  });

  it.each<[RangePreset, boolean]>([
    ["1h", true], ["6h", true], ["24h", true], ["7d", true], ["30d", true],
    ["today", false], ["yesterday", false], ["this_month", false], ["last_month", false],
  ])("isRolling(%s) is %s", (preset, expected) => {
    expect(isRolling(preset)).toBe(expected);
  });
});
