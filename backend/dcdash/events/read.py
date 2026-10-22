"""Reading the system events (w32): the filtered list with its keyset cursor, one event, the options, the summary and the CSV.

The system events are the rows of `diag_events`. Everything here is read only and writes no audit row. Three rules hold for all of it:

* SQL is built from fixed fragments and bound parameters only: a filter value (a kind, a level, a day, a cursor) is never put
  into the text of a statement.
* Every text that leaves goes through `scrub_strings` once more, with no `known` list (the reader does not know the source's
  secrets, and the writer may have been an older version or a code path that did not scrub): `message`, `code` and every string
  of `detail`.
* The list is ordered by `(ts, id)`, newest first, and paged by a cursor `<epoch microseconds>_<id>`. A bumped incident keeps its
  `ts` (only its count and `last_at` move), so a page never repeats or skips a row because the journal changed under it.
"""
import json
import re
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import ColumnElement, Integer, Text, and_, any_, func, literal, or_, select, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.audit import clip_error, scrub_strings, scrub_url_credentials
from dcdash.core.models import DiagEvent, Job, Source
from dcdash.core.timeutil import local_midnight
from dcdash.events import settings as events_settings

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
TOTAL_CAP = 10_000  # the list counts at most this many matches (and says when there are more)
EXPORT_LIMIT = 20_000  # the CSV is built in memory on the one API worker: the same limit as the audit export
CSV_HEADER = (
    "id", "time", "level", "source", "kind", "code", "message", "state", "count", "first_at", "last_at", "closed_at",
    "duration_seconds", "detail",
)
MAX_ID = 2_147_483_647
# The jobs a person starts from the Audit page and whose end is a journal event: the event links back to the audit entry.
STARTED_JOB_KINDS = ("test_source", "check_connection")
CLOSED_BY = ("recovered", "polling_stopped")

_COLUMNS = (
    DiagEvent.id, DiagEvent.ts, DiagEvent.level, DiagEvent.component, DiagEvent.source_id, DiagEvent.kind, DiagEvent.code,
    DiagEvent.message, DiagEvent.detail,
)
_NEWEST_FIRST = (DiagEvent.ts.desc(), DiagEvent.id.desc())
_OPEN = DiagEvent.detail["state"].astext == "open"
_CURSOR = re.compile(r"[0-9]{1,17}_[0-9]{1,18}")  # digits only: URL-safe, exact; 17 digits of microseconds reach the year 5138


@dataclass
class EventFilter:
    source: int | None = None  # a source id
    levels: list[str] = field(default_factory=list)  # any of these (info | warning | error)
    kinds: list[str] = field(default_factory=list)  # any of these
    date_from: date | None = None  # site days, both ends inclusive
    date_to: date | None = None
    open_only: bool = False  # only incidents that are still open


class ExportTooLarge(Exception):
    """More events match than the CSV may hold; `str(error)` is the sentence the caller shows."""

    def __init__(self, matched: int) -> None:
        super().__init__(f"{matched:,} events match; the export holds at most {EXPORT_LIMIT:,}. Narrow the date range and try again.")


def where(f: EventFilter, tz: str) -> list[ColumnElement[bool]]:
    """The WHERE conditions of a filter. Levels and kinds are bound arrays (`= ANY(:list)`); days are days in the site time zone
    `tz`, both ends inclusive."""
    clauses: list[ColumnElement[bool]] = []
    if f.source is not None:
        clauses.append(DiagEvent.source_id == f.source)
    if f.levels:
        clauses.append(DiagEvent.level == any_(literal(list(f.levels), ARRAY(Text))))
    if f.kinds:
        clauses.append(DiagEvent.kind == any_(literal(list(f.kinds), ARRAY(Text))))
    if f.date_from is not None:
        clauses.append(DiagEvent.ts >= local_midnight(f.date_from, tz))
    if f.date_to is not None:
        clauses.append(DiagEvent.ts < local_midnight(f.date_to + timedelta(days=1), tz))
    if f.open_only:
        clauses.append(_OPEN)
    return clauses


