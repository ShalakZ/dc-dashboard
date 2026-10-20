import { largestAbs, valueAxisFor } from "./chartScale";

describe("largestAbs", () => {
  it("is the largest magnitude, and ignores missing and non-finite members", () => {
    expect(largestAbs([1, -5, 3])).toBe(5);
    expect(largestAbs([null, undefined, Number.NaN, Infinity, 2])).toBe(2);
    expect(largestAbs([])).toBe(0);
  });
});

describe("the value axis of a chart (D3: one scale from the largest value it draws)", () => {
  it("reads 18,000 under kWh for a daily chart below 100,000 kWh", () => {
    const axis = valueAxisFor({ unit: "kWh", source: "energy" }, [9_500, 18_000]);
    expect(axis.name).toBe("kWh");
    expect(axis.format(18_000)).toBe("18,000");
    expect(axis.format(0)).toBe("0");
  });

  it("reads 250 and 300 under MWh when the largest value is 275,430 kWh", () => {
    const axis = valueAxisFor({ unit: "kWh", source: "energy" }, [120, 275_430.26]);
    expect(axis.name).toBe("MWh");
    expect(axis.format(250_000)).toBe("250");
    expect(axis.format(300_000)).toBe("300");
    expect(axis.format(12_500)).toBe("12.5");
    expect(axis.format(0)).toBe("0");
  });

  it("goes to MWh from 99,999.5 kWh (the unit is chosen after rounding) and stays in kWh at 99,999.4", () => {
    expect(valueAxisFor({ unit: "kWh", source: "energy" }, [99_999.5]).name).toBe("MWh");
    expect(valueAxisFor({ unit: "kWh", source: "energy" }, [99_999.4]).name).toBe("kWh");
  });

  it("is decided by the largest value, not by the small ones: a 4 kWh point does not pull the axis back to kWh", () => {
    const axis = valueAxisFor({ unit: "kWh", source: "energy" }, [4, 500_000]);
    expect(axis.name).toBe("MWh");
    expect(axis.scale.divisor).toBe(1000);
  });

  it("reads a negative largest value by its magnitude", () => {
    const axis = valueAxisFor({ unit: "kWh", source: "energy" }, [-250_000, 10]);
    expect(axis.name).toBe("MWh");
    expect(axis.format(-250_000)).toBe("-250");
  });

  it("never mixes units: every tick of one axis is in the same divisor", () => {
    const axis = valueAxisFor({ unit: "kWh", source: "energy" }, [275_430]);
    expect([0, 50_000, 100_000, 150_000, 200_000, 250_000, 300_000].map(axis.format)).toEqual(["0", "50", "100", "150", "200", "250", "300"]);
  });

  it("names a cost beyond 100,000 in k and in M, with the currency code", () => {
    expect(valueAxisFor({ unit: "QAR", source: "cost" }, [33_051.63]).name).toBe("QAR");
    const k = valueAxisFor({ unit: "QAR", source: "cost" }, [150_000, 3]);
    expect(k.name).toBe("k QAR");
    expect(k.format(150_000)).toBe("150");
    expect(k.format(50_000)).toBe("50");
    const m = valueAxisFor({ unit: "QAR", source: "cost" }, [1_234_567]);
    expect(m.name).toBe("M QAR");
    expect(m.format(1_000_000)).toBe("1");
    expect(m.format(500_000)).toBe("0.5");
  });

  it("names a cost with no currency thousands or millions", () => {
    expect(valueAxisFor({ unit: null, source: "cost" }, [5_000]).name).toBeUndefined();
    expect(valueAxisFor({ unit: null, source: "cost" }, [150_000]).name).toBe("thousands");
    expect(valueAxisFor({ unit: null, source: "cost" }, [2_000_000]).name).toBe("millions");
  });

  it("scales a power metric the same way and leaves every other unit as it is", () => {
    expect(valueAxisFor({ unit: "kW", source: "metric" }, [250_000]).name).toBe("MW");
    for (const unit of ["V", "A", "Hz"]) {
      const axis = valueAxisFor({ unit, source: "metric" }, [1_000_000]);
      expect(axis.name).toBe(unit);
      expect(axis.format(1_000_000)).toBe("1,000,000");
    }
  });

  it("gives a unit-less metric no axis name", () => {
    expect(valueAxisFor({ unit: "", source: "metric" }, [0.95]).name).toBeUndefined();
    expect(valueAxisFor({ unit: null, source: "metric" }, [0.95]).name).toBeUndefined();
  });

  it("never throws on an empty chart or a chart of missing figures", () => {
    const axis = valueAxisFor({ unit: "kWh", source: "energy" }, [null, Number.NaN]);
    expect(axis.name).toBe("kWh");
    expect(axis.format(0)).toBe("0");
  });

  it("keeps tiny ticks readable: a chart below 0.1 would otherwise read 0 everywhere", () => {
    const axis = valueAxisFor({ unit: "A", source: "metric" }, [0.004]);
    expect(axis.format(0.001)).toBe("0.001");
    expect(axis.format(0.004)).toBe("0.004");
    expect(axis.format(0)).toBe("0");
  });
});
