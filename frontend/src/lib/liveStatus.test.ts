import type { LiveStatus } from "../api/types";
import { agoText, statusView } from "./liveStatus";

describe("agoText", () => {
  it.each([
    [0, "0 s"],
    [4, "4 s"],
    [59.9, "59 s"], // floored, never rounded up into the next unit
    [60, "1 min"],
    [3599, "59 min"],
    [3600, "1 h"],
    [86399, "23 h"],
    [86400, "1 d"],
    [5 * 86400 + 100, "5 d"],
    [Number.NaN, "0 s"],
    [-3, "0 s"],
  ])("%s seconds reads %s", (seconds, expected) => {
    expect(agoText(seconds)).toBe(expected);
  });
});

describe("statusView", () => {
  const status = (over: Partial<LiveStatus>): LiveStatus => ({ collector_alive: true, readings_fresh: true, last_reading_age_seconds: 4, ...over });

  it("is nothing before the first answer", () => {
    expect(statusView(undefined)).toBeNull();
  });

  it("says Live with the age of the last reading", () => {
    expect(statusView(status({}))).toEqual({ state: "live", word: "Live", detail: "last reading 4 s ago" });
  });

  it("says Stale with the age of the last reading", () => {
    expect(statusView(status({ readings_fresh: false, last_reading_age_seconds: 300 }))).toEqual({ state: "stale", word: "Stale", detail: "last reading 5 min ago" });
  });

  it("says No readings yet when the server has nothing to judge", () => {
    expect(statusView(status({ readings_fresh: null, last_reading_age_seconds: null }))).toEqual({ state: "waiting", word: "No readings yet", detail: null });
  });

  // Review Focus 6: the two crossed cases name what is wrong, in words.
  it("says Collector offline when the collector is down, even if the readings are fresh", () => {
    expect(statusView(status({ collector_alive: false, readings_fresh: true }))).toEqual({ state: "offline", word: "Collector offline", detail: null });
  });

  it("still says Stale when the collector is up but the readings are old", () => {
    expect(statusView(status({ collector_alive: true, readings_fresh: false, last_reading_age_seconds: 600 }))?.word).toBe("Stale");
  });

  it("leaves the caption out when the server sent no age", () => {
    expect(statusView(status({ readings_fresh: true, last_reading_age_seconds: null }))).toEqual({ state: "live", word: "Live", detail: null });
  });

  it("offline wins over no readings", () => {
    expect(statusView(status({ collector_alive: false, readings_fresh: null, last_reading_age_seconds: null }))?.state).toBe("offline");
  });

  // The server judges freshness per mapping (3 x its interval), so a meter polled every 300 s is fine at 200 s.
  // The age is only a caption: the cutoff is never applied here.
  it("takes the verdict from readings_fresh, not from the age", () => {
    expect(statusView(status({ readings_fresh: true, last_reading_age_seconds: 200 }))).toMatchObject({ state: "live", word: "Live", detail: "last reading 3 min ago" });
    expect(statusView(status({ readings_fresh: false, last_reading_age_seconds: 200 }))).toMatchObject({ state: "stale", word: "Stale", detail: "last reading 3 min ago" });
  });
});
