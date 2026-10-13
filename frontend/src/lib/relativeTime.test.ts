import { relativeTime } from "./relativeTime";

const NOW = new Date("2026-10-13T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe("relativeTime: today (the site day), by minutes and hours", () => {
  it("says just now under a minute, and for a future time (never a negative age)", () => {
    expect(relativeTime(ago(0), NOW, "UTC")).toBe("just now");
    expect(relativeTime(ago(59 * SECOND), NOW, "UTC")).toBe("just now");
    expect(relativeTime(ago(-5 * SECOND), NOW, "UTC")).toBe("just now");
    expect(relativeTime(ago(-3 * HOUR), NOW, "UTC")).toBe("just now");
    expect(relativeTime(ago(-9 * 24 * HOUR), NOW, "UTC")).toBe("just now");
  });

  it("counts whole minutes up to 59 and whole hours after that", () => {
    expect(relativeTime(ago(60 * SECOND), NOW, "UTC")).toBe("1 min ago");
    expect(relativeTime(ago(5 * MINUTE + 59 * SECOND), NOW, "UTC")).toBe("5 min ago");
    expect(relativeTime(ago(59 * MINUTE + 59 * SECOND), NOW, "UTC")).toBe("59 min ago");
    expect(relativeTime(ago(60 * MINUTE), NOW, "UTC")).toBe("1 h ago");
    expect(relativeTime(ago(3 * HOUR + 40 * MINUTE), NOW, "UTC")).toBe("3 h ago");
    expect(relativeTime(ago(12 * HOUR), NOW, "UTC")).toBe("12 h ago"); // 00:00 the same day
  });
});

describe("relativeTime: other days, by calendar days of the site clock", () => {
  it("says yesterday for the day before, even a few hours ago", () => {
    expect(relativeTime(ago(12 * HOUR + MINUTE), NOW, "UTC")).toBe("yesterday"); // 23:59 the day before
    expect(relativeTime(ago(36 * HOUR), NOW, "UTC")).toBe("yesterday"); // 00:00 the day before
  });

  it("counts calendar days from two days on, not 24-hour spans", () => {
    expect(relativeTime(ago(36 * HOUR + MINUTE), NOW, "UTC")).toBe("2 days ago"); // 23:59 two days before
    expect(relativeTime(ago(60 * HOUR), NOW, "UTC")).toBe("2 days ago"); // 00:00 two days before
    expect(relativeTime(ago(4 * 24 * HOUR), NOW, "UTC")).toBe("4 days ago");
    expect(relativeTime("2026-10-04T23:59:59Z", NOW, "UTC")).toBe("9 days ago");
  });

  it("reads 14 days and gives nothing from 15 days on (the caller shows no line)", () => {
    expect(relativeTime("2026-09-29T00:00:00Z", NOW, "UTC")).toBe("14 days ago");
    expect(relativeTime("2026-09-29T23:59:59Z", NOW, "UTC")).toBe("14 days ago");
    expect(relativeTime("2026-09-28T23:59:59Z", NOW, "UTC")).toBeNull();
    expect(relativeTime("2025-01-01T00:00:00Z", NOW, "UTC")).toBeNull();
  });

  it("an entry just before midnight seen just after it reads yesterday (the day word follows the calendar; the time above it says how long)", () => {
    const after = new Date("2026-10-13T00:10:00Z");
    expect(relativeTime("2026-10-12T23:50:00Z", after, "UTC")).toBe("yesterday");
    expect(relativeTime("2026-10-12T23:59:30Z", new Date("2026-10-13T00:00:10Z"), "UTC")).toBe("just now"); // under a minute is never a day word
  });

  it("follows the site's calendar, not UTC's", () => {
    const entry = "2026-10-12T21:30:00Z"; // 00:30 on the 13th in Qatar (UTC+3), still the 12th in UTC
    const now = new Date("2026-10-13T00:00:00Z"); // 03:00 on the 13th in Qatar
    expect(relativeTime(entry, now, "Asia/Qatar")).toBe("2 h ago");
    expect(relativeTime(entry, now, "UTC")).toBe("yesterday");
  });

  it("an unknown zone reads as UTC", () => {
    expect(relativeTime(ago(3 * HOUR), NOW, "Mars/Olympus")).toBe("3 h ago");
    expect(relativeTime(ago(48 * HOUR), NOW, "Mars/Olympus")).toBe("2 days ago");
  });
});

describe("relativeTime: input it cannot read", () => {
  it("gives null for an invalid time or an invalid now", () => {
    expect(relativeTime("not a time", NOW, "UTC")).toBeNull();
    expect(relativeTime("", NOW, "UTC")).toBeNull();
    expect(relativeTime(ago(HOUR), new Date("nope"), "UTC")).toBeNull();
  });
});
