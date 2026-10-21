"""The rules that turn what a source says into what the database stores (w30 R6). Pure: no database, no network.

Readings keep the SOURCE's unit and value; the mapping's `scale` converts when a figure is computed. `scale_for` gives that
scale for a unit, so a unit is never fixed inside the readings. Times are stored as aware UTC; quality is GOOD only for a
good code (everything else is kept as BAD evidence and counted by its label); an interval stamped at its period end moves
back to the period start. Every refusal is a value or a plain sentence, so a report can count it: no function here raises for
a bad reading, and the two that raise (`scale_for`, `period_start`) only do so for a bad configuration."""

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from functools import lru_cache
from zoneinfo import ZoneInfo

from dcdash.connectors.base import BAD, GOOD

LABEL_MAX = 40  # a quality label is a report key; an unknown code of any length must not make a long one
SKEW = timedelta(minutes=5)  # how far ahead of this clock a source's time may be before it counts as clock skew


class Rejected(StrEnum):
    """Why a reading was refused; the value is the text shown in reports."""

    NO_ZONE = "naive_time_without_zone"
    NONEXISTENT = "local_time_does_not_exist"
    AMBIGUOUS = "ambiguous_local_time"
    FUTURE = "later_than_now_plus_5_minutes"
    TOO_OLD = "older_than_raw_retention"
    NOT_A_TIME = "not_a_time"


class NormaliseError(ValueError):
    """A configuration the rules cannot accept; the message is a plain sentence a person can read."""


# Units: the factor that turns a value in that unit into the metric's base unit. Spellings are the front end's
# (frontend/src/lib/unitFit.ts: lower case, blanks removed), pinned for both sides by tests/fixtures/unit_samples.json.
_POWER = {"w": 0.001, "kw": 1.0, "mw": 1000.0}
_ENERGY = {"wh": 0.001, "kwh": 1.0, "mwh": 1000.0}
# Every other metric takes its base unit only: a scaled spelling (kV, kA, var) is refused rather than guessed.
_BASE_ONLY = {
    "voltage_v": ("v",),
    "current_a": ("a",),
    "power_factor": ("pf", "cosphi", "cosφ"),
    "frequency_hz": ("hz",),
    "reactive_power_kvar": ("kvar",),
    "apparent_power_kva": ("kva",),
}
UNITS: dict[str, dict[str, float]] = {
    "active_power_kw": _POWER,
    "energy_kwh": _ENERGY,
    **{metric: {unit: 1.0 for unit in units} for metric, units in _BASE_ONLY.items()},
}
_SHOWN = {"active_power_kw": "W, kW, MW", "energy_kwh": "Wh, kWh, MWh"}


def _spelling(unit: str) -> str:
    return "".join(unit.lower().split())


def scale_for(unit: str | None, metric: str) -> float:
    """The factor that turns a value in `unit` into the base unit of `metric` (the mapping's `scale`)."""
    if metric == "custom":
        return 1.0
    table = UNITS.get(metric)
    if table is None:
        raise NormaliseError(f"the metric {metric} is not known, so its unit cannot be checked")
    accepted = _SHOWN.get(metric) or ", ".join(dict.fromkeys(table))
    if unit is None or not unit.strip():
        raise NormaliseError(f"no unit is given for the metric {metric}; it must be one of {accepted}")
    scale = table.get(_spelling(unit))
    if scale is None:
        raise NormaliseError(f'the unit "{unit.strip()}" cannot be used for the metric {metric}; it must be one of {accepted}')
    return scale


def refuse_interval_as_energy(kind: str, metric: str) -> None:
    """An interval tag carries energy per period; the engine's cumulative-energy maths would read every period as a reset."""
    if kind == "interval" and metric == "energy_kwh":
        raise NormaliseError(
            "an interval tag (energy per period) cannot be mapped as a cumulative energy counter: "
            "the engine would read every period as a counter reset"
        )


_BAD_LABELS = frozenset({"uncertain", "substituted", "interpolated", "bad", "stale"})


def quality(code: object) -> tuple[int, str | None]:
    """(GOOD or BAD, the lower-case label to count it by). Only a good code is GOOD: an uncertain kWh must not reach a bill
    silently. The label is None for good; an unknown code (or None) gives `unknown:<code>`. A bool is never a code: False == 0."""
    if isinstance(code, int) and not isinstance(code, bool) and code == 0:
        return GOOD, None
    if isinstance(code, str):
        label = code.strip().lower()
        if label == "good":
            return GOOD, None
        if label in _BAD_LABELS:
            return BAD, label
    return BAD, f"unknown:{str(code).strip().lower()}"[:LABEL_MAX]


