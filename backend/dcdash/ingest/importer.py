"""Import readings from a CSV export into one source (w31): the limits, the pre-scan, the parser, the dry run and the real run, the
report, and the command line (`python -m dcdash.ingest.importer`).

The shape of a run. A file arrives as bytes. `pre_scan` (pure) refuses what no profile could read (too big, UTF-16, NUL bytes, a line
over the limit, too many rows) and splits it into lines at the BYTE level. `parse_chunk` (pure) turns 10,000 lines at a time into
rows; both run on the compute thread (`core/compute.py`), so the event loop stays free for the other users. The writes are async,
one transaction per chunk, on ONE pool connection that also holds the advisory lock (`LOCK_KEY`): one import at a time, a dry run
included. Between chunks the loop yields. A row goes in through `store.insert_readings(notify=False)`: the first stored value of a
(point, time) pair wins, nothing is pushed to a widget, and an import never creates a point (a tag that is not one of the chosen
source's addresses is counted and named, not stored). The dry run is the same run with `store.classify_readings` for the write.

A reading keeps the SOURCE's unit and value. The mapping's `scale` converts when a figure is computed, so a unit cell in the file is
only checked against it, never applied.

Every row of the file ends in exactly one place: new, already there, differing, rejected (counted by reason) or an unknown tag, so
`rows_read = new + already + differing + rejected + unknown_rows`. A pair that appears twice in the file is de-duplicated here, over
the whole file (`insert_readings` would drop the second copy silently inside a batch and count it as `already` across batches), which
is also what makes the dry run and the real run agree. Nothing in a report, an audit row, a journal event or a log line carries a
reading value, except the five `differing_samples` the report names for a person to look at.
"""
import argparse
import asyncio
import csv
import hashlib
import json
import logging
import math
import re
import sys
import traceback
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, BinaryIO, NamedTuple
from zoneinfo import ZoneInfo

import asyncpg
from pydantic import ValidationError

from dcdash.connectors.base import BAD, GOOD
from dcdash.core import compute, journal
from dcdash.core.audit import audit_pool
from dcdash.core.pg import create_pool
from dcdash.core.storage import REFRESH_WINDOW_DAYS
from dcdash.ingest import normalise, rollups
from dcdash.ingest.backfill import _UNCAP  # the engine's own statement: the one other writer that reaches into compressed chunks
from dcdash.ingest.import_profile import IMPORT_PROFILES_KEY, ImportProfile, describe_problem, parse_profile
from dcdash.ingest.kinds import IMPORT_FINISHED
from dcdash.ingest.store import Row, classify_readings, insert_readings

log = logging.getLogger(__name__)

# ---- the limits (documented in docs/sources-and-discovery.md; a test can lower them) -------------------------------------------

LOCK_KEY = 7_312_001  # pg_try_advisory_lock(LOCK_KEY, 0): one import (or dry run) at a time
MAX_BYTES = 20 * 1024 * 1024
MAX_ROWS = 500_000
MAX_LINE_BYTES = 4_096
MAX_COLUMNS = 50
MAX_TIME_CHARS = 64
MAX_TAG_CHARS = 500
MAX_BLANK_LINES = 10_000  # blank lines allowed on top of the row limit before the line count itself is a reason to refuse
MAX_ABS_VALUE = 1e15
CHUNK_LINES = 10_000  # lines parsed and written together: one transaction
READ_TIMEOUT_SECONDS = 300  # the whole upload, read by the route
PROBLEMS_SHOWN = 20
UNKNOWN_SHOWN = 20
SAMPLES_SHOWN = 5
CELL_SHOWN = 80  # characters of a cell echoed in a report

# The reason codes of a rejected row besides `normalise.Rejected`'s (the front end words them: lib/importReport.ts).
MALFORMED = "malformed_line"  # an unbalanced quote, a line break inside a cell, too few or too many cells
BAD_TAG = "bad_tag"  # an empty tag, or one longer than MAX_TAG_CHARS
EMPTY_VALUE = "empty_value"
NOT_A_NUMBER = "not_a_number"
OUT_OF_RANGE = "value_out_of_range"
UNIT_DIFFERS = "unit_differs_from_mapping"
UNIT_INVALID = "unit_not_valid_for_metric"
INTERVAL_ENERGY = "interval_energy_in_counter_point"
DUPLICATE = "duplicate_in_file"
CONFLICTING = "conflicting_duplicate_in_file"
POINT_DELETED = "point_deleted"

REASON_TEXT = {  # for the command line; a browser words the codes itself
    MALFORMED: "the line does not fit the header (an unbalanced quote, or too few or too many cells)",
    BAD_TAG: f"the tag is empty or longer than {MAX_TAG_CHARS} characters",
    normalise.Rejected.NO_ZONE.value: "the time has no UTC offset and the profile names no zone",
    normalise.Rejected.NONEXISTENT.value: "this local time does not exist (the clocks went forward)",
    normalise.Rejected.AMBIGUOUS.value: "this local time happened twice (the clocks went back) and cannot be told apart",
    normalise.Rejected.FUTURE.value: "the time is more than 5 minutes in the future",
    normalise.Rejected.TOO_OLD.value: "the time is older than the raw readings are kept",
    normalise.Rejected.NOT_A_TIME.value: "the time cannot be read in the profile's format",
    EMPTY_VALUE: "the value is empty",
    NOT_A_NUMBER: "the value is not a number",
    OUT_OF_RANGE: "the value is beyond plus or minus 1e15",
    UNIT_DIFFERS: "the unit differs from the one the point's mapping converts from",
    UNIT_INVALID: "the unit is empty or not valid for the metric of the point's mapping",
    INTERVAL_ENERGY: "energy per period cannot go into a point mapped as a running energy counter",
    DUPLICATE: "the same tag and time are earlier in the file with the same value",
    CONFLICTING: "the same tag and time are earlier in the file with another value (the first one is used)",
    POINT_DELETED: "the point was deleted while the file was being imported",
}

