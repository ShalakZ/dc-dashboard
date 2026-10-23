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

// The 19 kinds the backend writes (core/journal.py, ingest/kinds.py and collector/identity.py) and the codes of source.offline; the parity test in the backend reads this file's text.
const KINDS = [
  "collector.started", "source.offline", "source.online", "points.bad", "points.recovered", "job.finished", "check.finished", "clock.skew", "http.5xx",
  "figures.mismatch", "readings.conflict", "history.filled", "history.failed", "history.closed_month", "import.finished", "source.identity_changed",
  "data.stale", "data.recovered", "readings.dropped",
];
const CODES = ["unreachable", "auth_failed", "timeout", "protocol_error", "exception", "config_invalid", "secret_undecryptable", "needs_profile", "not_supported"];

describe("eventText (w32): the one table of words", () => {
  it("has a name and a sentence for each of the 19 kinds, and none of the sentences is the raw kind", () => {
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

  describe("data.stale, data.recovered and readings.dropped (w35)", () => {
    const stale = (extra: Partial<SystemEvent> = {}) => event({
      kind: "data.stale", level: "error", code: null, component: "figures", message: "3 of 12 meters have had no good reading for up to 2 h 10 min",
      detail: { state: "open", count: 7, meters: 12, stale: 3, not_advancing: 0, frozen: false, oldest_stale_age_seconds: 7800 },
      incident: incident({ count: 7, duration_seconds: 2 * 3600 }), ...extra,
    });

    it("is named in the Kind filter and says how many meters have no good reading, without the number of times it was found", () => {
      expect(kindName("data.stale")).toBe("Stale meters");
      const text = describeEvent(stale());
      expect(text.headline).toBe("3 of 12 meters have no good reading");
      expect(text.count).toBeNull();
      expect(text.span).toBe("ongoing, 2 h");
      expect(JSON.stringify(text)).not.toMatch(/fail|offline|times/i);
      expect(describeEvent(stale({ incident: incident({ state: "closed", closed_by: "recovered", duration_seconds: 600 }) })).span).toBe("lasted 10 min");
    });

    it("says one meter in the singular and a source whose counters all stand still says they read Good", () => {
      expect(describeEvent(stale({ detail: { meters: 1, stale: 1 } })).headline).toBe("1 of 1 meter has no good reading");
      expect(describeEvent(stale({ detail: { stale: 2 } })).headline).toBe("2 meters have no good reading");
      expect(describeEvent(stale({ level: "warning", detail: { meters: 12, stale: 0, not_advancing: 2 } })).headline).toBe("2 energy counters have not risen");
      expect(describeEvent(stale({ level: "warning", detail: { not_advancing: 1 } })).headline).toBe("1 energy counter has not risen");
      expect(describeEvent(stale({ detail: { meters: 6, stale: 4, frozen: true } })).headline).toBe("Every energy counter of this source stands still although each reads Good");
      expect(describeEvent(stale({ detail: {} })).headline).toBe("Some meters have no good reading");
      expect(() => describeEvent(stale({ detail: { stale: "many", meters: null, frozen: "yes" } }))).not.toThrow();
      expect(() => describeEvent({ ...stale(), detail: null as unknown as Record<string, unknown> })).not.toThrow();
    });

    describe("says every count the incident keeps (silent meters, frozen counters, counters not rising), in the past once it is closed", () => {
      const closed = incident({ state: "closed", closed_by: "recovered", duration_seconds: 7800 });
      const words = (detail: Record<string, unknown>) => ({
        open: describeEvent(stale({ detail })).headline,
        shut: describeEvent(stale({ detail, incident: closed })).headline,
        line: openLine(stale({ detail }), "Asia/Qatar"),
      });

      it("silent meters only", () => {
        const w = words({ meters: 12, stale: 3, not_advancing: 0, frozen: false });
        expect(w.open).toBe("3 of 12 meters have no good reading");
        expect(w.shut).toBe("3 of 12 meters had no good reading");
        expect(words({ meters: 1, stale: 1 }).shut).toBe("1 of 1 meter had no good reading");
      });

      it("counters that have not risen only", () => {
        const w = words({ meters: 12, stale: 0, not_advancing: 2, frozen: false });
        expect(w.open).toBe("2 energy counters have not risen");
        expect(w.shut).toBe("2 energy counters had not risen");
        expect(words({ not_advancing: 1 }).shut).toBe("1 energy counter had not risen");
        expect(w.line).toBe("OPC UA server at 172.20.0.3:4840 has energy counters that stopped rising since 18 Oct 07:52 (2 h). 2 energy counters have not risen.");
      });

      it("a frozen source only (the old rows, which do not say how many counters are frozen, are this too)", () => {
        for (const detail of [{ meters: 4, stale: 4, frozen: true, frozen_counters: 4 }, { meters: 4, stale: 4, frozen: true }]) {
          const w = words(detail);
          expect(w.open).toBe("Every energy counter of this source stands still although each reads Good");
          expect(w.shut).toBe("Every energy counter of this source stood still although each read Good");
        }
      });

      it("a frozen source that also has silent meters says both (stale less the frozen counters, or the silent count when it is kept)", () => {
        for (const detail of [{ meters: 12, stale: 6, frozen: true, frozen_counters: 4 }, { meters: 12, stale: 6, frozen: true, silent: 2 }]) {
          const w = words(detail);
          expect(w.open).toBe("2 of 12 meters have no good reading; every energy counter of this source stands still although each reads Good");
          expect(w.shut).toBe("2 of 12 meters had no good reading; every energy counter of this source stood still although each read Good");
          expect(w.line).toBe(
            "OPC UA server at 172.20.0.3:4840 has stale meters since 18 Oct 07:52 (2 h). 2 of 12 meters have no good reading; every energy counter of this source stands still although each reads Good.",
          );
        }
        expect(words({ meters: 4, stale: 4, frozen: true, frozen_counters: 4 }).open).not.toMatch(/no good reading/); // every stale meter is a frozen counter: no silent part
      });

      it("silent meters and counters that have not risen say both, in the order the backend message has", () => {
        const w = words({ meters: 667, stale: 44, not_advancing: 19, frozen: false });
        expect(w.open).toBe("44 of 667 meters have no good reading; 19 energy counters have not risen");
        expect(w.shut).toBe("44 of 667 meters had no good reading; 19 energy counters had not risen");
        expect(w.line).toBe("OPC UA server at 172.20.0.3:4840 has stale meters since 18 Oct 07:52 (2 h). 44 of 667 meters have no good reading; 19 energy counters have not risen.");
      });

      it("all three parts", () => {
        const w = words({ meters: 20, stale: 6, not_advancing: 3, frozen: true, frozen_counters: 4 });
        expect(w.open).toBe("2 of 20 meters have no good reading; every energy counter of this source stands still although each reads Good; 3 energy counters have not risen");
        expect(w.shut).toBe("2 of 20 meters had no good reading; every energy counter of this source stood still although each read Good; 3 energy counters had not risen");
      });

      it("leaves a zero part out, groups thousands and never says 'times', 'failed' or 'offline'", () => {
        const w = words({ meters: 1334, stale: 1204, not_advancing: 0, frozen: false });
        expect(w.open).toBe("1,204 of 1,334 meters have no good reading");
        expect(words({ meters: 5000, stale: 0, not_advancing: 1204 }).open).toBe("1,204 energy counters have not risen");
        for (const line of [w.open, w.shut, w.line, words({ meters: 667, stale: 44, not_advancing: 19 }).shut]) expect(line).not.toMatch(/fail|offline|times/i);
      });

      it("does not throw on an old row with keys missing or of the wrong type, and says the plain fallback in the right tense", () => {
        const w = words({});
        expect(w.open).toBe("Some meters have no good reading");
        expect(w.shut).toBe("Some meters had no good reading");
        expect(words({ meters: 12, stale: 0, not_advancing: 0, frozen: false }).open).toBe("Some meters have no good reading");
        for (const detail of [{ stale: "many", meters: null, frozen: "yes", not_advancing: "x", silent: "y", frozen_counters: [] }, { frozen: true }, { frozen: true, stale: 2, frozen_counters: 5 }]) {
          expect(() => words(detail)).not.toThrow();
        }
        expect(() => describeEvent({ ...stale({ incident: closed }), detail: undefined as unknown as Record<string, unknown> })).not.toThrow();
      });
    });

    it("pins a stale source the way the page pins an incident, without 'offline' and without a number of failed reads", () => {
      expect(openLine(stale(), "Asia/Qatar")).toBe("OPC UA server at 172.20.0.3:4840 has stale meters since 18 Oct 07:52 (2 h). 3 of 12 meters have no good reading.");
      const slow = openLine(stale({ level: "warning", detail: { meters: 12, stale: 0, not_advancing: 2 } }), "Asia/Qatar");
      expect(slow).toBe("OPC UA server at 172.20.0.3:4840 has energy counters that stopped rising since 18 Oct 07:52 (2 h). 2 energy counters have not risen.");
      for (const line of [openLine(stale(), "Asia/Qatar"), slow, openLine(stale({ detail: {}, incident: null }), "Asia/Qatar")]) {
        expect(line).not.toMatch(/offline|failed|\b7\b/);
      }
      expect(openLine(stale({ source_id: null, source_name: null }), "Asia/Qatar")).toMatch(/^The system has stale meters since /);
    });

    it("words a recovery and the readings the writer had to drop", () => {
      expect(kindName("data.recovered")).toBe("Meters reporting again");
      expect(describeEvent(event({ kind: "data.recovered", level: "info", code: null, detail: { incident_id: 5, stale_seconds: 7800, meters: 12 } })).headline).toBe(
        "Meters reporting again after 2 h 10 min",
      );
      expect(describeEvent(event({ kind: "data.recovered", level: "info", code: null, detail: {} })).headline).toBe("Meters reporting again");
      expect(kindName("readings.dropped")).toBe("Readings dropped");
      expect(describeEvent(event({ kind: "readings.dropped", level: "error", code: null, source_id: null, source_name: null, detail: { dropped: 1204, buffer: 100000 } })).headline).toBe(
        "1,204 readings were dropped because the database did not take them in time",
      );
      expect(describeEvent(event({ kind: "readings.dropped", detail: { dropped: 1 } })).headline).toMatch(/^1 reading was dropped/);
      expect(describeEvent(event({ kind: "readings.dropped", detail: {} })).headline).toBe("Readings were dropped because the database did not take them in time");
    });
  });

  describe("source.identity_changed (w33): another server answers, or the same server renewed its certificate", () => {
    const THUMB_OLD = "3A:5F:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:12:91";
    const THUMB_NEW = "7C:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:E2";
    const different = (extra: Partial<SystemEvent> = {}) => event({
      kind: "source.identity_changed", level: "warning", code: null, message: "The server answering at this address is not the one this source used to talk to.",
      detail: {
        before: { application_uri: "urn:dcdash:simulator:dev", thumbprint: THUMB_OLD },
        after: { application_uri: "urn:dcdash:simulator:other", thumbprint: THUMB_NEW },
      },
      ...extra,
    });
    const renewed = (extra: Partial<SystemEvent> = {}) => event({
      kind: "source.identity_changed", level: "info", code: null, message: "The server's certificate changed.",
      detail: {
        before: { application_uri: "urn:dcdash:simulator:dev", thumbprint: THUMB_OLD },
        after: { application_uri: "urn:dcdash:simulator:dev", thumbprint: THUMB_NEW },
      },
      ...extra,
    });

    it("is named in the Kind filter and says in the headline that a different server answers at the address", () => {
      expect(kindName("source.identity_changed")).toBe("Server identity");
      expect(describeEvent(different()).headline).toBe("A different server answers at this address");
    });

    it("names the old and the new server and their certificates in the line under the headline, the thumbprints cut short", () => {
      const text = describeEvent(different());
      expect(text.reason).toBe(
        "It used to be urn:dcdash:simulator:dev, certificate 3A:5F:...:91. Now it is urn:dcdash:simulator:other, certificate 7C:01:...:E2.",
      );
      expect(text.count).toBeNull();
      expect(text.span).toBeNull();
      expect(JSON.stringify(text)).not.toContain(THUMB_OLD); // the whole fingerprint is in the stored detail, one click away
    });

    it("reads the simulator's instance id and an application name when there is no application URI", () => {
      const text = describeEvent(different({
        detail: { before: { instance: "dev", thumbprint: null }, after: { application_name: "Prosys OPC UA Simulation Server" } },
      }));
      expect(text.reason).toBe('It used to be the simulator "dev". Now it is Prosys OPC UA Simulation Server.');
    });

    it("reads as a notice, not a warning, when the same server renewed its certificate (the same kind at the info level)", () => {
      const text = describeEvent(renewed());
      expect(text.headline).toBe("The server's certificate changed");
      expect(text.headline).not.toMatch(/different/i);
      expect(text.reason).toBe("It is still urn:dcdash:simulator:dev. Certificate 3A:5F:...:91 was replaced by 7C:01:...:E2.");
      // the level tag the page draws comes from the row, not from the words: the kind is the same, the level is info
      expect(renewed().level).toBe("info");
    });

    it("never throws and keeps the headline when the detail is missing, of the wrong shape or half there", () => {
      for (const detail of [{}, { before: null, after: "x" }, { before: [], after: [] }, { before: { thumbprint: 7 }, after: { application_uri: 4 } }, { before: {} }]) {
        expect(() => describeEvent(different({ detail })), JSON.stringify(detail)).not.toThrow();
        expect(describeEvent(different({ detail })).headline).toBe("A different server answers at this address");
        expect(describeEvent(renewed({ detail })).headline).toBe("The server's certificate changed");
      }
      expect(describeEvent(different({ detail: {} })).reason).toBeNull();
      expect(describeEvent(renewed({ detail: { before: { application_uri: "urn:a" } } })).reason).toBe("It is still urn:a.");
      expect(() => describeEvent({ ...different(), detail: null as unknown as Record<string, unknown> })).not.toThrow();
      // a short thumbprint is shown whole
      expect(describeEvent(different({ detail: { before: { application_uri: "urn:a", thumbprint: "AB:CD" }, after: { application_uri: "urn:b" } } })).reason)
        .toBe("It used to be urn:a, certificate AB:CD. Now it is urn:b.");
    });
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
