import { compareAsset, compareBlock, compareChange, compareSeriesData, compareSide, compareStatData, valueRow } from "../test/dashboardFixtures";
import {
  changeCard, changeLine, changeMarks, CLOSED_NOTE, compareChartDescription, costMarkMeanings, compareLineNames, compareNotes, compareScale, dayLabel, dayOfMonthLabel, detailNotes,
  lastStateText, leftOutText, measureOf, measureUnit, monthName, noteLine, rateNoteText, sideCardFigure, sideCardText, sideFigure, sideText, whyNoneText, windowDates, windowLabel,
  withoutEnergyStars,
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
    expect(sideFigure(compareSide({ kwh: 1500 }), "kwh", 17, "QAR")).toBe("1,500.00 kWh");
    expect(sideFigure(compareSide({ cost: 300 }), "cost", 17, "QAR")).toBe("300.00 QAR");
    expect(sideFigure(compareSide({ cost: 300 }), "cost", 17, null)).toBe("300.00");
    expect(sideFigure(null, "kwh", 17, "QAR")).toBe("—");
  });

  it("is the EXACT face: the base unit and grouped digits, never scaled, with the star last (costMarkMeanings reads endsWith)", () => {
    expect(sideText(compareSide({ kwh: 275430.2575, estimated: true }), "kwh", 17)).toBe("~275,430.26");
    expect(sideFigure(compareSide({ kwh: 275430.2575, estimated: true }), "kwh", 17, "QAR")).toBe("~275,430.26 kWh");
    expect(sideText(compareSide({ cost: 275430.26, estimated: true, partial: true }), "cost", 17)).toBe("~275,430.26*");
    expect(sideText(compareSide({ cost: 275430.26, partial: true }), "cost", 17).endsWith("*")).toBe(true);
    expect(sideFigure(compareSide({ cost: 275430.26, partial: true }), "cost", 17, "QAR")).toBe("275,430.26* QAR");
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

  describe("carries the marks of its figures (w24 review I-2)", () => {
    const EST = { estimated: true, partial: false };
    const PART = { estimated: false, partial: true };
    const BOTH = { estimated: true, partial: true };

    it("puts ~ in front of the percentage and of the amount when a side is estimated", () => {
      expect(changeLine(compareChange({ abs: -294.32, percent: -0.2 }), "kWh", EST)).toBe("down ~0.2 % (~-294.32 kWh)");
      expect(changeLine(compareChange({ abs: 340, percent: 12.4 }), "kWh", EST)).toBe("up ~12.4 % (~+340.00 kWh)");
      expect(changeLine(compareChange({ abs: 340, why_none: "missing_days" }), "kWh", EST)).toBe("up ~340.00 kWh");
    });

    it("puts * behind a cost amount when a side is partial, also when the percentage is withheld for that reason", () => {
      expect(changeLine(compareChange({ abs: 18.6, why_none: "partial" }), "QAR", PART)).toBe("up 18.60* QAR");
      expect(changeLine(compareChange({ abs: -2, why_none: "partial" }), "QAR", PART)).toBe("down 2.00* QAR");
      expect(changeLine(compareChange({ abs: 18.6, percent: 12.4 }), "QAR", PART)).toBe("up 12.4 % (+18.60* QAR)"); // the star is the amount's, never the percentage's
      expect(changeLine(compareChange({ abs: 5, percent: 1 }), null, PART)).toBe("up 1.0 % (+5.00*)");
    });

    it("carries both marks together", () => {
      expect(changeLine(compareChange({ abs: 18.6, why_none: "partial" }), "QAR", BOTH)).toBe("up ~18.60* QAR");
      expect(changeLine(compareChange({ abs: -18.6, percent: -9 }), "QAR", BOTH)).toBe("down ~9.0 % (~-18.60* QAR)");
    });

    it("draws no mark on a line that shows no figure: no change, and a dash", () => {
      expect(changeLine(compareChange({ abs: 0, percent: 0 }), "kWh", BOTH)).toBe("no change");
      expect(changeLine(compareChange({ abs: -0.004, percent: -0.01 }), "kWh", EST)).toBe("no change");
      expect(changeLine(compareChange({ why_none: "no_previous" }), "kWh", BOTH)).toBe("—");
    });

    it("has no marks unless they are given", () => {
      expect(changeLine(compareChange({ abs: 340, percent: 12.4 }), "kWh", { estimated: false, partial: false })).toBe("up 12.4 % (+340.00 kWh)");
    });
  });
});