_NUMBER = re.compile(r"[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?")
_EPOCH_NUMBER = re.compile(r"-?[0-9]+(\.[0-9]+)?")
_THOUSANDS = str.maketrans("", "", " " + chr(0xA0) + chr(0x202F))  # the spaces a decimal-comma export groups its digits with
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_MICROSECOND = timedelta(microseconds=1)
_DAY = timedelta(days=1)
_BOM = b"\xef\xbb\xbf"

EXIT_REFUSED, EXIT_USAGE, EXIT_BUSY = 1, 2, 3


class ImportRefused(Exception):
    """A file (or a run) that is refused with a plain sentence; `status` is the HTTP status the route answers with."""

    def __init__(self, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.status = status


class ImportBusy(Exception):
    """Another import (or dry run) holds the lock."""


def clip_cell(text: str, limit: int = CELL_SHOWN) -> str:
    """A cell of the file as it may be shown or stored: at most `limit` characters, every control, format or separator character
    (a line break, a tab, a right-to-left override) replaced by `?`."""
    return "".join(ch if ch.isprintable() else "?" for ch in text[:limit])


# ---- the pre-scan ---------------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class PreScan:
    """A file that passed the pre-scan. `lines` holds every line without its line break (line N is `lines[N - 1]`)."""

    sha256: str
    size: int
    lines: list[bytes]
    header: int  # the index of the header line: the first line that is not blank
    rows: int  # the data lines after it that are not blank


def pre_scan(body: bytes) -> PreScan:
    """Refuse what no profile could read, and split the body into lines. Pure. The lines are cut at b"\\n" on the bytes (a trailing
    b"\\r" is dropped): `str.splitlines` would also cut at form feeds and at U+2028, and shift every line number the report names."""
    size = len(body)
    if size > MAX_BYTES:
        raise ImportRefused(f"the file is larger than {MAX_BYTES // (1024 * 1024)} MB; split it into several files", 413)
    if not body or body.isspace():
        raise ImportRefused("the file is empty")
    if body.startswith((b"\xff\xfe", b"\xfe\xff")):  # before the NUL check: a UTF-16 file is full of NUL bytes
        raise ImportRefused(
            "this file is saved as UTF-16 (or UTF-32), which the import does not read; open it in a spreadsheet or a text "
            "editor, save it as CSV UTF-8 and import it again"
        )
    if b"\x00" in body:
        raise ImportRefused("this file contains NUL bytes, so it is not a text file; save it as CSV UTF-8 and import it again")
    if body.count(b"\n") > MAX_ROWS + 1 + MAX_BLANK_LINES:
        raise ImportRefused(f"the file has too many lines; the limit is {MAX_ROWS:,} data rows")
    try:
        body.decode("utf-8")  # once, strictly: every line is then valid, since a line break never falls inside a UTF-8 sequence
    except UnicodeDecodeError as exc:
        line = body.count(b"\n", 0, exc.start) + 1
        raise ImportRefused(f"line {line:,} is not UTF-8 text; save the file as CSV UTF-8 and import it again") from None
    lines = body.split(b"\n")
    if lines[0].startswith(_BOM):
        lines[0] = lines[0][len(_BOM):]
    for index, line in enumerate(lines):
        if line.endswith(b"\r"):
            line = lines[index] = line[:-1]
        if len(line) > MAX_LINE_BYTES:
            hint = " (is the file saved with old Mac line endings?)" if b"\r" in line else ""
            raise ImportRefused(f"line {index + 1:,} is longer than {MAX_LINE_BYTES:,} bytes{hint}")
    header = next((index for index, line in enumerate(lines) if line.strip()), None)
    if header is None:
        raise ImportRefused("the file has no header line")
    rows = sum(1 for line in lines[header + 1:] if line.strip())
    if rows > MAX_ROWS:
        raise ImportRefused(f"the file has {rows:,} data rows; the limit is {MAX_ROWS:,}; split it into several files")
    return PreScan(hashlib.sha256(body).hexdigest(), size, lines, header, rows)


# ---- the layout: which cell is which -------------------------------------------------------------------------------------------


class Layout(NamedTuple):
    delimiter: str
    tag: int
    time: int
    value: int
    unit: int | None
    quality: int | None
    need: int  # the cells a data line must have to reach the tag, the time and the value


def _cells(text: str, delimiter: str) -> list[str]:
    """The cells of one line. A record never spans lines here: a line with a quote is read as a whole CSV record in strict mode (an
    unbalanced quote, or a quoted line break that cut the record, is an error), a line without one is split directly."""
    if '"' in text:
        return next(csv.reader([text], delimiter=delimiter, strict=True), [])
    return text.split(delimiter)


def _detect_delimiter(header: str, decimal: str) -> str:
    candidates = [d for d in (",", ";", "\t") if not (d == "," and decimal == ",")]
    best = max(candidates, key=lambda d: (header.count(d), -candidates.index(d)))
    return best if header.count(best) else candidates[0]


def resolve_layout(scan: PreScan, profile: ImportProfile) -> Layout:
    """Find the profile's columns in the header line (names match case-insensitively after trimming). Raises ImportRefused with a
    sentence that names the column and lists the ones the file has."""
    header = scan.lines[scan.header].decode("utf-8")
    delimiter = profile.delimiter or _detect_delimiter(header, profile.decimal)
    try:
        cells = _cells(header, delimiter)
    except csv.Error:
        raise ImportRefused("the header line has an unbalanced quote") from None
    if len(cells) > MAX_COLUMNS:
        raise ImportRefused(f"the header line has {len(cells):,} columns; the limit is {MAX_COLUMNS}")
    names = [cell.strip().casefold() for cell in cells]

    def find(label: str, column: str) -> int:
        hits = [index for index, name in enumerate(names) if name == column.strip().casefold()]
        shown = ", ".join(f'"{clip_cell(cell.strip(), 40)}"' for cell in cells[:10]) + (", ..." if len(cells) > 10 else "")
        if not hits:
            raise ImportRefused(f'the file has no column named "{clip_cell(column)}" (the {label} column of the profile); its columns are {shown}')
        if len(hits) > 1:
            raise ImportRefused(f'the file has {len(hits)} columns named "{clip_cell(column)}"; the {label} column of the profile must be one')
        return hits[0]

    tag, time, value = find("tag", profile.tag), find("time", profile.time), find("value", profile.value)
    unit = find("unit", profile.unit) if profile.unit else None
    quality = find("quality", profile.quality) if profile.quality else None
    return Layout(delimiter, tag, time, value, unit, quality, max(tag, time, value) + 1)


# ---- the pure parser --------------------------------------------------------------------------------------------------------------


class PointInfo(NamedTuple):
    point_id: int
    metric: str | None  # None: the point is not mapped
    scale: float | None
    check_unit: bool  # the mapping converts by one of the metric's unit factors, so a unit cell can be held against it
    interval_energy: bool  # an interval profile against a point mapped as cumulative energy


def point_info(point_id: int, metric: str | None, scale: float | None, reading: str) -> PointInfo:
    """A unit cell is only checked when the mapping's scale IS one of the unit table's factors: a live Modbus source maps a counter
    with a CT-ratio scale (60, say) that no unit spelling gives, and its rows are not wrong for that."""
    check = False
    if metric is not None and scale is not None and metric != "custom":
        table = normalise.UNITS.get(metric)
        check = table is not None and any(math.isclose(scale, factor) for factor in table.values())
    energy = False
    if metric is not None and reading == "interval":
        try:
            normalise.refuse_interval_as_energy("interval", metric)
        except normalise.NormaliseError:
            energy = True
    return PointInfo(point_id, metric, scale, check, energy)


@dataclass(frozen=True)
class ParseContext:
    layout: Layout
    profile: ImportProfile
    points: Mapping[str, PointInfo]  # address -> point, of the chosen source only
    now: datetime  # read once per run: the dry run and the real run judge the window alike
    retention_days: int
    closed: frozenset[str] = frozenset()  # the closed billing months, "YYYY-MM"
    site_zone: ZoneInfo | None = None  # needed only when there are closed months


class Kept(NamedTuple):
    line: int
    tag: str
    point_id: int
    ts: datetime  # aware UTC
    value: float
    quality: int
    month: str | None  # the site-zone month, only worked out when a month is closed
    label: str | None  # why the quality is BAD, None for good


@dataclass
class ChunkResult:
    last: dict[str, datetime]  # the last resolved instant of each tag (carries the repeated autumn hour across chunks)
    lines: int = 0  # the data lines read (blank lines are skipped, not counted)
    kept: list[Kept] = field(default_factory=list)
    rejected: dict[str, int] = field(default_factory=dict)
    problems: list[tuple[int, str]] = field(default_factory=list)  # the first PROBLEMS_SHOWN: (line, reason)
    unknown_rows: int = 0
    unknown: dict[str, None] = field(default_factory=dict)  # the unknown tags in order of first appearance


def _read_time(cell: str, time_format: str) -> Any:
    """What `normalise.parse_time` takes for this cell: the text itself for ISO, or a datetime read by the profile's format (None
    when it cannot be). Epochs and patterns become datetimes HERE because parse_time refuses any string of 10 characters or fewer
    (a 10-digit epoch is one). An absurd value (a year past 9999, a huge epoch) is None, never an exception."""
    if time_format == "iso":
        return cell
    try:
        if time_format in ("epoch_s", "epoch_ms"):
            if _EPOCH_NUMBER.fullmatch(cell) is None:
                return None
            amount = float(cell) if "." in cell else int(cell)
            return _EPOCH + (timedelta(seconds=amount) if time_format == "epoch_s" else timedelta(milliseconds=amount))
        return datetime.strptime(cell, time_format)
    except (OverflowError, OSError, ValueError):
        return None


def parse_chunk(first_number: int, lines: Sequence[bytes], ctx: ParseContext, last: Mapping[str, datetime]) -> ChunkResult:
    """Turn `lines` (the first is line `first_number` of the file) into rows. Pure, for the compute thread: it only READS its
    arguments and returns a new object, including the new per-tag last-instant map. It does not de-duplicate (the loop does, over
    the whole file) and it rejects a row for the first rule it breaks, in the order of the file's columns: line, tag, time, value,
    unit. Never raises for bad input."""
    layout, profile, points = ctx.layout, ctx.profile, ctx.points
    delimiter, tag_at, time_at, value_at = layout.delimiter, layout.tag, layout.time, layout.value
    unit_at, quality_at, need = layout.unit, layout.quality, layout.need
    interval = profile.reading == "interval"
    comma = profile.decimal == ","
    good = frozenset(profile.good_codes)
    result = ChunkResult(last=dict(last))
    resolved, kept, rejected, problems = result.last, result.kept, result.rejected, result.problems
    factors: dict[tuple[str, str], float | None] = {}  # the unit spellings seen, by (unit, metric)

    def reject(number: int, reason: str) -> None:
        rejected[reason] = rejected.get(reason, 0) + 1
        if len(problems) < PROBLEMS_SHOWN:
            problems.append((number, reason))

    for offset, raw in enumerate(lines):
        if not raw.strip():
            continue
        number = first_number + offset
        result.lines += 1
        text = raw.decode("utf-8")
        try:
            cells = _cells(text, delimiter)
        except csv.Error:
            reject(number, MALFORMED)
            continue
        if len(cells) > MAX_COLUMNS or len(cells) < need:
            reject(number, MALFORMED)
            continue

        tag = cells[tag_at].strip()
        if not tag or len(tag) > MAX_TAG_CHARS:
            reject(number, BAD_TAG)
            continue
        info = points.get(tag)
        if info is None:
            result.unknown_rows += 1
            result.unknown.setdefault(tag)
            continue
        if info.interval_energy:
            reject(number, INTERVAL_ENERGY)
            continue

        cell = cells[time_at].strip()
        read = _read_time(cell, profile.time_format) if len(cell) <= MAX_TIME_CHARS else None
        if read is None:
            reject(number, normalise.Rejected.NOT_A_TIME.value)
            continue
        moment = normalise.parse_time(read, profile.zone, previous=resolved.get(tag))
        if isinstance(moment, normalise.Rejected):
            reject(number, moment.value)
            continue
        resolved[tag] = moment  # the stamp as written, before an interval moves to its start: the series order is the file's
        if interval:
            try:
                moment = normalise.period_start(moment, profile.period_seconds or 0, profile.stamp or "start")
            except (OverflowError, ValueError):
                reject(number, normalise.Rejected.NOT_A_TIME.value)
                continue
        outside = normalise.check_window(moment, ctx.now, ctx.retention_days)
        if outside is not None:
            reject(number, outside.value)
            continue

        cell = cells[value_at].strip()
        if not cell:
            reject(number, EMPTY_VALUE)
            continue
        if comma:  # "1.234,5": the spaces and the dots are grouping, the comma is the point
            cell = cell.translate(_THOUSANDS).replace(".", "").replace(",", ".")
        if _NUMBER.fullmatch(cell) is None:  # NaN, inf, 0x10, 1_000 and any non-ASCII digit end here
            reject(number, NOT_A_NUMBER)
            continue
        value = float(cell)
        if not math.isfinite(value) or abs(value) > MAX_ABS_VALUE:  # 1e309 reads as inf
            reject(number, OUT_OF_RANGE)
            continue

        if unit_at is not None and info.check_unit:
            unit = cells[unit_at].strip() if unit_at < len(cells) else ""
            key = (unit, info.metric or "")
            if key not in factors:
                try:
                    factors[key] = normalise.scale_for(unit, info.metric or "")
                except normalise.NormaliseError:
                    factors[key] = None
            factor = factors[key]
            if factor is None:
                reject(number, UNIT_INVALID)
                continue
            if not math.isclose(factor, info.scale or 0.0):
                reject(number, UNIT_DIFFERS)
                continue

        quality, label = GOOD, None
        if quality_at is not None and quality_at < len(cells):
            code = cells[quality_at].strip().lower()
            if code and code not in good:
                quality = BAD
                label = clip_cell(normalise.quality(code)[1] or f"not_good:{code}", normalise.LABEL_MAX)
        month = moment.astimezone(ctx.site_zone).strftime("%Y-%m") if ctx.closed and ctx.site_zone is not None else None
        kept.append(Kept(number, tag, info.point_id, moment, value, quality, month, label))
    return result


def _dedupe(kept: list[Kept], seen: dict[int, tuple[float, int]], rejected: dict[str, int], problems: list[tuple[int, str]]) -> list[Kept]:
    """The rows whose (point, instant) pair no earlier row of the FILE had. A later copy is rejected `duplicate_in_file` (the same
    value and quality) or `conflicting_duplicate_in_file` (another value or quality: the first one is used, as the store would)."""
    fresh: list[Kept] = []
    for row in kept:
        key = (row.point_id << 56) | ((row.ts - _EPOCH) // _MICROSECOND)  # whole microseconds: a float second would blur them
        first = seen.get(key)
        if first is None:
            seen[key] = (row.value, row.quality)
            fresh.append(row)
            continue
        reason = DUPLICATE if first == (row.value, row.quality) else CONFLICTING
        rejected[reason] = rejected.get(reason, 0) + 1
        problems.append((row.line, reason))
    return fresh


# ---- the report -----------------------------------------------------------------------------------------------------------------------


def _plural(count: int, one: str, many: str | None = None) -> str:
    return f"{count:,} {one if count == 1 else (many or one + 's')}"


@dataclass
class ImportReport:
    """What a run did (or, for a dry run, would do): the same shape either way."""

    dry_run: bool
    source_id: int
    profile: str
    sha256: str
    size: int
    rows_read: int = 0
    new: int = 0
    already: int = 0
    differing: int = 0
    unknown_rows: int = 0
    unknown_total: int = 0  # distinct unknown tags
    unknown_names: list[str] = field(default_factory=list)  # the first UNKNOWN_SHOWN, clipped
    rejected_by: dict[str, int] = field(default_factory=dict)
    closed_months: dict[str, int] = field(default_factory=dict)  # accepted rows that fall in a closed billing month
    bad_quality: dict[str, int] = field(default_factory=dict)  # accepted rows stored as BAD, by label
    differing_samples: list[dict[str, Any]] = field(default_factory=list)
    problems: list[tuple[int, str]] = field(default_factory=list)
    refresh_state: str = "not_needed"
    refresh_days: int = 0
    refresh_note: str | None = None
    complete: bool = True
    error: str | None = None

    @property
    def rejected(self) -> int:
        return sum(self.rejected_by.values())

    def summary(self, *, names: bool = True) -> str:
        """`12,480 rows read, 12,000 new, 480 already there, 0 differing, 0 rejected, 3 unknown tags (A, B, C), 17 rows for unknown
        tags`: the one sentence a person reads. `names=False` leaves the tags out (the journal keeps counts only)."""
        parts = [
            f"{_plural(self.rows_read, 'row')} read", f"{self.new:,} new", f"{self.already:,} already there",
            f"{self.differing:,} differing", f"{self.rejected:,} rejected",
        ]
        if (bad := sum(self.bad_quality.values())) > 0:
            parts.append(f"{bad:,} stored with bad quality")
        if self.unknown_total > 0:
            shown = ""
            if names:
                listed = self.unknown_names[:5]
                shown = f" ({', '.join(listed)}{', ...' if self.unknown_total > len(listed) else ''})"
            parts.append(f"{_plural(self.unknown_total, 'unknown tag')}{shown}")
        if self.unknown_rows > 0:
            parts.append(f"{_plural(self.unknown_rows, 'row')} for unknown tags")
        return ", ".join(parts)

    def as_dict(self) -> dict[str, Any]:
        return {
            "dry_run": self.dry_run, "source_id": self.source_id, "profile": self.profile, "sha256": self.sha256, "size": self.size,
            "rows_read": self.rows_read, "new": self.new, "already": self.already, "differing": self.differing,
            "rejected": self.rejected, "unknown_rows": self.unknown_rows,
            "unknown_tags": {"count": self.unknown_total, "names": list(self.unknown_names)},
            "rejected_by": dict(sorted(self.rejected_by.items())), "closed_months": dict(sorted(self.closed_months.items())),
            "bad_quality": dict(sorted(self.bad_quality.items())), "differing_samples": list(self.differing_samples),
            "problems": [{"line": line, "reason": reason} for line, reason in self.problems], "problems_total": self.rejected,
            "refresh": {"state": self.refresh_state, "days": self.refresh_days, "note": self.refresh_note},
            "complete": self.complete, "error": self.error, "text": self.summary(),
        }


def audit_detail(report: ImportReport, via: str) -> dict[str, Any]:
    """The detail of the `readings.imported` audit row: the source, the profile, the file's SHA-256 and size and the counts. Never a
    value, a tag or a line of the file."""
    detail: dict[str, Any] = {
        "source_id": report.source_id, "profile": report.profile, "sha256": report.sha256, "size": report.size,
        "rows_read": report.rows_read, "new": report.new, "already": report.already, "differing": report.differing,
        "rejected": report.rejected, "unknown_rows": report.unknown_rows, "closed_months": dict(sorted(report.closed_months.items())),
        "complete": report.complete, "via": via,
    }
    if report.error:
        detail["error"] = report.error
    return detail


def report_lines(report: ImportReport) -> list[str]:
    """Everything the report says beyond its sentence, as lines for the command: the closed months, the rollups, the problem lines."""
    lines = [
        f"{_plural(rows, 'row')} in the closed month {month}: the rows are stored, its frozen figures do not change"
        for month, rows in sorted(report.closed_months.items())
    ]
    if report.refresh_note:
        lines.append(report.refresh_note)
    if report.problems:
        total = report.rejected
        lines.append(f"The first {len(report.problems)} of {total:,} rejected lines:" if total > len(report.problems) else "The rejected lines:")
        lines.extend(f"  line {line:,}: {REASON_TEXT.get(reason, reason)}" for line, reason in report.problems)
    return lines


# ---- the run ----------------------------------------------------------------------------------------------------------------------------

_TRY_LOCK = "SELECT pg_try_advisory_lock($1, 0)"
_POINTS = "SELECT p.id, p.address, m.metric, m.scale FROM points p LEFT JOIN mappings m ON m.point_id = p.id WHERE p.source_id = $1"
_CLOSED_MONTHS = "SELECT month FROM billing_closes WHERE reopened_at IS NULL"
# FOR KEY SHARE, in id order: the Undo of a tag list and the delete of a source take FOR UPDATE on the same rows, so neither can
# remove a point under a batch. It does NOT stop a delete that commits BETWEEN two batches from leaving the earlier batches' readings
# behind (readings have no foreign key, as for the live poll); that is the same trade the whole data path makes.
_LOCK_POINTS = "SELECT id FROM points WHERE id = ANY($1::int[]) AND source_id = $2 ORDER BY id FOR KEY SHARE"

def _now() -> datetime:
    """The run's clock, read once per run (a test replaces it: the sample file is dated, and the window is judged against now)."""
    return datetime.now(UTC)


BUSY_SENTENCE = "an import is running; try again when it has finished"
CANCELLED_SENTENCE = (
    "the import was interrupted (the server was stopping); what was stored stays, and importing the file again adds only the rest"
)


@dataclass
class _Stored:
    """What one chunk's transaction made of its rows."""

    accepted: list[Kept]
    gone: list[Kept]
    new: int = 0
    already: int = 0
    differing: int = 0
    samples: list[dict] = field(default_factory=list)
    first_new: datetime | None = None
    last_new: datetime | None = None


async def _store_chunk(conn: asyncpg.Connection, source_id: int, rows: list[Kept], dry_run: bool) -> _Stored:
    """One chunk in one transaction. The points are locked first, in id order and with the source checked again: a point that is
    gone (or is another source's) rejects its rows. The real run lifts the cap on decompressed rows, because a write into a
    compressed chunk decompresses the segments it touches and the cap would refuse an ordinary re-import of old data."""
    if not rows:
        return _Stored([], [])
    ids = sorted({row.point_id for row in rows})
    async with conn.transaction():
        if not dry_run:
            await conn.execute(_UNCAP)
        live = {found["id"] for found in await conn.fetch(_LOCK_POINTS, ids, source_id)}
        accepted = [row for row in rows if row.point_id in live]
        gone = [row for row in rows if row.point_id not in live]
        batch: list[Row] = [(row.point_id, row.ts, row.value, row.quality) for row in accepted]
        if dry_run:
            new, already, differing, samples = await classify_readings(conn, batch)
            return _Stored(accepted, gone, new, already, differing, samples)
        written = await insert_readings(conn, batch, notify=False)
    return _Stored(accepted, gone, written.new, written.already, written.differing, written.samples, written.first_new, written.last_new)


def refresh_windows(spans: Sequence[tuple[datetime, datetime]], now: datetime) -> list[tuple[datetime, datetime]]:
    """The ranges whose rollups an import has to refresh itself: the hours of the NEW rows that lie further back than the policies
    reach (`REFRESH_WINDOW_DAYS`, less an hour), merged where they touch and cut into pieces of at most that many days. Newer
    hours are refreshed by the policy and read live until then."""
    horizon = now - (timedelta(days=REFRESH_WINDOW_DAYS) - rollups.HOUR)
    spans = sorted((rollups.hour_floor(first), rollups.hour_floor(last) + rollups.HOUR) for first, last in spans if first < horizon)
    merged: list[tuple[datetime, datetime]] = []
    for lo, hi in spans:
        if merged and lo <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], hi))
        else:
            merged.append((lo, hi))
    pieces: list[tuple[datetime, datetime]] = []
    for lo, hi in merged:
        while lo < hi:
            pieces.append((lo, min(lo + timedelta(days=REFRESH_WINDOW_DAYS), hi)))
            lo += timedelta(days=REFRESH_WINDOW_DAYS)
    return pieces


