import { compareAsset, compareBlock, compareChange, compareSeriesData, compareSide, compareStatData, valueRow } from "../test/dashboardFixtures";
import {
  changeLine, CLOSED_NOTE, compareChartDescription, costMarkMeanings, compareLineNames, compareNotes, dayLabel, dayOfMonthLabel, detailNotes, lastStateText, leftOutText,
  measureOf, measureUnit, monthName, noteLine, rateNoteText, sideFigure, sideText, whyNoneText, windowDates, windowLabel, withoutEnergyStars,
} from "./compare";

const ctx = (over: Partial<{ days: number; thisSide: ReturnType<typeof compareSide> | null; lastSide: ReturnType<typeof compareSide> | null }> = {}) =>
  ({ days: 17, thisSide: compareSide(), lastSide: compareSide(), ...over });

describe("dates from the ISO text, never through a Date", () => {
  it("names the month of a month or a date", () => {
    expect(monthName("2026-10")).toBe("October");
    expect(monthName("2026-09-17")).toBe("September");
    expect(monthName("nonsense")).toBe("");
    expect(monthName("2026-13-01")).toBe("");
  });

  it("labels a day, and a day of the month by its slot", () => {
    expect(dayLabel("2026-10-05")).toBe("5 Oct");
    expect(dayLabel("soon")).toBe("soon");
    expect(dayOfMonthLabel("2026-09", 17)).toBe("17 Sep");
    expect(dayOfMonthLabel("2026-10-01", 3)).toBe("3 Oct");
  });

  it("labels a window: 1 to 17 Oct, one day on its own, a window across a month in full", () => {
    expect(windowLabel({ from: "2026-10-01", to: "2026-10-17" })).toBe("1 to 17 Oct");
    expect(windowLabel({ from: "2026-09-01", to: "2026-09-17" })).toBe("1 to 17 Sep");
    expect(windowLabel({ from: "2026-10-01", to: "2026-10-01" })).toBe("1 Oct");
    expect(windowLabel({ from: "2026-09-28", to: "2026-10-03" })).toBe("28 Sep to 3 Oct");
  });

  it("gives the dates of a window for the Details panel", () => {
    expect(windowDates({ from: "2026-10-01", to: "2026-10-17" })).toBe("2026-10-01 to 2026-10-17");
  });

  it("is the same in every browser zone (no Date is built from the text)", () => {
    const real = Date;
    const spy = vi.spyOn(globalThis, "Date").mockImplementation(() => { throw new Error("a Date was built"); });
    try {
      expect(windowLabel({ from: "2026-03-01", to: "2026-03-29" })).toBe("1 to 29 Mar");
      expect(leftOutText(["2026-03-29", "2026-03-30"], "2026-02")).toContain("February");
    } finally {
      spy.mockRestore();
    }
    expect(Date).toBe(real);
  });
});

describe("the figure of a side", () => {
  it("is the kWh with ~ for an estimate and never a * (the star belongs to cost)", () => {
    expect(sideText(compareSide({ kwh: 12.3 }), "kwh", 17)).toBe("12.30");
    expect(sideText(compareSide({ kwh: 12.3, estimated: true, partial: true }), "kwh", 17)).toBe("~12.30");
  });

  it("is the cost with ~ in front and * behind", () => {
    expect(sideText(compareSide({ cost: 4.5, estimated: true, partial: true }), "cost", 17)).toBe("~4.50*");
    expect(sideText(compareSide({ cost: 4.5 }), "cost", 17)).toBe("4.50");
  });

  it("is a dash, never a zero, for no side, a cost without a rate, or a side where every day has no readings", () => {
    expect(sideText(null, "kwh", 17)).toBe("—");
    expect(sideText(compareSide({ cost: null }), "cost", 17)).toBe("—");
    expect(sideText(compareSide({ kwh: 0, no_data_days: 17 }), "kwh", 17)).toBe("—");
    expect(sideText(compareSide({ kwh: 0, no_data_days: 16 }), "kwh", 17)).toBe("0.00");
  });

  it("adds the unit after a figure and none after a dash", () => {
    expect(sideFigure(compareSide({ kwh: 1500 }), "kwh", 17, "QAR")).toBe("1500.00 kWh");
    expect(sideFigure(compareSide({ cost: 300 }), "cost", 17, "QAR")).toBe("300.00 QAR");
    expect(sideFigure(compareSide({ cost: 300 }), "cost", 17, null)).toBe("300.00");
    expect(sideFigure(null, "kwh", 17, "QAR")).toBe("—");
  });

  it("knows the measure of a source and its unit", () => {
    expect(measureOf("energy")).toBe("kwh");
    expect(measureOf("cost")).toBe("cost");
    expect(measureUnit("kwh", "QAR")).toBe("kWh");
    expect(measureUnit("cost", "QAR")).toBe("QAR");
    expect(measureUnit("cost", null)).toBeNull();
  });
});