describe("the change line reads its direction from the PRINTED amount (w27 review 4)", () => {
  it("is down or up for a half cent, which prints as 0.13 and is not nothing", () => {
    expect(changeLine(compareChange({ abs: -0.125, percent: -1 }), "kWh")).toBe("down 1.0 % (-0.13 kWh)");
    expect(changeLine(compareChange({ abs: 0.125, percent: 1 }), "kWh")).toBe("up 1.0 % (+0.13 kWh)");
    expect(changeCard(compareChange({ abs: -0.125, percent: -1 }), "kwh", "kWh")).toBe("down 1.0 % (-0.13 kWh)");
    expect(changeCard(compareChange({ abs: 0.125, percent: 1 }), "kwh", "kWh")).toBe("up 1.0 % (+0.13 kWh)");
  });

  it("is no change for what prints as 0.00, either sign, on both faces, and never prints a minus on a zero", () => {
    for (const abs of [-0.004, 0.004, 0, -0]) {
      expect(changeLine(compareChange({ abs, percent: 0 }), "kWh")).toBe("no change");
      expect(changeCard(compareChange({ abs, percent: 0 }), "kwh", "kWh")).toBe("no change");
      expect(changeCard(compareChange({ abs }), "cost", "QAR", { estimated: true, partial: true })).toBe("no change");
    }
  });

  it("groups a big amount and a big percentage on the exact face", () => {
    expect(changeLine(compareChange({ abs: 150000, percent: 1234.56 }), "kWh")).toBe("up 1,234.6 % (+150,000.00 kWh)");
    expect(changeLine(compareChange({ abs: -1234.5, percent: -2 }), "QAR")).toBe("down 2.0 % (-1,234.50 QAR)");
  });

  it("is a dash for an amount that is not a number, whatever the percentage says", () => {
    expect(changeLine(compareChange({ abs: Number.NaN, percent: 1 }), "kWh")).toBe("—");
    expect(changeCard(compareChange({ abs: Number.POSITIVE_INFINITY }), "kwh", "kWh")).toBe("—");
  });
});