async def _refresh(pool: asyncpg.Pool, report: ImportReport, spans: Sequence[tuple[datetime, datetime]], now: datetime) -> None:
    """The rollups over the hours the import changed (D11): `pending_drop_range` first, as the backfill asks it, because a refresh
    over minutes whose raw readings are gone would delete real history. A window that is not safe, or that fails, is reported and
    left as it was; the rows stay stored."""
    windows = refresh_windows(spans, now)
    if not windows:
        return
    refreshed, trouble = 0, []
    for lo, hi in windows:
        where = f"{lo:%Y-%m-%d %H:%M} to {hi:%Y-%m-%d %H:%M} UTC"
        try:
            unsafe = await rollups.pending_drop_range(pool, lo, hi)
            if unsafe is not None:
                trouble.append(f"{where}: {unsafe.removesuffix(', so nothing is written')}")
                continue
            await rollups.refresh_range(pool, lo, hi, now)
        except Exception as exc:  # the class only: a database message could quote a value
            trouble.append(f"{where}: {type(exc).__name__}")
            continue
        refreshed += max(1, math.ceil((hi - lo) / _DAY))
    report.refresh_days = refreshed
    if trouble:
        report.refresh_state = "failed"
        report.refresh_note = (
            "the readings are stored, but the hourly and minute rollups were left as they were over " + "; ".join(trouble[:3])
            + (f"; and {len(trouble) - 3} more ranges" if len(trouble) > 3 else "")
        )
    else:
        report.refresh_state = "done"
        report.refresh_note = f"the rollups were refreshed over {_plural(refreshed, 'day')}"


