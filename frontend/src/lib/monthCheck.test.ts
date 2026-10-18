import type {
  EstimatedItem, FlatItem, GapsItem, LaterItem, MonthCheck, MonthCheckGroup, MonthCheckHead, ResetsItem, SilentItem, StartedItem, UnmeteredItem, UnpricedItem,
} from "../api/types";
import {
  GROUP_ORDER, LATER_TITLE, LOADING_LABEL, NOT_COUNTED_TITLE, SHOW_FEWER, UNMETERED_TITLE, checkLineText, countSlotText, describedByText, groupIntro, groupTitle,
  headline, headlineReason, itemLines, laterIntro, laterLine, lookedAtLine, moreLine, showAllText, stateNote, unmeteredIntro, unmeteredLines,
  type CheckGroupKey, type MonthCheckStatus,
} from "./monthCheck";

// Every case names its zone: Asia/Qatar is UTC+3 all year, so 06:00Z reads 09:00 and the result never depends on the machine running the tests.
const ZONE = "Asia/Qatar";
const LIMITS = { flat_hours: 24, short_minutes: 60, short_share: 0.01, max_tolerated_hours: 24, cap: 50 };
const none = <T,>(): MonthCheckGroup<T> => ({ total: 0, items: [] });

function check(over: Partial<MonthCheck> = {}): MonthCheck {
  return {
    month: "2026-09", timezone: ZONE, state: "finished", closed: false,
    from: "2026-08-31T21:00:00Z", to: "2026-09-30T21:00:00Z", month_end: "2026-09-30T21:00:00Z",
    hours: 720, meters: 217, meter_hours: 156240, things: 0, limits: LIMITS,
    groups: {
      silent: none(), gaps: none(), estimated: none(), resets: none(), started: none(), unpriced: none(), flat: none(), unmetered: none(), later: none(),
    },
    ...over,
  };
}

const head = (kind: "counter" | "power", over: Partial<MonthCheckHead> = {}): MonthCheckHead => ({
  asset_id: 7, path: "Hall / Rack 4 / Feed A", kind, point: "kWh total", source: "Hall PLC", interval_seconds: 900, ...over,
});

describe("headline and its reason (D6: the order is the whole point)", () => {
  it.each([
    [12, "12 things to check"],
    [1, "1 thing to check"],
    [1200, "1,200 things to check"],
  ])("%i things read %s", (things, expected) => {
    expect(headline(check({ things }))).toBe(expected);
    expect(headlineReason(check({ things }))).toBeNull();
  });

  it("is Nothing to check only when meters were looked at and nothing was found", () => {
    expect(headline(check())).toBe("Nothing to check");
    expect(headlineReason(check())).toBeNull();
  });

  it("is Nothing to look at yet for a month that has not begun", () => {
    const c = check({ state: "not_begun", hours: 0, meters: 0, meter_hours: 0, to: "2026-08-31T21:00:00Z" });
    expect(headline(c)).toBe("Nothing to look at yet");
    expect(headlineReason(c)).toBe("This month has not begun.");
  });

  it("is Nothing to look at yet while the first hour of the month is still running", () => {
    const c = check({ state: "open", hours: 0, meters: 0, meter_hours: 0 });
    expect(headline(c)).toBe("Nothing to look at yet");
    expect(headlineReason(c)).toBe("The first hour of this month is not over yet.");
  });

  it("is Nothing to look at yet when the only meters of the site started after what was looked at: no meter has recorded anything in the month", () => {
    const laterItem: LaterItem = { asset_id: 1, path: "A / B", kind: "counter", first_reading: "2026-10-01T05:00:00Z" };
    const c = check({ meters: 0, meter_hours: 0, groups: { ...check().groups, later: { total: 1, items: [laterItem] } } });
    expect(headline(c)).toBe("Nothing to look at yet");
    expect(headlineReason(c)).toBe("No meter has recorded anything in this month.");
  });

  it("is Nothing to look at yet, with its own reason, for a site that has no meter at all (nothing to wait for; review M4)", () => {
    const c = check({ meters: 0, meter_hours: 0 });
    expect(headline(c)).toBe("Nothing to look at yet");
    expect(headlineReason(c)).toBe("No asset has an energy (kWh) counter or a power (kW) reading mapped.");
    expect(headlineReason(check({ state: "open", meters: 0, meter_hours: 0 }))).toBe("No asset has an energy (kWh) counter or a power (kW) reading mapped.");
  });

  it("keeps the other reasons first: a month that has not begun or whose first hour is not over says so even with no meter", () => {
    expect(headlineReason(check({ state: "not_begun", hours: 0, meters: 0, meter_hours: 0 }))).toBe("This month has not begun.");
    expect(headlineReason(check({ state: "open", hours: 0, meters: 0, meter_hours: 0 }))).toBe("The first hour of this month is not over yet.");
  });

  it("puts things first: every meter silent for ever is a list to read, never an empty answer", () => {
    const silent = { total: 3, items: [0, 1, 2].map((i): SilentItem => ({ ...head("counter", { asset_id: i }), reason: "never", since: null, hours: 720, last_reading: null, children: 0 })) };
    const c = check({ meters: 3, meter_hours: 2160, things: 3, groups: { ...check().groups, silent } });
    expect(headline(c)).toBe("3 things to check");
    expect(headlineReason(c)).toBeNull();
  });

  it("puts things before the look-at-yet cases, even if the server sent a odd combination", () => {
    expect(headline(check({ things: 2, state: "not_begun", hours: 0 }))).toBe("2 things to check");
    expect(headline(check({ things: 2, hours: 0 }))).toBe("2 things to check");
    expect(headline(check({ things: 2, meters: 0 }))).toBe("2 things to check");
  });
});

