import { formatAge, formatSpan } from "./age";

describe("formatAge", () => {
  it.each([
    [0, "0 s ago"], [12.7, "12 s ago"], [59.9, "59 s ago"], [60, "1 min ago"], [3599, "59 min ago"],
    [3600, "1 h ago"], [86399, "23 h ago"], [86400, "1 d ago"], [-5, "0 s ago"],
  ])("%s seconds reads %s", (seconds, text) => expect(formatAge(seconds)).toBe(text));

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])("shows a dash for %s", (value) =>
    expect(formatAge(value)).toBe("—"));

  it("formatSpan is the same without the word ago", () => expect(formatSpan(95)).toBe("1 min"));
});