def _failure(exc: BaseException, line: int | None) -> str:
    where = f"before line {line:,}" if line is not None else "before it started"
    return f"the import stopped {where} ({type(exc).__name__}); what was stored stays, and importing the file again adds only the rest"


def _log_failure(source_id: int, exc: BaseException) -> None:
    """The class and the place, never the message: a database error can quote the row that failed."""
    frame = traceback.extract_tb(exc.__traceback__)[-1] if exc.__traceback__ else None
    log.warning(
        "import into source %s failed: %s at %s", source_id, type(exc).__name__,
        f"{Path(frame.filename).name}:{frame.lineno}" if frame else "an unknown place",
    )


async def _import(
    conn: asyncpg.Connection, pool: asyncpg.Pool, report: ImportReport, *, profile: ImportProfile, scan: PreScan, layout: Layout,
    now: datetime,
) -> None:
    source_id, dry_run = report.source_id, report.dry_run
    spans: list[tuple[datetime, datetime]] = []  # the times of the new rows of each chunk: what the rollups have to be refreshed over
    line = None  # the first line of the chunk being worked on, for the sentence of a failure
    try:
        retention = await rollups.raw_retention_days(pool)
        closed = frozenset(found["month"] for found in await conn.fetch(_CLOSED_MONTHS))
        site = ZoneInfo(await rollups.site_timezone(pool)) if closed else None
        points = {
            found["address"]: point_info(found["id"], found["metric"], found["scale"], profile.reading)
            for found in await conn.fetch(_POINTS, source_id)
        }
        ctx = ParseContext(layout, profile, points, now, retention, closed, site)
        seen: dict[int, tuple[float, int]] = {}
        unknown_seen: set[str] = set()
        last: dict[str, datetime] = {}
        start, total = scan.header + 1, len(scan.lines)
        while start < total:
            line = start + 1
            stop = min(start + CHUNK_LINES, total)
            parsed = await compute.run(parse_chunk, line, scan.lines[start:stop], ctx, last)
            rejected, problems = dict(parsed.rejected), list(parsed.problems)
            fresh = _dedupe(parsed.kept, seen, rejected, problems)
            stored = await _store_chunk(conn, source_id, fresh, dry_run)
            # The chunk is committed: only now does it count, so an interrupted run reports what was really written.
            for row in stored.gone:
                rejected[POINT_DELETED] = rejected.get(POINT_DELETED, 0) + 1
                problems.append((row.line, POINT_DELETED))
            report.rows_read += parsed.lines
            report.unknown_rows += parsed.unknown_rows
            for tag in parsed.unknown:
                if tag not in unknown_seen:
                    unknown_seen.add(tag)
                    if len(report.unknown_names) < UNKNOWN_SHOWN:
                        report.unknown_names.append(clip_cell(tag))
            report.unknown_total = len(unknown_seen)
            for reason, count in rejected.items():
                report.rejected_by[reason] = report.rejected_by.get(reason, 0) + count
            if len(report.problems) < PROBLEMS_SHOWN:
                report.problems.extend(sorted(problems)[: PROBLEMS_SHOWN - len(report.problems)])
            report.new += stored.new
            report.already += stored.already
            report.differing += stored.differing
            for row in stored.accepted:
                if row.month in closed:
                    report.closed_months[row.month] = report.closed_months.get(row.month, 0) + 1
                if row.label is not None:
                    report.bad_quality[row.label] = report.bad_quality.get(row.label, 0) + 1
            if len(report.differing_samples) < SAMPLES_SHOWN and stored.samples:
                tags = {row.point_id: row.tag for row in stored.accepted}
                for sample in stored.samples[: SAMPLES_SHOWN - len(report.differing_samples)]:
                    report.differing_samples.append({
                        "tag": clip_cell(tags.get(sample["point_id"], "")), "ts": sample["ts"], "stored": sample["stored"], "file": sample["resent"],
                    })
            if stored.first_new is not None and stored.last_new is not None:
                spans.append((stored.first_new, stored.last_new))
            last, start, line = parsed.last, stop, None
            await asyncio.sleep(0)  # let the other requests in between two chunks
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        report.complete, report.error = False, _failure(exc, line)
        _log_failure(source_id, exc)
    if spans:  # also after a failure half-way: what was stored should not wait for the next import to reach the rollups
        await _refresh(pool, report, spans, now)


