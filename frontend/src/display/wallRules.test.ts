import type { WidgetConfig } from "../api/types";
import type { DisplayItem, DisplayStatus, DisplayWidget } from "./displayApi";
import {
  BACKOFF_STEPS_MS, COLLECTOR_DOWN_MS, FADE_HALF_MS, FETCH_AHEAD_MS, HEARTBEAT_MS, JITTER_MAX, MAX_IN_FLIGHT, NOT_UPDATED_MS, READINGS_FLOOR_SECONDS,
  RELOAD_GUARD_MS, REREAD_MIN_MS, REVOKED_STEPS_MS, SCREEN_BAND_MS, SWAP_WAIT_MS, WAKE_HOLD_MS, WAKE_JUMP_MS, bandFor, buildChanged, busyWait,
  clockOffset, failureWait, formatClock, isDataWidget, itemsDiffer, jittered, nextShown, positionOf, readingsStoppedAt, refetchDue, reloadAllowed,
  revokedWait, shownItems, wallRefetchMs,
} from "./wallRules";

const widget = (id: number, type = "stat", config: unknown = { source: "energy" }): DisplayWidget => ({ id, type, title: `W${id}`, config, x: 0, y: id, w: 3, h: 2 });
const item = (id: number, over: Partial<DisplayItem> = {}): DisplayItem => ({
  id, seconds: 20, skipped: null, focus: null, dashboard: { id, name: `D${id}`, range: "today", widgets: [widget(id * 10)] }, ...over,
});
const config = (over: Partial<WidgetConfig> = {}): WidgetConfig => ({ assets: [], source: "energy", metric: null, aggregation: "sum", range: null, bars: "asset", min: 0, max: null, ...over });

describe("the constants of the brief", () => {
  it("are the numbers R2 to R10 name", () => {
    expect([FETCH_AHEAD_MS, SWAP_WAIT_MS, FADE_HALF_MS, HEARTBEAT_MS, WAKE_JUMP_MS]).toEqual([8_000, 5_000, 150, 5_000, 15_000]);
    expect([NOT_UPDATED_MS, SCREEN_BAND_MS, WAKE_HOLD_MS, RELOAD_GUARD_MS, REREAD_MIN_MS]).toEqual([120_000, 120_000, 10_000, 10_000, 10_000]);
    expect(MAX_IN_FLIGHT).toBe(2);
    expect(BACKOFF_STEPS_MS).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
    expect(JITTER_MAX).toBe(0.3);
    expect(REVOKED_STEPS_MS).toEqual([300_000, 900_000, 3_600_000]);
    expect([COLLECTOR_DOWN_MS, READINGS_FLOOR_SECONDS]).toEqual([50_000, 60]);
  });
});

describe("shownItems", () => {
  it("keeps, in order, the items that are not skipped and have a dashboard with at least one widget", () => {
    const items = [
      item(1),
      item(2, { skipped: "dashboard_deleted", dashboard: null }),
      item(3, { skipped: "no_widgets" }),
      item(4, { dashboard: null }),
      item(5, { dashboard: { id: 5, name: "Empty", range: "today", widgets: [] } }),
      item(6),
    ];
    expect(shownItems(items).map((shown) => shown.id)).toEqual([1, 6]);
  });
  it("is empty for an empty playlist, and does not change its argument", () => {
    const items: DisplayItem[] = [];
    expect(shownItems(items)).toEqual([]);
    expect(shownItems(items)).not.toBe(items);
  });
});

describe("positionOf", () => {
  const shown = [item(7), item(8), item(9)];
  it("is 1-based among the shown items", () => {
    expect(positionOf(shown, 7)).toEqual({ index: 1, of: 3 });
    expect(positionOf(shown, 9)).toEqual({ index: 3, of: 3 });
  });
  it("is null for an item that is not shown", () => {
    expect(positionOf(shown, 1)).toBeNull();
    expect(positionOf([], 7)).toBeNull();
  });
});