describe("lookedAtLine", () => {
  it("says what was read, in the site zone, and never promises anything", () => {
    // 217 meters x 720 hours = 156,240 meter hours: the number counts EXPECTED hours, so it is never called readings (review C1)
    expect(lookedAtLine(check(), ZONE)).toBe(
      "Looked at 217 meters over 720 hours (156,240 meter hours in all), from 2026-09-01 00:00 to 2026-10-01 00:00. Only the hourly readings that billing uses were read, so this check cannot see every kind of fault.",
    );
  });

  it("ends an open month at the last full hour", () => {
    const c = check({ state: "open", to: "2026-09-12T11:00:00Z", hours: 275, meters: 4, meter_hours: 1100 });
    expect(lookedAtLine(c, ZONE)).toBe(
      "Looked at 4 meters over 275 hours (1,100 meter hours in all), from 2026-09-01 00:00 to 2026-09-12 14:00, the last full hour. Only the hourly readings that billing uses were read, so this check cannot see every kind of fault.",
    );
  });

  it("uses the singular, and leaves out the total when it only repeats the hours", () => {
    const c = check({ hours: 1, meters: 1, meter_hours: 1, from: "2026-08-31T21:00:00Z", to: "2026-08-31T22:00:00Z" });
    expect(lookedAtLine(c, ZONE)).toBe(
      "Looked at 1 meter over 1 hour, from 2026-09-01 00:00 to 2026-09-01 01:00. Only the hourly readings that billing uses were read, so this check cannot see every kind of fault.",
    );
  });

  it("keeps the total for one meter that started late", () => {
    expect(lookedAtLine(check({ meters: 1, meter_hours: 500 }), ZONE)).toContain("Looked at 1 meter over 720 hours (500 meter hours in all), from");
  });

  it("never calls the total readings: it counts the hours expected of each meter, with or without a reading", () => {
    expect(lookedAtLine(check(), ZONE)).not.toMatch(/of readings/);
    expect(lookedAtLine(check({ meters: 1, meter_hours: 1, hours: 720 }), ZONE)).toContain("(1 meter hour in all)");
  });

  it("says nothing was read when no hour is over yet", () => {
    expect(lookedAtLine(check({ state: "not_begun", hours: 0, meters: 0, meter_hours: 0 }), ZONE)).toBe("Nothing was read.");
    expect(lookedAtLine(check({ state: "open", hours: 0, meters: 0, meter_hours: 0 }), ZONE)).toBe("Nothing was read.");
  });
});

describe("stateNote", () => {
  it("explains a closed month: the bill is frozen, the check is not", () => {
    expect(stateNote(check({ closed: true }))).toBe(
      "This month is closed: its billed figures are frozen. This check describes the readings as they are stored today.",
    );
  });
  it("explains an open month", () => {
    expect(stateNote(check({ state: "open" }))).toBe("This month is still running: the check stops at the last full hour.");
  });
  it("has nothing to add for a finished month that is not closed, or one that has not begun", () => {
    expect(stateNote(check())).toBeNull();
    expect(stateNote(check({ state: "not_begun" }))).toBeNull();
  });
});

describe("group titles and introductions", () => {
  it("lists the seven groups in the order of how much they can change a bill", () => {
    expect([...GROUP_ORDER]).toEqual(["silent", "gaps", "estimated", "resets", "started", "unpriced", "flat"]);
  });

  it.each<[CheckGroupKey, string]>([
    ["silent", "Meters with no readings"],
    ["gaps", "Gaps in the readings"],
    ["estimated", "Estimated from power"],
    ["resets", "Counter went back or dipped"],
    ["started", "Started part way through the month"],
    ["unpriced", "Energy with no rate"],
    ["flat", "Readings that did not change"],
  ])("%s is titled %s", (key, title) => {
    expect(groupTitle(key)).toBe(title);
  });

  it("states the estimate rule as one sentence, exactly", () => {
    expect(groupIntro("estimated", check())).toBe(
      "An hour is marked estimated when the asset has no energy (kWh) counter, so its energy is worked out from average power (kW) readings; anything that adds up estimated hours is marked estimated too.",
    );
  });

  it("states the thresholds of gaps and flat from the limits the server used", () => {
    // The rule of the server's tolerated_hours: a counter read every 3600 s or slower may miss ceil(interval / 3600) hours, at most the limit; a faster one none (review I2)
    expect(groupIntro("gaps", check())).toBe(
      "Hours in a row with no reading at all. A counter read once an hour or less often may miss as many hours in a row as its reading interval is long, rounded up (a counter read every 2 hours: 2 hours), at most 24 hours, and that is allowed for. A counter read more often than once an hour has no such allowance. A power meter also lists the time missing inside hours that have readings, from 60 minutes and one part in 100 of the time looked at.",
    );
    expect(groupIntro("flat", check())).toBe("Readings that stay exactly the same for 24 hours or more. That can mean a meter that stopped updating.");
    const other = check({ limits: { ...LIMITS, flat_hours: 48, max_tolerated_hours: 12, short_minutes: 30, short_share: 0.02 } });
    expect(groupIntro("flat", other)).toContain("48 hours");
    const gaps = groupIntro("gaps", other);
    expect(gaps).toContain("12 hours");
    expect(gaps).toContain("30 minutes");
    expect(gaps).toContain("one part in 50");
  });

  it("has a plain introduction for the other groups", () => {
    expect(groupIntro("silent", check())).toBe("Meters that recorded nothing in this month, or that stopped recording before the end of what was looked at.");
    expect(groupIntro("resets", check())).toBe("A counter should only count up. These went back down, or dipped below an earlier reading, at least once.");
    expect(groupIntro("started", check())).toBe(
      "These meters gave their first reading after the month began. Before that, the asset counts what the assets under it add up to.",
    );
    expect(groupIntro("unpriced", check())).toBe("Energy that no rate covers. It is in the kWh figures but not in the cost. Add a rate on the Tariffs page to price it.");
  });
});