describe("the card face of a comparison (w27)", () => {
  const EST = { estimated: true, partial: false };
  const sides = (thisSide: ReturnType<typeof compareSide>, last: ReturnType<typeof compareSide>) => ({ this: thisSide, last });

  it("sets both sides of the demo in MWh, the larger side's unit: ~275.43 MWh against ~275.99 MWh", () => {
    const pair = sides(compareSide({ kwh: 275430.2575, estimated: true }), compareSide({ kwh: 275993.077, estimated: true }));
    const scale = compareScale(pair, "kwh", 17, "QAR");
    expect(sideCardFigure(pair.this, "kwh", 17, scale)).toBe("~275.43 MWh");
    expect(sideCardFigure(pair.last, "kwh", 17, scale)).toBe("~275.99 MWh");
    expect(sideCardText(pair.this, "kwh", 17, scale)).toBe("~275.43"); // no unit: the stat draws it apart
    expect(sideFigure(pair.this, "kwh", 17, "QAR")).toBe("~275,430.26 kWh"); // the title: the exact face
    expect(sideFigure(pair.last, "kwh", 17, "QAR")).toBe("~275,993.08 kWh");
  });

  it("keeps a cost in the site's currency below 100,000, with grouped digits and no scale letter", () => {
    const pair = sides(compareSide({ cost: 33051.6309, estimated: true }), compareSide({ cost: 33119.1692, estimated: true }));
    const none = compareScale(pair, "cost", 17, null);
    expect(sideCardFigure(pair.this, "cost", 17, none)).toBe("~33,051.63");
    expect(sideCardFigure(pair.last, "cost", 17, none)).toBe("~33,119.17");
    const qar = compareScale(pair, "cost", 17, "QAR");
    expect(sideCardFigure(pair.this, "cost", 17, qar)).toBe("~33,051.63 QAR");
    expect(sideCardFigure(compareSide({ cost: 33051.6309 }), "cost", 17, qar)).toBe("33,051.63 QAR");
  });

  it("writes k behind a cost of 100,000 or more and keeps the star after it: 275.43k* QAR", () => {
    const pair = sides(compareSide({ cost: 275430.26, partial: true }), compareSide({ cost: 280000 }));
    const scale = compareScale(pair, "cost", 17, "QAR");
    expect(scale.letter).toBe("k");
    expect(sideCardFigure(pair.this, "cost", 17, scale)).toBe("275.43k* QAR");
    expect(sideCardFigure(pair.last, "cost", 17, scale)).toBe("280.00k QAR");
    expect(sideCardFigure(compareSide({ cost: 275430.26, estimated: true, partial: true }), "cost", 17, scale)).toBe("~275.43k* QAR");
    expect(sideFigure(pair.this, "cost", 17, "QAR")).toBe("275,430.26* QAR"); // the title: exact, star last
    expect(sideCardFigure(compareSide({ cost: 275430.26 }), "cost", 17, scale)).toBe("275.43k QAR");
  });

  it("promotes after rounding: 99,999.5 kWh is 100.00 MWh and 9,999.996 kWh is 10,000 kWh", () => {
    const high = compareScale(sides(compareSide({ kwh: 99999.5 }), compareSide({ kwh: 99999.5 })), "kwh", 17, null);
    expect(sideCardFigure(compareSide({ kwh: 99999.5 }), "kwh", 17, high)).toBe("100.00 MWh");
    const edge = compareScale(sides(compareSide({ kwh: 9999.996 }), compareSide({ kwh: 9999.996 })), "kwh", 17, null);
    expect(sideCardFigure(compareSide({ kwh: 9999.996 }), "kwh", 17, edge)).toBe("10,000 kWh");
  });

  it("shares the unit of the larger side, and steps down to the base unit so a small side never reads 0.00: 500,000 kWh and 4 kWh", () => {
    const pair = sides(compareSide({ kwh: 500000 }), compareSide({ kwh: 4 }));
    const scale = compareScale(pair, "kwh", 17, null);
    expect(sideCardFigure(pair.this, "kwh", 17, scale)).toBe("500,000 kWh");
    expect(sideCardFigure(pair.last, "kwh", 17, scale)).toBe("4.00 kWh");
    const near = sides(compareSide({ kwh: 5200 }), compareSide({ kwh: 500000 }));
    const mwh = compareScale(near, "kwh", 17, null);
    expect(sideCardFigure(near.this, "kwh", 17, mwh)).toBe("5.20 MWh");
    expect(sideCardFigure(near.last, "kwh", 17, mwh)).toBe("500.00 MWh");
  });

  it("leaves a side with no figure out of the pick, and draws it as a dash with no unit and no scale", () => {
    const gone = compareSide({ kwh: 0, cost: null, no_data_days: 17 });
    const scale = compareScale({ this: compareSide({ kwh: 275430.2575 }), last: gone }, "kwh", 17, null);
    expect(scale.unit).toBe("MWh"); // the dash does not drag the other side down to kWh
    expect(sideCardFigure(gone, "kwh", 17, scale)).toBe("—");
    expect(sideCardText(gone, "kwh", 17, scale)).toBe("—");
    expect(sideCardFigure(null, "kwh", 17, scale)).toBe("—");
    expect(sideCardFigure(compareSide({ cost: null }), "cost", 17, compareScale(sides(compareSide({ cost: null }), compareSide({ cost: null })), "cost", 17, "QAR"))).toBe("—");
    expect(compareScale({ this: null, last: null }, "kwh", 17, null).unit).toBe("kWh"); // nothing to pick from: the base unit
  });

  it("puts a star only on a cost, whatever the kWh side carries", () => {
    const side = compareSide({ kwh: 275430.2575, estimated: true, partial: true });
    expect(sideCardFigure(side, "kwh", 17, compareScale({ this: side, last: side }, "kwh", 17, null))).toBe("~275.43 MWh");
  });

  it("picks the change's OWN scale from its amount: the demo's down ~0.2 % (~-562.82 kWh) under two MWh figures", () => {
    expect(changeCard(compareChange({ abs: -562.8195, percent: -0.2039 }), "kwh", "kWh", EST)).toBe("down ~0.2 % (~-562.82 kWh)");
    expect(changeLine(compareChange({ abs: -562.8195, percent: -0.2039 }), "kWh", EST)).toBe("down ~0.2 % (~-562.82 kWh)"); // the title
  });

  it("shows the cost change of the demo with no currency: down ~0.2 % (~-67.54)", () => {
    expect(changeCard(compareChange({ abs: -67.5383, percent: -0.2039 }), "cost", null, EST)).toBe("down ~0.2 % (~-67.54)");
    expect(changeCard(compareChange({ abs: -67.5383, percent: -0.2039 }), "cost", "QAR", EST)).toBe("down ~0.2 % (~-67.54 QAR)");
  });

  it("steps a big change up: 150,000 kWh is +150.00 MWh on the card and +150,000.00 kWh in its title", () => {
    expect(changeCard(compareChange({ abs: 150000, percent: 12.4 }), "kwh", "kWh")).toBe("up 12.4 % (+150.00 MWh)");
    expect(changeCard(compareChange({ abs: 150000, why_none: "missing_days" }), "kwh", "kWh", EST)).toBe("up ~150.00 MWh");
    expect(changeLine(compareChange({ abs: 150000, percent: 12.4 }), "kWh")).toBe("up 12.4 % (+150,000.00 kWh)");
  });

  it("writes a big cost change with k and the star behind it", () => {
    expect(changeCard(compareChange({ abs: -250000, percent: -9 }), "cost", "QAR", { estimated: true, partial: true })).toBe("down ~9.0 % (~-250.00k* QAR)");
    expect(changeCard(compareChange({ abs: 18.6, why_none: "partial" }), "cost", "QAR", { estimated: false, partial: true })).toBe("up 18.60* QAR");
  });

  it("never scales a change in a unit that is not energy or cost", () => {
    expect(changeCard(compareChange({ abs: 150000, percent: 12.4 }), "kwh", "V")).toBe("up 12.4 % (+150,000.00 V)");
  });
});