describe("nextShown", () => {
  const shown = [item(7), item(8), item(9)];
  it("is the item after the current one", () => {
    expect(nextShown(shown, 7)?.id).toBe(8);
    expect(nextShown(shown, 8)?.id).toBe(9);
  });
  it("wraps from the last to the first", () => {
    expect(nextShown(shown, 9)?.id).toBe(7);
  });
  it("is the first when nothing is current or the current one is no longer shown", () => {
    expect(nextShown(shown, null)?.id).toBe(7);
    expect(nextShown(shown, 42)?.id).toBe(7);
  });
  it("is the same item when it is the only one", () => {
    expect(nextShown([item(7)], 7)?.id).toBe(7);
  });
  it("is null when nothing is shown", () => {
    expect(nextShown([], null)).toBeNull();
    expect(nextShown([], 7)).toBeNull();
  });
});

describe("itemsDiffer", () => {
  it("is false for equal items, including a copy made field by field", () => {
    const a = item(1, { focus: { id: 2, name: "Hall", trail: ["Pilot", "Hall"] } });
    const copy = JSON.parse(JSON.stringify(a)) as DisplayItem;
    expect(itemsDiffer(a, a)).toBe(false);
    expect(itemsDiffer(a, copy)).toBe(false);
  });
  it("is false when the config has its keys in another order (compared structurally)", () => {
    const a = item(1, { dashboard: { id: 1, name: "D", range: "today", widgets: [widget(1, "stat", { source: "energy", compare: "none" })] } });
    const b = item(1, { dashboard: { id: 1, name: "D", range: "today", widgets: [widget(1, "stat", { compare: "none", source: "energy" })] } });
    expect(itemsDiffer(a, b)).toBe(false);
  });
  it.each([
    ["id", (a: DisplayItem): DisplayItem => ({ ...a, id: 99 })],
    ["seconds", (a: DisplayItem): DisplayItem => ({ ...a, seconds: 21 })],
    ["the focus appearing", (a: DisplayItem): DisplayItem => ({ ...a, focus: { id: 2, name: "Hall", trail: ["Hall"] } })],
    ["the dashboard going", (a: DisplayItem): DisplayItem => ({ ...a, dashboard: null })],
    ["the dashboard id", (a: DisplayItem): DisplayItem => ({ ...a, dashboard: { ...a.dashboard!, id: 5 } })],
    ["the dashboard name", (a: DisplayItem): DisplayItem => ({ ...a, dashboard: { ...a.dashboard!, name: "Other" } })],
    ["the dashboard range", (a: DisplayItem): DisplayItem => ({ ...a, dashboard: { ...a.dashboard!, range: "this_month" } })],
    ["a widget added", (a: DisplayItem): DisplayItem => ({ ...a, dashboard: { ...a.dashboard!, widgets: [...a.dashboard!.widgets, widget(99)] } })],
    ["a widget removed", (a: DisplayItem): DisplayItem => ({ ...a, dashboard: { ...a.dashboard!, widgets: [] } })],
    ["a widget id", (a: DisplayItem): DisplayItem => ({ ...a, dashboard: { ...a.dashboard!, widgets: [{ ...a.dashboard!.widgets[0], id: 77 }] } })],
    ["a widget type", (a: DisplayItem): DisplayItem => ({ ...a, dashboard: { ...a.dashboard!, widgets: [{ ...a.dashboard!.widgets[0], type: "bar" }] } })],
    ["a widget title", (a: DisplayItem): DisplayItem => ({ ...a, dashboard: { ...a.dashboard!, widgets: [{ ...a.dashboard!.widgets[0], title: "New" }] } })],
    ["a widget config (deep)", (a: DisplayItem): DisplayItem => ({ ...a, dashboard: { ...a.dashboard!, widgets: [{ ...a.dashboard!.widgets[0], config: { source: "cost" } }] } })],
    ["a widget x", (a: DisplayItem): DisplayItem => ({ ...a, dashboard: { ...a.dashboard!, widgets: [{ ...a.dashboard!.widgets[0], x: 4 }] } })],
    ["a widget y", (a: DisplayItem): DisplayItem => ({ ...a, dashboard: { ...a.dashboard!, widgets: [{ ...a.dashboard!.widgets[0], y: 9 }] } })],
    ["a widget width", (a: DisplayItem): DisplayItem => ({ ...a, dashboard: { ...a.dashboard!, widgets: [{ ...a.dashboard!.widgets[0], w: 6 }] } })],
    ["a widget height", (a: DisplayItem): DisplayItem => ({ ...a, dashboard: { ...a.dashboard!, widgets: [{ ...a.dashboard!.widgets[0], h: 5 }] } })],
    ["the order of the widgets", (a: DisplayItem): DisplayItem => ({ ...a, dashboard: { ...a.dashboard!, widgets: [...a.dashboard!.widgets, widget(99)].reverse() } })],
  ])("is true when %s differs", (_name, change) => {
    const base = item(1);
    expect(itemsDiffer(base, change(base))).toBe(true);
    expect(itemsDiffer(change(base), base)).toBe(true);
  });
  it.each([
    ["the focus id", { id: 3, name: "Hall", trail: ["Pilot", "Hall"] }],
    ["the focus name", { id: 2, name: "Hall 2", trail: ["Pilot", "Hall"] }],
    ["the focus trail", { id: 2, name: "Hall", trail: ["Pilot", "Hall", "Row"] }],
    ["a step of the focus trail", { id: 2, name: "Hall", trail: ["Other", "Hall"] }],
  ])("is true when %s differs", (_name, focus) => {
    expect(itemsDiffer(item(1, { focus: { id: 2, name: "Hall", trail: ["Pilot", "Hall"] } }), item(1, { focus }))).toBe(true);
  });
});

