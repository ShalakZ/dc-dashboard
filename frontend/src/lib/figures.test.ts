import { readFileSync } from "node:fs";
import {
  amountText, cardFigure, cardText, exactText, familyOf, groupDigits, IDENTITY, percentDigits, pickScale, tickText, type Family, type Marks, type Scale,
} from "./figures";

const none: Marks = { estimated: false, partial: false };
const est: Marks = { estimated: true, partial: false };
const part: Marks = { estimated: false, partial: true };
const both: Marks = { estimated: true, partial: true };

/** A single figure on its own: the scale its own size picks. */
const alone = (family: Family, unit: string | null, value: number, marks: Marks = none): string => cardText(value, pickScale(family, unit, [value]), marks);
const energy = (unit: string, value: number, marks: Marks = none): string => alone("energy", unit, value, marks);
const cost = (unit: string | null, value: number, marks: Marks = none): string => alone("cost", unit, value, marks);

describe("familyOf", () => {
  it.each<[string | null, "metric" | "energy" | "cost", Family]>([
    ["kWh", "energy", "energy"], ["kWh", "metric", "energy"], ["kW", "metric", "energy"], ["kVA", "metric", "energy"], ["kvar", "metric", "energy"],
    ["V", "metric", "plain"], ["A", "metric", "plain"], ["Hz", "metric", "plain"], ["", "metric", "plain"], [null, "metric", "plain"], ["bar", "metric", "plain"],
    ["MWh", "metric", "plain"], ["QAR", "cost", "cost"], [null, "cost", "cost"], ["kWh", "cost", "cost"],
  ])("%j from a %s source is %s", (unit, source, family) => {
    expect(familyOf(unit, source)).toBe(family);
  });
  it("does not take a property of Object for a unit", () => {
    expect(familyOf("constructor", "metric")).toBe("plain");
    expect(familyOf("__proto__", "metric")).toBe("plain");
    expect(pickScale("energy", "constructor", [5_000_000]).unit).toBe("constructor");
  });
});

describe("the card face of an energy figure (R2: two decimals below 10,000, none to 100,000, then the next unit)", () => {
  it.each<[number, string]>([
    [7.25, "7.25 kWh"], [562.82, "562.82 kWh"], [1124, "1,124.00 kWh"], [9999.994, "9,999.99 kWh"],
    [9999.996, "10,000 kWh"], [10_000, "10,000 kWh"], [33_051.6309, "33,052 kWh"], [99_999.4, "99,999 kWh"],
    [99_999.5, "100.00 MWh"], [275_430.2575, "275.43 MWh"], [1_234_567, "1,234.57 MWh"], [45_678_000, "45,678 MWh"], [123_456_000, "123.46 GWh"],
  ])("%d kWh reads %s", (value, text) => {
    expect(energy("kWh", value)).toBe(text);
  });
  it.each<[number, string]>([
    // the unit is chosen after rounding at EVERY step (plan review 1)
    [9_999_995, "10,000 MWh"], [99_999_500, "100.00 GWh"], [99_999_999.5, "100.00 GWh"], [999_995, "1,000.00 MWh"],
    [999_994, "999.99 MWh"], [9_999_994, "9,999.99 MWh"], [99_994_999, "99,995 MWh"], [123_456_789_000, "123,457 GWh"],
  ])("%d kWh crosses its boundaries as %s", (value, text) => {
    expect(energy("kWh", value)).toBe(text);
  });
  it("keeps the sign of a negative figure and drops the minus of a zero", () => {
    expect(energy("kWh", -562.8195)).toBe("-562.82 kWh");
    expect(energy("kWh", -275_430.2575)).toBe("-275.43 MWh");
    expect(energy("kWh", -9999.996)).toBe("-10,000 kWh");
    expect(energy("kWh", 0)).toBe("0.00 kWh");
    expect(energy("kWh", -0)).toBe("0.00 kWh");
    expect(energy("kWh", 0.004)).toBe("0.00 kWh");
    expect(energy("kWh", -0.004)).toBe("0.00 kWh");
    expect(energy("kWh", -0.004, est)).toBe("~0.00 kWh");
  });
  it("rounds by toFixed, as every old figure and Billing do (1.005 is 1.00, 2.675 is 2.67: not the rounding of a locale API)", () => {
    expect(energy("kWh", 1.005)).toBe("1.00 kWh");
    expect(energy("kWh", 2.675)).toBe("2.67 kWh");
    expect(energy("kWh", 0.125)).toBe("0.13 kWh");
    expect(energy("kWh", -0.125)).toBe("-0.13 kWh");
  });
  it("steps kW, kVA and kvar the same way (kVA and kvar stop at M)", () => {
    expect(energy("kW", 18.5)).toBe("18.50 kW");
    expect(energy("kW", 33_051.6309)).toBe("33,052 kW");
    expect(energy("kW", 275_430.2575)).toBe("275.43 MW");
    expect(energy("kW", 123_456_000)).toBe("123.46 GW");
    expect(energy("kVA", 99_999.5)).toBe("100.00 MVA");
    expect(energy("kVA", 275_430.2575)).toBe("275.43 MVA");
    expect(energy("kVA", 123_456_000)).toBe("123,456 MVA");
    expect(energy("kvar", 275_430.2575)).toBe("275.43 Mvar");
    expect(energy("kvar", 7.25)).toBe("7.25 kvar");
    expect(energy("kvar", 123_456_000_000)).toBe("123,456,000 Mvar");
  });
});