def cursor_of(ts: datetime, event_id: int) -> str:
    """The cursor that continues the list after this row: `<epoch microseconds>_<id>` (exact: no floating point)."""
    return f"{(ts - EPOCH) // timedelta(microseconds=1)}_{event_id}"


def parse_cursor(value: str) -> tuple[datetime, int] | None:
    """(time, id) of a cursor, or None when `value` is not one."""
    if _CURSOR.fullmatch(value) is None:
        return None
    micros, event_id = value.split("_")
    try:
        return EPOCH + timedelta(microseconds=int(micros)), int(event_id)
    except OverflowError:
        return None


def _after(cursor: tuple[datetime, int]) -> ColumnElement[bool]:
    ts, event_id = cursor
    # `ts <= :ts` first: a plain range on the indexed column, so the planner can walk the ts index instead of a row comparison
    return and_(DiagEvent.ts <= ts, or_(DiagEvent.ts < ts, DiagEvent.id < event_id))


async def source_names(db: AsyncSession, ids: Iterable[int]) -> dict[int, str]:
    """The current names of the sources among `ids` (a source that is gone is left out)."""
    wanted = sorted(set(ids))
    if not wanted:
        return {}
    rows = await db.execute(select(Source.id, Source.name).where(Source.id == any_(literal(wanted, ARRAY(Integer)))))
    return {source_id: name for source_id, name in rows}


def _when(value: Any, fallback: datetime | None) -> datetime | None:
    """A time stored in a detail (an ISO text written by the database), else `fallback`."""
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return fallback
        return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)
    return fallback


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def incident(ts: datetime, detail: Any, now: datetime) -> dict[str, Any] | None:
    """The incident view of a row: None for a row that is not one (no `state` of open or closed in its detail, which is every
    row written before w32 and every other kind of event).

    `first_at` is the true start (`since`, when the source was already offline before the collector noticed), else the row's
    time; `last_at` the latest failed read; the duration is the stored one when closed, else measured at read time."""
    if not isinstance(detail, dict) or detail.get("state") not in ("open", "closed"):
        return None
    state = detail["state"]
    first = _when(detail.get("since"), ts) or ts
    last = _when(detail.get("last_at"), ts) or ts
    closed_at = _when(detail.get("closed_at"), None) if state == "closed" else None
    if state == "open":
        seconds = (now - first).total_seconds()
    elif _number(detail.get("duration_seconds")):
        seconds = float(detail["duration_seconds"])
    elif closed_at is not None:
        seconds = (closed_at - first).total_seconds()
    else:
        seconds = 0.0
    count = detail.get("count")
    closed_by = detail.get("closed_by") if state == "closed" and detail.get("closed_by") in CLOSED_BY else None
    return {
        "state": state,
        "count": count if type(count) is int and count >= 0 else 1,
        "first_at": first,
        "last_at": last,
        "closed_at": closed_at,
        "duration_seconds": int(max(seconds, 0)),
        "closed_by": closed_by,
    }


def shape(row: Any, names: Mapping[int, str], *, now: datetime) -> dict[str, Any]:
    """One event as the API answers it. `names` holds the current names of the sources that exist: a row of a source that is not
    in it is of a deleted source. Message, code and detail are scrubbed here a second time, with no `known` list."""
    source_id = row.source_id
    return {
        "id": row.id,
        "ts": row.ts,
        "level": row.level,
        "component": row.component,
        "source_id": source_id,
        "source_name": names.get(source_id) if source_id is not None else None,
        "source_deleted": source_id is not None and source_id not in names,
        "kind": row.kind,
        "code": scrub_strings(row.code),
        "message": scrub_strings(row.message),
        "detail": scrub_strings(row.detail),
        "incident": incident(row.ts, row.detail, now),
    }


