import { describeLatest } from "./valueTip";
import type { MappingLatest } from "../hooks/useMappingLatest";

const latest = (over: Partial<MappingLatest> = {}): MappingLatest => ({
  mapping_id: 7, value: 12.4, unit: "kW", ts: "2026-10-17T10:00:00Z", quality: 0, age_seconds: 3, stale: false, ...over,
});

describe("describeLatest", () => {
  it("says the value with its unit and the age, in the project's two-decimal format", () => {
    expect(describeLatest(latest(), "ok", 3)).toEqual({ text: "12.40 kW, 3 s ago", tone: "ok" });
  });

  it("uses the age it is given (grown in the browser), not the one in the answer", () => {
    expect(describeLatest(latest({ age_seconds: 3 }), "ok", 125).text).toBe("12.40 kW, 2 min ago");
  });

  it("leaves out the unit when the metric has none, and the age when there is none", () => {
    expect(describeLatest(latest({ unit: "" }), "ok", 3).text).toBe("12.40, 3 s ago");
    expect(describeLatest(latest(), "ok", null).text).toBe("12.40 kW");
  });

  it("adds the word stale to an old reading", () => {
    expect(describeLatest(latest({ stale: true, age_seconds: 400 }), "ok", 400)).toEqual({ text: "12.40 kW, 6 min ago, stale", tone: "stale" });
  });

  it("calls a reading whose quality is not 0 a bad reading", () => {
    expect(describeLatest(latest({ quality: 1 }), "ok", 3)).toEqual({ text: "12.40 kW, 3 s ago, bad reading", tone: "bad" });
    expect(describeLatest(latest({ quality: 1, stale: true }), "ok", 3).text).toBe("12.40 kW, 3 s ago, stale, bad reading");
  });

  it("says there is no reading yet when the mapping has no row", () => {
    const none = latest({ value: null, ts: null, quality: null, age_seconds: null });
    expect(describeLatest(none, "ok", null)).toEqual({ text: "No reading yet", tone: "none" });
  });

  it("says a failed read could not be read, and a pending one is being read", () => {
    expect(describeLatest(undefined, "error", null)).toEqual({ text: "Could not read the value", tone: "bad" });
    expect(describeLatest(undefined, "loading", null)).toEqual({ text: "Reading…", tone: "none" });
  });

  it("says no reading when the answer is missing although the state is ok", () => {
    expect(describeLatest(undefined, "ok", null)).toEqual({ text: "No reading yet", tone: "none" });
  });
});
