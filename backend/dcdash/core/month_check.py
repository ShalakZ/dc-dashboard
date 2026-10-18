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
from types import MappingProxyType
from typing import Any

from dcdash.core.energy import MINUTE_COVERAGE_MAX_INTERVAL, HourRow, Meter, counter_hours, power_hours
from dcdash.core.tree import AssetTree

FLAT_HOURS = 24  # a reading that did not move for this many clock hours is listed
SHORT_MINUTES = 60  # a power-only meter's part-covered time is listed from this many minutes ...
SHORT_SHARE = 0.01  # ... and from this share of its expected minutes, whichever is more
MAX_TOLERATED_HOURS = 24  # a slow counter's normal empty hours are tolerated up to this many in a row
CAP = 50  # items per group in the answer (the group's `total` is the true count)
EVENT_LIMIT = 5  # reset events listed per meter

LIMITS: Mapping[str, Any] = MappingProxyType({  # read-only: an answer takes `dict(LIMITS)`, a caller cannot change the module's
    "flat_hours": FLAT_HOURS,
    "short_minutes": SHORT_MINUTES,
    "short_share": SHORT_SHARE,
    "max_tolerated_hours": MAX_TOLERATED_HOURS,
    "cap": CAP,
})

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
    children: int = 0  # assets under it: an own meter that is silent bills 0 for those hours whatever its children read


@dataclass(frozen=True)
class Gaps:
    """`runs`, `hours`, `longest_*`, `first_start` and `last_end` describe the month only (a counter listed only for the hole
    before the month has none). `leading_hours` is the missing run that begins at the first expected hour, tolerated or not;
    `hours_before_month` the hours without a row between a counter's reading before the month and the month."""

    runs: int
    hours: int
    longest_hours: int | None
    longest_start: datetime | None
    first_start: datetime | None
    last_end: datetime | None
    leading_hours: int
    hours_before_month: int
    previous_reading: datetime | None
    short_hours: int
    short_minutes: int


@dataclass(frozen=True)
class Estimated:
    hours_estimated: int
    hours_total: int
    negative_hours: int = 0  # hours whose (scaled) energy is below zero, e.g. a current transformer fitted the wrong way round
    negative_kwh: float = 0.0  # their sum, at most 0


@dataclass(frozen=True)
class Resets:
    resets: int
    dips: int
    falls: int
    events: tuple[tuple[datetime, str, float], ...]  # (hour, kind, size of the fall in the meter's own units)


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


def _ceil_hour(value: datetime) -> datetime:
    """The first whole UTC hour at or after `value`."""
    bucket = _utc(value).replace(minute=0, second=0, microsecond=0)
    return bucket if bucket >= value else bucket + HOUR


def expected_hours(first_bucket: datetime | None, start: datetime, stop: datetime) -> list[datetime]:
    """The UTC hour starts in [max(first_bucket, start), stop): the hours a meter should have a row for. A point that never
    recorded anything (`first_bucket` None) is expected over the whole range; one that first read at or after `stop` has none."""
    bucket = _ceil_hour(start if first_bucket is None else max(first_bucket, start))
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


def _hours_before_month(hours: Sequence[datetime], all_hours: Sequence[datetime], meter: Meter, before: HourRow | None) -> int:
    """The hours without a row between a counter's reading before the month and the month. The engine measures the first row of
    the month from that reading however old it is, so all of them are billed into the first row. Only a counter whose first
    expected hour is the first hour of the range has them (one that began later is measured from its own first reading)."""
    if not meter.counter or before is None or not hours or not all_hours or hours[0] != all_hours[0]:
        return 0
    return max(0, int((hours[0] - before.bucket) / HOUR) - 1)


