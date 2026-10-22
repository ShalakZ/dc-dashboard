import type { Incident, SystemEvent } from "../api/types";
import {
  codeReason, describeEvent, formatShortTime, KIND_NAMES, kindName, LEVEL_WORDS, OFFLINE_BANNER_SECONDS, openLine, sourceLabel,
} from "./eventText";
import { OFFLINE_BANNER_SECONDS as SOURCES_THRESHOLD } from "./sourceStatus";

const event = (extra: Partial<SystemEvent> = {}): SystemEvent => ({
  id: 7, ts: "2026-10-22T08:00:00Z", level: "warning", component: "collector", source_id: 4, source_name: "OPC UA server at 172.20.0.3:4840", source_deleted: false,
  kind: "source.offline", code: "unreachable", message: "[Errno 111] Connect call failed ('172.20.0.3', 4840)", detail: {}, incident: null, ...extra,
});
const incident = (extra: Partial<Incident> = {}): Incident => ({
  state: "open", count: 1204, first_at: "2026-10-18T04:52:00Z", last_at: "2026-10-22T08:00:00Z", closed_at: null, duration_seconds: 4 * 86400 + 2 * 3600, closed_by: null, ...extra,
});

// The 15 kinds the backend writes (core/journal.py and ingest/kinds.py) and the codes of source.offline; the parity test in the backend reads this file's text.
const KINDS = [
  "collector.started", "source.offline", "source.online", "points.bad", "points.recovered", "job.finished", "check.finished", "clock.skew", "http.5xx",
  "figures.mismatch", "readings.conflict", "history.filled", "history.failed", "history.closed_month", "import.finished",
];
const CODES = ["unreachable", "auth_failed", "timeout", "protocol_error", "exception", "config_invalid", "secret_undecryptable", "needs_profile", "not_supported"];