describe("itemLines: who reads what", () => {
  it("names the point and its source", () => {
    const item: EstimatedItem = { ...head("power"), hours_estimated: 700, hours_total: 720, negative_hours: 0, negative_kwh: 0 };
    expect(itemLines("estimated", item, ZONE).reads).toBe("Reads kWh total (Hall PLC)");
  });
  it("names the point alone when the source is hidden, and nothing when the point is hidden", () => {
    const base = { hours_estimated: 1, hours_total: 1, negative_hours: 0, negative_kwh: 0 };
    expect(itemLines("estimated", { ...head("power", { source: null }), ...base }, ZONE).reads).toBe("Reads kWh total");
    expect(itemLines("estimated", { ...head("power", { point: null, source: null }), ...base }, ZONE).reads).toBeNull();
  });
});

describe("itemLines: silent (counter: moves later; power: counts as zero)", () => {
  const silent = (kind: "counter" | "power", over: Partial<SilentItem>): SilentItem => ({
    ...head(kind), reason: "never", since: null, hours: 720, last_reading: null, children: 0, ...over,
  });

  it("never recorded anything", () => {
    expect(itemLines("silent", silent("counter", {}), ZONE).lines).toEqual(["No reading has ever been recorded.", "It counts as 0 kWh."]);
    expect(itemLines("silent", silent("power", {}), ZONE).lines).toEqual(["No reading has ever been recorded.", "Its energy counts as an estimated 0 kWh."]);
  });

  it("nothing in the month, with and without an earlier reading", () => {
    const withLast = silent("counter", { reason: "none_in_month", last_reading: "2026-08-31T20:00:00Z" });
    // a counter that recorded before the month bills its energy into the first reading that comes back: the trailing item's second sentence (review M1)
    expect(itemLines("silent", withLast, ZONE).lines).toEqual([
      "No readings in this month (the last one before it was 2026-08-31 23:00).",
      "It counts as 0 kWh.",
      "The energy it measures in that time is not lost: it is counted when readings come back, in a later month if they come back after this one ends.",
    ]);
    const without = silent("power", { reason: "none_in_month" });
    expect(itemLines("silent", without, ZONE).lines).toEqual(["No readings in this month.", "Its energy counts as an estimated 0 kWh."]);
    // a counter with nothing before the month has nothing to move, and a power meter's time is simply 0
    expect(itemLines("silent", silent("counter", { reason: "none_in_month" }), ZONE).lines).toEqual(["No readings in this month.", "It counts as 0 kWh."]);
    expect(itemLines("silent", silent("power", { reason: "none_in_month", last_reading: "2026-08-31T20:00:00Z" }), ZONE).lines).toHaveLength(2);
  });

  it("stopped before the end: a counter's energy is not lost, a power meter's is", () => {
    const counter = silent("counter", { reason: "trailing", since: "2026-09-28T21:00:00Z", hours: 24, last_reading: "2026-09-28T20:00:00Z" });
    expect(itemLines("silent", counter, ZONE).lines).toEqual([
      "No readings since 2026-09-29 00:00 (24 hours at the end of what was looked at).",
      "The energy it measures in that time is not lost: it is counted when readings come back, in a later month if they come back after this one ends.",
    ]);
    const power = silent("power", { reason: "trailing", since: "2026-09-30T20:00:00Z", hours: 1 });
    expect(itemLines("silent", power, ZONE).lines).toEqual([
      "No readings since 2026-09-30 23:00 (1 hour at the end of what was looked at).",
      "That time counts as 0 kWh.",
    ]);
  });

  it("copes with a trailing item that carries no start", () => {
    const item = silent("counter", { reason: "trailing", since: null, hours: 5 });
    expect(itemLines("silent", item, ZONE).lines[0]).toBe("No readings at the end of what was looked at (5 hours).");
  });

  it("a parent with assets under it says their energy is not in its figure (whatever those assets read), for every reason and both kinds", () => {
    const CHILDREN = "It has 3 assets under it; while its own meter has no readings their energy is not counted in its figure.";
    for (const kind of ["counter", "power"] as const) {
      expect(itemLines("silent", silent(kind, { children: 3 }), ZONE).lines.at(-1)).toBe(CHILDREN);
      expect(itemLines("silent", silent(kind, { children: 3, reason: "none_in_month" }), ZONE).lines.at(-1)).toBe(CHILDREN);
      expect(itemLines("silent", silent(kind, { children: 3, reason: "trailing", since: "2026-09-28T21:00:00Z", hours: 24 }), ZONE).lines.at(-1)).toBe(CHILDREN);
    }
    expect(itemLines("silent", silent("counter", { children: 3 }), ZONE).lines).toHaveLength(3);
  });

  it("one asset under it reads in the singular, none says nothing about assets", () => {
    expect(itemLines("silent", silent("counter", { children: 1 }), ZONE).lines.at(-1)).toBe(
      "It has 1 asset under it; while its own meter has no readings their energy is not counted in its figure.",
    );
    expect(itemLines("silent", silent("counter", { children: 0 }), ZONE).lines).toHaveLength(2);
    expect(itemLines("silent", silent("counter", { children: 0 }), ZONE).lines.join(" ")).not.toContain("under it");
  });
});