def _zone(name: object) -> ZoneInfo | None:
    """The zone, or None when there is none or the name is not one (a typo in a tag's zone is every reading's problem, and
    it must be a counted rejection, not an exception in a poll). A name is whatever a source sent: a number or a list is no name
    either, and the cache behind this must never be handed something it cannot hash."""
    return _named_zone(name) if isinstance(name, str) else None


@lru_cache(maxsize=64)
def _named_zone(name: str) -> ZoneInfo | None:
    if not name.strip():
        return None
    try:
        return ZoneInfo(name.strip())
    except (KeyError, ValueError, OSError):  # not found, malformed key, a directory instead of a file
        return None


def _local_to_utc(naive: datetime, zone: str | None, previous: datetime | None) -> datetime | Rejected:
    tz = _zone(zone)
    if tz is None:
        return Rejected.NO_ZONE
    first = naive.replace(tzinfo=tz, fold=0)
    second = naive.replace(tzinfo=tz, fold=1)
    if first.utcoffset() == second.utcoffset():
        return first.astimezone(UTC)
    # The offset differs between the two folds: the clock either skipped this time or showed it twice.
    as_first, as_second = first.astimezone(UTC), second.astimezone(UTC)
    if as_first.astimezone(tz).replace(tzinfo=None) != naive:
        return Rejected.NONEXISTENT
    if previous is None:
        return Rejected.AMBIGUOUS
    for candidate in (as_first, as_second):  # order is the only evidence: the first pass, then the second one
        if candidate > previous:
            return candidate
    return Rejected.AMBIGUOUS


def parse_time(value: object, zone: str | None, *, previous: datetime | None = None) -> datetime | Rejected:
    """A source's time as an aware UTC datetime, or the reason it was refused. Never raises for bad input.

    An offset (or Z) is converted. A naive time needs the tag's `zone`. `previous` is the last resolved instant of the same
    ascending series: it is what tells the first pass through the repeated autumn hour from the second."""
    if isinstance(value, str):
        text = value.strip()
        if len(text) <= 10:  # every date-only spelling is at most 10 characters; a day is not an instant
            return Rejected.NOT_A_TIME
        try:
            value = datetime.fromisoformat(text)
        except ValueError:
            return Rejected.NOT_A_TIME
    if not isinstance(value, datetime):
        return Rejected.NOT_A_TIME
    try:
        if value.utcoffset() is not None:
            return value.astimezone(UTC)
        return _local_to_utc(value, zone, previous)
    except (OverflowError, ValueError):  # a year-1 time with an offset has no UTC
        return Rejected.NOT_A_TIME


def convert_series(
    values: Sequence[object], zone: str | None, *, previous: datetime | None = None
) -> list[datetime | Rejected]:
    """`parse_time` over an ascending series, carrying the last good instant forward so the repeated autumn hour becomes
    two different UTC hours. `previous` seeds that carry when the series continues an earlier page."""
    converted: list[datetime | Rejected] = []
    for value in values:
        result = parse_time(value, zone, previous=previous)
        converted.append(result)
        if not isinstance(result, Rejected):
            previous = result
    return converted


def period_start(ts: datetime, period_seconds: int, stamp: str) -> datetime:
    """The start of the period a value covers. A value stamped at its END (23:45 to 24:00 stamped 00:00 next day) moves back
    by the period, so it lands in the right hour, day and month."""
    if period_seconds <= 0:
        raise NormaliseError(f"a period of {period_seconds} seconds is not a length of time; it must be more than zero")
    if stamp == "end":
        return ts - timedelta(seconds=period_seconds)
    if stamp == "start":
        return ts
    raise NormaliseError(f'the stamp "{stamp}" is not known; a value is stamped at the "start" or the "end" of its period')


def check_window(ts: datetime, now: datetime, raw_retention_days: int) -> Rejected | None:
    """FUTURE beyond five minutes of clock skew; TOO_OLD past raw retention minus a day (a refresh over a range whose raw
    chunk is already dropped would delete rollup rows, R8 c)."""
    if ts > now + SKEW:
        return Rejected.FUTURE
    if ts < now - timedelta(days=raw_retention_days - 1):
        return Rejected.TOO_OLD
    return None