def _gaps(
    hours: Sequence[datetime],
    runs: list[tuple[int, int]],
    meter: Meter,
    before: HourRow | None,
    rows: Sequence[HourRow],
    *,
    leading: int,
    hours_before: int,
    tolerated: int,
) -> Gaps | None:
    """`runs` are the missing runs longer than the tolerance (interior, or leading); `leading` is the missing run that begins at
    the first expected hour whether or not it is tolerated; `hours_before` the hours without a row before the month (see
    `_hours_before_month`). The item exists for a run, for short time worth listing, or when `hours_before + leading` is more than
    the meter's tolerance: that hole is billed into the first row of the month."""
    longest = max(runs, key=lambda run: run[1]) if runs else None  # the earliest of equally long runs
    short_hours, short_minutes = _short_time(rows, meter, len(hours)) if not meter.counter else (0, 0)
    hole_before = hours_before + leading > tolerated
    if not runs and not short_hours and not hole_before:
        return None
    return Gaps(
        runs=len(runs),
        hours=sum(length for _, length in runs),
        longest_hours=None if longest is None else longest[1],
        longest_start=None if longest is None else hours[longest[0]],
        first_start=None if not runs else hours[runs[0][0]],
        last_end=None if not runs else hours[runs[-1][0] + runs[-1][1] - 1] + HOUR,
        leading_hours=leading,
        hours_before_month=hours_before,
        previous_reading=before.bucket if (meter.counter and before is not None and (leading or hole_before)) else None,
        short_hours=short_hours,
        short_minutes=short_minutes,
    )


def _short_time(rows: Sequence[HourRow], meter: Meter, expected: int) -> tuple[int, int]:
    """Hours of a power-only meter that HAVE a row but are covered less than fully by the engine's own coverage rule, and the
    minutes that adds up to, both 0 unless the total reaches max(SHORT_MINUTES, SHORT_SHARE of the expected minutes) so the
    ordinary drift of a poll loop does not list every meter. A row without samples is no row for the engine: it is a missing hour
    (see `check_meter`), so it adds no short time here."""
    short_hours, missing = 0, 0.0
    for row in rows:
        if row.n <= 0:
            continue
        coverage = row_coverage(row, meter.interval_seconds)
        if coverage < 1.0:
            short_hours += 1
            missing += (1.0 - coverage) * 60
    missing = round(missing, 6)
    if short_hours and missing >= max(SHORT_MINUTES, round(expected * 60 * SHORT_SHARE, 6)):
        return short_hours, round(missing)
    return 0, 0


def _fall_size(kind: str, row: HourRow, previous: float | None) -> float:
    """How far a reading went down, in the meter's own units: a reset from the previous last value to this hour's last, a dip from
    the previous last value to this hour's lowest sample, a fall from this hour's highest sample to its last. The first two only
    exist when there is a previous value."""
    if kind == "fell" or previous is None:
        return row.max_value - row.last_value
    return previous - (row.last_value if kind == "reset" else row.min_value)


def _resets(rows: Sequence[HourRow], baseline_last: float | None) -> Resets | None:
    events: list[tuple[datetime, str, float]] = []
    previous = baseline_last
    for row, kind in zip(rows, classify_counter_rows(rows, baseline_last)):
        if kind:
            events.append((row.bucket, kind, _fall_size(kind, row, previous)))
        previous = row.last_value
    if not events:
        return None
    kinds = [kind for _, kind, _ in events]
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


def _flat_runs(
    rows: Sequence[HourRow], flags: Sequence[bool], counter: bool, before_bucket: datetime | None, first_hour: datetime
) -> list[tuple[datetime, int]]:
    """(start, clock hours) of every run of consecutive flat ROWS. A missing hour between two rows does not end a run: the value
    before and after the hole is the same, so the hole holds no energy either. The run ends with the last flat row's hour. A
    power-only run starts at its first flat row's bucket. A COUNTER's value was already standing still from the end of the
    previous row's hour (the row before the run, or the reading before the month for the first row), so it starts there, but not
    before the month (`first_hour`); with nothing before it, at its own bucket."""
    runs: list[tuple[datetime, int]] = []
    begin: datetime | None = None
    first: HourRow | None = None
    last: HourRow | None = None

    def close() -> None:
        if begin is not None and last is not None:
            runs.append((begin, int((last.bucket - begin) / HOUR) + 1))

    previous_bucket = before_bucket
    for row, flat in zip(rows, flags):
        if row.n <= 0 and not counter:
            continue  # the engine skips it; it neither continues nor ends a run
        if not flat:
            close()
            begin = first = last = None
        elif first is None or (not counter and row.min_value != first.min_value):
            close()
            first = last = row
            begin = row.bucket if (not counter or previous_bucket is None) else max(first_hour, previous_bucket + HOUR)
        else:
            last = row
        previous_bucket = row.bucket
    close()
    return runs