describe("isDataWidget", () => {
  it("is true for the five data types", () => {
    for (const type of ["timeseries", "bar", "stat", "gauge", "table"]) expect(isDataWidget(type), type).toBe(true);
  });
  it("is false for text and for anything unknown", () => {
    for (const type of ["text", "", "Stat", "chart", "constructor", "toString"]) expect(isDataWidget(type), type).toBe(false);
  });
});

describe("wallRefetchMs and refetchDue", () => {
  it("asks a comparison every 60 s and every other card every 30 s (A12)", () => {
    expect(wallRefetchMs(config())).toBe(30_000);
    expect(wallRefetchMs(config({ compare: "none" }))).toBe(30_000);
    expect(wallRefetchMs(config({ compare: "same_days_last_month" }))).toBe(60_000);
  });
  it("is due with no answer", () => {
    expect(refetchDue(config(), null, 1_000_000)).toBe(true);
  });
  it("is due at 30 s of age and not at 29.999 s (and 60 s for a comparison)", () => {
    expect(refetchDue(config(), 1_000, 1_000 + 29_999)).toBe(false);
    expect(refetchDue(config(), 1_000, 1_000 + 30_000)).toBe(true);
    expect(refetchDue(config(), 1_000, 1_000 + 30_001)).toBe(true);
    const compare = config({ compare: "same_days_last_month" });
    expect(refetchDue(compare, 1_000, 1_000 + 59_999)).toBe(false);
    expect(refetchDue(compare, 1_000, 1_000 + 60_000)).toBe(true);
  });
  it("is not due at age 0, and is due when the clock moved back (a negative age)", () => {
    expect(refetchDue(config(), 5_000, 5_000)).toBe(false);
    expect(refetchDue(config(), 5_000, 4_999)).toBe(true);
    expect(refetchDue(config(), 5_000, -10_000)).toBe(true);
  });
});

