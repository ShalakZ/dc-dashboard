import type { ImportReport } from "../api/types";
import { CLOSED_MONTH_NOTE, closedMonthLines, importButtonText, importSentence, rejectedText } from "./importReport";

const CODES = [
  "naive_time_without_zone", "local_time_does_not_exist", "ambiguous_local_time", "later_than_now_plus_5_minutes", "older_than_raw_retention",
  "not_a_time", "not_a_number", "value_out_of_range", "empty_value", "unit_differs_from_mapping", "unit_not_valid_for_metric",
  "interval_energy_in_counter_point", "point_deleted", "duplicate_in_file", "conflicting_duplicate_in_file",
];

const report = (over: Partial<ImportReport> = {}): ImportReport => ({
  dry_run: true, source_id: 3, profile: "hourly", sha256: "ab".repeat(32), size: 1000,
  rows_read: 12_480, new: 12_000, already: 480, differing: 0, rejected: 0, unknown_rows: 0,
  unknown_tags: { count: 0, names: [] }, rejected_by: {}, closed_months: {}, differing_samples: [], problems: [], problems_total: 0,
  refresh: { state: "not_needed", days: 0, note: null }, complete: true, error: null,
  text: "12,480 rows read, 12,000 new, 480 already there, 0 differing, 0 rejected", ...over,
});

describe("rejectedText", () => {
  it.each(CODES)("%s has its own words, which are not the code", (code) => {
    const text = rejectedText(code);
    expect(text).not.toContain("_");
    expect(text).not.toMatch(/^Not accepted/);
    expect(text.length).toBeGreaterThan(10);
  });

  it("gives every known code different words", () => {
    expect(new Set(CODES.map(rejectedText)).size).toBe(CODES.length);
  });

  it("says what is wrong with a time that has no zone, a duplicate and an energy-per-period reading", () => {
    expect(rejectedText("naive_time_without_zone")).toBe("The time has no zone and the profile names none");
    expect(rejectedText("conflicting_duplicate_in_file")).toContain("first one is used");
    expect(rejectedText("interval_energy_in_counter_point")).toContain("running energy counter");
  });

  it("shows a code it does not know, clipped to 40 characters", () => {
    expect(rejectedText("brand_new_reason")).toBe("Not accepted (brand_new_reason)");
    const exactly = "a".repeat(40);
    expect(rejectedText(exactly)).toBe(`Not accepted (${exactly})`);
    const clipped = rejectedText("b".repeat(41));
    expect(clipped).toBe(`Not accepted (${"b".repeat(39)}…)`);
    expect(clipped.slice("Not accepted (".length, -1)).toHaveLength(40);
    expect(rejectedText("c".repeat(5000)).length).toBeLessThan(60);
  });

  it("does not take a property of the table for a code", () => {
    expect(rejectedText("constructor")).toBe("Not accepted (constructor)");
    expect(rejectedText("__proto__")).toBe("Not accepted (__proto__)");
    expect(rejectedText("")).toBe("Not accepted ()");
  });
});

describe("importButtonText", () => {
  it.each([
    [12_000, "Import 12,000 rows"], [1, "Import 1 row"], [2, "Import 2 rows"], [0, "Import 0 rows"], [500_000, "Import 500,000 rows"], [1234567, "Import 1,234,567 rows"],
  ])("%s new rows read %s", (rows, text) => expect(importButtonText(report({ new: rows }))).toBe(text));

  it("does not print a number that is not one", () => {
    expect(importButtonText(report({ new: Number.NaN }))).toBe("Import 0 rows");
  });
});

describe("importSentence", () => {
  it("frames a check as storing nothing yet", () => {
    expect(importSentence(report())).toBe("Checked: 12,480 rows read, 12,000 new, 480 already there, 0 differing, 0 rejected. Nothing is stored until you import.");
  });

  it("frames a finished import as done, and does not double a full stop the server put", () => {
    expect(importSentence(report({ dry_run: false, text: "5 rows read, 5 new." }))).toBe("Imported: 5 rows read, 5 new.");
  });

  it("says why a run stopped, what was stored so far and that the same file can be imported again", () => {
    const text = importSentence(report({ dry_run: false, complete: false, error: "the database stopped answering.", text: "3,000 rows read, 2,000 new" }));
    expect(text).toContain("The import stopped before the end: the database stopped answering.");
    expect(text).toContain("So far 3,000 rows read, 2,000 new.");
    expect(text).toContain("Importing the same file again is safe");
  });

  it("still reads when a stopped run gives no reason", () => {
    expect(importSentence(report({ dry_run: false, complete: false, error: null, text: "10 rows read" }))).toMatch(/^The import stopped before the end\. So far 10 rows read\./);
  });
});

describe("closedMonthLines", () => {
  it("lists each closed month with its rows, oldest first, with a singular for one row", () => {
    expect(closedMonthLines(report({ closed_months: { "2026-09": 1_240, "2026-07": 1, "2026-08": 12 } }))).toEqual([
      "1 row in the closed month 2026-07", "12 rows in the closed month 2026-08", "1,240 rows in the closed month 2026-09",
    ]);
  });

  it("lists nothing when no row fell in a closed month", () => {
    expect(closedMonthLines(report())).toEqual([]);
    expect(closedMonthLines(report({ closed_months: { "2026-09": 0 } }))).toEqual([]);
  });

  it("has a note that says the closed figures stay as they are", () => {
    expect(CLOSED_MONTH_NOTE).toContain("frozen");
  });
});