describe("itemLines: gaps", () => {
  const gaps = (kind: "counter" | "power", over: Partial<GapsItem>): GapsItem => ({
    ...head(kind), runs: 2, hours: 9, longest_hours: 6, longest_start: "2026-09-20T06:00:00Z", first_start: "2026-09-05T03:00:00Z", last_end: "2026-09-21T10:00:00Z",
    leading_hours: 0, hours_before_month: 0, previous_reading: null, short_hours: 0, short_minutes: 0, ...over,
  });
  const COUNTER_NOTE = "The energy in a gap is not lost: it is counted in the hour the readings come back, so the days around a gap can be off.";
  const POWER_NOTE = "Time without a reading counts as 0 kWh, so this meter reads low by whatever it used in that time.";

  it("counter: several gaps, and the energy comes back later", () => {
    expect(itemLines("gaps", gaps("counter", {}), ZONE).lines).toEqual([
      "2 gaps: 9 hours without any reading in all. The longest is 6 hours from 2026-09-20 09:00. The first starts 2026-09-05 06:00, the last ends 2026-09-21 13:00.",
      COUNTER_NOTE,
    ]);
  });

  it("one gap reads as one gap", () => {
    const one = gaps("counter", { runs: 1, hours: 6, first_start: "2026-09-20T06:00:00Z", last_end: "2026-09-20T12:00:00Z" });
    expect(itemLines("gaps", one, ZONE).lines[0]).toBe("1 gap: 6 hours without any reading. It starts 2026-09-20 09:00 and ends 2026-09-20 15:00.");
  });

  it("power: the time counts as zero", () => {
    expect(itemLines("gaps", gaps("power", {}), ZONE).lines).toEqual([
      "2 gaps: 9 hours without any reading in all. The longest is 6 hours from 2026-09-20 09:00. The first starts 2026-09-05 06:00, the last ends 2026-09-21 13:00.",
      POWER_NOTE,
    ]);
  });

  it("counter: a gap that starts the month is measured from the reading before it", () => {
    const item = gaps("counter", { leading_hours: 5, previous_reading: "2026-08-31T15:00:00Z" });
    expect(itemLines("gaps", item, ZONE).lines).toEqual([
      expect.stringContaining("2 gaps"),
      COUNTER_NOTE,
      "The gap starts the month: the first reading after it counts everything since 2026-08-31 18:00, including energy used before this month began.",
    ]);
  });

  it("no leading sentence without a reading to measure from, or without a hole before the first reading", () => {
    expect(itemLines("gaps", gaps("counter", { leading_hours: 5, previous_reading: null }), ZONE).lines).toHaveLength(2);
    expect(itemLines("gaps", gaps("counter", { leading_hours: 0, hours_before_month: 0, previous_reading: "2026-08-31T15:00:00Z" }), ZONE).lines).toHaveLength(2);
  });

  describe("a counter listed for the hole before the month (the first reading of the month counts everything since the last one before it)", () => {
    const NO_RUNS: Partial<GapsItem> = { runs: 0, hours: 0, longest_hours: null, longest_start: null, first_start: null, last_end: null };
    const HOLE = (since: string, before: string) =>
      `The first reading of the month counts everything since ${since}${before} (the energy of that time is in this month, though some of it was used before it).`;

    it("with no gap at all: only that sentence, and never `0 gaps`", () => {
      const item = gaps("counter", { ...NO_RUNS, hours_before_month: 300, previous_reading: "2026-08-19T09:00:00Z" });
      expect(itemLines("gaps", item, ZONE).lines).toEqual([HOLE("2026-08-19 12:00", ", 300 hours before the month began")]);
    });

    it("says `1 hour` in the singular", () => {
      const item = gaps("counter", { ...NO_RUNS, hours_before_month: 1, previous_reading: "2026-08-31T18:00:00Z" });
      expect(itemLines("gaps", item, ZONE).lines).toEqual([HOLE("2026-08-31 21:00", ", 1 hour before the month began")]);
    });

    it("after the sentences of a gap inside the month", () => {
      const item = gaps("counter", { hours_before_month: 12, previous_reading: "2026-08-31T08:00:00Z" });
      expect(itemLines("gaps", item, ZONE).lines).toEqual([
        expect.stringContaining("2 gaps"),
        COUNTER_NOTE,
        HOLE("2026-08-31 11:00", ", 12 hours before the month began"),
      ]);
    });

    it("a gap that starts the month and a hole before it: the new sentence, not the old one", () => {
      const item = gaps("counter", { leading_hours: 5, hours_before_month: 10, previous_reading: "2026-08-31T05:00:00Z" });
      const lines = itemLines("gaps", item, ZONE).lines;
      expect(lines.at(-1)).toBe(HOLE("2026-08-31 08:00", ", 10 hours before the month began"));
      expect(lines.join(" ")).not.toContain("The gap starts the month");
    });

    it("a gap that starts the month with nothing before it keeps the sentence it always had, and no hours before the month", () => {
      const item = gaps("counter", { leading_hours: 5, hours_before_month: 0, previous_reading: "2026-08-31T15:00:00Z" });
      expect(itemLines("gaps", item, ZONE).lines.at(-1)).toBe(
        "The gap starts the month: the first reading after it counts everything since 2026-08-31 18:00, including energy used before this month began.",
      );
    });

    it("is never said for a power meter, which has nothing to measure from", () => {
      const item = gaps("power", { ...NO_RUNS, short_hours: 2, short_minutes: 90, hours_before_month: 0, previous_reading: null });
      expect(itemLines("gaps", item, ZONE).lines.join(" ")).not.toContain("first reading of the month");
    });

    it("says nothing about the hole without the reading it is measured from", () => {
      const item = gaps("counter", { hours_before_month: 12, previous_reading: null });
      expect(itemLines("gaps", item, ZONE).lines).toHaveLength(2);
    });
  });

  it("an item with no gap is not described as `0 gaps`, whatever it is listed for", () => {
    const short = gaps("power", { runs: 0, hours: 0, longest_hours: null, longest_start: null, first_start: null, last_end: null, short_hours: 2, short_minutes: 90 });
    expect(itemLines("gaps", short, ZONE).lines.join(" ")).not.toMatch(/\b0 gaps\b|\bgaps?:/);
  });

  it("power: time missing inside hours that have readings, after the gaps", () => {
    const item = gaps("power", { short_hours: 6, short_minutes: 144 });
    expect(itemLines("gaps", item, ZONE).lines.at(-1)).toBe(
      "Another 6 hours had readings for only part of the hour (2 hours 24 minutes missing in all); the missing part counts as 0 kWh.",
    );
  });

  it("power: listed only for the time missing inside hours, no gap at all", () => {
    const item = gaps("power", { runs: 0, hours: 0, longest_hours: null, longest_start: null, first_start: null, last_end: null, short_hours: 1, short_minutes: 61 });
    expect(itemLines("gaps", item, ZONE).lines).toEqual([
      "1 hour had readings for only part of the hour (1 hour 1 minute missing in all); the missing part counts as 0 kWh.",
    ]);
  });

  it.each([[59, "59 minutes"], [60, "1 hour"], [1, "1 minute"], [120, "2 hours"], [125, "2 hours 5 minutes"]])("%i missing minutes read %s", (minutes, text) => {
    const item = gaps("power", { runs: 0, longest_hours: null, longest_start: null, first_start: null, last_end: null, short_hours: 3, short_minutes: minutes });
    expect(itemLines("gaps", item, ZONE).lines[0]).toContain(`(${text} missing in all)`);
  });

  it("skips the parts a gap item does not carry", () => {
    const item = gaps("counter", { longest_hours: null, longest_start: null, first_start: null, last_end: null });
    expect(itemLines("gaps", item, ZONE).lines[0]).toBe("2 gaps: 9 hours without any reading in all.");
  });
});

