import { formatSiteClock, formatSiteDateTime, formatSiteDay, formatSiteTick, siteMonth } from "./siteTime";

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