describe("the change line", () => {
  it("says up with a plus and the amount, in words and sign", () => {
    expect(changeLine(compareChange({ abs: 340, percent: 12.4 }), "kWh")).toBe("up 12.4 % (+340.00 kWh)");
  });

  it("says down with a minus", () => {
    expect(changeLine(compareChange({ abs: -120, percent: -3.1 }), "kWh")).toBe("down 3.1 % (-120.00 kWh)");
    expect(changeLine(compareChange({ abs: -4.5, percent: -9 }), "QAR")).toBe("down 9.0 % (-4.50 QAR)");
  });

  it("is no change when the amount is nothing at the shown precision, even a hair below zero", () => {
    expect(changeLine(compareChange({ abs: 0, percent: 0 }), "kWh")).toBe("no change");
    expect(changeLine(compareChange({ abs: -0.004, percent: -0.01 }), "kWh")).toBe("no change");
    expect(changeLine(compareChange({ abs: 0.004, percent: 0.01 }), "kWh")).toBe("no change");
  });

  it("shows only the signed amount when the server withheld the percentage, and a dash when there is no amount", () => {
    expect(changeLine(compareChange({ abs: 340, why_none: "missing_days" }), "kWh")).toBe("up 340.00 kWh");
    expect(changeLine(compareChange({ abs: -2, why_none: "partial" }), "QAR")).toBe("down 2.00 QAR");
    expect(changeLine(compareChange({ why_none: "no_previous" }), "kWh")).toBe("—");
  });

  it("works without a unit (a site with no currency)", () => {
    expect(changeLine(compareChange({ abs: 5, percent: 1 }), null)).toBe("up 1.0 % (+5.00)");
  });
});

describe("the reasons a percentage is withheld", () => {
  it("names the missing days of last month, of this month, or of both", () => {
    expect(whyNoneText("missing_days", "kwh", ctx({ lastSide: compareSide({ no_data_days: 3 }) }))).toBe("No percentage: last month has no readings on 3 of the 17 days.");
    expect(whyNoneText("missing_days", "kwh", ctx({ thisSide: compareSide({ no_data_days: 1 }) }))).toBe("No percentage: this month has no readings on 1 of the 17 days.");
    expect(whyNoneText("missing_days", "kwh", ctx({ thisSide: compareSide({ no_data_days: 1 }), lastSide: compareSide({ no_data_days: 3 }) })))
      .toBe("No percentage: last month has no readings on 3 and this month on 1 of the 17 days.");
    expect(whyNoneText("missing_days", "kwh", ctx())).toBe("No percentage: some days have no readings.");
  });

  it("has a sentence for each of the other reasons", () => {
    expect(whyNoneText("partial", "cost", ctx())).toBe("No percentage: some of the cost has no rate.");
    expect(whyNoneText("previous_zero", "kwh", ctx())).toBe("No percentage: last month used nothing.");
    expect(whyNoneText("previous_zero", "cost", ctx())).toBe("No percentage: last month's cost was zero.");
    expect(whyNoneText("no_previous", "kwh", ctx())).toBe("No readings last month.");
    expect(whyNoneText("no_current", "kwh", ctx())).toBe("No readings this month.");
    expect(whyNoneText("currency", "cost", ctx())).toBe("No cost comparison: the currency changed since last month closed.");
    expect(whyNoneText("no_cost", "cost", ctx())).toBe("No cost comparison: no rate applies to these days.");
  });

  it("has a sentence for the last states that cannot be compared, and none for the others", () => {
    expect(lastStateText("not_in_closed")).toBe("Not in last month's closed figures.");
    expect(lastStateText("other_zone")).toBe("Last month was closed in another time zone, so it cannot be compared day by day.");
    expect(lastStateText("ok")).toBeNull();
    expect(lastStateText("no_readings")).toBeNull();
  });
});