async def _wrap_up(
    pool: asyncpg.Pool, report: ImportReport, via: str, user_id: int | None, *, audit_row: bool, wait: bool
) -> None:
    """The journal event of a real import and, when the route cannot write it (the handler was cancelled), its audit row. Each is
    best effort: a failure here never hides the report."""
    if audit_row:
        try:
            await audit_pool(pool, user_id, "readings.imported", audit_detail(report, via))
        except Exception as exc:
            log.warning("could not write the audit row of an interrupted import: %s", type(exc).__name__)
    detail = {
        "via": via, "profile": report.profile, "rows_read": report.rows_read, "new": report.new, "already": report.already,
        "differing": report.differing, "rejected": report.rejected, "unknown_rows": report.unknown_rows,
        "closed_months": dict(sorted(report.closed_months.items())), "complete": report.complete, "refresh": report.refresh_state,
    }
    message = f"an import into the source stored {report.new:,} new readings ({report.summary(names=False)})"
    if not report.complete:
        message = f"an import into the source stopped half-way: {report.summary(names=False)}"
    kwargs: dict[str, Any] = {"level": "info" if report.complete else "warning", "source_id": report.source_id, "detail": detail}
    if wait:
        await journal.record(pool, "api", IMPORT_FINISHED, message, **kwargs)
    else:
        journal.record_soon(pool, "api", IMPORT_FINISHED, message, **kwargs)