async def page(
    db: AsyncSession, f: EventFilter, tz: str, before: tuple[datetime, int] | None, limit: int, include_total: bool
) -> dict[str, Any]:
    """One page of the list, newest first: `{items, next, total, total_capped}`. `next` is the cursor of the page after this one
    (None on the last); `total` counts the filter (not the cursor) up to TOTAL_CAP, and is None unless asked for."""
    clauses = where(f, tz)
    query = select(*_COLUMNS).where(*clauses)
    if before is not None:
        query = query.where(_after(before))
    rows = (await db.execute(query.order_by(*_NEWEST_FIRST).limit(limit + 1))).all()
    more = len(rows) > limit
    rows = rows[:limit]
    names = await source_names(db, {row.source_id for row in rows if row.source_id is not None})
    now = datetime.now(timezone.utc)
    total, capped = None, False
    if include_total:
        matched = await db.scalar(select(func.count()).select_from(select(DiagEvent.id).where(*clauses).limit(TOTAL_CAP + 1).subquery()))
        total, capped = min(matched or 0, TOTAL_CAP), (matched or 0) > TOTAL_CAP
    return {
        "items": [shape(row, names, now=now) for row in rows],
        "next": cursor_of(rows[-1].ts, rows[-1].id) if more else None,
        "total": total,
        "total_capped": capped,
    }


# Who started the job whose end this event is: the newest audit entry of an action that starts a job and names it. A single
# job is `detail.job_id`, a "test all" lists its jobs in `detail.job_ids`. `audit_log` has no index on the detail, so this walks
# the newest entries first and stops at the first match (the entry is written just before the job runs).
_STARTED_BY = text(
    """
    SELECT a.id, a.ts, COALESCE(a.actor_name, u.username) AS username
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.action IN ('source.tested', 'source.checked', 'source.test_all')
      AND (a.detail->>'job_id' = :job_text OR a.detail->'job_ids' @> to_jsonb(CAST(:job AS integer)))
    ORDER BY a.id DESC LIMIT 1
    """
)


def job_of(kind: str, detail: Any) -> int | None:
    """The id of the job an event reports the end of, for the two kinds of event that end a job a person started (a connection
    check, a source test); None for any other event or a detail that holds no whole number in range."""
    if not isinstance(detail, dict):
        return None
    if kind == "job.finished" and detail.get("kind") not in STARTED_JOB_KINDS:
        return None
    if kind not in ("check.finished", "job.finished"):
        return None
    job_id = detail.get("job_id")
    return job_id if type(job_id) is int and 0 < job_id <= MAX_ID else None


async def started_by(db: AsyncSession, kind: str, detail: Any) -> dict[str, Any] | None:
    """`{audit_id, username, ts}` of the audit entry that started the job this event ended, else None. `username` is the name
    the entry copied when it was written, so it survives the account (None when nobody was signed in)."""
    job_id = job_of(kind, detail)
    if job_id is None:
        return None
    row = (await db.execute(_STARTED_BY, {"job": job_id, "job_text": str(job_id)})).first()
    return None if row is None else {"audit_id": row.id, "username": row.username, "ts": row.ts}


async def one(db: AsyncSession, event_id: int, *, with_started_by: bool) -> dict[str, Any] | None:
    """One event, with `started_by` (always present: None unless `with_started_by` and an audit entry started it), or None."""
    row = (await db.execute(select(*_COLUMNS).where(DiagEvent.id == event_id))).first()
    if row is None:
        return None
    names = await source_names(db, [row.source_id] if row.source_id is not None else [])
    event = shape(row, names, now=datetime.now(timezone.utc))
    event["started_by"] = await started_by(db, row.kind, row.detail) if with_started_by else None
    return event