describe("the marks of a change", () => {
  const asset = (over: Parameters<typeof compareAsset>[0]) => compareAsset(over);

  it("is estimated when either side is, for either measure", () => {
    expect(changeMarks(asset({ this: compareSide({ estimated: true }) }), "kwh")).toEqual({ estimated: true, partial: false });
    expect(changeMarks(asset({ last: compareSide({ estimated: true }) }), "cost")).toEqual({ estimated: true, partial: false });
    expect(changeMarks(asset({}), "kwh")).toEqual({ estimated: false, partial: false });
  });

  it("is partial only on a cost, when either side is partial: an energy comparison never shows a star", () => {
    expect(changeMarks(asset({ this: compareSide({ partial: true }) }), "cost").partial).toBe(true);
    expect(changeMarks(asset({ last: compareSide({ partial: true }) }), "cost").partial).toBe(true);
    expect(changeMarks(asset({ this: compareSide({ partial: true }), last: compareSide({ partial: true }) }), "kwh").partial).toBe(false);
  });

  it("copes with a side that is missing", () => {
    expect(changeMarks(asset({ last: null, this: compareSide({ estimated: true }) }), "kwh")).toEqual({ estimated: true, partial: false });
    expect(changeMarks(asset({ last: null, this: null }), "cost")).toEqual({ estimated: false, partial: false });
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

  it("says both months when neither has readings (w24 review m7): the server only names the last month, the first reason that holds", () => {
    const none = compareSide({ kwh: 0, no_data_days: 17 });
    expect(whyNoneText("no_previous", "kwh", ctx({ thisSide: none, lastSide: none }))).toBe("No readings this month or last month.");
    expect(whyNoneText("no_previous", "cost", ctx({ thisSide: none, lastSide: null }))).toBe("No readings this month or last month.");
    expect(whyNoneText("no_previous", "kwh", ctx({ thisSide: null, lastSide: null }))).toBe("No readings this month or last month.");
    expect(whyNoneText("no_previous", "kwh", ctx({ thisSide: compareSide({ no_data_days: 16 }), lastSide: none }))).toBe("No readings last month.");
  });

  it("says both months in the notes of an asset with no readings on either side", () => {
    const none = compareSide({ kwh: 0, no_data_days: 17 });
    const asset = compareAsset({ this: none, last: none, last_state: "no_readings", kwh: compareChange({ why_none: "no_previous" }) });
    expect(compareNotes(compareBlock(), asset, "kwh")).toEqual(["No readings this month or last month."]);
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

  it("draws no mark on the last month's line of a cost whose currency changed: it has no figure to mark", () => {
    const gone = compareAsset({ this: compareSide({ estimated: true }), last: compareSide({ estimated: true, partial: true, cost: null }), cost: compareChange({ why_none: "currency" }) });
    expect(compareLineNames(compareBlock(), gone, "cost")).toEqual(["October ~", "September"]);
    expect(compareLineNames(compareBlock(), gone, "kwh")).toEqual(["October ~", "September ~"]); // its kWh are real
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

  it("does not call a currency change a missing rate: last month's cost is a dash because the currency changed, and a rate that really is missing still is (w24 review C-1)", () => {
    const currency = compareAsset({ last: compareSide({ cost: null }), cost: compareChange({ why_none: "currency" }) });
    expect(costMarkMeanings(compareStatData({ compare: compareBlock({ assets: [currency] }) }))).toEqual([]);
    const missing = compareAsset({ last: compareSide({ cost: null }), cost: compareChange({ why_none: "no_cost" }) });
    expect(costMarkMeanings(compareStatData({ compare: compareBlock({ assets: [missing] }) }))).toEqual(["— no rate: no tariff applies to this figure"]);
    // both together: this month's own cost lacks a rate while last month's is in another currency
    const both = compareAsset({ this: compareSide({ cost: null }), last: compareSide({ cost: null }), cost: compareChange({ why_none: "currency" }) });
    expect(costMarkMeanings(compareStatData({ compare: compareBlock({ assets: [both] }) }))).toEqual(["— no rate: no tariff applies to this figure"]);
  });

  it("says nothing when the table draws neither mark, for a side with no readings (a dash that is not a missing rate), for a cost widget and without a comparison", () => {
    expect(costMarkMeanings(compareStatData())).toEqual([]);
    expect(costMarkMeanings(sides({ cost: null, no_data_days: 17 }))).toEqual([]);
    expect(costMarkMeanings(sides({ partial: true, cost: null, no_data_days: 17 }))).toEqual([]);
    expect(costMarkMeanings({ ...sides({ partial: true }), source: "cost" })).toEqual([]);
    expect(costMarkMeanings(compareStatData({ compare: null }))).toEqual([]);
  });
});