describe("jittered, failureWait, busyWait", () => {
  it("adds 0 to 30 percent and rounds", () => {
    expect(jittered(5_000, () => 0)).toBe(5_000);
    expect(jittered(5_000, () => 0.5)).toBe(5_750);
    expect(jittered(5_000, () => 0.999)).toBe(6_499);
    expect(jittered(7_000, () => 0.999)).toBe(9_098);
    expect(jittered(1_000, () => 1 / 3)).toBe(1_100);
  });
  it("starts the failure waits at 5 s and doubles to 60 s, then stays", () => {
    const waits = [0, 1, 2, 3, 4, 5, 6, 40].map((attempt) => failureWait(attempt, () => 0));
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000]);
  });
  it("jitters the failure waits by 0 to 30 percent", () => {
    expect(failureWait(0, () => 0)).toBe(5_000);
    expect(failureWait(0, () => 0.999)).toBe(6_499);
    expect(failureWait(4, () => 0.999)).toBe(77_982);
  });
  it("treats a negative attempt as the first", () => {
    expect(failureWait(-3, () => 0)).toBe(5_000);
  });
  it("waits the Retry-After for a busy answer, 60 s without one, between 1 and 120 s, plus jitter", () => {
    expect(busyWait(7, () => 0)).toBe(7_000);
    expect(busyWait(7, () => 0.999)).toBe(9_098);
    expect(busyWait(null, () => 0)).toBe(60_000);
    expect(busyWait(0, () => 0)).toBe(1_000);
    expect(busyWait(1, () => 0)).toBe(1_000);
    expect(busyWait(120, () => 0)).toBe(120_000);
    expect(busyWait(121, () => 0)).toBe(120_000);
    expect(busyWait(100_000, () => 0.5)).toBe(138_000);
  });
});

describe("clockOffset", () => {
  it("takes the first reading: server date minus the local time of receipt", () => {
    expect(clockOffset(10_000, 4_000, null)).toBe(6_000);
    expect(clockOffset(-5_000, 1_000, null)).toBe(-6_000);
  });
  it("keeps the previous offset when the header was not readable", () => {
    expect(clockOffset(null, 4_000, 5_500)).toBe(5_500);
    expect(clockOffset(null, 4_000, null)).toBe(0);
  });
  it("ignores a change of 2 s or less (the header has one-second resolution), takes one of more than 2 s", () => {
    expect(clockOffset(10_000, 4_000, 6_000)).toBe(6_000);
    expect(clockOffset(10_000, 4_000, 5_000)).toBe(5_000); // new 6000, previous 5000: 1000 apart
    expect(clockOffset(10_000, 4_000, 4_000)).toBe(4_000); // exactly 2000 apart: kept
    expect(clockOffset(10_000, 4_000, 8_000)).toBe(8_000);
    expect(clockOffset(10_000, 4_000, 3_999)).toBe(6_000); // 2001 apart: taken
    expect(clockOffset(10_000, 4_000, 8_001)).toBe(6_000);
    expect(clockOffset(10_000, 4_000, -50_000)).toBe(6_000); // a dead clock battery corrected
  });
});

describe("formatClock", () => {
  const instant = Date.UTC(2026, 9, 20, 14, 2, 59);
  it("formats a 24-hour HH:MM in the zone", () => {
    expect(formatClock(instant, "UTC")).toBe("14:02");
    expect(formatClock(instant, "Asia/Tokyo")).toBe("23:02");
    expect(formatClock(instant, "America/New_York")).toBe("10:02");
  });
  it("shows midnight as 00:xx and late evening as 23:xx, never 24:xx or AM/PM", () => {
    expect(formatClock(Date.UTC(2026, 9, 20, 0, 5), "UTC")).toBe("00:05");
    expect(formatClock(Date.UTC(2026, 9, 20, 23, 59), "UTC")).toBe("23:59");
    expect(formatClock(Date.UTC(2026, 9, 20, 12, 0), "UTC")).toBe("12:00");
  });
  it("is null for a zone the browser does not know, an empty zone, or a moment that is not a time; it never throws", () => {
    expect(formatClock(instant, "Not/AZone")).toBeNull();
    expect(formatClock(instant, "")).toBeNull();
    expect(formatClock(Number.NaN, "UTC")).toBeNull();
    expect(() => formatClock(instant, "💥")).not.toThrow();
  });
});

describe("buildChanged", () => {
  it("is true for two different builds", () => {
    expect(buildChanged("abc123", "def456")).toBe(true);
    expect(buildChanged("dev", "abc123")).toBe(true);
  });
  it("is false for the same build, and never dev to dev", () => {
    expect(buildChanged("abc123", "abc123")).toBe(false);
    expect(buildChanged("dev", "dev")).toBe(false);
  });
  it("is false when either is not known (an older server sends none)", () => {
    expect(buildChanged(null, "abc123")).toBe(false);
    expect(buildChanged("abc123", null)).toBe(false);
    expect(buildChanged(null, null)).toBe(false);
  });
});

