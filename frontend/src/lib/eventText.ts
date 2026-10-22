import type { EventLevel, SystemEvent } from "../api/types";
import { formatSpanLong } from "./age";
import { stepLabel } from "./diagnostics";
import { formatSiteDateTime } from "./siteTime";

/**
 * The one table of words of the System events page (w32): a name for each kind the backend writes, a headline and a plain reason for each code of a
 * source that goes offline, and the sentences built from a row's stored detail. Every kind of `core/journal.py`, `ingest/kinds.py` and `collector/identity.py` and every
 * status a connector can raise (`ConnectorError("<status>"`) appears below as a quoted word: `backend/tests/test_events_text_parity.py` reads this
 * file's text and fails when the backend writes one that is missing. A kind or a code that is not here falls back to the stored text and never throws.
 */

/** The Sources page says a source is offline once it has been out of reach this long (`offline_since` older than this). */
export const OFFLINE_BANNER_SECONDS = 120;

export const LEVEL_WORDS: Readonly<Record<EventLevel, string>> = { info: "Info", warning: "Warning", error: "Error" };

/** The friendly name of each kind (the Kind filter, the drawer). */
export const KIND_NAMES: Readonly<Record<string, string>> = {
  "collector.started": "Collector started",
  "source.offline": "Source went offline",
  "source.online": "Source back online",
  "points.bad": "Bad readings",
  "points.recovered": "Readings good again",
  "job.finished": "Background job",
  "check.finished": "Connection check",
  "clock.skew": "Clock difference",
  "http.5xx": "Server error",
  "figures.mismatch": "Figure check",
  "readings.conflict": "Conflicting readings",
  "history.filled": "History filled in",
  "history.failed": "History problem",
  "history.closed_month": "Closed month touched",
  "import.finished": "File import",
  "source.identity_changed": "Server identity",
};

export const kindName = (kind: string): string => KIND_NAMES[kind] ?? kind;

/** What a person is told about a failure code, in a sentence (the stored text is one click away). */
const CODE_REASONS: Readonly<Record<string, string>> = {
  "unreachable": "Could not connect to the server.",
  "auth_failed": "The server did not accept the user name or password.",
  "timeout": "The server did not answer in time.",
  "protocol_error": "The server answered in a way the dashboard could not use.",
  "exception": "Reading failed with an unexpected error.",
  "config_invalid": "The source's settings are not valid, so it is not being read.",
  "secret_undecryptable": "The stored password cannot be read, so the source is not being read.",
  "needs_profile": "No device profile is chosen for this source.",
  "not_supported": "This source cannot do that.",
};

/** The plain sentence for a code, or null for a code that is not known. */
export const codeReason = (code: string | null | undefined): string | null => (code ? (CODE_REASONS[code] ?? null) : null);

/** The headline of a source that went offline, by the code of the failure. */
const OFFLINE_HEADLINES: Readonly<Record<string, string>> = {
  "unreachable": "Went offline: could not reach the server",
  "auth_failed": "Went offline: the server refused the sign-in",
  "timeout": "Went offline: the server did not answer in time",
  "protocol_error": "Went offline: the server's answer could not be used",
  "exception": "Went offline: an unexpected error",
  "config_invalid": "Not being read: the source's settings are not valid",
  "secret_undecryptable": "Not being read: the stored password cannot be read",
  "needs_profile": "Went offline: no device profile is chosen",
  "not_supported": "Went offline: this source cannot do that",
};

/** In the pinned line a source "is offline"; these two codes mean it was never read at all. */
const NOT_READ_CODES: ReadonlySet<string> = new Set(["config_invalid", "secret_undecryptable"]);

const JOB_NAMES: Readonly<Record<string, string>> = {
  "test_source": "connection test",
  "check_connection": "connection check",
  "browse_source": "browse",
  "scan": "scan",
  "history_fill": "history fill",
};

const HISTORY_HEADLINES: Readonly<Record<string, string>> = {
  "not_supported": "This source keeps no history",
  "unknown_addresses": "The source does not have some of the mapped addresses",
  "set_aside": "Some points could not be read from the history",
  "owed_range_dropped": "Some rollups could not be refreshed and were left as they are",
  "auth_failed": "The source refused the sign-in while its history was read",
  "refresh_failed": "The history backfill stopped",
};

type Detail = Record<string, unknown>;
const isRecord = (value: unknown): value is Detail => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const n = (value: number) => value.toLocaleString("en-US");
const times = (count: number) => `${n(count)} ${count === 1 ? "time" : "times"}`;
const reads = (count: number) => `${n(count)} failed ${count === 1 ? "read" : "reads"}`;
const polls = (count: number) => `${n(count)} ${count === 1 ? "poll" : "polls"}`;

