"""The Billing month check: what to look at before a month is trusted or closed (pure maths, no database, no clock).

For each metered asset it reads the `readings_1h` rows of the month (what the energy engine reads) and lists what could
change a figure without the page showing it: silence, holes, estimated hours, counter resets, a meter that began part way,
hours without a rate and a reading that stood still. The risk it guards against is a false all-clear, so every rule is
written against the engine's own (`counter_hours`, `power_hours`, `assemble`'s splice at the first reading, `cost_by_hour`'s
local-day rate), never against a guess of what the data "should" look like. Nothing here edits those modules.

Terms. An *expected hour* is a UTC hour in which the meter should have a row: from the later of its first reading and the
start of the range (the whole range when it never recorded anything) up to, not including, `stop`. A meter whose first
reading is at or after `stop` has none: it is only listed under `later`. A *run* is a maximal stretch of consecutive expected
hours without a row. The run that reaches the last expected hour is silence ("trailing"), every other run is a gap.
"""
import math
from bisect import bisect_left
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Any

from dcdash.core.energy import MINUTE_COVERAGE_MAX_INTERVAL, HourRow, Meter, counter_hours, power_hours
from dcdash.core.tree import AssetTree

FLAT_HOURS = 24  # a reading that did not move for this many clock hours is listed
SHORT_MINUTES = 60  # a power-only meter's part-covered time is listed from this many minutes ...
SHORT_SHARE = 0.01  # ... and from this share of its expected minutes, whichever is more
MAX_TOLERATED_HOURS = 24  # a slow counter's normal empty hours are tolerated up to this many in a row
CAP = 50  # items per group in the answer (the group's `total` is the true count)
EVENT_LIMIT = 5  # reset events listed per meter

LIMITS: dict[str, Any] = {
    "flat_hours": FLAT_HOURS,
    "short_minutes": SHORT_MINUTES,
    "short_share": SHORT_SHARE,
    "max_tolerated_hours": MAX_TOLERATED_HOURS,
    "cap": CAP,
}

HOUR = timedelta(hours=1)
THINGS = ("silent", "gaps", "estimated", "resets", "started", "unpriced", "flat")  # the groups that count as things to check


@dataclass(frozen=True)
class MeterInput:
    asset_id: int
    meter: Meter
    rows: Sequence[HourRow]  # this point's rows, ascending, buckets in [start, stop); rows outside are ignored
    before: HourRow | None  # the last row before `start` (any meter kind), None if there is none
    first_bucket: datetime | None  # the first bucket this point ever had; None = it never recorded anything


@dataclass(frozen=True)
class Silent:
    reason: str  # "never" | "none_in_month" | "trailing"
    since: datetime | None
    hours: int
    last_reading: datetime | None


@dataclass(frozen=True)
class Gaps:
    runs: int
    hours: int
    longest_hours: int | None
    longest_start: datetime | None
    first_start: datetime | None
    last_end: datetime | None
    leading_hours: int
    previous_reading: datetime | None
    short_hours: int
    short_minutes: int


@dataclass(frozen=True)
class Estimated:
    hours_estimated: int
    hours_total: int


@dataclass(frozen=True)
class Resets:
    resets: int
    dips: int
    falls: int
    events: tuple[tuple[datetime, str], ...]


@dataclass(frozen=True)
class Started:
    first_reading: datetime
    children: int


@dataclass(frozen=True)
class Unpriced:
    kwh: float
    hours: int
    days: int
    first_day: date
    last_day: date


@dataclass(frozen=True)
class Flat:
    runs: int
    longest_hours: int
    longest_start: datetime
    first_start: datetime


@dataclass(frozen=True)
class MeterCheck:
    """What one meter's rows say. `expected` is its number of expected hours (0 = not looked at in this range)."""

    asset_id: int
    kind: str  # "counter" | "power"
    interval_seconds: int
    expected: int
    first_reading: datetime | None
    later: bool  # the first reading is at or after the end of the range
    silent: Silent | None = None
    gaps: Gaps | None = None
    estimated: Estimated | None = None
    resets: Resets | None = None
    started: Started | None = None
    unpriced: Unpriced | None = None
    flat: Flat | None = None