describe("reloadAllowed", () => {
  it("allows the first reload", () => {
    expect(reloadAllowed(null, 5_000)).toBe(true);
  });
  it("allows one per 10 s: not at 9.999 s, yes at 10 s and 10.001 s", () => {
    expect(reloadAllowed(100_000, 100_000)).toBe(false);
    expect(reloadAllowed(100_000, 109_999)).toBe(false);
    expect(reloadAllowed(100_000, 110_000)).toBe(true);
    expect(reloadAllowed(100_000, 110_001)).toBe(true);
  });
  it("counts a last reload in the future as recent", () => {
    expect(reloadAllowed(200_000, 100_000)).toBe(false);
    expect(reloadAllowed(100_001, 100_000)).toBe(false);
  });
});

describe("revokedWait", () => {
  it("asks again after 5, 15 and 60 minutes, then stops", () => {
    expect(revokedWait(0)).toBe(300_000);
    expect(revokedWait(1)).toBe(900_000);
    expect(revokedWait(2)).toBe(3_600_000);
    expect(revokedWait(3)).toBeNull();
    expect(revokedWait(50)).toBeNull();
  });
  it("is null for an attempt that is not a step", () => {
    expect(revokedWait(-1)).toBeNull();
    expect(revokedWait(1.5)).toBeNull();
  });
});

describe("readingsStoppedAt", () => {
  it("is null when the age is not known or under the 60 s floor", () => {
    expect(readingsStoppedAt(null, 1_000_000)).toBeNull();
    expect(readingsStoppedAt(0, 1_000_000)).toBeNull();
    expect(readingsStoppedAt(59.999, 1_000_000)).toBeNull();
    expect(readingsStoppedAt(Number.NaN, 1_000_000)).toBeNull();
  });
  it("is the server's now minus the age from 60 s up", () => {
    expect(readingsStoppedAt(60, 1_000_000)).toBe(940_000);
    expect(readingsStoppedAt(703.2, 1_000_000)).toBe(296_800);
  });
});