async def summary(db: AsyncSession) -> dict[str, Any]:
    """The tiles of the page: open incidents, warnings and errors of the last 24 hours, what is kept, and the retention."""
    day_ago = func.now() - timedelta(hours=24)
    open_now, warnings, errors, kept, oldest = (
        await db.execute(
            select(
                func.count().filter(_OPEN),
                func.count().filter(and_(DiagEvent.level == "warning", DiagEvent.ts >= day_ago)),
                func.count().filter(and_(DiagEvent.level == "error", DiagEvent.ts >= day_ago)),
                func.count(),
                func.min(DiagEvent.ts),
            )
        )
    ).one()
    current = await events_settings.load(db)
    return {
        "open_incidents": open_now,
        "warnings_24h": warnings,
        "errors_24h": errors,
        "kept": kept,
        "oldest": oldest,
        "retention_days": current.retention_days,
        "max_rows": current.max_rows,
    }


async def options(db: AsyncSession) -> dict[str, Any]:
    """The kinds that occur in the journal, and the sources that have events (a source that is gone is named by its id)."""
    kinds = (await db.scalars(select(DiagEvent.kind).distinct().order_by(DiagEvent.kind))).all()
    with_events = (await db.scalars(select(DiagEvent.source_id).where(DiagEvent.source_id.is_not(None)).distinct())).all()
    names = await source_names(db, with_events)
    sources = sorted(
        ({"id": source_id, "name": names.get(source_id, f"deleted source #{source_id}")} for source_id in with_events),
        key=lambda source: (source["name"].casefold(), source["id"]),
    )
    return {"kinds": list(kinds), "sources": sources}


async def export_rows(db: AsyncSession, f: EventFilter, tz: str) -> tuple[Sequence[Any], dict[int, str]]:
    """The rows a CSV holds (newest first) and the names of their sources. Raises ExportTooLarge when more than EXPORT_LIMIT match."""
    clauses = where(f, tz)
    rows = (await db.execute(select(*_COLUMNS).where(*clauses).order_by(*_NEWEST_FIRST).limit(EXPORT_LIMIT + 1))).all()
    if len(rows) > EXPORT_LIMIT:
        raise ExportTooLarge(await db.scalar(select(func.count()).select_from(DiagEvent).where(*clauses)) or len(rows))
    return rows, await source_names(db, {row.source_id for row in rows if row.source_id is not None})


def csv_rows(rows: Iterable[Any], names: Mapping[int, str], zone: ZoneInfo, now: datetime) -> Iterator[list[object]]:
    """The cells of each CSV row, in the order of CSV_HEADER: scrubbed like the list, times in the site zone `zone`, the detail as
    JSON. (A generator, so a caller can run it in a worker thread; `write_csv` makes every cell formula-safe.)"""

    def local(moment: datetime | None) -> datetime | None:
        return None if moment is None else moment.astimezone(zone)

    for row in rows:
        event = shape(row, names, now=now)
        inc = event["incident"]
        source = "" if event["source_id"] is None else event["source_name"] or f"deleted source #{event['source_id']}"
        yield [
            event["id"], local(event["ts"]), event["level"], source, event["kind"], event["code"], event["message"],
            inc["state"] if inc else "", inc["count"] if inc else "", local(inc["first_at"]) if inc else "",
            local(inc["last_at"]) if inc else "", local(inc["closed_at"]) if inc else "", inc["duration_seconds"] if inc else "",
            json.dumps(event["detail"], ensure_ascii=False),
        ]


def _obj(value: Any) -> Any:
    """A JSONB value as Python data: a `text()` query may hand it back as undecoded text (a Core `select` decodes it itself)."""
    if isinstance(value, (str, bytes)):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


# The newest open `source.offline` row of each source asked about: one statement for all of them, never one per source.
_OPEN_OFFLINE = text(
    """
    SELECT DISTINCT ON (source_id) source_id, ts, detail
    FROM diag_events
    WHERE kind = 'source.offline' AND detail->>'state' = 'open' AND source_id = ANY(:ids)
    ORDER BY source_id, id DESC
    """
)