describe("itemLines: estimated and started", () => {
  it("says how many hours were worked out from power", () => {
    const item: EstimatedItem = { ...head("power"), hours_estimated: 700, hours_total: 720, negative_hours: 0, negative_kwh: 0 };
    expect(itemLines("estimated", item, ZONE).lines).toEqual(["Its energy is worked out from power readings in 700 of its 720 hours."]);
    expect(itemLines("estimated", { ...item, hours_estimated: 1, hours_total: 1 }, ZONE).lines).toEqual(["Its energy is worked out from power readings in 1 of its 1 hour."]);
  });

  it("negative power readings: how many hours, how much energy, and what it does to the figures", () => {
    const item: EstimatedItem = { ...head("power"), hours_estimated: 720, hours_total: 720, negative_hours: 12, negative_kwh: -3600.04 };
    expect(itemLines("estimated", item, ZONE).lines).toEqual([
      "Its energy is worked out from power readings in 720 of its 720 hours.",
      "12 hours had a negative power reading (-3,600 kWh in all). That lowers its figure and the figures above it; a meter fitted the wrong way round does this.",
    ]);
    expect(itemLines("estimated", { ...item, negative_hours: 1, negative_kwh: -2.56 }, ZONE).lines[1]).toBe(
      "1 hour had a negative power reading (-2.6 kWh in all). That lowers its figure and the figures above it; a meter fitted the wrong way round does this.",
    );
  });

  it("no sentence about negative readings when there were none, and never `-0`", () => {
    const item: EstimatedItem = { ...head("power"), hours_estimated: 5, hours_total: 5, negative_hours: 0, negative_kwh: 0 };
    expect(itemLines("estimated", item, ZONE).lines).toHaveLength(1);
    const tiny = itemLines("estimated", { ...item, negative_hours: 1, negative_kwh: -0.01 }, ZONE).lines[1];
    expect(tiny).toContain("(0 kWh in all)");
    expect(tiny).not.toContain("-0");
  });

  it("started: what the asset counts before its first reading", () => {
    const item: StartedItem = { ...head("counter"), first_reading: "2026-09-12T06:00:00Z", children: 3 };
    expect(itemLines("started", item, ZONE).lines).toEqual(["First reading 2026-09-12 09:00. Before that this asset counts what the assets under it add up to."]);
    expect(itemLines("started", { ...item, children: 0 }, ZONE).lines).toEqual([
      "First reading 2026-09-12 09:00. Before that this asset counts what the assets under it add up to (nothing, it has none).",
    ]);
  });
});

describe("itemLines: resets (a reset is approximate, a dip and a fall are ignored)", () => {
  const resets = (over: Partial<ResetsItem>): ResetsItem => ({ ...head("counter"), resets: 0, dips: 0, falls: 0, events: [], ...over });
  const RESET_TAIL = "a reset or a rollover. The energy of that hour is approximate: what was counted just before and just after it is kept, what happened in between is not.";

  it("one reset, with how far the reading fell", () => {
    const item = resets({ resets: 1, events: [{ at: "2026-09-10T06:00:00Z", kind: "reset", size: 65535 }] });
    expect(itemLines("resets", item, ZONE).lines).toEqual([`The counter went back down 1 time (2026-09-10 09:00, by 65,535): ${RESET_TAIL}`]);
  });

  it("two resets, a dip and a fall: one sentence each, only the kinds that happened, each event with its size", () => {
    const item = resets({
      resets: 2, dips: 1, falls: 2,
      events: [
        { at: "2026-09-10T06:00:00Z", kind: "reset", size: 1200.5 }, { at: "2026-09-11T06:00:00Z", kind: "dip", size: 12 }, { at: "2026-09-12T06:00:00Z", kind: "reset", size: 65535 },
        { at: "2026-09-13T06:00:00Z", kind: "fell", size: 0.25 }, { at: "2026-09-14T06:00:00Z", kind: "fell", size: 3 },
      ],
    });
    expect(itemLines("resets", item, ZONE).lines).toEqual([
      `The counter went back down 2 times (2026-09-10 09:00, by 1,200.5; 2026-09-12 09:00, by 65,535): ${RESET_TAIL}`,
      "The counter dipped below its earlier reading and recovered 1 time (2026-09-11 09:00, by 12). The figure ignores the dip and counts the rise from the earlier reading.",
      "A reading went down inside an hour 2 times (2026-09-13 09:00, by 0.3; 2026-09-14 09:00, by 3); the hour is counted from its last reading.",
    ]);
  });

  it("sizes keep at most one decimal and a thousands separator", () => {
    const at = "2026-09-10T06:00:00Z";
    const text = (size: number) => itemLines("resets", resets({ resets: 1, events: [{ at, kind: "reset", size }] }), ZONE).lines[0];
    expect(text(1234567.89)).toContain("by 1,234,567.9)");
    expect(text(65535)).toContain("by 65,535)");
    expect(text(7)).toContain("by 7)");
    expect(text(0.04)).toContain("by 0)");
  });

  it("says so when there are more events than the five listed", () => {
    const events = [1, 2, 3, 4, 5].map((day) => ({ at: `2026-09-0${day}T06:00:00Z`, kind: "reset" as const, size: day * 10 }));
    const lines = itemLines("resets", resets({ resets: 8, events }), ZONE).lines;
    expect(lines[0]).toBe(
      "The counter went back down 8 times (2026-09-01 09:00, by 10; 2026-09-02 09:00, by 20; 2026-09-03 09:00, by 30; 2026-09-04 09:00, by 40; 2026-09-05 09:00, by 50; and later ones): " +
        RESET_TAIL,
    );
  });

  it("a kind that happened but is not among the listed events reads as later ones", () => {
    const events = [{ at: "2026-09-01T06:00:00Z", kind: "reset" as const, size: 5 }];
    expect(itemLines("resets", resets({ resets: 1, dips: 2, events }), ZONE).lines[1]).toBe(
      "The counter dipped below its earlier reading and recovered 2 times (later ones). The figure ignores the dip and counts the rise from the earlier reading.",
    );
  });
});