async def run_import(
    pool: asyncpg.Pool, *, source_id: int, profile: ImportProfile, scan: PreScan, layout: Layout, dry_run: bool, via: str = "web",
    user_id: int | None = None, now: datetime | None = None, wait_journal: bool = False,
) -> ImportReport:
    """Run (or, with `dry_run`, only plan) an import and return its report. Raises ImportBusy when another import holds the lock,
    and CancelledError when cancelled; every other failure ends in the report (`complete` false, `error` a sentence with the class
    of the exception and no message).

    ONE pool connection takes the lock and runs every chunk's transaction; the rollup refresh borrows a second one at the end, so
    an import holds at most two of the pool's five. The lock goes when the connection goes back to the pool (its reset releases
    session locks). A cancelled run writes its own audit row and journal event from a short connection of its own, shielded; on any
    other path the caller writes the audit row (the route in its own body, the command after this returns)."""
    now = now or _now()
    report = ImportReport(dry_run, source_id, profile.name, scan.sha256, scan.size)
    async with pool.acquire() as conn:
        if not await conn.fetchval(_TRY_LOCK, LOCK_KEY):
            raise ImportBusy(BUSY_SENTENCE)
        try:
            await _import(conn, pool, report, profile=profile, scan=scan, layout=layout, now=now)
        except asyncio.CancelledError:
            report.complete, report.error = False, CANCELLED_SENTENCE
            if not dry_run:
                await asyncio.shield(_wrap_up(pool, report, via, user_id, audit_row=True, wait=True))
            raise
        except Exception as exc:  # before the first chunk: nothing was written
            report.complete, report.error = False, _failure(exc, None)
            _log_failure(source_id, exc)
    if not dry_run:
        await _wrap_up(pool, report, via, user_id, audit_row=False, wait=wait_journal)
    return report


