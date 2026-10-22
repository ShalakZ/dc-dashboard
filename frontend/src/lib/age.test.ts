import { ageNow, formatAge, formatSpan, formatSpanLong, secondsSince } from "./age";

describe("formatAge", () => {
  it.each([
    [0, "0 s ago"], [12.7, "12 s ago"], [59.9, "59 s ago"], [60, "1 min ago"], [3599, "59 min ago"],
    [3600, "1 h ago"], [86399, "23 h ago"], [86400, "1 d ago"], [-5, "0 s ago"],
  ])("%s seconds reads %s", (seconds, text) => expect(formatAge(seconds)).toBe(text));

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])("shows a dash for %s", (value) =>
    expect(formatAge(value)).toBe("—"));

  it("formatSpan is the same without the word ago", () => expect(formatSpan(95)).toBe("1 min"));
});

describe("secondsSince", () => {
  it("is the elapsed time between a moment and now, in seconds", () => expect(secondsSince(10_000, 55_500)).toBe(45.5));
  it("is never negative, for an answer that arrived after the last tick", () => expect(secondsSince(60_000, 58_000)).toBe(0));
  it("is 0 when nothing was received yet (a query's dataUpdatedAt is 0)", () => expect(secondsSince(0, 1_700_000_000_000)).toBe(0));
});

describe("ageNow", () => {
  it("grows the age the server gave by the time elapsed since the answer", () => expect(ageNow(5, 10_000, 55_000)).toBe(50));
  it("keeps a missing age missing", () => {
    expect(ageNow(null, 10_000, 55_000)).toBeNull();
    expect(ageNow(undefined, 10_000, 55_000)).toBeUndefined();
  });
});

describe("formatSpanLong (w32: how long a source has been down)", () => {
  it.each([
    [0, "0 s"], [45, "45 s"], [59.9, "59 s"], [60, "1 min"], [180, "3 min"], [3599, "59 min"],
    [3600, "1 h"], [7500, "2 h 5 min"], [7200, "2 h"], [7260, "2 h 1 min"], [86399, "23 h 59 min"],
    [86400, "1 d"], [352800, "4 d 2 h"], [345600, "4 d"], [349200, "4 d 1 h"], [-5, "0 s"],
  ])("%s seconds reads %s", (seconds, text) => expect(formatSpanLong(seconds)).toBe(text));

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])("shows a dash for %s", (value) => expect(formatSpanLong(value)).toBe("—"));

  it("drops a second unit that is zero, so 2 h 0 min is 2 h and 4 d 0 h is 4 d (and the single units of formatSpan are unchanged)", () => {
    expect(formatSpanLong(2 * 3600 + 59)).toBe("2 h");
    expect(formatSpanLong(4 * 86400 + 3599)).toBe("4 d");
    expect(formatSpan(352800)).toBe("4 d");
  });
});