def _flat(rows: Sequence[HourRow], meter: Meter, before: HourRow | None, start: datetime) -> Flat | None:
    baseline_last = None if before is None else before.last_value
    flags = _flat_flags(rows, meter, baseline_last)
    before_bucket = None if before is None else before.bucket
    counted = [run for run in _flat_runs(rows, flags, meter.counter, before_bucket, _ceil_hour(start)) if run[1] >= FLAT_HOURS]
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
    children = len(tree.children(inp.asset_id))
    # A power-only row without samples is no row for the engine (`power_hours` skips it): its hour is a missing hour.
    live = [row for row in rows if meter.counter or row.n > 0]
    present = {row.bucket for row in live}
    tolerance = tolerated_hours(meter)
    if not rows:
        if first is None:
            silent = Silent("never", None, len(hours), None, children)
        else:
            silent = Silent("none_in_month", None, len(hours), None if before is None else before.bucket, children)
    else:
        runs = _missing_runs(hours, present)
        trailing = runs.pop() if runs and runs[-1][0] + runs[-1][1] == len(hours) else None
        if trailing is not None and trailing[1] > tolerance:
            silent = Silent("trailing", hours[trailing[0]], trailing[1], live[-1].bucket if live else None, children)
        leading = runs[0][1] if runs and runs[0][0] == 0 else 0  # the run that begins at the first expected hour, tolerated or not
        gaps = _gaps(
            hours, [run for run in runs if run[1] > tolerance], meter, before, live,
            leading=leading, hours_before=_hours_before_month(hours, all_hours, meter, before), tolerated=tolerance,
        )
        if meter.counter:
            resets = _resets(rows, baseline)
    estimated = None
    if not meter.counter:
        negative = [
            energy for raw in power_hours(rows, meter.interval_seconds).values() if (energy := raw * meter.scale) < 0
        ]
        estimated = Estimated(len(live), len(hours), len(negative), sum(negative, 0.0))
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
        flat=_flat(rows, meter, before, start) if rows else None,
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
                 "last_reading": _iso_or_none(s.last_reading), "children": s.children},
            ))
        if (g := check.gaps) is not None:
            groups["gaps"].append((
                # worst first: the time missing (a minute of short time counts as a minute), then the hole before the month
                (-(g.hours * 60 + g.short_minutes), -(g.hours_before_month + g.leading_hours), *tail),
                {**head, "runs": g.runs, "hours": g.hours, "longest_hours": g.longest_hours,
                 "longest_start": _iso_or_none(g.longest_start), "first_start": _iso_or_none(g.first_start),
                 "last_end": _iso_or_none(g.last_end), "leading_hours": g.leading_hours,
                 "hours_before_month": g.hours_before_month, "previous_reading": _iso_or_none(g.previous_reading),
                 "short_hours": g.short_hours, "short_minutes": g.short_minutes},
            ))
        if (e := check.estimated) is not None:
            groups["estimated"].append((
                (-e.hours_estimated, *tail),
                {**head, "hours_estimated": e.hours_estimated, "hours_total": e.hours_total,
                 "negative_hours": e.negative_hours, "negative_kwh": e.negative_kwh},
            ))
        if (r := check.resets) is not None:
            groups["resets"].append((
                (-r.resets, -(r.dips + r.falls), *tail),  # a real reset makes an hour approximate; a dip or a fell changes nothing
                {**head, "resets": r.resets, "dips": r.dips, "falls": r.falls,
                 "events": [{"at": _iso(at), "kind": kind, "size": size} for at, kind, size in r.events]},
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