async def open_incidents(db: AsyncSession, source_ids: Iterable[int]) -> dict[int, dict[str, Any]]:
    """The open `source.offline` incident of each source that has one: `{source_id: {"first_at": datetime, "count": int}}`.

    `first_at` is the true start (`detail.since`, else the row's time), `count` the failed reads counted so far. One query for
    all the sources, none for an empty list. A source with no open incident is not in the answer."""
    ids = sorted(set(source_ids))
    if not ids:
        return {}
    now = datetime.now(timezone.utc)
    found: dict[int, dict[str, Any]] = {}
    for row in (await db.execute(_OPEN_OFFLINE, {"ids": ids})).all():
        view = incident(row.ts, _obj(row.detail), now)
        if view is not None:
            found[row.source_id] = {"first_at": view["first_at"], "count": view["count"]}
    return found


# ---- how a started check or test ended (the Audit page's `outcome`) -----------------------------------------------------

OUTCOME_ACTIONS = ("source.tested", "source.checked", "source.test_all")
_ENDING_EVENTS = ("check.finished", "job.finished")  # the journal rows that end a job a person started (see `job_of`)
_JOB_OF_ACTION = {"source.tested": "test", "source.checked": "check", "source.test_all": "test"}
# The page's own step labels (`STEP_NAMES` in frontend/src/lib/diagnostics.ts): the Audit outcome and System events name the same step
# in the same words. `tests/test_events_text_parity.py` holds the two tables equal.
_STEP_WORDS = {
    "dns": "DNS resolution", "tcp": "TCP connection", "endpoints": "Server endpoints", "certificates": "Certificates",
    "session": "Session", "server_time": "Server clock", "namespaces": "Namespaces", "read_points": "Reading the points",
    "timing": "Read timing", "test": "Connection test",
}
# What a person is told about the failure code of a test (the status of the connector's error): the same sentences as `CODE_REASONS`
# in frontend/src/lib/eventText.ts, held equal by `tests/test_events_text_parity.py`. The raw text of the error (`[Errno 111] Connect
# call failed ...`) is for the Raw view; a code that is not here falls back to it.
CODE_REASONS = {
    "unreachable": "Could not connect to the server.",
    "auth_failed": "The server did not accept the user name or password.",
    "timeout": "The server did not answer in time.",
    "protocol_error": "The server answered in a way the dashboard could not use.",
    "exception": "Reading failed with an unexpected error.",
    "config_invalid": "The source's settings are not valid, so it is not being read.",
    "secret_undecryptable": "The stored password cannot be read, so the source is not being read.",
    "needs_profile": "No device profile is chosen for this source.",
    "not_supported": "This source cannot do that.",
}
_REASON_CHARS = 200
NO_SOURCE_TESTED = "No source was tested."


@dataclass(frozen=True)
class _Ended:
    """How one job ended, from the facts a journal row or a jobs row holds."""

    state: str  # passed | failed | running | gone
    what: str = "test"  # check (a connection check) | test (a source test)
    event_id: int | None = None
    steps: int | None = None
    first_failed: str | None = None
    reason: str | None = None  # unscrubbed here; `_reason` cleans it when the sentence is built
    code: str | None = None  # the failure status of a test (the journal row's `code`, else the job result's `status`)


_GONE = _Ended("gone")


def _valid_id(value: Any) -> bool:
    return type(value) is int and 0 < value <= MAX_ID


def job_ids_of(action: str, detail: Any) -> list[int]:
    """The ids of the jobs an audit entry started: `detail.job_id` (a check or a test) or `detail.job_ids` (a test of all).
    Anything that is not a whole number in range is ignored; a job is listed once."""
    if not isinstance(detail, dict):
        return []
    if action == "source.test_all":
        listed = detail.get("job_ids")
        return list(dict.fromkeys(item for item in listed if _valid_id(item))) if isinstance(listed, list) else []
    return [detail["job_id"]] if _valid_id(detail.get("job_id")) else []


