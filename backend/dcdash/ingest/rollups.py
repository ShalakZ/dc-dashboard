"""What the seeder and the history backfill share about the rollups (w30 D8): the hour edges, the refresh of a continuous aggregate
over a range, the check that a refresh would not delete history, and the two storage facts both need (the raw retention and the site
time zone).

Why a refresh needs care. `refresh_continuous_aggregate` recomputes every bucket of its window from the raw readings, and the raw
retention policy logs an invalidation over every chunk it drops: a refresh over a window that holds minutes whose raw readings are
gone would recompute them from nothing and DELETE real rollup history (migration 0004, `_MINUTES_WITHOUT_RAW`). So a caller asks
`pending_drop_range` first. The refresh only materialises buckets that lie wholly inside its window, so `refresh_range` aligns both
ends to bucket edges and clamps the end the way the policies do: the hourly view up to the start of the previous hour, the minute
view up to the previous whole minute. The newest hour is then served by real-time aggregation and is not frozen for the 70 minutes
the policy would leave it."""
import asyncio
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import asyncpg

from dcdash.core.config import get_settings
from dcdash.core.storage import FACTORY_STORAGE_SETTINGS, REFRESH_WINDOW_DAYS, STORAGE_KEY

HOUR = timedelta(hours=1)
MINUTE = timedelta(minutes=1)
LOCK_ATTEMPTS = 50
LOCK_WAIT_SECONDS = 0.2


def hour_floor(ts: datetime) -> datetime:
    """time_bucket('1 hour', ts): the rollup buckets are UTC hours."""
    return ts.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


def hour_ceil(ts: datetime) -> datetime:
    floored = hour_floor(ts)
    return floored if floored == ts else floored + HOUR


def minute_floor(ts: datetime) -> datetime:
    return ts.astimezone(timezone.utc).replace(second=0, microsecond=0)


def minute_ceil(ts: datetime) -> datetime:
    floored = minute_floor(ts)
    return floored if floored == ts else floored + MINUTE


# ---- two storage facts -------------------------------------------------------------------------------------------------------


async def stored_setting(pool: asyncpg.Pool, key: str) -> dict:
    value = await pool.fetchval("SELECT value FROM settings WHERE key = $1", key)
    if isinstance(value, str):
        value = json.loads(value)
    return value if isinstance(value, dict) else {}


def default_timezone() -> str:
    try:
        return get_settings().timezone
    except Exception:  # no secret key in this environment: the dry run still works
        return os.environ.get("DCDASH_TIMEZONE", "UTC")


async def site_timezone(pool: asyncpg.Pool) -> str:
    """The site time zone the way api.settings.current_timezone reads it: the stored value, else the configured default."""
    name = (await stored_setting(pool, "general")).get("timezone")
    for candidate in (name, default_timezone()):
        try:
            ZoneInfo(str(candidate))
            return str(candidate)
        except (KeyError, ValueError, OSError):
            continue
    return "UTC"


async def raw_retention_days(pool: asyncpg.Pool) -> int:
    """Raw retention from the `storage` setting; the factory value when it is missing or no longer passes the storage rules."""
    days = (await stored_setting(pool, STORAGE_KEY)).get("raw_retention_days")
    if isinstance(days, int) and not isinstance(days, bool) and days >= REFRESH_WINDOW_DAYS + 1:
        return days
    return FACTORY_STORAGE_SETTINGS.raw_retention_days


# ---- the refresh -------------------------------------------------------------------------------------------------------------


async def refresh_view(pool: asyncpg.Pool, view: str, lo: datetime, hi: datetime) -> None:
    """refresh_continuous_aggregate must run outside a transaction: a pooled connection executing a bare statement (the simple
    query protocol, autocommit) satisfies that. A policy job refreshing the same view holds a lock for a moment: retry."""
    sql = f"CALL refresh_continuous_aggregate('{view}', '{lo.isoformat()}'::timestamptz, '{hi.isoformat()}'::timestamptz)"
    for attempt in range(LOCK_ATTEMPTS):
        try:
            async with pool.acquire() as conn:
                await conn.execute(sql)
            return
        except asyncpg.LockNotAvailableError:
            if attempt == LOCK_ATTEMPTS - 1:
                raise
            await asyncio.sleep(LOCK_WAIT_SECONDS)


async def refresh_range(pool: asyncpg.Pool, lo: datetime, hi: datetime, now: datetime) -> list[str]:
    """Both rollups over [lo, hi] widened to whole buckets, the minute view first (the hourly one is built on it), the end of each
    clamped as in the module docstring. A view whose clamped window holds no whole bucket is left alone. Returns the views refreshed.
    `now` is the caller's clock, never the database's."""
    done: list[str] = []
    minute_end = min(minute_ceil(hi), minute_floor(now) - MINUTE)
    if minute_floor(lo) < minute_end:
        await refresh_view(pool, "readings_1m", minute_floor(lo), minute_end)
        done.append("readings_1m")
    hour_end = min(hour_ceil(hi), hour_floor(now) - HOUR)
    if hour_floor(lo) < hour_end:
        await refresh_view(pool, "readings_1h", hour_floor(lo), hour_end)
        done.append("readings_1h")
    return done


# A rollup minute older than the oldest raw reading: raw data was dropped (or deleted) and the rollup still has what it made of it.
_MINUTES_WITHOUT_RAW = """
SELECT min(bucket) FROM readings_1m
WHERE bucket >= $1 AND bucket < $2
  AND bucket < coalesce((SELECT time_bucket(INTERVAL '1 minute', min(ts)) FROM readings), 'infinity'::timestamptz)
"""


# The same question against a floor the caller took earlier: $3 is the oldest raw reading it saw (NULL: there was none, so every
# rollup minute lacks its raw readings).
_MINUTES_BELOW_FLOOR = """
SELECT min(bucket) FROM readings_1m
WHERE bucket >= $1 AND bucket < $2
  AND bucket < coalesce(time_bucket(INTERVAL '1 minute', $3::timestamptz), 'infinity'::timestamptz)
"""

_READ_NOW: Any = object()  # `pending_drop_range(floor=...)` not given: the oldest raw reading is read when the question is asked


async def pending_drop_range(pool: asyncpg.Pool, lo: datetime, hi: datetime, *, floor: datetime | None = _READ_NOW) -> str | None:
    """Why a refresh over [hour_floor(lo), hi] would be unsafe, as a sentence without a full stop at its end, or None.

    `floor` is for a caller that WRITES raw readings before it asks (an import): the rows it stored have lowered `min(ts)`, which
    hides the minutes that lie below the raw data it found. It passes the instant it read before its first write, from which on
    no minute has lost its raw readings (the import's end of the lost stretch; None: no raw reading at all, every minute counts)."""
    if floor is _READ_NOW:
        oldest = await pool.fetchval(_MINUTES_WITHOUT_RAW, hour_floor(lo), hi)
    else:
        oldest = await pool.fetchval(_MINUTES_BELOW_FLOOR, hour_floor(lo), hi, floor)
    if oldest is None:
        return None
    return (
        f"the 1-minute rollup (readings_1m) holds minutes from {oldest:%Y-%m-%d %H:%M} UTC whose raw readings are gone (the raw "
        "retention dropped them). Refreshing the rollups over the range would recompute them from nothing and delete that real "
        "history, so nothing is written"
    )