# ---- the command line ---------------------------------------------------------------------------------------------------------------


def _say(text: str = "", *, error: bool = False) -> None:
    print(text, file=sys.stderr if error else sys.stdout, flush=True)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m dcdash.ingest.importer",
        description="Import readings from a CSV export into one source. Without --yes it only checks the file and writes nothing.",
    )
    parser.add_argument("--source", type=int, required=True, help="the id of the source whose points the tags name")
    profile = parser.add_mutually_exclusive_group(required=True)
    profile.add_argument("--profile-name", help="the name of an import profile saved in the dashboard")
    profile.add_argument("--profile-file", type=Path, help="a JSON file with an import profile (the fields of the saved ones)")
    parser.add_argument("--yes", action="store_true", help="really import the file (without it: check it and write nothing)")
    parser.add_argument("file", help="the CSV file, or - to read it from standard input")
    return parser


async def _profile(args: argparse.Namespace, pool: asyncpg.Pool) -> ImportProfile:
    """The profile the command line names; raises ImportRefused with a sentence."""
    if args.profile_file is not None:
        try:
            raw = json.loads(args.profile_file.read_bytes()[: 1024 * 1024])
        except (OSError, ValueError) as exc:
            raise ImportRefused(f"could not read the profile file: {type(exc).__name__}") from None
        name = raw.get("name") if isinstance(raw, dict) and isinstance(raw.get("name"), str) else args.profile_file.stem
    else:
        stored = (await rollups.stored_setting(pool, IMPORT_PROFILES_KEY)).get("profiles")
        name = args.profile_name
        raw = stored.get(name) if isinstance(stored, dict) else None
        if raw is None:
            raise ImportRefused(f"there is no saved import profile called {clip_cell(name)}")
    try:
        return parse_profile(raw, name)
    except ValidationError as exc:
        raise ImportRefused(describe_problem(exc)) from None


