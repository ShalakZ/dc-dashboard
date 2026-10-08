import type { BillingAssetRow } from "../api/types";
import { depthsByAsset, fmtCost, fmtKwh, fmtRate, monthLabel, shiftMonth } from "./billing";

describe("shiftMonth", () => {
  it.each([
    ["2026-10", -1, "2026-09"], ["2026-10", 1, "2026-11"], ["2026-10", 0, "2026-10"],
    ["2026-01", -1, "2025-12"], ["2026-12", 1, "2027-01"], ["2026-03", -14, "2025-01"],
  ])("%s moved by %i is %s", (month, delta, expected) => {
    expect(shiftMonth(month, delta)).toBe(expected);
  });
});

describe("monthLabel and number formats", () => {
  it("names the month in words", () => {
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(monthLabel("2025-12")).toBe("December 2025");
  });

  it("formats kWh to one decimal, cost to two, and a rate without trailing zeros up to six decimals", () => {
    expect(fmtKwh(12.5)).toBe("12.5");
    expect(fmtKwh(0)).toBe("0.0");
    expect(fmtCost(0.9)).toBe("0.90");
    expect(fmtRate(0.12)).toBe("0.12");
    expect(fmtRate(0.1234567)).toBe("0.123457");
    expect(fmtRate(1)).toBe("1");
    expect(fmtRate(0)).toBe("0");
    expect(fmtRate(null)).toBe("—");
  });
});

describe("depthsByAsset", () => {
  const row = (asset_id: number, parent_id: number | null, name: string, path: string): BillingAssetRow => ({
    asset_id, parent_id, name, path, rate_per_kwh: null, days: [], total: null,
  });

  it("derives depth from the parent chain, not from splitting the path on ' / '", () => {
    const depth = depthsByAsset([
      row(1, null, "Site", "Site"),
      row(2, 1, "MV2", "Site / MV2"),
      row(3, 2, "A / B", "Site / MV2 / A / B"), // an asset name that itself contains ' / '
      row(4, 1, "Spare", "Site / Spare"),
    ]);
    expect([...depth]).toEqual([[1, 0], [2, 1], [3, 2], [4, 1]]);
  });
});
