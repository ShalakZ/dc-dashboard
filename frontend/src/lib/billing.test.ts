import type { BillingAssetRow } from "../api/types";
import { clampMonth, depthsByAsset, fmtCost, fmtKwh, fmtRate, MONTH_NAMES, monthLabel, monthsOfYear, shiftMonth, yearsBetween } from "./billing";

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

describe("the year and month picker helpers", () => {
  it("names the twelve months in order", () => {
    expect(MONTH_NAMES).toHaveLength(12);
    expect([MONTH_NAMES[0], MONTH_NAMES[2], MONTH_NAMES[11]]).toEqual(["January", "March", "December"]);
  });

  it("lists every year from the lowest month's to the current month's", () => {
    expect(yearsBetween("2024-11", "2026-02")).toEqual([2024, 2025, 2026]);
    expect(yearsBetween("2026-02", "2026-10")).toEqual([2026]);
    expect(yearsBetween("2026-12", "2026-12")).toEqual([2026]);
  });

  it("lists only the months of a year that lie inside the bounds", () => {
    expect(monthsOfYear(2025, "2025-03", "2026-10")).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]); // the first year starts at the lowest month
    expect(monthsOfYear(2026, "2025-03", "2026-10")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // the last year ends at the current month
    expect(monthsOfYear(2026, "2024-01", "2028-12")).toHaveLength(12); // a year strictly inside has all twelve
    expect(monthsOfYear(2026, "2026-04", "2026-06")).toEqual([4, 5, 6]); // one year holding both bounds
    expect(monthsOfYear(2024, "2025-03", "2026-10")).toEqual([]); // outside the bounds: nothing
    expect(monthsOfYear(2027, "2025-03", "2026-10")).toEqual([]);
  });

  it.each([
    ["2024-12", "2025-03", "2026-10", "2025-03"], // before the first month: the first month
    ["2027-01", "2025-03", "2026-10", "2026-10"], // after the current month: the current month
    ["2025-03", "2025-03", "2026-10", "2025-03"], ["2026-10", "2025-03", "2026-10", "2026-10"], // the bounds themselves stay
    ["2025-07", "2025-03", "2026-10", "2025-07"], // inside: untouched
  ])("clamps %s into [%s, %s] as %s", (month, lowest, current, expected) => {
    expect(clampMonth(month, lowest, current)).toBe(expected);
  });
});
