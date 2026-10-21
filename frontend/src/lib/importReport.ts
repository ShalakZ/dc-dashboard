import type { ImportReport } from "../api/types";

/** Words for the reason codes of backend/dcdash/ingest (`normalise.Rejected` and the importer's own). Each reads as a short sentence without its full stop. */
const REJECTED: Record<string, string> = {
  naive_time_without_zone: "The time has no zone and the profile names none",
  local_time_does_not_exist: "The local time does not exist (the clocks went forward)",
  ambiguous_local_time: "The local time is ambiguous (the clocks went back)",
  later_than_now_plus_5_minutes: "The time is more than 5 minutes in the future",
  older_than_raw_retention: "The time is older than the readings are kept",
  older_than_stored_raw_readings: "The time is in a stretch whose raw readings the retention removed; the summaries there are kept, so nothing can be added",
  not_a_time: "The time cannot be read",
  not_a_number: "The value is not a number",
  value_out_of_range: "The value is out of range",
  empty_value: "The value is empty",
  unit_differs_from_mapping: "The unit differs from the unit the point is mapped with",
  unit_not_valid_for_metric: "The unit is not valid for the point's metric",
  interval_energy_in_counter_point: "Energy per period cannot go into a point read as a running counter or as a power",
  malformed_line: "The line is not a well-formed row (an unbalanced quote, a line break inside a cell, or too few or too many cells)",
  bad_tag: "The tag is empty or too long",
  point_deleted: "The point was deleted while the file was being read",
  duplicate_in_file: "The same reading is in the file more than once",
  conflicting_duplicate_in_file: "The same time is in the file again with another value (the first one is used)",
};

/** The longest unknown code shown: a code is the server's, but a longer one than any it sends today must not stretch a list. */
const CODE_MAX = 40;

/** A reason code in plain words; a code this build does not know is shown as it is, clipped to 40 characters. */
export function rejectedText(reason: string): string {
  if (Object.hasOwn(REJECTED, reason)) return REJECTED[reason];
  const code = reason.length > CODE_MAX ? `${reason.slice(0, CODE_MAX - 1)}…` : reason;
  return `Not accepted (${code})`;
}

const count = (n: number) => (Number.isFinite(n) ? n : 0).toLocaleString("en-US");

/** "Import 12,000 rows": the button that stores what a check found new. The caller decides whether it is enabled (nothing new gives "Import 0 rows"). */
export function importButtonText(report: Pick<ImportReport, "new">): string {
  return `Import ${count(report.new)} ${report.new === 1 ? "row" : "rows"}`;
}

/**
 * The sentence above the lists of a report: the server's own summary (`text`) in the frame of what it is. A check stores nothing, a finished import
 * is done, and a run that stopped half-way says why and that the same file can be imported again.
 */
export function importSentence(report: Pick<ImportReport, "dry_run" | "complete" | "error" | "text">): string {
  const text = report.text.trim().replace(/\.$/, "");
  if (report.dry_run) return `Checked: ${text}. Nothing is stored until you import.`;
  if (!report.complete) {
    const why = report.error ? `: ${report.error.trim().replace(/\.$/, "")}` : "";
    return `The import stopped before the end${why}. So far ${text}. Importing the same file again is safe: a reading that is stored is never stored twice.`;
  }
  return `Imported: ${text}.`;
}

/** What to tell a person whose rows fell into a closed billing month. */
export const CLOSED_MONTH_NOTE = "A closed month keeps its frozen figures: the new rows are stored, but the closed bill does not change. The counts are rows of the file, whether they were new or already there.";

/** One line for each closed month that took rows ("3 rows in the closed month 2026-09"), oldest month first; none when no row fell in one. */
export function closedMonthLines(report: Pick<ImportReport, "closed_months">): string[] {
  return Object.entries(report.closed_months)
    .filter(([, rows]) => rows > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, rows]) => `${count(rows)} ${rows === 1 ? "row" : "rows"} in the closed month ${month}`);
}
