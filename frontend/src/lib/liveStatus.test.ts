import type { LiveStatus, SourceMeters } from "../api/types";
import { agoText, metersLine, notRisingWord, staleMetersWord, statusView } from "./liveStatus";

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

// w35: the data watchdog. The order (plan I10): Collector offline, then stale meters, then today's words, and "Live" says when counters do not rise.
describe("statusView with the meter fields (w35)", () => {
  const status = (over: Partial<LiveStatus>): LiveStatus => ({ collector_alive: true, readings_fresh: true, last_reading_age_seconds: 4, ...over });

  it("names the stale meters first, with the oldest silence as the detail and the numbers for the chip", () => {
    expect(statusView(status({ meters: 48, meters_stale: 3, oldest_stale_age_seconds: 7260 }))).toEqual({
      state: "stale", word: "3 of 48 meters stale", detail: "oldest 2 h ago", staleMeters: { stale: 3, total: 48 },
    });
  });

  it("says one meter in the singular where the grammar needs it", () => {
    expect(statusView(status({ meters: 12, meters_stale: 1, oldest_stale_age_seconds: 600 }))?.word).toBe("1 of 12 meters stale");
    expect(statusView(status({ meters: 1, meters_stale: 1, oldest_stale_age_seconds: 600 }))?.word).toBe("1 of 1 meter stale");
  });

  it("groups the thousands of the stale word, and keeps the plain numbers for the chip to group in its narrow part", () => {
    expect(statusView(status({ meters: 1334, meters_stale: 1334, oldest_stale_age_seconds: 600 }))).toMatchObject({
      word: "1,334 of 1,334 meters stale", staleMeters: { stale: 1334, total: 1334 },
    });
  });

  it("puts the stale meters before the stale word, also while the other readings are fresh, stale or not there at all", () => {
    for (const readings_fresh of [true, false, null]) {
      expect(statusView(status({ readings_fresh, meters: 10, meters_stale: 2, oldest_stale_age_seconds: 90 })), String(readings_fresh)).toMatchObject({ state: "stale", word: "2 of 10 meters stale", detail: "oldest 1 min ago" });
    }
  });

  it("leaves the detail out when the server sent no age (null, missing or not a number)", () => {
    expect(statusView(status({ meters: 5, meters_stale: 2, oldest_stale_age_seconds: null }))?.detail).toBeNull();
    expect(statusView(status({ meters: 5, meters_stale: 2 }))?.detail).toBeNull();
    expect(statusView(status({ meters: 5, meters_stale: 2, oldest_stale_age_seconds: Number.NaN }))?.detail).toBeNull();
  });

  it("never writes 'of undefined': without a total (or one that cannot be right) it counts the stale meters alone", () => {
    expect(statusView(status({ meters_stale: 3 }))).toMatchObject({ word: "3 meters stale", staleMeters: { stale: 3, total: null } });
    expect(statusView(status({ meters: null, meters_stale: 1 }))).toMatchObject({ word: "1 meter stale", staleMeters: { stale: 1, total: null } });
    expect(statusView(status({ meters: 2, meters_stale: 3 }))).toMatchObject({ word: "3 meters stale", staleMeters: { stale: 3, total: null } });
  });

  it("keeps Collector offline first, even with stale meters", () => {
    expect(statusView(status({ collector_alive: false, meters: 8, meters_stale: 8, oldest_stale_age_seconds: 900 }))).toEqual({ state: "offline", word: "Collector offline", detail: null });
  });

  it("says today's words when no meter is stale: zero, null, missing", () => {
    expect(statusView(status({ meters: 8, meters_stale: 0 }))).toEqual({ state: "live", word: "Live", detail: "last reading 4 s ago" });
    expect(statusView(status({ meters: null, meters_stale: null, meters_not_advancing: null }))).toEqual({ state: "live", word: "Live", detail: "last reading 4 s ago" });
    expect(statusView(status({}))).toEqual({ state: "live", word: "Live", detail: "last reading 4 s ago" });
  });

  it("says Stale for old readings when no meter is stale, and No readings yet when there are none", () => {
    expect(statusView(status({ meters: 8, meters_stale: 0, readings_fresh: false, last_reading_age_seconds: 300 }))).toEqual({ state: "stale", word: "Stale", detail: "last reading 5 min ago" });
    expect(statusView(status({ meters: 8, meters_stale: 0, readings_fresh: null, last_reading_age_seconds: null }))).toEqual({ state: "waiting", word: "No readings yet", detail: null });
  });

  it("keeps Live and tells how many counters do not rise, in place of the age of the last reading", () => {
    expect(statusView(status({ meters: 8, meters_stale: 0, meters_not_advancing: 2 }))).toEqual({ state: "live", word: "Live", detail: "2 meters not rising" });
    expect(statusView(status({ meters: 8, meters_stale: 0, meters_not_advancing: 1 }))).toEqual({ state: "live", word: "Live", detail: "1 meter not rising" });
    expect(statusView(status({ meters_not_advancing: 3, last_reading_age_seconds: null }))?.detail).toBe("3 meters not rising");
  });

  it("does not touch Stale or No readings yet when counters do not rise", () => {
    expect(statusView(status({ meters_not_advancing: 2, readings_fresh: false, last_reading_age_seconds: 300 }))).toEqual({ state: "stale", word: "Stale", detail: "last reading 5 min ago" });
    expect(statusView(status({ meters_not_advancing: 2, readings_fresh: null, last_reading_age_seconds: null }))).toEqual({ state: "waiting", word: "No readings yet", detail: null });
  });

  it("lets stale meters win over counters that do not rise", () => {
    expect(statusView(status({ meters: 9, meters_stale: 1, meters_not_advancing: 4, oldest_stale_age_seconds: 3600 }))).toMatchObject({ word: "1 of 9 meters stale", detail: "oldest 1 h ago" });
  });

  it("treats waiting meters as nothing to say", () => {
    expect(statusView(status({ meters: 5, meters_stale: 0, meters_waiting: 5 }))).toEqual({ state: "live", word: "Live", detail: "last reading 4 s ago" });
  });
});