describe("eventText (w32): the one table of words", () => {
  it("has a name and a sentence for each of the 15 kinds, and none of the sentences is the raw kind", () => {
    expect(Object.keys(KIND_NAMES).sort()).toEqual([...KINDS].sort());
    for (const kind of KINDS) {
      expect(kindName(kind), kind).not.toBe(kind);
      const text = describeEvent(event({ kind, code: null, message: `raw ${kind}` }));
      expect(text.headline.length, kind).toBeGreaterThan(3);
      expect(text.headline, kind).not.toBe(kind);
    }
  });

  it("has a headline and a plain reason for each code of source.offline, and no headline shows the raw code", () => {
    for (const code of CODES) {
      const text = describeEvent(event({ code }));
      expect(text.headline, code).toMatch(/^(Went offline|Not being read)/);
      expect(text.headline, code).not.toContain(code);
      expect(codeReason(code), code).toMatch(/\.$/);
      expect(text.reason, code).toBe(codeReason(code));
    }
    expect(describeEvent(event({ code: "unreachable" })).headline).toBe("Went offline: could not reach the server");
    expect(describeEvent(event({ code: "unreachable" })).reason).toBe("Could not connect to the server.");
  });

  it("never throws and falls back to the raw text for a kind or a code it does not know", () => {
    const odd = describeEvent(event({ kind: "brand.new", code: "weird", message: "something happened", detail: { x: 1 } }));
    expect(odd.headline).toBe("something happened");
    expect(kindName("brand.new")).toBe("brand.new");
    expect(codeReason("weird")).toBeNull();
    const code = describeEvent(event({ code: "weird", message: "it broke" }));
    expect(code.headline).toBe("Went offline");
    expect(code.reason).toBe("it broke");
    expect(describeEvent(event({ kind: "brand.new", message: "" })).headline).toBe("brand.new");
    // a detail of the wrong shape
    expect(() => describeEvent(event({ kind: "check.finished", detail: { steps: "many", first_failed: 4, ok: "yes" } }))).not.toThrow();
    expect(() => describeEvent(event({ kind: "source.online", detail: { offline_seconds: "long" } }))).not.toThrow();
    expect(() => describeEvent({ ...event(), detail: null as unknown as Record<string, unknown> })).not.toThrow();
  });

  it("counts an open incident and says it is ongoing; a closed one says how long it lasted", () => {
    const open = describeEvent(event({ incident: incident() }));
    expect(open.count).toBe("failed 1,204 times");
    expect(open.span).toBe("ongoing, 4 d 2 h");
    const closed = describeEvent(event({ incident: incident({ state: "closed", closed_at: "2026-10-22T09:00:00Z", closed_by: "recovered", count: 1 }) }));
    expect(closed.count).toBe("failed 1 time");
    expect(closed.span).toBe("lasted 4 d 2 h");
    const stopped = describeEvent(event({ incident: incident({ state: "closed", closed_by: "polling_stopped", duration_seconds: 300 }) }));
    expect(stopped.span).toBe("stopped being read after 5 min");
    expect(describeEvent(event({ kind: "points.bad", code: null, incident: incident({ count: 12 }) })).count).toBe("12 polls with bad readings");
  });

  it("shows an old row (no incident) as before: no count, no span", () => {
    const old = describeEvent(event());
    expect(old.count).toBeNull();
    expect(old.span).toBeNull();
    expect(old.headline).toBe("Went offline: could not reach the server");
  });

  it("says how many of the points read badly when the detail knows", () => {
    expect(describeEvent(event({ kind: "points.bad", code: null, detail: { bad: 3, total: 12 } })).headline).toBe("3 of 12 points read badly");
    expect(describeEvent(event({ kind: "points.bad", code: null, detail: {} })).headline).toBe("Some points read badly");
  });

  it("words a recovery, from the new detail keys and from the older ones", () => {
    expect(describeEvent(event({ kind: "source.online", level: "info", code: null, detail: { incident_id: 5, offline_seconds: 4 * 86400 + 2 * 3600, failed_reads: 1204 } }))).toMatchObject({
      headline: "Back online after 4 d 2 h", count: "1,204 failed reads counted",
    });
    expect(describeEvent(event({ kind: "source.online", detail: { offline_seconds: null, failures: 1 } }))).toMatchObject({ headline: "Back online", count: null });
    expect(describeEvent(event({ kind: "source.online", detail: { offline_seconds: 4 * 86400 + 2 * 3600 + 5, failures: 1 } })).headline).toBe("Back online after 4 d 2 h");
    expect(describeEvent(event({ kind: "points.recovered", detail: { incident_id: 5, bad_seconds: 180, polls_with_bad_readings: 3 } }))).toMatchObject({
      headline: "All points read good again after 3 min", count: "3 polls had bad readings",
    });
    expect(describeEvent(event({ kind: "points.recovered", detail: { bad_seconds: 60, first: "x", total: 4 } })).headline).toBe("All points read good again after 1 min");
  });

  it("words a connection check and a job by how it ended", () => {
    expect(describeEvent(event({ kind: "check.finished", code: null, detail: { ok: true, steps: 7 } })).headline).toBe("The connection check passed (7 steps)");
    expect(describeEvent(event({ kind: "check.finished", detail: { ok: false, first_failed: "session", steps: 5 } })).headline).toBe('The connection check failed at "Session"');
    expect(describeEvent(event({ kind: "check.finished", detail: { ok: false } })).headline).toBe("The connection check failed");
    expect(describeEvent(event({ kind: "job.finished", level: "info", code: null, detail: { ok: true, kind: "test_source" } })).headline).toBe("The connection test passed");
    const failed = describeEvent(event({ kind: "job.finished", level: "error", code: null, detail: { ok: false, kind: "check_connection", error: "the worker restarted" } }));
    expect(failed.headline).toBe("The connection check failed");
    expect(failed.reason).toBe("the worker restarted");
    expect(describeEvent(event({ kind: "job.finished", detail: { ok: false, kind: "mystery" } })).headline).toBe("A background job failed");
  });

  it("gives a failed job a plain reason from its CODE and never the raw connector text when the code is known (review I1)", () => {
    const raw = "[Errno 111] Connect call failed ('172.20.0.3', 4840)";
    const failed = describeEvent(event({ kind: "job.finished", level: "error", code: "unreachable", message: raw, detail: { ok: false, kind: "test_source", error: raw, job_id: 3 } }));
    expect(failed.headline).toBe("The connection test failed");
    expect(failed.reason).toBe("Could not connect to the server.");
    expect(JSON.stringify(failed)).not.toContain("Errno");
    // a code the table does not know, or none, keeps the stored text
    expect(describeEvent(event({ kind: "job.finished", code: "brand_new", detail: { ok: false, kind: "test_source", error: "it broke" } })).reason).toBe("it broke");
    expect(describeEvent(event({ kind: "job.finished", code: null, detail: { ok: false, kind: "test_source", error: "it broke" } })).reason).toBe("it broke");
    expect(describeEvent(event({ kind: "job.finished", code: "timeout", detail: { ok: false, kind: "test_source" } })).reason).toBe("The server did not answer in time.");
    // a job that passed has no reason, whatever code the row carries
    expect(describeEvent(event({ kind: "job.finished", level: "info", code: "unreachable", detail: { ok: true, kind: "test_source" } })).reason).toBeNull();
  });

  it("says a test passed or failed, and browsing finished; the other jobs keep their words (review M5)", () => {
    const job = (kind: string, ok: boolean) => describeEvent(event({ kind: "job.finished", code: null, detail: { ok, kind } })).headline;
    expect(job("test_source", true)).toBe("The connection test passed");
    expect(job("test_source", false)).toBe("The connection test failed");
    expect(job("browse_source", true)).toBe("Browsing the source finished");
    expect(job("browse_source", false)).toBe("The browse failed");
    expect(job("scan", true)).toBe("The scan finished");
    expect(job("check_connection", true)).toBe("The connection check finished");
    expect(job("history_fill", true)).toBe("The history fill finished");
    expect(job("mystery", true)).toBe("A background job finished");
  });

  it("words the other kinds in plain sentences", () => {
    expect(describeEvent(event({ kind: "clock.skew", detail: { skew_seconds: 125 } })).headline).toBe("The source's clock is 2 min ahead of ours");
    expect(describeEvent(event({ kind: "clock.skew", detail: { skew_seconds: -90 } })).headline).toBe("The source's clock is 1 min behind ours");
    expect(describeEvent(event({ kind: "history.filled", detail: { new: 1500 } })).headline).toBe("1,500 readings were filled in from the source's history");
    expect(describeEvent(event({ kind: "history.failed", code: "not_supported" })).headline).toBe("This source keeps no history");
    expect(describeEvent(event({ kind: "history.failed", code: "unreachable" })).reason).toBe("Could not connect to the server.");
    expect(describeEvent(event({ kind: "history.closed_month", detail: { month: "2026-09" } })).headline).toBe("Readings were filled into 2026-09, a month that is closed");
    expect(describeEvent(event({ kind: "import.finished", level: "warning" })).headline).toBe("A file import stopped half-way");
    expect(describeEvent(event({ kind: "import.finished", level: "info" })).headline).toBe("A file import finished");
  });

  it("writes the line of an open problem the way the page pins it", () => {
    const line = openLine(event({ incident: incident() }), "Asia/Qatar");
    expect(line).toBe("OPC UA server at 172.20.0.3:4840 is offline since 18 Oct 07:52 (4 d 2 h), 1,204 failed reads. Could not connect to the server.");
    expect(openLine(event({ code: "secret_undecryptable", incident: incident({ count: 1 }) }), "Asia/Qatar")).toMatch(/^OPC UA server at 172\.20\.0\.3:4840 cannot be read since 18 Oct 07:52 \(4 d 2 h\), 1 failed read\. /);
    expect(openLine(event({ kind: "points.bad", code: null, incident: incident({ count: 12 }) }), "Asia/Qatar")).toBe(
      "OPC UA server at 172.20.0.3:4840 has bad readings since 18 Oct 07:52 (4 d 2 h), 12 polls with bad readings.",
    );
    expect(openLine(event({ code: "weird", message: "raw words", incident: incident() }), "Asia/Qatar")).toMatch(/is offline since .* raw words$/);
  });

  it("names a source, a deleted source and no source", () => {
    expect(sourceLabel(event())).toBe("OPC UA server at 172.20.0.3:4840");
    expect(sourceLabel(event({ source_id: 3, source_name: null, source_deleted: true }))).toBe("deleted source #3");
    expect(sourceLabel(event({ source_id: null, source_name: null }))).toBeNull();
  });

  it("writes a time as '18 Oct 07:52' in the site zone, and gives back the text it cannot read", () => {
    expect(formatShortTime("2026-10-18T04:52:30Z", "Asia/Qatar")).toBe("18 Oct 07:52");
    expect(formatShortTime("not a time", "Asia/Qatar")).toBe("not a time");
  });

  it("keeps the banner threshold of the Sources page here, and a word for each level", () => {
    expect(OFFLINE_BANNER_SECONDS).toBe(120);
    expect(SOURCES_THRESHOLD, "lib/sourceStatus.ts keeps its own copy of the number; the two must stay equal").toBe(OFFLINE_BANNER_SECONDS);
    expect(LEVEL_WORDS).toEqual({ info: "Info", warning: "Warning", error: "Error" });
  });
});
