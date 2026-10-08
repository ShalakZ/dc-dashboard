"""Site-timezone helpers: where a day or a month begins, and the range presets.

Every datetime returned here is in UTC. Two datetimes that share a ZoneInfo subtract by wall clock, which is
23 hours off across a daylight-saving change; in UTC, subtraction is elapsed time. Display with
`.astimezone(ZoneInfo(site_zone))` and take a local date with `.astimezone(...).date()`.
"""
import re
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

RANGE_PRESETS: tuple[str, ...] = (
    "1h", "6h", "24h", "7d", "30d", "today", "yesterday", "this_month", "last_month",
)
_ROLLING_HOURS = {"1h": 1, "6h": 6, "24h": 24, "7d": 7 * 24, "30d": 30 * 24}
ROLLING: frozenset[str] = frozenset(_ROLLING_HOURS)
_MONTH = re.compile(r"([0-9]{4})-(0[1-9]|1[0-2])")


def _zone(tz_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz_name)
    except (KeyError, ValueError, OSError):  # unknown key, malformed key, or a directory such as "America"
        raise ValueError(f"unknown timezone: {tz_name}") from None


def _aware(value: datetime, name: str) -> datetime:
    if value.tzinfo is None:
        raise ValueError(f"{name} must include a timezone offset")
    return value


def _midnight(day: date, zone: ZoneInfo) -> datetime:
    """The instant local `day` begins, in UTC. Where the zone skips midnight that day, the first instant
    after the gap; where it repeats midnight, the first occurrence."""
    return datetime.combine(day, time.min, tzinfo=zone).astimezone(timezone.utc)


def _shift_month(first: date, months: int) -> date:
    index = first.year * 12 + first.month - 1 + months
    return date(index // 12, index % 12 + 1, 1)


def validate_whole_hour_zone(tz_name: str) -> None:
    """Raise ValueError unless the zone exists and its UTC offset is a whole number of hours in January and July.

    A whole-hour offset puts local midnight on an hourly rollup bucket edge all year.
    """
    zone = _zone(tz_name)
    for probe in (datetime(2026, 1, 15, 12, tzinfo=timezone.utc), datetime(2026, 7, 15, 12, tzinfo=timezone.utc)):
        offset = probe.astimezone(zone).utcoffset()
        if offset is None or offset.total_seconds() % 3600:
            raise ValueError(
                f"timezone {tz_name} has a UTC offset ({offset}) that is not a whole number of hours"
            )


def day_start(now: datetime, tz_name: str) -> datetime:
    """The instant (UTC) of midnight at the start of `now`'s day in the given timezone."""
    zone = _zone(tz_name)
    return _midnight(_aware(now, "now").astimezone(zone).date(), zone)


def day_bounds(now: datetime, tz_name: str) -> tuple[datetime, datetime]:
    """[local midnight of `now`'s day, the next local midnight): 23, 24 or 25 hours long."""
    zone = _zone(tz_name)
    day = _aware(now, "now").astimezone(zone).date()
    return _midnight(day, zone), _midnight(day + timedelta(days=1), zone)


def month_start(now: datetime, tz_name: str) -> datetime:
    """Midnight at the start of `now`'s month in the given timezone."""
    zone = _zone(tz_name)
    return _midnight(_aware(now, "now").astimezone(zone).date().replace(day=1), zone)


def month_bounds(month: str, tz_name: str) -> tuple[datetime, datetime]:
    """"YYYY-MM" -> [first local midnight of the month, first local midnight of the next month)."""
    match = _MONTH.fullmatch(month)
    if match is None or not 1970 <= int(match[1]) <= 2100:
        raise ValueError("month must look like YYYY-MM")
    zone = _zone(tz_name)
    first = date(int(match[1]), int(match[2]), 1)
    return _midnight(first, zone), _midnight(_shift_month(first, 1), zone)


def resolve_range(preset: str, now: datetime, tz_name: str) -> tuple[datetime, datetime]:
    """[start, end) for a range preset. Rolling presets end now; calendar ones follow the site timezone."""
    zone = _zone(tz_name)
    now = _aware(now, "now")
    if preset in _ROLLING_HOURS:
        # Subtract in UTC: timedelta arithmetic on a zoned datetime moves the wall clock, not elapsed time.
        end = now.astimezone(timezone.utc)
        return end - timedelta(hours=_ROLLING_HOURS[preset]), end
    today = now.astimezone(zone).date()
    first = today.replace(day=1)
    if preset == "today":
        return _midnight(today, zone), now.astimezone(timezone.utc)
    if preset == "yesterday":
        return _midnight(today - timedelta(days=1), zone), _midnight(today, zone)
    if preset == "this_month":
        return _midnight(first, zone), now.astimezone(timezone.utc)
    if preset == "last_month":
        return _midnight(_shift_month(first, -1), zone), _midnight(first, zone)
    raise ValueError(f"range must be one of {', '.join(RANGE_PRESETS)}")


def local_days(start: datetime, end: datetime, tz_name: str) -> list[tuple[date, datetime, datetime]]:
    """The local days overlapping [start, end) as (date, from, to), with the first and last clipped to the range.

    A day is 23, 24 or 25 hours long where the zone changes its clock; consecutive entries abut exactly.
    """
    zone = _zone(tz_name)
    start, end = _aware(start, "start"), _aware(end, "end")
    days: list[tuple[date, datetime, datetime]] = []
    day = start.astimezone(zone).date()
    while True:
        day_from, day_to = _midnight(day, zone), _midnight(day + timedelta(days=1), zone)
        if day_from >= end:
            return days
        lo, hi = max(start, day_from), min(end, day_to)
        if lo < hi:
            days.append((day, lo.astimezone(timezone.utc), hi.astimezone(timezone.utc)))
        day += timedelta(days=1)