describe("the words of the watchdog (w35)", () => {
  it("writes the stale word and the not-rising word with the right noun", () => {
    expect(staleMetersWord(3, 48)).toBe("3 of 48 meters stale");
    expect(staleMetersWord(1, 1)).toBe("1 of 1 meter stale");
    expect(staleMetersWord(1, null)).toBe("1 meter stale");
    expect(staleMetersWord(2, null)).toBe("2 meters stale");
    expect(notRisingWord(1)).toBe("1 meter not rising");
    expect(notRisingWord(2)).toBe("2 meters not rising");
  });

  it("groups the thousands of every count with a comma, as the other w35 texts do", () => {
    expect(staleMetersWord(91, 1334)).toBe("91 of 1,334 meters stale");
    expect(staleMetersWord(12000, 12345)).toBe("12,000 of 12,345 meters stale");
    expect(staleMetersWord(1204, null)).toBe("1,204 meters stale");
    expect(notRisingWord(1204)).toBe("1,204 meters not rising");
    expect(metersLine({ total: 12345, stale: 12000, not_advancing: 0, frozen: false, oldest_stale_age_seconds: null })?.text).toBe("12,000 of 12,345 meters stale");
  });

  describe("metersLine (the Sources page)", () => {
    const meters = (over: Partial<SourceMeters>): SourceMeters => ({ total: 12, stale: 0, not_advancing: 0, frozen: false, oldest_stale_age_seconds: null, ...over });

    it("is stale words in the warning ink when something is stale, also for a frozen source", () => {
      expect(metersLine(meters({ stale: 2 }))).toEqual({ text: "2 of 12 meters stale", stale: true });
      expect(metersLine(meters({ total: 4, stale: 4, frozen: true }))).toEqual({ text: "4 of 4 meters stale", stale: true });
    });

    it("lets stale win over not rising", () => {
      expect(metersLine(meters({ stale: 1, not_advancing: 5 }))?.text).toBe("1 of 12 meters stale");
    });

    it("is the muted not-rising words when only counters stand still, and names no hours", () => {
      expect(metersLine(meters({ not_advancing: 1 }))).toEqual({ text: "1 meter not rising", stale: false });
      expect(metersLine(meters({ not_advancing: 4 }))).toEqual({ text: "4 meters not rising", stale: false });
    });

    it("is nothing when all is well, and when the server sent no meters", () => {
      expect(metersLine(meters({}))).toBeNull();
      expect(metersLine(null)).toBeNull();
      expect(metersLine(undefined)).toBeNull();
    });

    it("counts the stale meters alone when the total cannot be right", () => {
      expect(metersLine(meters({ total: 1, stale: 3 }))?.text).toBe("3 meters stale");
    });
  });
});