describe("the card face of a cost (k and M, the currency code stays)", () => {
  it.each<[number, string]>([
    [0, "0.00 QAR"], [7.5, "7.50 QAR"], [33_051.6309, "33,051.63 QAR"], [99_999.994, "99,999.99 QAR"], [99_999.996, "100.00k QAR"],
    [100_000, "100.00k QAR"], [275_430.26, "275.43k QAR"], [999_994, "999.99k QAR"], [999_995, "1.00M QAR"], [999_999.996, "1.00M QAR"],
    [1_234_567, "1.23M QAR"], [1_234_567_890, "1,234.57M QAR"], [-33_051.6309, "-33,051.63 QAR"], [-275_430.26, "-275.43k QAR"], [-0.004, "0.00 QAR"],
  ])("a cost of %d reads %s", (value, text) => {
    expect(cost("QAR", value)).toBe(text);
  });
  it("without a currency code the figure has no unit and keeps its letter", () => {
    expect(cost(null, 33_051.6309)).toBe("33,051.63");
    expect(cost(null, 275_430.26)).toBe("275.43k");
    expect(cost(null, 1_234_567)).toBe("1.23M");
    expect(cost("", 1_234_567)).toBe("1.23M");
  });
  it("puts the marks in today's order: ~, sign, digits, letter, *, unit", () => {
    expect(cost("QAR", 275_430.26, part)).toBe("275.43k* QAR");
    expect(cost("QAR", 275_430.26, both)).toBe("~275.43k* QAR");
    expect(cost("QAR", -67.5383, est)).toBe("~-67.54 QAR");
    expect(cost(null, 33_051.6309, est)).toBe("~33,051.63");
    expect(cost("QAR", 12.3, part)).toBe("12.30* QAR");
  });
});

describe("units that never scale", () => {
  it.each<[string | null, number, string]>([
    ["V", 230.456, "230.46 V"], ["V", 1_234_567.891, "1,234,567.89 V"], ["A", 12.5, "12.50 A"], ["A", 1_234_567.891, "1,234,567.89 A"],
    ["Hz", 50, "50.00 Hz"], ["Hz", -0.004, "0.00 Hz"], ["", 0.987, "0.99"], [null, 0.987, "0.99"], ["bar", 123_456_789.5, "123,456,789.50 bar"],
  ])("%j %d reads %s", (unit, value, text) => {
    expect(alone("plain", unit, value)).toBe(text);
  });
  it("keeps the marks in order", () => {
    expect(alone("plain", "V", 230.456, est)).toBe("~230.46 V");
    expect(alone("plain", "V", 230.456, both)).toBe("~230.46* V");
  });
});