/** The thumbprint kept to its first 5 and last 2 characters (`3A:5F:...:91`, the same cut as the Discovery panel's); a short one is shown whole. */
const shortThumbprint = (value: string): string => (value.length > 12 ? `${value.slice(0, 5)}:...:${value.slice(-2)}` : value);

/** Who a server said it is, in a few words, and its certificate; null for a side the stored detail does not describe. */
function serverWords(side: unknown): { who: string | null; thumbprint: string | null } | null {
  if (!isRecord(side)) return null;
  const uri = text(side.application_uri);
  const instance = text(side.instance);
  const name = text(side.application_name);
  const who = uri ?? (instance ? `the simulator "${instance}"` : name);
  const thumbprint = text(side.thumbprint);
  return who === null && thumbprint === null ? null : { who, thumbprint };
}

const withCertificate = (server: { who: string | null; thumbprint: string | null }): string =>
  [server.who, server.thumbprint ? `certificate ${shortThumbprint(server.thumbprint)}` : null].filter((part) => part !== null).join(", ");

/**
 * source.identity_changed (w33) at its two levels, by the level of the row: `warning` = another server answers at the source's address (the old and the new one
 * are named, the certificates cut short); `info` = the same server renewed its certificate (a notice, not a problem). The stored detail is `{before, after}`, each
 * side the strings that server announced; any of it can be missing, and the line under the headline then says less.
 */
function identityChanged(event: SystemEvent, detail: Detail): { headline: string; reason: string | null } {
  const before = serverWords(detail.before);
  const after = serverWords(detail.after);
  if (event.level === "info") {
    const who = after?.who ?? before?.who ?? null;
    const sentences = [
      who ? `It is still ${who}.` : null,
      before?.thumbprint && after?.thumbprint ? `Certificate ${shortThumbprint(before.thumbprint)} was replaced by ${shortThumbprint(after.thumbprint)}.`
        : after?.thumbprint ? `The new certificate is ${shortThumbprint(after.thumbprint)}.` : null,
    ].filter((part) => part !== null);
    return { headline: "The server's certificate changed", reason: sentences.length > 0 ? sentences.join(" ") : null };
  }
  const sentences = [
    before ? `It used to be ${withCertificate(before)}.` : null,
    after ? `Now it is ${withCertificate(after)}.` : null,
  ].filter((part) => part !== null);
  return { headline: "A different server answers at this address", reason: sentences.length > 0 ? sentences.join(" ") : null };
}

/** What a Friendly row says: the headline, a plain reason under it, how many times it happened and how long it lasted (incidents only). */
export interface EventText { headline: string; reason: string | null; count: string | null; span: string | null }

function after(base: string, seconds: unknown): string {
  const value = num(seconds);
  return value === null ? base : `${base} after ${formatSpanLong(value)}`;
}