describe("the notes", () => {
  it("says which days have no matching day, with the right grammar", () => {
    expect(leftOutText(["2026-03-29", "2026-03-30"], "2026-02")).toBe("29 and 30 March have no matching day in February.");
    expect(leftOutText(["2026-03-29", "2026-03-30", "2026-03-31"], "2026-02")).toBe("29, 30 and 31 March have no matching day in February.");
    expect(leftOutText(["2026-05-31"], "2026-04")).toBe("31 May has no matching day in April.");
    expect(leftOutText([], "2026-02")).toBe("");
  });

  it("words the rate note from the date", () => {
    expect(rateNoteText("2026-10-05")).toBe("A rate changed on 5 Oct, so the cost change is not only usage.");
  });

  it("puts the reason first, then the rate note (cost only), the left-out days and the closed note", () => {
    const compare = compareBlock({ left_out_days: ["2026-10-31"], last_month: { month: "2026-09", closed: true } });
    const asset = compareAsset({ cost: compareChange({ abs: 4, why_none: "partial" }), kwh: compareChange({ abs: 4, percent: 2 }), rate_change: { date: "2026-10-05" } });
    expect(compareNotes(compare, asset, "cost")).toEqual([
      "No percentage: some of the cost has no rate.",
      "A rate changed on 5 Oct, so the cost change is not only usage.",
      "31 October has no matching day in September.",
      CLOSED_NOTE,
    ]);
    expect(compareNotes(compare, asset, "kwh")).toEqual(["31 October has no matching day in September.", CLOSED_NOTE]);
  });

  it("speaks last_state in place of the reason, and says nothing of a rate or a closed month it cannot compare", () => {
    const compare = compareBlock({ last_month: { month: "2026-09", closed: true } });
    const asset = compareAsset({ last: null, last_state: "not_in_closed", cost: compareChange({ why_none: "no_previous" }), rate_change: { date: "2026-10-05" } });
    expect(compareNotes(compare, asset, "cost")).toEqual(["Not in last month's closed figures."]);
  });

  it("has no note for a plain comparison", () => {
    expect(compareNotes(compareBlock(), compareAsset(), "kwh")).toEqual([]);
  });

  it("shows the first note and counts the others", () => {
    expect(noteLine([])).toBe("");
    expect(noteLine(["One."])).toBe("One.");
    expect(noteLine(["One.", "Two.", "Three."])).toBe("One. (+2 more in Details)");
  });

  it("lists every note once for Details, a measure's own reason with its measure in front", () => {
    const compare = compareBlock({ left_out_days: ["2026-10-31"] });
    const asset = compareAsset({ kwh: compareChange({ abs: 4, why_none: "previous_zero" }), cost: compareChange({ abs: 4, why_none: "partial" }), rate_change: { date: "2026-10-05" } });
    expect(detailNotes(compare, asset)).toEqual([
      "31 October has no matching day in September.",
      "Energy: No percentage: last month used nothing.",
      "Cost: No percentage: some of the cost has no rate.",
      "Cost: A rate changed on 5 Oct, so the cost change is not only usage.",
    ]);
    const same = compareAsset({ kwh: compareChange({ abs: 4, why_none: "missing_days" }), cost: compareChange({ abs: 4, why_none: "missing_days" }), last: compareSide({ no_data_days: 2 }) });
    expect(detailNotes(compareBlock(), same)).toEqual(["No percentage: last month has no readings on 2 of the 17 days."]);
  });
});