describe("itemLines: unpriced and flat", () => {
  it("unpriced: kWh, hours, days", () => {
    const item: UnpricedItem = { ...head("counter"), kwh: 1234.56, hours: 48, days: 2, first_day: "2026-09-03", last_day: "2026-09-04" };
    expect(itemLines("unpriced", item, ZONE).lines).toEqual([
      "1,234.6 kWh in 48 hours had no rate, on 2 days (2026-09-03 to 2026-09-04). Those hours are in the kWh but not in the cost.",
    ]);
    expect(itemLines("unpriced", { ...item, kwh: 0.5, hours: 1, days: 1, last_day: "2026-09-03" }, ZONE).lines).toEqual([
      "0.5 kWh in 1 hour had no rate, on 1 day (2026-09-03). Those hours are in the kWh but not in the cost.",
    ]);
  });

  it("flat counter: it counts nothing for that time", () => {
    const item: FlatItem = { ...head("counter"), runs: 2, longest_hours: 36, longest_start: "2026-09-20T06:00:00Z", first_start: "2026-09-10T06:00:00Z" };
    expect(itemLines("flat", item, ZONE).lines).toEqual([
      "The readings did not change for 36 hours in a row from 2026-09-20 09:00 (2 stretches of 24 hours or more).",
      "It counts 0 kWh for that time. If the equipment was in use, check the meter.",
    ]);
    expect(itemLines("flat", { ...item, runs: 1 }, ZONE).lines[0]).toContain("(1 stretch of 24 hours or more)");
  });

  it("flat power: counted as if the power had stayed the same", () => {
    const item: FlatItem = { ...head("power"), runs: 1, longest_hours: 30, longest_start: "2026-09-20T06:00:00Z", first_start: "2026-09-20T06:00:00Z" };
    expect(itemLines("flat", item, ZONE).lines).toEqual([
      "The power reading did not change for 30 hours in a row from 2026-09-20 09:00 (1 stretch of 24 hours or more).",
      "The energy for that time is worked out as if the power had stayed the same. If the load moved, check the meter.",
    ]);
  });

  it("flat names the threshold the server used when it is handed the limits", () => {
    const item: FlatItem = { ...head("counter"), runs: 1, longest_hours: 60, longest_start: "2026-09-20T06:00:00Z", first_start: "2026-09-20T06:00:00Z" };
    expect(itemLines("flat", item, ZONE, { ...LIMITS, flat_hours: 48 }).lines[0]).toContain("(1 stretch of 48 hours or more)");
  });
});

describe("moreLine", () => {
  it("counts the findings the list does not show", () => {
    const group: MonthCheckGroup<unknown> = { total: 62, items: new Array(50).fill({}) };
    expect(moreLine(group, 50)).toBe("and 12 more");
    expect(moreLine({ total: 1250, items: new Array(50).fill({}) }, 50)).toBe("and 1,200 more");
  });
  it("is null when everything is shown", () => {
    expect(moreLine({ total: 3, items: [{}, {}, {}] }, 50)).toBeNull();
    expect(moreLine({ total: 0, items: [] }, 50)).toBeNull();
  });
});

describe("information blocks", () => {
  const unmetered = (total: number): MonthCheck => check({ groups: { ...check().groups, unmetered: { total, items: [] } } });

  it("unmetered: says what it is, and that it is not in the number at the top", () => {
    expect(unmeteredIntro(unmetered(20))).toBe("20 assets have no meter of their own and no meter above them, so no energy is counted for them. They are not part of the number at the top.");
    expect(unmeteredIntro(unmetered(1))).toBe("1 asset has no meter of its own and no meter above it, so no energy is counted for it. It is not part of the number at the top.");
    expect(unmeteredIntro(unmetered(0))).toBe("Every asset at the bottom of the tree has a meter of its own or one above it.");
  });

  it("unmetered: an asset beside measured ones says what is missing from the figure above", () => {
    const beside: UnmeteredItem = { asset_id: 1, path: "A / B", beside_measured: true };
    expect(unmeteredLines(beside)).toBe("The asset above is billed from other meters under it; if this one uses power, that power is not in that figure.");
    expect(unmeteredLines({ ...beside, beside_measured: false })).toBe("Nothing measures this asset or any asset above it.");
  });

  it("later: a meter whose first reading came after what was looked at", () => {
    const item: LaterItem = { asset_id: 1, path: "A / B", kind: "counter", first_reading: "2026-09-30T21:00:00Z" };
    expect(laterLine(item, ZONE)).toBe("First reading 2026-10-01 00:00: after what was looked at.");
  });
});