def _utc(value: datetime) -> datetime:
    return value.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return _utc(value).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso_or_none(value: datetime | None) -> str | None:
    return None if value is None else _iso(value)


def expected_hours(first_bucket: datetime | None, start: datetime, stop: datetime) -> list[datetime]:
    """The UTC hour starts in [max(first_bucket, start), stop): the hours a meter should have a row for. A point that never
    recorded anything (`first_bucket` None) is expected over the whole range; one that first read at or after `stop` has none."""
    begin = start if first_bucket is None else max(first_bucket, start)
    bucket = _utc(begin).replace(minute=0, second=0, microsecond=0)
    if bucket < begin:
        bucket += HOUR
    hours: list[datetime] = []
    while bucket < stop:
        hours.append(bucket)
        bucket += HOUR
    return hours


def row_coverage(row: HourRow, interval_seconds: int) -> float:
    """The share of the hour a power row covers: exactly the factor `power_hours` multiplies the average power by."""
    if interval_seconds <= MINUTE_COVERAGE_MAX_INTERVAL:
        return min(1.0, row.minutes / 60)
    return min(1.0, row.n * interval_seconds / 3600)


def classify_counter_rows(rows: Sequence[HourRow], baseline_last: float | None) -> list[str | None]:
    """One entry per row, following the branches of `counter_hours` (the previous value is the previous row's last value, the
    reading before the first row for the first): "reset" (the hour ends below it: the engine counts across the reset), "dip" (the
    minimum went below it but the hour recovered: a glitch the engine ignores), "fell" (neither, yet the maximum is above the last
    value: a counter never goes down, so a reading went down inside the hour), else None. With nothing before it the first row is
    never a reset or a dip, but can be "fell"."""
    kinds: list[str | None] = []
    previous = baseline_last
    for row in rows:
        if previous is not None and row.last_value < previous:
            kinds.append("reset")
        elif previous is not None and row.min_value < previous:
            kinds.append("dip")
        elif row.max_value > row.last_value:
            kinds.append("fell")
        else:
            kinds.append(None)
        previous = row.last_value
    return kinds


def tolerated_hours(meter: Meter) -> int:
    """How many hours in a row without a row are normal for this meter. A counter polled slower than once an hour leaves hourly
    buckets empty by design (capped, because the interval has no upper bound); a faster counter and every power-only meter
    tolerate none: the engine counts an hour without a row as no energy."""
    if not meter.counter or meter.interval_seconds < 3600:
        return 0
    return min(MAX_TOLERATED_HOURS, math.ceil(meter.interval_seconds / 3600))


def _missing_runs(hours: Sequence[datetime], present: set[datetime]) -> list[tuple[int, int]]:
    """(index of the first hour, length) of each maximal run of expected hours without a row."""
    runs: list[tuple[int, int]] = []
    i, total = 0, len(hours)
    while i < total:
        if hours[i] in present:
            i += 1
            continue
        j = i
        while j < total and hours[j] not in present:
            j += 1
        runs.append((i, j - i))
        i = j
    return runs


def _gaps(
    hours: Sequence[datetime], runs: list[tuple[int, int]], meter: Meter, before: HourRow | None, rows: Sequence[HourRow]
) -> Gaps | None:
    longest = max(runs, key=lambda run: run[1]) if runs else None  # the earliest of equally long runs
    short_hours, short_minutes = _short_time(rows, meter, len(hours)) if not meter.counter else (0, 0)
    if not runs and not short_hours:
        return None
    leading = runs[0][1] if runs and runs[0][0] == 0 else 0
    return Gaps(
        runs=len(runs),
        hours=sum(length for _, length in runs),
        longest_hours=None if longest is None else longest[1],
        longest_start=None if longest is None else hours[longest[0]],
        first_start=None if not runs else hours[runs[0][0]],
        last_end=None if not runs else hours[runs[-1][0] + runs[-1][1] - 1] + HOUR,
        leading_hours=leading,
        previous_reading=before.bucket if (meter.counter and leading and before is not None) else None,
        short_hours=short_hours,
        short_minutes=short_minutes,
    )