def _read(path: str, stdin: BinaryIO) -> bytes:
    """At most the cap and one byte more (so that a bigger file is seen as bigger): the command never holds a whole huge file."""
    if path == "-":
        return stdin.read(MAX_BYTES + 1)
    with open(path, "rb") as handle:  # the operator's own path on their own machine; nothing from a browser reaches here
        return handle.read(MAX_BYTES + 1)


async def amain(
    argv: Sequence[str] | None = None, *, pool: asyncpg.Pool | None = None, stdin: BinaryIO | None = None,
    clock: Any = None,
) -> int:
    """The command, as a coroutine (a test awaits it with the pool it already has; the command line goes through `main`).

    Exit codes: 0 done (or checked), 1 refused or failed, 2 bad arguments or an unusable profile, 3 another import is running."""
    parser = _parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exit_:  # argparse prints its own message and exits 2; --help exits 0
        return exit_.code if isinstance(exit_.code, int) else EXIT_USAGE
    try:
        body = _read(args.file, stdin or sys.stdin.buffer)
        scan = await compute.run(pre_scan, body)
    except OSError as exc:
        _say(f"could not read the file: {exc.strerror or type(exc).__name__}", error=True)
        return EXIT_REFUSED
    except ImportRefused as refused:
        _say(str(refused), error=True)
        return EXIT_REFUSED
    own = pool is None
    if pool is None:
        try:
            pool = await create_pool()
        except Exception as exc:  # the class says which; the message could quote the connection string
            _say(f"could not open the database: {type(exc).__name__}", error=True)
            return EXIT_REFUSED
    try:
        name = await pool.fetchval("SELECT name FROM sources WHERE id = $1", args.source)
        if name is None:
            _say(f"there is no source with id {args.source}", error=True)
            return EXIT_REFUSED
        try:
            profile = await _profile(args, pool)
        except ImportRefused as refused:  # the profile asked for is not usable: a mistake in the arguments
            _say(str(refused), error=True)
            return EXIT_USAGE
        try:
            layout = resolve_layout(scan, profile)
        except ImportRefused as refused:  # the file does not have the profile's columns
            _say(str(refused), error=True)
            return EXIT_REFUSED
        report = await run_import(
            pool, source_id=args.source, profile=profile, scan=scan, layout=layout, dry_run=not args.yes, via="command",
            now=clock() if clock else None, wait_journal=True,
        )
        if args.yes:
            try:
                await audit_pool(pool, None, "readings.imported", audit_detail(report, "command"))
            except Exception as exc:
                _say(f"the import is done, but its audit row could not be written ({type(exc).__name__})", error=True)
        what = "Import" if args.yes else "Dry run"
        _say(f"{what} of {_plural(scan.rows, 'row')} into source {args.source} ({clip_cell(' '.join(name.split()))}), profile {clip_cell(profile.name)}.")
        _say(report.summary())
        for text in report_lines(report):
            _say(text)
        if not report.complete:
            _say(report.error or "the import did not finish", error=True)
            return EXIT_REFUSED
        _say("Done." if args.yes else "Dry run: nothing was written; run again with --yes to import the file.")
        return 0
    except ImportBusy as busy:
        _say(str(busy), error=True)
        return EXIT_BUSY
    except Exception as exc:  # whatever else: the class, never a message that could quote a row
        _say(f"the import failed: {type(exc).__name__}", error=True)
        return EXIT_REFUSED
    finally:
        if own:
            await pool.close()


def main(argv: Sequence[str] | None = None) -> int:
    try:
        return asyncio.run(amain(argv))
    except KeyboardInterrupt:
        _say("Stopped. What was stored stays; importing the same file again adds only what is missing.", error=True)
        return 130


if __name__ == "__main__":
    sys.exit(main())