describe("the count on the button, the sentence behind it and the line in the Close month dialog", () => {
  const ready = (over: Partial<MonthCheck>): MonthCheckStatus => ({ status: "ready", data: check(over) });
  const NOT_BEGUN = ready({ state: "not_begun", hours: 0, meters: 0, meter_hours: 0 });
  const NO_HOUR = ready({ state: "open", hours: 0, meters: 0, meter_hours: 0 });
  const NO_METER = ready({ meters: 0, meter_hours: 0 });
  const NOTHING = ready({});
  const SOME = ready({ things: 3 });
  const ONE = ready({ things: 1 });
  const NINETY_NINE = ready({ things: 99 });
  const HUNDRED = ready({ things: 100 });
  const LOADING: MonthCheckStatus = { status: "loading" };
  const ERROR: MonthCheckStatus = { status: "error", message: "boom" };

  it.each([
    ["loading", LOADING, ""],
    ["an error", ERROR, ""],
    ["a month that has not begun", NOT_BEGUN, ""],
    ["no hour finished yet", NO_HOUR, ""],
    ["no meter looked at", NO_METER, ""],
    ["nothing found", NOTHING, "0"],
    ["one thing", ONE, "1"],
    ["three things", SOME, "3"],
    ["99 things", NINETY_NINE, "99"],
    ["100 things", HUNDRED, "99+"],
  ])("count slot for %s is %j", (_name, status, expected) => {
    expect(countSlotText(status)).toBe(expected);
  });

  it.each([
    ["loading", LOADING, "not read yet"],
    ["an error", ERROR, "not read yet"],
    ["a month that has not begun", NOT_BEGUN, "nothing to look at yet"],
    ["no hour finished yet", NO_HOUR, "nothing to look at yet"],
    ["no meter looked at", NO_METER, "nothing to look at yet"],
    ["nothing found", NOTHING, "nothing to check"],
    ["one thing", ONE, "1 thing to check"],
    ["three things", SOME, "3 things to check"],
    ["100 things (the slot says 99+, the sentence says the number)", HUNDRED, "100 things to check"],
    ["1,200 things", ready({ things: 1200 }), "1,200 things to check"],
  ])("described-by sentence for %s is %j", (_name, status, expected) => {
    expect(describedByText(status)).toBe(expected);
  });

  it.each([
    [LOADING, "Month check: not read yet (see Check month on the page)."],
    [ERROR, "Month check: not read yet (see Check month on the page)."],
    [NOT_BEGUN, "Month check: nothing to look at yet (see Check month on the page)."],
    [NOTHING, "Month check: nothing to check (see Check month on the page)."],
    [SOME, "Month check: 3 things to check (see Check month on the page)."],
  ])("the Close month dialog line for %j", (status, expected) => {
    expect(checkLineText(status)).toBe(expected);
  });
});

// --------------------------------------------------------------------------------------------------------------------------------------------
// The wording rules: nothing a person could read as a promise that the month is right. WHOLE words only (so "Looked at" and "look" and "already"
// are fine), case-insensitive, and no percent sign. The scan runs over EVERY string an exported function returns, for every kind of finding,
// both meter kinds, one and many, every status and state.

const BANNED = /\b(ok|ready|verified|correct|accurate|guarantee|safe|all good|passed)\b|%/i;

describe("the banned-word scan itself", () => {
  it.each(["Looked at 12 meters", "We look at it", "already done", "Nothing to look at yet", "a lookup", "It is fine to proceed"])("lets %j through", (text) => {
    expect(BANNED.test(text)).toBe(false);
  });
  it.each(["It is OK", "ok", "Everything is ready", "VERIFIED", "this is correct.", "accurate to", "a guarantee", "is safe", "all good", "Passed", "one in 100%"])("catches %j", (text) => {
    expect(BANNED.test(text)).toBe(true);
  });
});

/** One finding of every kind, for a counter and for a power meter, with singular and plural counts. */
function everyItem(kind: "counter" | "power", many: boolean): Record<CheckGroupKey, ReturnType<typeof head>[]> {
  const n = many ? 12 : 1;
  const t = "2026-09-20T06:00:00Z";
  const silent = (["never", "none_in_month", "trailing"] as const).flatMap((reason) =>
    [null, "2026-08-31T20:00:00Z"].flatMap((last_reading) =>
      [0, n].map((children): SilentItem => ({ ...head(kind), reason, since: reason === "trailing" ? t : null, hours: n, last_reading, children })),
    ),
  );
  const gaps: GapsItem[] = [
    { ...head(kind), runs: n, hours: n, longest_hours: n, longest_start: t, first_start: t, last_end: t, leading_hours: 0, hours_before_month: 0, previous_reading: null, short_hours: 0, short_minutes: 0 },
    { ...head(kind), runs: n, hours: n, longest_hours: n, longest_start: t, first_start: t, last_end: t, leading_hours: n, hours_before_month: 0, previous_reading: t, short_hours: n, short_minutes: n * 7 },
    { ...head(kind), runs: 0, hours: 0, longest_hours: null, longest_start: null, first_start: null, last_end: null, leading_hours: 0, hours_before_month: 0, previous_reading: null, short_hours: n, short_minutes: 59 + n },
    { ...head(kind), runs: n, hours: n, longest_hours: n, longest_start: t, first_start: t, last_end: t, leading_hours: n, hours_before_month: n, previous_reading: t, short_hours: 0, short_minutes: 0 },
    { ...head(kind), runs: 0, hours: 0, longest_hours: null, longest_start: null, first_start: null, last_end: null, leading_hours: 0, hours_before_month: many ? 300 : 1, previous_reading: t, short_hours: 0, short_minutes: 0 },
  ];
  const estimated: EstimatedItem[] = [
    { ...head(kind), hours_estimated: n, hours_total: n + 5, negative_hours: 0, negative_kwh: 0 },
    { ...head(kind), hours_estimated: n, hours_total: n + 5, negative_hours: n, negative_kwh: -n * 1.25 },
  ];
  const everyKind = [{ at: t, kind: "reset" as const, size: 65535 }, { at: t, kind: "dip" as const, size: 12.5 }, { at: t, kind: "fell" as const, size: n }];
  const resets: ResetsItem[] = [
    { ...head(kind), resets: n, dips: n, falls: n, events: everyKind },
    { ...head(kind), resets: 8, dips: 0, falls: 0, events: [] },
  ];
  const started: StartedItem[] = [{ ...head(kind), first_reading: t, children: 0 }, { ...head(kind), first_reading: t, children: n }];
  const unpriced: UnpricedItem[] = [{ ...head(kind), kwh: n * 1.25, hours: n, days: n, first_day: "2026-09-03", last_day: many ? "2026-09-04" : "2026-09-03" }];
  const flat: FlatItem[] = [{ ...head(kind), runs: n, longest_hours: 24 + n, longest_start: t, first_start: t }];
  return { silent, gaps, estimated, resets, started, unpriced, flat } as unknown as Record<CheckGroupKey, ReturnType<typeof head>[]>;
}