def _short_time(rows: Sequence[HourRow], meter: Meter, expected: int) -> tuple[int, int]:
    """Hours of a power-only meter that HAVE a row but are covered less than fully by the engine's own coverage rule, and the
    minutes that adds up to, both 0 unless the total reaches max(SHORT_MINUTES, SHORT_SHARE of the expected minutes) so the
    ordinary drift of a poll loop does not list every meter. A row without samples adds nothing in the engine: fully short."""
    short_hours, missing = 0, 0.0
    for row in rows:
        coverage = 0.0 if row.n <= 0 else row_coverage(row, meter.interval_seconds)
        if coverage < 1.0:
            short_hours += 1
            missing += (1.0 - coverage) * 60
    missing = round(missing, 6)
    if short_hours and missing >= max(SHORT_MINUTES, round(expected * 60 * SHORT_SHARE, 6)):
        return short_hours, round(missing)
    return 0, 0


def _resets(rows: Sequence[HourRow], baseline_last: float | None) -> Resets | None:
    events = [(row.bucket, kind) for row, kind in zip(rows, classify_counter_rows(rows, baseline_last)) if kind]
    if not events:
        return None
    kinds = [kind for _, kind in events]
    return Resets(kinds.count("reset"), kinds.count("dip"), kinds.count("fell"), tuple(events[:EVENT_LIMIT]))


def _flat_flags(rows: Sequence[HourRow], meter: Meter, baseline_last: float | None) -> list[bool]:
    """Per row: does the engine count exactly zero for it on the plain branch (a counter's last = the previous last, or for a
    first row with nothing before it last = min; a reset row is never flat), or for a power-only row, is every sample the same
    value? A power-only run also needs the same value as the row before, which `_flat_runs` checks."""
    flags: list[bool] = []
    if meter.counter:
        previous = baseline_last
        for row in rows:
            # A reset row has last < previous, so it can never equal it: it is not flat (the brief's rule), by construction.
            flags.append(row.last_value == (row.min_value if previous is None else previous))
            previous = row.last_value
    else:
        flags = [row.n > 0 and row.min_value == row.max_value for row in rows]
    return flags


def _flat_runs(rows: Sequence[HourRow], flags: Sequence[bool], counter: bool) -> list[tuple[datetime, int]]:
    """(first bucket, clock hours) of every run of consecutive flat ROWS. A missing hour between two rows does not end a run: the
    value before and after the hole is the same, so the hole holds no energy either. The length runs from the first row's bucket
    to the end of the last row's hour."""
    runs: list[tuple[datetime, int]] = []
    first: HourRow | None = None
    last: HourRow | None = None

    def close() -> None:
        if first is not None and last is not None:
            runs.append((first.bucket, int((last.bucket - first.bucket) / HOUR) + 1))

    for row, flat in zip(rows, flags):
        if row.n <= 0 and not counter:
            continue  # the engine skips it; it neither continues nor ends a run
        if not flat:
            close()
            first = last = None
        elif first is None or (not counter and row.min_value != first.min_value):
            close()
            first = last = row
        else:
            last = row
    close()
    return runs


def _flat(rows: Sequence[HourRow], meter: Meter, baseline_last: float | None) -> Flat | None:
    counted = [run for run in _flat_runs(rows, _flat_flags(rows, meter, baseline_last), meter.counter) if run[1] >= FLAT_HOURS]
    if not counted:
        return None
    longest = max(counted, key=lambda run: run[1])  # the earliest of equally long runs
    return Flat(runs=len(counted), longest_hours=longest[1], longest_start=longest[0], first_start=counted[0][0])


def _unpriced(
    rows: Sequence[HourRow], meter: Meter, baseline_last: float | None, asset_id: int,
    rate_for: Callable[[int, date], float | None], zone: tzinfo,
) -> Unpriced | None:
    """Own hours with scaled kWh above zero and no rate on their local date (the engine's `_price` rule)."""
    per_hour = counter_hours(rows, baseline_last) if meter.counter else power_hours(rows, meter.interval_seconds)
    rates: dict[date, float | None] = {}
    kwh, hours, days = 0.0, 0, set()
    for bucket, raw in per_hour.items():
        energy = raw * meter.scale
        if energy <= 0:
            continue
        day = bucket.astimezone(zone).date()
        if day not in rates:
            rates[day] = rate_for(asset_id, day)
        if rates[day] is None:
            kwh += energy
            hours += 1
            days.add(day)
    if not hours:
        return None
    return Unpriced(kwh=kwh, hours=hours, days=len(days), first_day=min(days), last_day=max(days))