def _reason(value: Any) -> str | None:
    """A reason as one short plain line for a sentence: scrubbed (a URL's credentials), on one line, cut, no closing full stop.

    The scrub comes FIRST: `str.split()` also splits on a no-break space, and the scrub keeps such a space inside a password on
    purpose, so collapsing the whitespace before it would cut a URL in two pieces that neither the scrub nor `clip_error` can see."""
    if not isinstance(value, str):
        return None
    line = clip_error(" ".join(scrub_url_credentials(value).split()), _REASON_CHARS).rstrip(" .")
    return line or None


def _step_words(step: str) -> str:
    words = _STEP_WORDS.get(step) or re.sub(r"[_\s]+", " ", scrub_url_credentials(step)).strip()
    return clip_error(words, 40).replace('"', "'")


def _from_event(row: Any) -> tuple[int, _Ended] | None:
    """The job a journal row ended and how, or None for a row that does not end a started job."""
    detail = _obj(row.detail)
    job_id = job_of(row.kind, detail)
    if job_id is None:
        return None
    what = "check" if row.kind == "check.finished" or detail.get("kind") == "check_connection" else "test"
    steps = detail.get("steps")
    first = detail.get("first_failed")
    ok = detail.get("ok") is True
    return job_id, _Ended(
        "passed" if ok else "failed", what, row.id, steps if type(steps) is int and steps >= 0 else None,
        first if isinstance(first, str) and first else None, None if ok else detail.get("error"),
        None if ok or not isinstance(row.code, str) else row.code,
    )


def _from_job(row: Any) -> _Ended:
    """A finished job's outcome when the journal has no row for it (a restart failed it, or its row was dropped or pruned)."""
    what = "check" if row.kind == "check_connection" else "test"
    if row.status not in ("done", "failed"):
        return _Ended("running", what)
    body = _obj(row.result)
    body = body if isinstance(body, dict) else {}
    # The same rule as the journal's: a check passed when it says so; a test passed unless its result says it did not.
    ok = row.status == "done" and (body.get("ok") is True if what == "check" else body.get("ok") is not False)
    steps = body.get("steps")
    first = body.get("first_failed")
    reason = next((body[key] for key in ("error", "message") if isinstance(body.get(key), str) and body[key]), None)
    status = body.get("status")
    return _Ended(
        "passed" if ok else "failed", what, None, len(steps) if isinstance(steps, list) else None,
        first if isinstance(first, str) and first else None, None if ok else reason,
        status if not ok and isinstance(status, str) else None,
    )


def _sentence(ended: _Ended, retention_days: int) -> str:
    """The plain sentence for one job."""
    if ended.state == "running":
        return "Still running."
    if ended.state == "gone":
        return f"The outcome was not recorded, or it is no longer kept (system events are kept {retention_days} days)."
    if ended.what == "check":
        if ended.state == "passed":
            if ended.steps is None:
                return "The connection check passed."
            return f"The connection check passed ({ended.steps} step{'' if ended.steps == 1 else 's'})."
        if ended.first_failed:
            return f'The connection check failed at "{_step_words(ended.first_failed)}".'
        reason = _reason(ended.reason)
        return f"The connection check failed: {reason}." if reason else "The connection check failed."
    if ended.state == "passed":
        return "The test passed."
    known = CODE_REASONS.get(ended.code) if ended.code else None  # the plain words of the code, never the connector's raw error
    if known:
        return f"The test failed. {known}"
    reason = _reason(ended.reason)
    return f"The test failed: {reason}." if reason else "The test failed."


