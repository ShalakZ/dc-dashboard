import { addDays, formatSiteClock, formatSiteDateTime, formatSiteDay, formatSiteTick, isSiteDay, siteDay, siteMonth } from "./siteTime";

describe("formatSiteDateTime", () => {
  // Every case names its zone, so the result never depends on the machine running the tests.
  it.each([
    ["2026-10-07T10:00:00Z", "Asia/Qatar", "2026-10-07 13:00:00"],
    ["2026-10-06T21:00:00Z", "Asia/Qatar", "2026-10-07 00:00:00"], // midnight reads 00, never 24
    ["2026-10-07T10:00:00+03:00", "UTC", "2026-10-07 07:00:00"],
    ["2026-03-29T00:30:00Z", "Europe/Amsterdam", "2026-03-29 01:30:00"], // CET
    ["2026-03-29T01:30:00Z", "Europe/Amsterdam", "2026-03-29 03:30:00"], // CEST: 02:xx does not exist that day
    ["2026-10-25T00:30:00Z", "Europe/Amsterdam", "2026-10-25 02:30:00"], // CEST
    ["2026-10-25T01:30:00Z", "Europe/Amsterdam", "2026-10-25 02:30:00"], // CET: 02:30 happens twice on a 25-hour day
  ])("%s in %s reads %s", (iso, zone, expected) => {
    expect(formatSiteDateTime(iso, zone)).toBe(expected);
  });

  it("returns the input unchanged when it cannot format it", () => {
    expect(formatSiteDateTime("not a date", "UTC")).toBe("not a date");
    expect(formatSiteDateTime("2026-10-07T10:00:00Z", "Mars/Olympus")).toBe("2026-10-07T10:00:00Z");
  });
});

describe("formatSiteClock", () => {
  it("prints the wall clock of the site zone", () => {
    expect(formatSiteClock("2026-10-07T10:00:05Z", "Asia/Qatar")).toBe("13:00:05");
    expect(formatSiteClock("2026-10-07T23:30:00Z", "Asia/Qatar")).toBe("02:30:00"); // the next day over there
  });
  it("returns the input when it cannot be formatted", () => {
    expect(formatSiteClock("not a date", "Asia/Qatar")).toBe("not a date");
    expect(formatSiteClock("2026-10-07T10:00:05Z", "Not/AZone")).toBe("2026-10-07T10:00:05Z");
  });
});

describe("formatSiteTick", () => {
  const iso = "2026-10-06T21:00:00Z"; // 2026-10-07 00:00 in Asia/Qatar
  it.each<["hour" | "day" | null, string]>([
    [null, "00:00"],
    ["hour", "10-07 00:00"],
    ["day", "10-07"],
  ])("bucket %s reads %s", (bucket, expected) => {
    expect(formatSiteTick(iso, "Asia/Qatar", bucket)).toBe(expected);
  });
});

describe("formatSiteDay", () => {
  it.each([
    ["2026-10-07", "Wed 07 Oct"],
    ["2026-03-29", "Sun 29 Mar"],
    ["2026-01-01", "Thu 01 Jan"],
    ["2026-02-30", "2026-02-30"], // not a real day: returned unchanged
    ["nope", "nope"],
  ])("%s reads %s", (day, expected) => {
    expect(formatSiteDay(day)).toBe(expected);
  });
});

describe("siteMonth", () => {
  it("names the month on the wall clock of the site zone, not UTC", () => {
    const edge = new Date("2026-10-31T22:30:00Z");
    expect(siteMonth(edge, "UTC")).toBe("2026-10");
    expect(siteMonth(edge, "Asia/Qatar")).toBe("2026-11"); // 01:30 on 1 November there
  });
});

describe("siteDay", () => {
  const edge = new Date("2026-10-05T21:30:00Z");
  it("names the day on the wall clock of the site zone, not UTC", () => {
    expect(siteDay(edge, "Asia/Qatar")).toBe("2026-10-06"); // 00:30 on the 6th there
    expect(siteDay(edge, "UTC")).toBe("2026-10-05");
  });
  it("falls back to UTC for an unknown zone", () => {
    expect(siteDay(edge, "Mars/Olympus")).toBe("2026-10-05");
  });
  it("is empty for an invalid date", () => {
    expect(siteDay(new Date("nope"), "UTC")).toBe("");
  });
});

describe("addDays", () => {
  it.each([
    ["2026-10-06", -6, "2026-09-30"],
    ["2026-10-06", 1, "2026-10-07"],
    ["2026-10-06", 0, "2026-10-06"],
    ["2026-03-01", -1, "2026-02-28"],
    ["2028-03-01", -1, "2028-02-29"], // a leap year
    ["2026-12-31", 1, "2027-01-01"],
    ["2026-01-01", -1, "2025-12-31"],
    ["0050-01-01", 1, "0050-01-02"], // a two-digit-looking year stays itself
    ["2026-10-25", 1, "2026-10-26"], // a clock-change day in Europe: a calendar day is still one day
  ])("%s %i days is %s", (day, n, expected) => {
    expect(addDays(day, n)).toBe(expected);
  });
  it("returns anything that is not a real day unchanged", () => {
    expect(addDays("2026-02-30", 1)).toBe("2026-02-30");
    expect(addDays("nope", 1)).toBe("nope");
  });
});

describe("isSiteDay", () => {
  it.each([["2026-10-06", true], ["2028-02-29", true], ["2026-02-29", false], ["2026-02-30", false], ["2026-13-01", false], ["2026-1-5", false], ["", false]])(
    "%s is %s",
    (day, expected) => {
      expect(isSiteDay(day)).toBe(expected);
    },
  );
});