def check_meter(
    tree: AssetTree,
    inp: MeterInput,
    *,
    start: datetime,
    stop: datetime,
    rate_for: Callable[[int, date], float | None],
    zone: tzinfo,
    all_hours: Sequence[datetime] | None = None,
) -> MeterCheck:
    """Every finding for one meter. `all_hours` is `expected_hours(None, start, stop)`, shared by the caller to save time."""
    meter = inp.meter
    kind = "counter" if meter.counter else "power"
    rows = sorted((row for row in inp.rows if start <= row.bucket < stop), key=lambda row: row.bucket)
    first = inp.first_bucket
    if rows and (first is None or rows[0].bucket < first):
        first = rows[0].bucket  # the rows are the evidence: a point with a row in the range has recorded something
    if all_hours is None:
        all_hours = expected_hours(None, start, stop)
    hours = all_hours if first is None else all_hours[bisect_left(all_hours, first):]
    if not hours:
        later = bool(all_hours) and first is not None and first >= stop
        return MeterCheck(inp.asset_id, kind, meter.interval_seconds, 0, first, later)

    before = inp.before
    baseline = None if before is None else before.last_value
    silent = gaps = resets = None
    present = {row.bucket for row in rows}
    tolerance = tolerated_hours(meter)
    if not rows:
        if first is None:
            silent = Silent("never", None, len(hours), None)
        else:
            silent = Silent("none_in_month", None, len(hours), None if before is None else before.bucket)
    else:
        runs = _missing_runs(hours, present)
        trailing = runs.pop() if runs and runs[-1][0] + runs[-1][1] == len(hours) else None
        if trailing is not None and trailing[1] > tolerance:
            silent = Silent("trailing", hours[trailing[0]], trailing[1], rows[-1].bucket)
        gaps = _gaps(hours, [run for run in runs if run[1] > tolerance], meter, before, rows)
        if meter.counter:
            resets = _resets(rows, baseline)
    estimated = None
    if not meter.counter:
        estimated = Estimated(sum(1 for row in rows if row.n > 0), len(hours))
    started = None
    if first is not None and start < first < stop:
        started = Started(first, len(tree.children(inp.asset_id)))
    return MeterCheck(
        inp.asset_id, kind, meter.interval_seconds, len(hours), first, False,
        silent=silent,
        gaps=gaps,
        estimated=estimated,
        resets=resets,
        started=started,
        unpriced=_unpriced(rows, meter, baseline, inp.asset_id, rate_for, zone) if rows else None,
        flat=_flat(rows, meter, baseline) if rows else None,
    )


def _finish(entries: list[tuple[tuple, dict[str, Any]]]) -> dict[str, Any]:
    entries.sort(key=lambda entry: entry[0])
    return {"total": len(entries), "items": [item for _, item in entries[:CAP]]}


def _unmetered(tree: AssetTree, metered: set[int]) -> dict[str, Any]:
    """Leaves nothing measures: no meter of their own and none on any asset above. `beside_measured` marks the ones whose parent
    has a meter somewhere beneath it: that asset is billed from the other meters under it, without this leaf's power."""
    beneath: set[int] = set()
    for asset_id in metered:
        if asset_id in tree.nodes:
            beneath.update(tree.ancestors_or_self(asset_id)[1:])
    entries: list[tuple[tuple, dict[str, Any]]] = []
    for asset_id in tree.preorder():
        if tree.children(asset_id) or any(owner in metered for owner in tree.ancestors_or_self(asset_id)):
            continue
        parent = tree.nodes[asset_id].parent_id
        beside = parent is not None and parent in beneath
        path = tree.path(asset_id)
        entries.append(((not beside, path, asset_id), {"asset_id": asset_id, "path": path, "beside_measured": beside}))
    return _finish(entries)