function everyString(): string[] {
  const out: string[] = [];
  const states: Partial<MonthCheck>[] = [
    {}, { things: 1 }, { things: 12 }, { things: 1200 }, { closed: true }, { state: "open" }, { state: "open", closed: true },
    { state: "not_begun", hours: 0, meters: 0, meter_hours: 0 }, { state: "open", hours: 0, meters: 0, meter_hours: 0 }, { meters: 0, meter_hours: 0 },
    { hours: 1, meters: 1, meter_hours: 1 }, { meters: 1, meter_hours: 500 },
    { meters: 0, meter_hours: 0, groups: { ...check().groups, later: { total: 1, items: [] } } }, // only meters that started after what was looked at
    { limits: { flat_hours: 48, short_minutes: 30, short_share: 0.02, max_tolerated_hours: 12, cap: 25 } },
  ];
  for (const state of states) {
    const c = check(state);
    out.push(headline(c), lookedAtLine(c, ZONE));
    for (const text of [headlineReason(c), stateNote(c)]) if (text !== null) out.push(text);
    for (const key of GROUP_ORDER) out.push(groupTitle(key), groupIntro(key, c));
    for (const total of [0, 1, 20]) out.push(unmeteredIntro(check({ groups: { ...c.groups, unmetered: { total, items: [] } } })));
    for (const status of [{ status: "loading" }, { status: "error", message: "x" }, { status: "ready", data: c }] as MonthCheckStatus[]) {
      out.push(countSlotText(status), describedByText(status), checkLineText(status));
    }
  }
  for (const kind of ["counter", "power"] as const) {
    for (const many of [false, true]) {
      const items = everyItem(kind, many);
      for (const key of GROUP_ORDER) {
        for (const item of items[key]) {
          const { reads, lines } = itemLines(key, item as never, ZONE);
          if (reads !== null) out.push(reads);
          out.push(...lines);
        }
      }
    }
    out.push(laterLine({ asset_id: 1, path: "A", kind, first_reading: "2026-10-01T00:00:00Z" }, ZONE));
  }
  for (const beside of [true, false]) out.push(unmeteredLines({ asset_id: 1, path: "A", beside_measured: beside }));
  // the drawer's own words (review M2): they live in this module so this scan reaches them
  for (const total of [1, 2, 20]) out.push(laterIntro(total));
  out.push(NOT_COUNTED_TITLE, UNMETERED_TITLE, LATER_TITLE, LOADING_LABEL, SHOW_FEWER, showAllText(6), showAllText(2000));
  for (const [total, shown] of [[62, 50], [51, 50], [3, 3]]) {
    const more = moreLine({ total, items: new Array(shown).fill({}) }, 50);
    if (more !== null) out.push(more);
  }
  return out;
}

describe("no sentence promises that the month is right", () => {
  const strings = everyString();

  it("scans a real number of sentences", () => {
    expect(strings.length).toBeGreaterThan(150);
    expect(new Set(strings).size).toBeGreaterThan(80);
  });

  it("uses none of the banned words and no percent sign", () => {
    expect(strings.filter((text) => BANNED.test(text))).toEqual([]);
  });

  it("leaves no stray space at either end of a sentence, and no double space inside one", () => {
    expect(strings.filter((text) => text.trim() !== text || text.includes("  "))).toEqual([]);
  });

  it("never prints a half-built value", () => {
    expect(strings.filter((text) => /undefined|null|NaN|\[object/.test(text))).toEqual([]);
  });

  it("covers the singular forms: 1 hour, 1 gap, 1 time", () => {
    const joined = strings.join("\n");
    expect(joined).toContain("1 hour at the end");
    expect(joined).toContain("1 gap:");
    expect(joined).toContain("1 time (");
    expect(joined).toContain("1 hour before the month began");
    expect(joined).toContain("It has 1 asset under it");
    expect(joined).toContain("1 hour had a negative power reading");
    expect(joined).not.toMatch(/\b1 (hours|gaps|times|stretches|days|things|meters|assets)\b/);
  });

  it("scans the drawer's own words too: its headings, the intro of the later meters, its loading label and its two fold buttons", () => {
    expect(strings).toEqual(expect.arrayContaining([
      "Not counted", "Assets nothing measures", "Meters that started later", "Loading the month check", "Show fewer", "Show all 6", "Show all 2,000",
      "20 meters gave their first reading after what was looked at. Until then each asset counts what the assets under it add up to. They are not part of the number at the top.",
      "No asset has an energy (kWh) counter or a power (kW) reading mapped.",
      "The energy it measures in that time is not lost: it is counted when readings come back, in a later month if they come back after this one ends.",
    ]));
    expect(laterIntro(1)).toMatch(/^1 meter gave its first reading/);
  });

  it("scans the new sentences: the hole before the month, silent parents, negative power and the size of a fall", () => {
    const joined = strings.join("\n");
    expect(joined).toContain("The first reading of the month counts everything since");
    expect(joined).toContain("It has 12 assets under it; while its own meter has no readings their energy is not counted in its figure.");
    expect(joined).toContain("a meter fitted the wrong way round does this.");
    expect(joined).toContain(", by 65,535");
    expect(joined).toContain(", by 12.5");
  });
});