describe("bandFor", () => {
  const T = Date.UTC(2026, 9, 20, 14, 2, 0);
  const status = (over: Partial<DisplayStatus> = {}): DisplayStatus => ({ collectorAlive: true, readingsFresh: true, lastReadingAgeSeconds: 5, ...over });
  const quiet = { now: T, bandClock: T, wakeHoldUntil: 0, status: status(), collectorDownMs: null, readingsStoppedAt: null, timeZone: "UTC" };

  it("shows nothing when all is well, and when the status is unknown or nothing was ever read", () => {
    expect(bandFor(quiet)).toBeNull();
    expect(bandFor({ ...quiet, status: null })).toBeNull();
    expect(bandFor({ ...quiet, status: status({ readingsFresh: null, lastReadingAgeSeconds: null }) })).toBeNull();
  });

  describe("the screen band (R9.2)", () => {
    const stale = (ms: number) => ({ ...quiet, now: T + ms });
    it("opens at 120 s since the band clock: not at 119.999 s, yes at 120 s and 120.001 s", () => {
      expect(bandFor(stale(SCREEN_BAND_MS - 1))).toBeNull();
      expect(bandFor(stale(SCREEN_BAND_MS))).toEqual({ kind: "screen", text: "This screen has not been updated since 14:02. Trying again..." });
      expect(bandFor(stale(SCREEN_BAND_MS + 1))?.kind).toBe("screen");
    });
    it("says the time of the band clock in the site's zone", () => {
      expect(bandFor({ ...stale(SCREEN_BAND_MS), timeZone: "Asia/Tokyo" })?.text).toBe("This screen has not been updated since 23:02. Trying again...");
    });
    it("leaves out ' since <time>' when the zone is not known", () => {
      expect(bandFor({ ...stale(SCREEN_BAND_MS), timeZone: "Not/AZone" })?.text).toBe("This screen has not been updated. Trying again...");
      expect(bandFor({ ...stale(SCREEN_BAND_MS), timeZone: "" })?.text).toBe("This screen has not been updated. Trying again...");
    });
    it("is held back until the wake hold ends: not before it, yes at it and after", () => {
      const held = { ...stale(SCREEN_BAND_MS + 5_000), wakeHoldUntil: T + SCREEN_BAND_MS + 10_000 };
      expect(bandFor(held)).toBeNull();
      expect(bandFor({ ...held, now: held.wakeHoldUntil - 1 })).toBeNull();
      expect(bandFor({ ...held, now: held.wakeHoldUntil })?.kind).toBe("screen");
      expect(bandFor({ ...held, now: held.wakeHoldUntil + 1 })?.kind).toBe("screen");
    });
  });

  describe("the collector band (R9.1, M5)", () => {
    it("opens when the collector has been down for 50 s: not at 49.999 s, yes at 50 s and 50.001 s", () => {
      expect(bandFor({ ...quiet, collectorDownMs: COLLECTOR_DOWN_MS - 1 })).toBeNull();
      expect(bandFor({ ...quiet, collectorDownMs: COLLECTOR_DOWN_MS })).toEqual({ kind: "collector", text: "The data collector stopped." });
      expect(bandFor({ ...quiet, collectorDownMs: COLLECTOR_DOWN_MS + 1 })?.kind).toBe("collector");
    });
    it("is not a band when the collector is not known to be down (null)", () => {
      expect(bandFor({ ...quiet, collectorDownMs: null })).toBeNull();
    });
  });

  describe("the readings band (R9.1, A10)", () => {
    const stopped = { ...quiet, status: status({ readingsFresh: false, lastReadingAgeSeconds: 703 }) };
    it("says the time the readings stopped when it is known", () => {
      expect(bandFor({ ...stopped, readingsStoppedAt: Date.UTC(2026, 9, 20, 13, 52) })).toEqual({ kind: "readings", text: "Readings stopped arriving at 13:52." });
      expect(bandFor({ ...stopped, readingsStoppedAt: Date.UTC(2026, 9, 20, 13, 52), timeZone: "Asia/Tokyo" })?.text).toBe("Readings stopped arriving at 22:52.");
    });
    it("is timeless when the time is not known or cannot be formatted", () => {
      expect(bandFor({ ...stopped, readingsStoppedAt: null })).toEqual({ kind: "readings", text: "Readings stopped arriving." });
      expect(bandFor({ ...stopped, readingsStoppedAt: Date.UTC(2026, 9, 20, 13, 52), timeZone: "Not/AZone" })?.text).toBe("Readings stopped arriving.");
    });
    it("is only for readings_fresh false: fresh, nothing-read-yet (null) and unknown status show nothing (one stale meter is not a band)", () => {
      expect(bandFor({ ...quiet, status: status({ readingsFresh: true, lastReadingAgeSeconds: 9_999 }) })).toBeNull();
      expect(bandFor({ ...quiet, status: status({ readingsFresh: null }) })).toBeNull();
      expect(bandFor({ ...quiet, status: null, readingsStoppedAt: T })).toBeNull();
    });
  });

  describe("priority: screen over collector over readings (P5)", () => {
    const everything = {
      ...quiet, now: T + SCREEN_BAND_MS, collectorDownMs: COLLECTOR_DOWN_MS, status: status({ readingsFresh: false }), readingsStoppedAt: T - 60_000,
    };
    it("shows the screen band when all three hold", () => {
      expect(bandFor(everything)?.kind).toBe("screen");
    });
    it("shows the collector band over the readings band once the screen band is held back or closed", () => {
      expect(bandFor({ ...everything, wakeHoldUntil: everything.now + 1 })?.kind).toBe("collector");
      expect(bandFor({ ...everything, bandClock: everything.now })?.kind).toBe("collector");
    });
    it("shows the readings band when only that holds", () => {
      expect(bandFor({ ...everything, bandClock: everything.now, collectorDownMs: 49_999 })?.kind).toBe("readings");
    });
  });
});