describe("a missing figure", () => {
  const scale = pickScale("energy", "kWh", [5]);
  it.each<[string, number | null | undefined]>([["null", null], ["undefined", undefined], ["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity]])(
    "%s is a dash with no unit and no marks on every face",
    (_name, value) => {
      expect(cardFigure(value, scale, both)).toBe("—");
      expect(cardText(value, scale, both)).toBe("—");
      expect(exactText(value, "kWh", both)).toBe("—");
      expect(cardText(value, pickScale("cost", "QAR", [100]), both)).toBe("—");
      expect(amountText(value, scale)).toEqual({ digits: "—", zero: false, negative: false });
    },
  );
  it("does not throw for a tick that is not a number", () => {
    expect(tickText(NaN)).toBe("—");
    expect(tickText(Infinity)).toBe("—");
    expect(tickText(5, 0)).toBe("—");
  });
});

describe("the exact face (base unit, two decimals, grouped, never scaled)", () => {
  it.each<[number | null, string | null, Marks, string]>([
    [275_430.2575, "kWh", est, "~275,430.26 kWh"], [33_051.6309, "QAR", part, "33,051.63* QAR"], [33_051.6309, null, est, "~33,051.63"],
    [-562.8195, "kWh", est, "~-562.82 kWh"], [1234.5, null, none, "1,234.50"], [-1234.5, "kWh", none, "-1,234.50 kWh"], [138_130.96, "kWh", none, "138,130.96 kWh"],
    [0, "V", none, "0.00 V"], [-0.004, "kWh", none, "0.00 kWh"], [-0, "kWh", est, "~0.00 kWh"], [999_999.996, "kWh", none, "1,000,000.00 kWh"],
    [1_234_567_890.126, "QAR", both, "~1,234,567,890.13* QAR"], [50, "Hz", none, "50.00 Hz"], [0.987, "", none, "0.99"], [null, "kWh", est, "—"],
  ])("%j %j reads %s", (value, unit, marks, text) => {
    expect(exactText(value, unit, marks)).toBe(text);
  });
});

describe("the tick face", () => {
  it.each<[number, number | undefined, string]>([
    [18_000, undefined, "18,000"], [0, undefined, "0"], [-0, undefined, "0"], [0.5, undefined, "0.5"], [250_000, 1000, "250"], [300_000, 1000, "300"],
    [1500, undefined, "1,500"], [-1500, undefined, "-1,500"], [1234.5, undefined, "1,234.5"], [20, undefined, "20"], [100, undefined, "100"], [0.25, undefined, "0.25"],
    [0.001, undefined, "0"], [-0.001, undefined, "0"], [2_500_000, 1_000_000, "2.5"], [12_345_678, 1000, "12,345.68"], [5, 1000, "0.01"],
  ])("tickText(%d, %s) is %s", (value, divisor, text) => {
    expect(tickText(value, divisor)).toBe(text);
  });
});

describe("groupDigits", () => {
  it.each<[string, string]>([
    ["0", "0"], ["999", "999"], ["1000", "1,000"], ["1234567", "1,234,567"], ["1234567.5", "1,234,567.5"], ["12345.678", "12,345.678"], ["-1234.5", "-1,234.5"],
    ["0.12345", "0.12345"], ["—", "—"], ["", ""], ["1e+21", "1e+21"],
  ])("%j becomes %j", (digits, text) => {
    expect(groupDigits(digits)).toBe(text);
  });
});

describe("percentDigits", () => {
  it("is one decimal, grouped and without a sign", () => {
    expect(percentDigits(0.2039)).toBe("0.2");
    expect(percentDigits(-0.2039)).toBe("0.2");
    expect(percentDigits(1234.56)).toBe("1,234.6");
    expect(percentDigits(0)).toBe("0.0");
    expect(percentDigits(-12.34)).toBe("12.3");
  });
});

describe("one scale for a group (R3, D2)", () => {
  it("gives both sides of a comparison the unit of the larger side", () => {
    const scale = pickScale("energy", "kWh", [275_430.2575, 275_993.077]);
    expect(scale.unit).toBe("MWh");
    expect(scale.divisor).toBe(1000);
    expect(cardFigure(275_430.2575, scale, est)).toBe("~275.43");
    expect(cardFigure(275_993.077, scale, est)).toBe("~275.99");
    expect(cardText(275_430.2575, scale, est)).toBe("~275.43 MWh");
    expect(cardText(275_993.077, scale, est)).toBe("~275.99 MWh");
  });
  it("takes the larger side whichever side it is, and ignores a missing side", () => {
    expect(pickScale("energy", "kWh", [500, 275_993.077]).unit).toBe("MWh");
    expect(pickScale("energy", "kWh", [275_993.077, 500]).unit).toBe("MWh");
    expect(pickScale("energy", "kWh", [null, 275_993.077, undefined, NaN]).unit).toBe("MWh");
    expect(pickScale("energy", "kWh", [null, 500]).unit).toBe("kWh");
    expect(pickScale("energy", "kWh", [-275_993.077, 500]).unit).toBe("MWh");
  });
  it("shows 5.2 MWh next to 500 MWh as 5.20 MWh", () => {
    const scale = pickScale("energy", "kWh", [5200, 500_000]);
    expect(cardText(5200, scale, none)).toBe("5.20 MWh");
    expect(cardText(500_000, scale, none)).toBe("500.00 MWh");
  });
  it("decides after rounding: a group whose larger side rounds up to 100,000 moves to MWh", () => {
    expect(pickScale("energy", "kWh", [99_999.5, 12]).unit).toBe("MWh");
    expect(pickScale("energy", "kWh", [99_999.4, 12]).unit).toBe("kWh");
  });
  it("steps the group down rather than print a zero for something that is not zero (4 kWh beside 500,000 kWh)", () => {
    const scale = pickScale("energy", "kWh", [4, 500_000]);
    expect(scale.unit).toBe("kWh");
    expect(scale.divisor).toBe(1);
    expect(cardText(4, scale, none)).toBe("4.00 kWh");
    expect(cardText(500_000, scale, none)).toBe("500,000 kWh");
    expect(pickScale("energy", "kWh", [-4, 500_000]).unit).toBe("kWh");
    // nine tenths of a hundredth still shows a digit (0.009 MWh is "0.01"), and an exact zero never forces a step down
    expect(pickScale("energy", "kWh", [9, 500_000]).unit).toBe("MWh");
    expect(pickScale("energy", "kWh", [0, 500_000]).unit).toBe("MWh");
    expect(pickScale("energy", "kWh", [-0, 500_000]).unit).toBe("MWh");
    // several steps down in one go: 4 kWh beside 5,000,000,000 kWh would read 0.00 GWh and 0.00 MWh
    expect(pickScale("energy", "kWh", [4, 5_000_000_000]).unit).toBe("kWh");
    expect(pickScale("energy", "kWh", [4_000, 5_000_000_000]).unit).toBe("MWh");
  });
  it("prints no minus for a small negative at a larger scale: -4 kWh at an MWh scale reads 0.00", () => {
    const mwh = pickScale("energy", "kWh", [500_000]);
    expect(amountText(-4, mwh)).toEqual({ digits: "0.00", zero: true, negative: true });
    expect(cardFigure(-4, mwh, none)).toBe("0.00");
    expect(cardText(-4, mwh, est)).toBe("~0.00 MWh");
    expect(cardText(4, mwh, none)).toBe("0.00 MWh");
  });
  it("steps a cost group the same way", () => {
    const k = pickScale("cost", "QAR", [275_430.26, 200]);
    expect(k.letter).toBe("k");
    expect(cardText(275_430.26, k, none)).toBe("275.43k QAR");
    expect(cardText(200, k, none)).toBe("0.20k QAR");
    const down = pickScale("cost", "QAR", [4, 500_000]);
    expect(down.letter).toBe("");
    expect(cardText(4, down, none)).toBe("4.00 QAR");
    expect(cardText(500_000, down, none)).toBe("500,000.00 QAR");
    const m = pickScale("cost", null, [1_234_567, 999_999]);
    expect(m.letter).toBe("M");
    expect(cardText(999_999, m, none)).toBe("1.00M");
    expect(pickScale("cost", "QAR", [33_051.6309, 33_119.1692]).letter).toBe("");
    expect(cardText(33_051.6309, pickScale("cost", null, [33_051.6309, 33_119.1692]), est)).toBe("~33,051.63");
  });
  it("covers a gauge's value, min and max with one scale (review 18)", () => {
    const scale = pickScale("energy", "kW", [1500, 0, 500_000]);
    expect(scale.unit).toBe("MW");
    expect(cardText(1500, scale, none)).toBe("1.50 MW");
    expect(cardText(0, scale, none)).toBe("0.00 MW");
    expect(cardText(500_000, scale, none)).toBe("500.00 MW");
    const small = pickScale("energy", "kW", [7.5, 0, 20]);
    expect(small.unit).toBe("kW");
    expect(tickText(0, small.divisor)).toBe("0");
    expect(tickText(20, small.divisor)).toBe("20");
  });
  it("does not scale a plain unit and survives no values at all", () => {
    expect(pickScale("plain", "V", [230_000, 5]).unit).toBe("V");
    expect(pickScale("plain", "V", [230_000, 5]).divisor).toBe(1);
    expect(pickScale("energy", "kWh", []).unit).toBe("kWh");
    expect(pickScale("energy", "kWh", [null, undefined, NaN]).divisor).toBe(1);
    expect(pickScale("energy", "kWh", [0, -0]).unit).toBe("kWh");
    expect(pickScale("cost", "QAR", []).letter).toBe("");
  });
  it("each unit of a group of watts follows its own chain", () => {
    expect(pickScale("energy", "kW", [275_430]).unit).toBe("MW");
    expect(pickScale("energy", "kVA", [275_430]).unit).toBe("MVA");
    expect(pickScale("energy", "kvar", [275_430]).unit).toBe("Mvar");
    expect(pickScale("energy", "kVA", [275_430_000_000]).unit).toBe("MVA");
  });
});

describe("the axis name of a scale (D3)", () => {
  it.each<[Family, string | null, number, string | null]>([
    ["energy", "kWh", 5, "kWh"], ["energy", "kWh", 275_430, "MWh"], ["energy", "kWh", 123_456_000, "GWh"], ["energy", "kW", 275_430, "MW"],
    ["cost", "QAR", 5, "QAR"], ["cost", "QAR", 275_430, "k QAR"], ["cost", "QAR", 1_234_567, "M QAR"],
    ["cost", null, 5, null], ["cost", null, 275_430, "thousands"], ["cost", null, 1_234_567, "millions"],
    ["plain", "V", 230, "V"], ["plain", "", 0.9, null], ["plain", null, 0.9, null],
  ])("%s %j around %d is named %j", (family, unit, value, name) => {
    expect(pickScale(family, unit, [value]).axisName).toBe(name);
  });
  it("shows an axis in MWh as 250 and 300 under MWh, and the daily axis as 18,000 under kWh", () => {
    const mwh = pickScale("energy", "kWh", [300_000]);
    expect(mwh.axisName).toBe("MWh");
    expect(tickText(250_000, mwh.divisor)).toBe("250");
    expect(tickText(300_000, mwh.divisor)).toBe("300");
    const daily = pickScale("energy", "kWh", [18_000]);
    expect(daily.axisName).toBe("kWh");
    expect(tickText(18_000, daily.divisor)).toBe("18,000");
  });
});

describe("IDENTITY and the shape of a scale", () => {
  it("is the base unit with no scaling", () => {
    expect(IDENTITY("kWh")).toEqual({ divisor: 1, unit: "kWh", letter: "", axisName: "kWh", family: "plain" });
    expect(IDENTITY(null)).toEqual({ divisor: 1, unit: null, letter: "", axisName: null, family: "plain" });
    expect(IDENTITY("")).toEqual({ divisor: 1, unit: "", letter: "", axisName: null, family: "plain" });
    expect(cardText(275_430.2575, IDENTITY("kWh"), est)).toBe("~275,430.26 kWh");
  });
  it("is what a scale of the base step equals", () => {
    const base: Scale = pickScale("energy", "kWh", [5]);
    expect(base).toEqual({ divisor: 1, unit: "kWh", letter: "", axisName: "kWh", family: "energy" });
    expect(pickScale("cost", "QAR", [1_234_567])).toEqual({ divisor: 1_000_000, unit: "QAR", letter: "M", axisName: "M QAR", family: "cost" });
  });
});

describe("amountText (review 4: the sign is read from the printed digits)", () => {
  const kwh = pickScale("energy", "kWh", [5]);
  it.each<[number, { digits: string; zero: boolean; negative: boolean }]>([
    [-562.8195, { digits: "562.82", zero: false, negative: true }],
    [562.8195, { digits: "562.82", zero: false, negative: false }],
    [-0.125, { digits: "0.13", zero: false, negative: true }],
    [0.125, { digits: "0.13", zero: false, negative: false }],
    [-0.004, { digits: "0.00", zero: true, negative: true }],
    [0.004, { digits: "0.00", zero: true, negative: false }],
    [-0.005, { digits: "0.01", zero: false, negative: true }],
    [0, { digits: "0.00", zero: true, negative: false }],
    [-0, { digits: "0.00", zero: true, negative: false }],
    [1234.5, { digits: "1,234.50", zero: false, negative: false }],
    [-67.5383, { digits: "67.54", zero: false, negative: true }],
    [33_051.6309, { digits: "33,052", zero: false, negative: false }],
  ])("%d prints %j", (value, expected) => {
    expect(amountText(value, kwh)).toEqual(expected);
  });
  it("prints the digits of the scale it is given, without the letter", () => {
    expect(amountText(150_000, pickScale("energy", "kWh", [150_000]))).toEqual({ digits: "150.00", zero: false, negative: false });
    expect(amountText(-275_430.26, pickScale("cost", "QAR", [275_430.26]))).toEqual({ digits: "275.43", zero: false, negative: true });
    expect(amountText(1_234_567_890, pickScale("cost", "QAR", [1_234_567_890]))).toEqual({ digits: "1,234.57", zero: false, negative: false });
  });
  it("is zero for a value that rounds to zero at a larger scale, and not zero when it rounds to a digit", () => {
    const mwh = pickScale("energy", "kWh", [500_000]);
    expect(amountText(4, mwh).zero).toBe(true);
    expect(amountText(5, mwh).zero).toBe(false); // 0.005 MWh prints 0.01
    expect(amountText(-5, mwh)).toEqual({ digits: "0.01", zero: false, negative: true });
  });
});

describe("the worked examples of R2 (the demo's values)", () => {
  const thisMonth = 275_430.2575;
  const lastMonth = 275_993.077;
  it("energy: this month against last month on one unit, the change on its own", () => {
    const group = pickScale("energy", "kWh", [thisMonth, lastMonth]);
    expect(cardText(thisMonth, group, est)).toBe("~275.43 MWh");
    expect(cardText(lastMonth, group, est)).toBe("~275.99 MWh");
    const change = -562.8195;
    expect(cardText(change, pickScale("energy", "kWh", [change]), est)).toBe("~-562.82 kWh");
    expect(percentDigits(-0.2039)).toBe("0.2");
  });
  it("cost: the figure and its change", () => {
    const group = pickScale("cost", null, [33_051.6309, 33_119.1692]);
    expect(cardFigure(33_051.6309, group, est)).toBe("~33,051.63");
    expect(cardFigure(33_119.1692, group, est)).toBe("~33,119.17");
    expect(cardFigure(-67.5383, pickScale("cost", null, [-67.5383]), est)).toBe("~-67.54");
  });
  it("the breakdown line: the rest of the bars in one figure", () => {
    expect(cardText(262_071.8, pickScale("energy", "kWh", [262_071.8]), est)).toBe("~262.07 MWh");
  });
  it("a table cell is the exact face, and the exact face is what the title of the stat says", () => {
    expect(exactText(138_130.96, null, none)).toBe("138,130.96");
    expect(exactText(thisMonth, "kWh", est)).toBe("~275,430.26 kWh");
    expect(exactText(33_051.6309, null, est)).toBe("~33,051.63");
  });
  it("the daily axis reads 18,000 under kWh", () => {
    expect(tickText(18_000)).toBe("18,000");
  });
});

describe("no locale API anywhere (D1)", () => {
  const stubbed: (() => void)[] = [];
  afterEach(() => {
    while (stubbed.length) stubbed.pop()!();
  });
  it("does not read the browser's locale: every export gives the same text with Intl.NumberFormat and toLocaleString throwing and the language set to German", () => {
    const refuse = (name: string) => () => {
      throw new Error(`${name} must not be used`);
    };
    const numberFormat = vi.spyOn(Intl, "NumberFormat").mockImplementation(refuse("Intl.NumberFormat") as never);
    const toLocale = vi.spyOn(Number.prototype, "toLocaleString").mockImplementation(refuse("toLocaleString"));
    const language = vi.spyOn(navigator, "language", "get").mockReturnValue("de-DE");
    stubbed.push(() => numberFormat.mockRestore(), () => toLocale.mockRestore(), () => language.mockRestore());
    expect(navigator.language).toBe("de-DE");
    expect(() => new Intl.NumberFormat("en-US")).toThrow();

    const kwh = pickScale("energy", "kWh", [275_430.2575, 275_993.077]);
    const qar = pickScale("cost", "QAR", [1_234_567, 50_000]);
    expect(cardText(275_430.2575, kwh, est)).toBe("~275.43 MWh");
    expect(cardFigure(1_234_567, qar, part)).toBe("1.23M*");
    expect(cardText(50_000, qar, none)).toBe("0.05M QAR");
    expect(exactText(1_234_567.891, "kWh", both)).toBe("~1,234,567.89* kWh");
    expect(tickText(1_234_567.5)).toBe("1,234,567.5");
    expect(tickText(250_000, 1000)).toBe("250");
    expect(groupDigits("1234567.5")).toBe("1,234,567.5");
    expect(amountText(-1234.5, IDENTITY("kWh"))).toEqual({ digits: "1,234.50", zero: false, negative: true });
    expect(percentDigits(1234.56)).toBe("1,234.6");
    expect(familyOf("kWh", "energy")).toBe("energy");
    expect(IDENTITY("V").unit).toBe("V");
    expect(cardText(null, kwh, est)).toBe("—");
  });
  it("the module does not name a locale API in its source", () => {
    const source = readFileSync("src/lib/figures.ts", "utf8"); // vitest runs from the frontend directory
    expect(source).not.toMatch(/Intl|toLocale|localeCompare|navigator|\.language/);
  });
});
