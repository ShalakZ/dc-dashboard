import type { HistorySummary, Source } from "../api/types";
import { historyLine } from "./historyLine";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const hoursAgo = (hours: number) => minutesAgo(hours * 60);

const history = (over: Partial<HistorySummary> = {}): HistorySummary => ({
  supports_history: true, state: "idle", answered_through: null, last_success_at: null, next_try_at: null, last_error: null, ...over,
});
const row = (over: Partial<Pick<Source, "connector_type" | "polls" | "enabled" | "history">> = {}): Pick<Source, "connector_type" | "polls" | "enabled" | "history"> => ({
  connector_type: "simulator", polls: true, enabled: true, history: history(), ...over,
});

describe("historyLine", () => {
  it("says a file source is filled by importing files, whatever its history says", () => {
    expect(historyLine(row({ connector_type: "file", polls: false, history: null }), NOW)).toBe("Filled by importing files");
    expect(historyLine(row({ connector_type: "file", polls: false, history: history({ supports_history: false, state: "not_supported" }) }), NOW)).toBe("Filled by importing files");
    expect(historyLine(row({ connector_type: "file", polls: undefined, history: undefined }), NOW)).toBe("Filled by importing files");
    expect(historyLine(row({ connector_type: "other", polls: false, history: history({ state: "filling" }) }), NOW)).toBe("Filled by importing files");
  });

  it("shows nothing for a connector that keeps no history (every real source today)", () => {
    expect(historyLine(row({ connector_type: "modbus", history: history({ supports_history: false, state: "not_supported" }) }), NOW)).toBeNull();
    expect(historyLine(row({ connector_type: "modbus", history: history({ supports_history: false, state: "idle", last_success_at: minutesAgo(3) }) }), NOW)).toBeNull();
  });

  it("shows nothing when the list row carries no history (an older server, a fixture) or a state it does not know", () => {
    expect(historyLine(row({ history: null }), NOW)).toBeNull();
    expect(historyLine(row({ history: undefined }), NOW)).toBeNull();
    expect(historyLine(row({ history: history({ state: "not_supported" }) }), NOW)).toBeNull();
    expect(historyLine(row({ history: history({ state: "paused" as never }) }), NOW)).toBeNull();
  });

  it("treats a missing polls as polling", () => {
    expect(historyLine(row({ polls: undefined, history: history({ state: "never_run" }) }), NOW)).toBe("History: not started yet");
  });

  it("never_run: not started yet", () => {
    expect(historyLine(row({ history: history({ state: "never_run" }) }), NOW)).toBe("History: not started yet");
  });

  describe("a source that is switched off", () => {
    const off = (state: HistorySummary["state"], over: Partial<HistorySummary> = {}) => row({ enabled: false, history: history({ state, ...over }) });

    it("never_run reads as not filled because the source is off, not as 'not started yet' for ever", () => {
      expect(historyLine(off("never_run"), NOW)).toBe("History: not filled (the source is switched off)");
    });

    it("keeps the same line for a source that is on, and reads a row without the field as on", () => {
      expect(historyLine(row({ enabled: true, history: history({ state: "never_run" }) }), NOW)).toBe("History: not started yet");
      expect(historyLine(row({ enabled: undefined, history: history({ state: "never_run" }) }), NOW)).toBe("History: not started yet");
    });

    it("leaves every other state as the history says it (a fill started by hand on a switched-off source is real)", () => {
      expect(historyLine(off("filling", { answered_through: hoursAgo(5) }), NOW)).toBe("History: filling, 5 hours behind");
      expect(historyLine(off("idle", { last_success_at: minutesAgo(3) }), NOW)).toBe("History: up to date, last fill 3 min ago");
      expect(historyLine(off("backing_off", { last_error: "no answer" }), NOW)).toBe("History: waiting, no answer");
      expect(historyLine(off("not_supported"), NOW)).toBeNull();
    });

    it("shows nothing for a switched-off connector that keeps no history, and still says a file source is filled by files", () => {
      expect(historyLine(row({ enabled: false, history: history({ supports_history: false, state: "not_supported" }) }), NOW)).toBeNull();
      expect(historyLine(row({ enabled: false, connector_type: "file", polls: false, history: null }), NOW)).toBe("Filled by importing files");
    });
  });

  describe("filling", () => {
    const filling =(answered_through: string | null) => row({ history: history({ state: "filling", answered_through }) });

    it("counts the whole hours between what was answered and now", () => {
      expect(historyLine(filling(hoursAgo(5)), NOW)).toBe("History: filling, 5 hours behind");
      expect(historyLine(filling(minutesAgo(5 * 60 + 59)), NOW)).toBe("History: filling, 5 hours behind");
      expect(historyLine(filling(hoursAgo(1)), NOW)).toBe("History: filling, 1 hour behind");
      expect(historyLine(filling(hoursAgo(1234)), NOW)).toBe("History: filling, 1,234 hours behind");
    });

    it("is under an hour behind, or has no figure, rather than 0 hours or NaN", () => {
      expect(historyLine(filling(minutesAgo(59)), NOW)).toBe("History: filling, less than an hour behind");
      expect(historyLine(filling(new Date(NOW + 60_000).toISOString()), NOW)).toBe("History: filling, less than an hour behind"); // a clock that runs ahead
      expect(historyLine(filling(null), NOW)).toBe("History: filling");
      expect(historyLine(filling("not a date"), NOW)).toBe("History: filling");
    });
  });

  describe("idle", () => {
    const idle = (last_success_at: string | null) => row({ history: history({ state: "idle", last_success_at }) });

    it("is up to date, with the age of the last fill in the units of the rest of the page", () => {
      expect(historyLine(idle(minutesAgo(3)), NOW)).toBe("History: up to date, last fill 3 min ago");
      expect(historyLine(idle(new Date(NOW - 20_000).toISOString()), NOW)).toBe("History: up to date, last fill 20 s ago");
      expect(historyLine(idle(hoursAgo(5)), NOW)).toBe("History: up to date, last fill 5 h ago");
      expect(historyLine(idle(hoursAgo(50)), NOW)).toBe("History: up to date, last fill 2 d ago");
    });

    it("has no age to give when the last fill is unknown or unreadable, and never a negative one", () => {
      expect(historyLine(idle(null), NOW)).toBe("History: up to date");
      expect(historyLine(idle("soon"), NOW)).toBe("History: up to date");
      expect(historyLine(idle(new Date(NOW + 5_000).toISOString()), NOW)).toBe("History: up to date, last fill 0 s ago");
    });
  });

  describe("backing_off", () => {
    const waiting = (last_error: string | null) => row({ history: history({ state: "backing_off", last_error }) });

    it("shows the last error", () => {
      expect(historyLine(waiting("the source did not answer in time"), NOW)).toBe("History: waiting, the source did not answer in time");
    });

    it("shows no error when there is none, and keeps the line on one line", () => {
      expect(historyLine(waiting(null), NOW)).toBe("History: waiting");
      expect(historyLine(waiting("  \n "), NOW)).toBe("History: waiting");
      expect(historyLine(waiting("first\n  second\tthird"), NOW)).toBe("History: waiting, first second third");
    });

    it("clips an error to 80 characters (the 80th is the ellipsis of a longer one)", () => {
      const exactly = "e".repeat(80);
      expect(historyLine(waiting(exactly), NOW)).toBe(`History: waiting, ${exactly}`);
      const clipped = historyLine(waiting("e".repeat(81)), NOW)!;
      expect(clipped).toBe(`History: waiting, ${"e".repeat(79)}…`);
      expect(clipped.slice("History: waiting, ".length)).toHaveLength(80);
      expect(historyLine(waiting("x".repeat(5000)), NOW)!.length).toBeLessThan(100);
    });
  });
});