function headlineOf(event: SystemEvent, detail: Detail): { headline: string; reason?: string | null; count?: string | null } {
  const { kind, code } = event;
  switch (kind) {
    case "collector.started":
      return { headline: "The collector started" };
    case "source.offline": {
      const known = code ? OFFLINE_HEADLINES[code] : undefined;
      if (known) return { headline: known, reason: codeReason(code) };
      return { headline: "Went offline", reason: event.message || null };
    }
    case "source.online": {
      const failed = num(detail.failed_reads);
      return { headline: after("Back online", detail.offline_seconds), count: failed === null ? null : `${n(failed)} failed ${failed === 1 ? "read" : "reads"} counted` };
    }
    case "points.bad": {
      const bad = num(detail.bad);
      const total = num(detail.total);
      return { headline: bad !== null && total !== null ? `${n(bad)} of ${n(total)} points read badly` : "Some points read badly" };
    }
    case "points.recovered": {
      const bad = num(detail.polls_with_bad_readings);
      return { headline: after("All points read good again", detail.bad_seconds), count: bad === null ? null : `${n(bad)} ${bad === 1 ? "poll" : "polls"} had bad readings` };
    }
    case "job.finished": {
      const job = text(detail.kind);
      const name = job ? (JOB_NAMES[job] ?? null) : null;
      const failed = detail.ok === false;
      const subject = name ? `The ${name}` : "A background job";
      // A test says whether it passed; browsing the source "finished" in its own words; the plain reason of a failure comes from its code, the stored text only for a code not in the table.
      const verb = failed ? "failed" : job === "test_source" ? "passed" : "finished";
      const headline = !failed && job === "browse_source" ? "Browsing the source finished" : `${subject} ${verb}`;
      return { headline, reason: failed ? (codeReason(code) ?? text(detail.error)) : null };
    }
    case "check.finished": {
      if (detail.ok === true) {
        const steps = num(detail.steps);
        return { headline: steps === null ? "The connection check passed" : `The connection check passed (${n(steps)} ${steps === 1 ? "step" : "steps"})` };
      }
      const step = text(detail.first_failed);
      return { headline: step ? `The connection check failed at "${stepLabel({ id: step, name: "" })}"` : "The connection check failed" };
    }
    case "clock.skew": {
      const skew = num(detail.skew_seconds);
      if (skew === null) return { headline: "The source's clock differs from ours" };
      return { headline: `The source's clock is ${formatSpanLong(Math.abs(skew))} ${skew >= 0 ? "ahead of" : "behind"} ours` };
    }
    case "http.5xx":
      return { headline: "The dashboard hit a server error" };
    case "figures.mismatch":
      return { headline: "A stored figure was found wrong and worked out again" };
    case "readings.conflict":
      return { headline: "Readings were sent again with different values; the stored ones were kept" };
    case "history.filled": {
      const filled = num(detail.new);
      return { headline: filled === null ? "Readings were filled in from the source's history" : `${n(filled)} ${filled === 1 ? "reading was" : "readings were"} filled in from the source's history` };
    }
    case "history.failed": {
      const known = code ? HISTORY_HEADLINES[code] : undefined;
      return { headline: known ?? "The history of the source could not be read", reason: known ? null : (codeReason(code) ?? (event.message || null)) };
    }
    case "history.closed_month": {
      const month = text(detail.month);
      return { headline: month ? `Readings were filled into ${month}, a month that is closed` : "Readings were filled into a month that is closed" };
    }
    case "import.finished":
      return { headline: event.level === "warning" || event.level === "error" ? "A file import stopped half-way" : "A file import finished" };
    case "source.identity_changed":
      return identityChanged(event, detail);
    default:
      return { headline: event.message || kind };
  }
}

/** The words of one event, from the kind, the code, the incident and the stored detail. Never throws, whatever the row holds. */
export function describeEvent(event: SystemEvent): EventText {
  const detail = isRecord(event.detail) ? event.detail : {};
  const base = headlineOf(event, detail);
  const incident = event.incident;
  let count: string | null = base.count ?? null;
  let span: string | null = null;
  if (incident) {
    count = event.kind === "points.bad" ? `${polls(incident.count)} with bad readings` : `failed ${times(incident.count)}`;
    const length = formatSpanLong(incident.duration_seconds);
    span =
      incident.state === "open" ? `ongoing, ${length}` : incident.closed_by === "polling_stopped" ? `stopped being read after ${length}` : `lasted ${length}`;
  }
  return { headline: base.headline, reason: base.reason ?? null, count, span };
}

/** The name the row shows for its source: the name, "deleted source #3", or null for an event of no source. */
export function sourceLabel(event: Pick<SystemEvent, "source_id" | "source_name" | "source_deleted">): string | null {
  if (event.source_name) return event.source_name;
  if (event.source_id === null) return null;
  return event.source_deleted ? `deleted source #${event.source_id}` : `source #${event.source_id}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `18 Oct 07:52` in the site zone; the text itself when it cannot be read as a time. */
export function formatShortTime(iso: string, timezone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(formatSiteDateTime(iso, timezone));
  return match ? `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[4]}:${match[5]}` : iso;
}

/**
 * The line of a problem that is still open, as the page pins it above the list: who, since when (and for how long), how many failed reads, and the plain
 * reason: `OPC UA server at 172.20.0.3:4840 is offline since 18 Oct 07:52 (4 d 2 h), 1,204 failed reads. Could not connect to the server.`
 */
export function openLine(event: SystemEvent, timezone: string): string {
  const incident = event.incident;
  const name = sourceLabel(event) ?? "The system";
  const verb = event.kind === "points.bad" ? "has bad readings" : event.code && NOT_READ_CODES.has(event.code) ? "cannot be read" : "is offline";
  const since = formatShortTime(incident?.first_at ?? event.ts, timezone);
  const length = incident ? ` (${formatSpanLong(incident.duration_seconds)})` : "";
  const failures = !incident ? "" : event.kind === "points.bad" ? `, ${polls(incident.count)} with bad readings` : `, ${reads(incident.count)}`;
  const reason = event.kind === "points.bad" ? null : describeEvent(event).reason;
  return `${name} ${verb} since ${since}${length}${failures}.${reason ? ` ${reason}` : ""}`;
}
