import type { BillingLive } from "../api/types";
import {
  clampMonth, closedOnText, fmtCost, fmtKwh, fmtRate, fmtSigned, fmtSignedKwh, liveDeltaText, MONTH_NAMES, monthLabel, monthsOfYear, shiftMonth, yearsBetween,
} from "./billing";

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

describe("fmtSigned and fmtSignedKwh", () => {
  it.each([
    [12.5, 2, "+12.50"], [-3, 2, "-3.00"], [0, 2, "0.00"], [0.004, 2, "0.00"], [-0.004, 2, "0.00"], [0.005, 2, "+0.01"], [1234.567, 1, "+1234.6"],
  ])("fmtSigned(%f, %i) is %s", (value, digits, expected) => {
    expect(fmtSigned(value, digits)).toBe(expected);
  });

  it.each([
    [80, "+80"], [-80, "-80"], [12.5, "+12.5"], [0.004, "+0.004"], [-0.0012, "-0.001"], [0.0004, "0"], [0, "0"],
  ])("fmtSignedKwh(%f) is %s (up to three decimals, no trailing zeros)", (value, expected) => {
    expect(fmtSignedKwh(value)).toBe(expected);
  });
});

describe("liveDeltaText (the quiet line under a closed month)", () => {
  const live = (over: Partial<BillingLive> = {}): BillingLive => ({
    total_kwh: 1000, total_cost: 120, delta_kwh: 0, delta_cost: 0, differs: true, changed_assets: 0, currency: "QAR", ...over,
  });
  const WITH_COST = { total_cost: 100 };
  const NO_COST = { total_cost: null };

  // The fifth column is the currency the month was closed in; it is QAR (the fixtures' own) unless a row says otherwise.
  it.each<[string, BillingLive | null | undefined, { total_cost: number | null }, string | null, (string | null)?]>([
    ["live is null (today's tree could not be priced)", null, WITH_COST, null],
    ["live is missing (an older server)", undefined, WITH_COST, null],
    ["nothing differs", live({ differs: false }), WITH_COST, null],
    ["the cost differs (up)", live({ total_cost: 130.5, delta_cost: 10.5, delta_kwh: 80 }), WITH_COST, "Today's tree and rates would give 130.50 QAR (+10.50)."],
    ["the cost differs (down)", live({ total_cost: 90, delta_cost: -10 }), WITH_COST, "Today's tree and rates would give 90.00 QAR (-10.00)."],
    ["the cost differs and so does the kWh: the cost is what is said", live({ total_cost: 130.5, delta_cost: 30.5, delta_kwh: 250 }), WITH_COST, "Today's tree and rates would give 130.50 QAR (+30.50)."],
    ["only the kWh differs", live({ total_cost: 100, delta_cost: 0, delta_kwh: 12.5, total_kwh: 812.5 }), WITH_COST, "Today's tree and rates would give 812.5 kWh (+12.5)."],
    ["only the kWh differs, by a thousandth", live({ total_cost: 100, delta_cost: 0.001, delta_kwh: 0.004, total_kwh: 800 }), WITH_COST, "Today's tree and rates would give 800.0 kWh (+0.004)."],
    ["today there is no rate, so no cost", live({ total_cost: null, delta_cost: null, delta_kwh: 0 }), WITH_COST, "Today's tree and rates would give no cost, because there is no rate today."],
    ["the frozen month had no cost and today there is a rate (delta_cost is null)", live({ total_cost: 55, delta_cost: null, delta_kwh: 0 }), NO_COST, "Today's tree and rates would give 55.00 QAR (the closed figures have no cost)."],
    ["neither side has a cost and the kWh differs", live({ total_cost: null, delta_cost: null, delta_kwh: -4 , total_kwh: 96 }), NO_COST, "Today's tree and rates would give 96.0 kWh (-4)."],
    ["no currency then and now: the amount has no unit", live({ total_cost: 130.5, delta_cost: 30.5, currency: null }), WITH_COST, "Today's tree and rates would give 130.50 (+30.50).", null],
    ["the totals differ and one asset differs", live({ total_cost: 130.5, delta_cost: 30.5, changed_assets: 1 }), WITH_COST, "Today's tree and rates would give 130.50 QAR (+30.50), 1 asset differs."],
    ["the totals differ and three assets differ", live({ total_cost: 90, delta_cost: -10, changed_assets: 3 }), WITH_COST, "Today's tree and rates would give 90.00 QAR (-10.00), 3 assets differ."],
    ["no cost today and two assets differ", live({ total_cost: null, delta_cost: null, changed_assets: 2 }), WITH_COST, "Today's tree and rates would give no cost, because there is no rate today, 2 assets differ."],
    ["the totals agree but one asset differs (a move)", live({ delta_cost: 0, changed_assets: 1 }), WITH_COST, "Today's tree and rates give the same total, but 1 asset differs."],
    ["the totals agree but four assets differ", live({ delta_cost: 0, changed_assets: 4 }), WITH_COST, "Today's tree and rates give the same total, but 4 assets differ."],
    ["the totals agree to the cent and the thousandth", live({ delta_cost: 0.004, delta_kwh: 0.0004, changed_assets: 2 }), WITH_COST, "Today's tree and rates give the same total, but 2 assets differ."],
    ["neither side has a cost, the kWh agree and an asset differs", live({ total_cost: null, delta_cost: null, changed_assets: 1 }), NO_COST, "Today's tree and rates give the same total, but 1 asset differs."],
    ["differs is true but nothing says why", live({ delta_cost: 0 }), WITH_COST, "Today's tree and rates would give different figures."],
    // The currency changed after the close (M2): the server answers delta_cost null, and the line gives today's total in both currencies, no signed change.
    ["the currency was removed after the close: today's amount is said with words, not as a bare number", live({ total_cost: 130.5, delta_cost: null, currency: null }), WITH_COST, "Today's tree and rates would give 130.50 with no currency (closed in QAR).", "QAR"],
    ["the currency changed alone", live({ total_cost: 130.5, delta_cost: null, currency: "EUR" }), WITH_COST, "Today's tree and rates would give 130.50 EUR (closed in QAR).", "QAR"],
    ["the currency changed and assets differ too", live({ total_cost: 130.5, delta_cost: null, currency: "EUR", changed_assets: 2 }), WITH_COST, "Today's tree and rates would give 130.50 EUR (closed in QAR), 2 assets differ.", "QAR"],
    ["the month was closed with no currency and there is one now", live({ total_cost: 130.5, delta_cost: null, currency: "QAR" }), WITH_COST, "Today's tree and rates would give 130.50 QAR (closed with no currency).", null],
    ["the currency changed and the kWh moved: still no signed change", live({ total_cost: 130.5, delta_cost: null, delta_kwh: 40, currency: "EUR" }), WITH_COST, "Today's tree and rates would give 130.50 EUR (closed in QAR).", "QAR"],
    ["the currency changed but today has no rate: the missing rate is what is said", live({ total_cost: null, delta_cost: null, currency: "EUR" }), WITH_COST, "Today's tree and rates would give no cost, because there is no rate today.", "QAR"],
    ["the currency changed but the closed month had no cost: its own sentence", live({ total_cost: 55, delta_cost: null, currency: "EUR" }), NO_COST, "Today's tree and rates would give 55.00 EUR (the closed figures have no cost).", "QAR"],
  ])("%s", (_name, value, closed, expected, frozen = "QAR") => {
    expect(liveDeltaText(value, closed, frozen)).toBe(expected);
  });
});

describe("closedOnText", () => {
  it("is the day on the site's wall clock, with the weekday and the year", () => {
    expect(closedOnText("2026-10-15T09:00:00Z", "Asia/Qatar")).toBe("Thu 15 Oct 2026");
  });

  it("uses the site zone near midnight UTC, not UTC", () => {
    expect(closedOnText("2026-10-14T21:30:00Z", "Asia/Qatar")).toBe("Thu 15 Oct 2026"); // 00:30 on the 15th in Doha
    expect(closedOnText("2026-10-14T21:30:00Z", "UTC")).toBe("Wed 14 Oct 2026");
    expect(closedOnText("2026-10-15T02:30:00Z", "America/New_York")).toBe("Wed 14 Oct 2026"); // 22:30 on the 14th
  });

  it("gives the text back unchanged when it is not an instant", () => {
    expect(closedOnText("not a date", "UTC")).toBe("not a date");
  });
});