describe("the chart's names", () => {
  it("names the two lines by their months, with the side's marks", () => {
    const asset = compareAsset({ this: compareSide({ estimated: true }), last: compareSide({ partial: true }) });
    expect(compareLineNames(compareBlock(), asset, "kwh")).toEqual(["October ~", "September"]);
    expect(compareLineNames(compareBlock(), asset, "cost")).toEqual(["October ~", "September *"]);
  });

  it("falls back to this month and last month when the windows are missing", () => {
    expect(compareLineNames(compareBlock({ this_window: null, last_month: { month: "", closed: false } }), undefined, "kwh")).toEqual(["This month", "Last month"]);
  });

  it("describes the chart for a screen reader", () => {
    const data = compareStatData({ type: "timeseries" });
    expect(compareChartDescription(data, data.compare!)).toBe("Line chart comparing October with September, day by day for LV Panel 1. Energy in kWh. Open Details for the figures.");
  });
});

describe("no star on an energy comparison", () => {
  const starred = () => {
    const data = compareSeriesData(2, 2);
    data.series[0].partial = true;
    data.series[0].points[0] = { ...data.series[0].points[0], partial: true };
    data.compare!.assets[0].last_points[1] = { ...data.compare!.assets[0].last_points[1], partial: true, estimated: true };
    data.values = [valueRow({ partial: true, estimated: true })];
    return data;
  };

  it("clears partial on the series, its points, the values and last month's points, and keeps everything else (the estimates, the sides)", () => {
    const data = starred();
    data.compare!.assets[0].this = compareSide({ partial: true });
    const cleared = withoutEnergyStars(data);
    expect(cleared.series[0].partial).toBe(false);
    expect(cleared.series[0].points.some((p) => p.partial)).toBe(false);
    expect(cleared.values[0]).toMatchObject({ partial: false, estimated: true });
    expect(cleared.compare!.assets[0].last_points[1]).toMatchObject({ partial: false, estimated: true });
    expect(cleared.compare!.assets[0].this?.partial).toBe(true); // a side's partial is a cost mark of the Details table
    expect(data.series[0].partial).toBe(true); // the answer itself is not touched
  });

  it("is the answer itself when there is nothing to clear, for a cost comparison, and for a widget without one", () => {
    const clean = compareSeriesData(2, 2);
    expect(withoutEnergyStars(clean)).toBe(clean);
    const cost = { ...starred(), source: "cost" as const };
    expect(withoutEnergyStars(cost)).toBe(cost);
    const plain = { ...starred(), compare: null };
    expect(withoutEnergyStars(plain)).toBe(plain);
  });
});

describe("the cost marks of Details' table on an energy widget", () => {
  const sides = (over: Parameters<typeof compareSide>[0]) => compareStatData({ compare: compareBlock({ assets: [compareAsset({ this: compareSide(over) })] }) });

  it("says what a star and a dash in the cost column mean, in the words of the ordinary meanings", () => {
    expect(costMarkMeanings(sides({ partial: true }))).toEqual(["* partial: some energy in the period had no rate, so the cost is incomplete"]);
    expect(costMarkMeanings(sides({ cost: null }))).toEqual(["— no rate: no tariff applies to this figure"]);
    expect(costMarkMeanings(sides({ partial: true, cost: 3 })).length).toBe(1);
  });

  it("says nothing when the table draws neither mark, for a side with no readings (a dash that is not a missing rate), for a cost widget and without a comparison", () => {
    expect(costMarkMeanings(compareStatData())).toEqual([]);
    expect(costMarkMeanings(sides({ cost: null, no_data_days: 17 }))).toEqual([]);
    expect(costMarkMeanings(sides({ partial: true, cost: null, no_data_days: 17 }))).toEqual([]);
    expect(costMarkMeanings({ ...sides({ partial: true }), source: "cost" })).toEqual([]);
    expect(costMarkMeanings(compareStatData({ compare: null }))).toEqual([]);
  });
});