def _all_of(ended: Sequence[_Ended]) -> dict[str, Any]:
    """`{state, text, counts}` for the jobs of a test of all sources."""
    counts = {name: sum(1 for one in ended if one.state == name) for name in ("passed", "failed", "running", "gone")}
    words = {"passed": "passed", "failed": "failed", "running": "running", "gone": "no longer kept"}
    if not ended:
        return {"state": "gone", "text": NO_SOURCE_TESTED, "counts": counts}
    if counts["failed"]:
        state = "failed"
    elif counts["running"]:
        state = "running"
    elif counts["passed"] == len(ended):
        state = "passed"
    else:
        state = "gone"
    return {"state": state, "text": ", ".join(f"{counts[name]} {words[name]}" for name in words if counts[name]), "counts": counts}


async def _ended_jobs(db: AsyncSession, job_ids: list[int], since: datetime) -> dict[int, _Ended]:
    """How each job ended: from its journal row (ONE query for all, rows no older than `since`, the earliest audit entry asked
    about: an entry is written before its job runs), else from its jobs row (at most ONE more query, for the jobs with no row)."""
    texts = literal([str(job_id) for job_id in job_ids], ARRAY(Text))
    events = await db.execute(
        select(DiagEvent.id, DiagEvent.kind, DiagEvent.code, DiagEvent.detail)
        .where(DiagEvent.kind.in_(_ENDING_EVENTS), DiagEvent.ts >= since, DiagEvent.detail["job_id"].astext == any_(texts))
        .order_by(DiagEvent.id.desc())
    )
    ended: dict[int, _Ended] = {}
    for row in events:
        found = _from_event(row)
        if found is not None:
            ended.setdefault(found[0], found[1])  # the newest row of a job wins
    missing = [job_id for job_id in job_ids if job_id not in ended]
    if missing:
        jobs = await db.execute(
            select(Job.id, Job.kind, Job.status, Job.result).where(
                Job.id == any_(literal(missing, ARRAY(Integer))), Job.kind.in_(STARTED_JOB_KINDS)
            )
        )
        for row in jobs:
            ended[row.id] = _from_job(row)
    return ended


async def outcomes(db: AsyncSession, entries: Sequence[Any]) -> dict[int, dict[str, Any]]:
    """How the checks and tests that audit `entries` started ended: `{entry id: {state, text, event_id, counts}}` for the entries
    of `source.tested`, `source.checked` and `source.test_all` (an entry of any other action is not in the answer).

    The words are built here, from `ok` and the scrubbed reason, never from the journal's own message. One journal query and at
    most one jobs query for all the entries, whatever their number. Nothing is written."""
    wanted = {entry.id: (entry.action, job_ids_of(entry.action, entry.detail)) for entry in entries if entry.action in OUTCOME_ACTIONS}
    if not wanted:
        return {}
    every = sorted({job_id for _, ids in wanted.values() for job_id in ids})
    ended: dict[int, _Ended] = {}
    if every:
        since = min(entry.ts for entry in entries if wanted.get(entry.id, ("", []))[1])
        ended = await _ended_jobs(db, every, since)
    plans: dict[int, tuple[str, list[_Ended]]] = {}
    for entry_id, (action, ids) in wanted.items():
        mine = [ended.get(job_id) for job_id in ids]
        # a job of the other kind than the action started (a hand-written audit detail) is not this entry's outcome
        verdicts = [one if one is not None and one.what == _JOB_OF_ACTION[action] else _GONE for one in mine]
        plans[entry_id] = (action, verdicts or ([] if action == "source.test_all" else [_GONE]))
    needs_days = any(one.state == "gone" for _, verdicts in plans.values() for one in verdicts)
    days = (await events_settings.load(db)).retention_days if needs_days else 0
    answer: dict[int, dict[str, Any]] = {}
    for entry_id, (action, verdicts) in plans.items():
        if action == "source.test_all":
            body = _all_of(verdicts)
            event_id = verdicts[0].event_id if len(verdicts) == 1 else None
        else:
            body = {"state": verdicts[0].state, "text": _sentence(verdicts[0], days), "counts": None}
            event_id = verdicts[0].event_id
        answer[entry_id] = {"state": body["state"], "text": body["text"], "event_id": event_id, "counts": body["counts"]}
    return answer