def build_report(
    tree: AssetTree,
    inputs: Sequence[MeterInput],
    *,
    start: datetime,
    stop: datetime,
    rate_for: Callable[[int, date], float | None],
    zone: tzinfo,
    names: Mapping[int, tuple[str | None, str | None]] | None = None,
) -> dict[str, Any]:
    """The whole answer except the envelope: hours, meters, meter_hours, things and the nine groups (see the plan, section 3).
    `rate_for(asset_id, local date)` is the tariff lookup, `zone` the site's zone (the local date of an hour is
    `bucket.astimezone(zone).date()`), `names` maps an asset id to (point name, source name)."""
    names = names or {}
    all_hours = expected_hours(None, start, stop) if stop > start else []
    if not all_hours:
        return {
            "hours": 0, "meters": 0, "meter_hours": 0, "things": 0,
            "groups": {name: {"total": 0, "items": []} for name in (*THINGS, "unmetered", "later")},
        }
    groups: dict[str, list[tuple[tuple, dict[str, Any]]]] = {name: [] for name in THINGS}
    later: list[tuple[tuple, dict[str, Any]]] = []
    meters = meter_hours = 0
    for inp in inputs:
        check = check_meter(tree, inp, start=start, stop=stop, rate_for=rate_for, zone=zone, all_hours=all_hours)
        path = tree.path(inp.asset_id)
        if check.later and check.first_reading is not None:
            later.append((
                (path, inp.asset_id),
                {"asset_id": inp.asset_id, "path": path, "kind": check.kind, "first_reading": _iso(check.first_reading)},
            ))
        if not check.expected:
            continue
        meters += 1
        meter_hours += check.expected
        point, source = names.get(inp.asset_id, (None, None))
        head = {
            "asset_id": inp.asset_id, "path": path, "kind": check.kind, "point": point, "source": source,
            "interval_seconds": check.interval_seconds,
        }
        tail = (path, inp.asset_id)
        if (s := check.silent) is not None:
            groups["silent"].append((
                (s.reason != "never", -s.hours, *tail),
                {**head, "reason": s.reason, "since": _iso_or_none(s.since), "hours": s.hours,
                 "last_reading": _iso_or_none(s.last_reading)},
            ))
        if (g := check.gaps) is not None:
            groups["gaps"].append((
                (-g.hours, *tail),
                {**head, "runs": g.runs, "hours": g.hours, "longest_hours": g.longest_hours,
                 "longest_start": _iso_or_none(g.longest_start), "first_start": _iso_or_none(g.first_start),
                 "last_end": _iso_or_none(g.last_end), "leading_hours": g.leading_hours,
                 "previous_reading": _iso_or_none(g.previous_reading), "short_hours": g.short_hours,
                 "short_minutes": g.short_minutes},
            ))
        if (e := check.estimated) is not None:
            groups["estimated"].append((
                (-e.hours_estimated, *tail),
                {**head, "hours_estimated": e.hours_estimated, "hours_total": e.hours_total},
            ))
        if (r := check.resets) is not None:
            groups["resets"].append((
                (-(r.resets + r.dips + r.falls), *tail),
                {**head, "resets": r.resets, "dips": r.dips, "falls": r.falls,
                 "events": [{"at": _iso(at), "kind": kind} for at, kind in r.events]},
            ))
        if (st := check.started) is not None:
            groups["started"].append((
                (-st.first_reading.timestamp(), *tail),
                {**head, "first_reading": _iso(st.first_reading), "children": st.children},
            ))
        if (u := check.unpriced) is not None:
            groups["unpriced"].append((
                (-u.kwh, *tail),
                {**head, "kwh": u.kwh, "hours": u.hours, "days": u.days, "first_day": u.first_day.isoformat(),
                 "last_day": u.last_day.isoformat()},
            ))
        if (f := check.flat) is not None:
            groups["flat"].append((
                (-f.longest_hours, *tail),
                {**head, "runs": f.runs, "longest_hours": f.longest_hours, "longest_start": _iso(f.longest_start),
                 "first_start": _iso(f.first_start)},
            ))
    finished: dict[str, Any] = {name: _finish(entries) for name, entries in groups.items()}
    finished["unmetered"] = _unmetered(tree, {inp.asset_id for inp in inputs})
    finished["later"] = _finish(later)
    return {
        "hours": len(all_hours),
        "meters": meters,
        "meter_hours": meter_hours,
        "things": sum(finished[name]["total"] for name in THINGS),
        "groups": finished,
    }
