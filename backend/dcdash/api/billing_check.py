"""The Billing month check (W21): `GET /api/billing/month-check`, a plain list of what to look at before a month is trusted or
closed. It only reads. The maths is core/month_check.py (pure); this module resolves the month, reads the hourly rollup rows
of every metered point with ONE statement, and hands both over. It changes no figure and writes nothing (no audit row)."""
from collections import defaultdict
from datetime import datetime, timezone
from functools import partial
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api import billing
from dcdash.api.billing import MONTH_PATTERN
from dcdash.api.deps import current_user, get_db, require_permission
from dcdash.api.settings import current_timezone
from dcdash.core import compute
from dcdash.core.cost import TariffRow, load_tariffs, rate_at
from dcdash.core.energy import PART_ROWS, HourRow, Meter, load_meters
from dcdash.core.models import BillingClose, Point, Source, User
from dcdash.core.month_check import LIMITS, MeterInput, build_report
from dcdash.core.timeutil import month_bounds, validate_whole_hour_zone
from dcdash.core.tree import AssetTree

router = APIRouter(prefix="/api", tags=["billing"])

# One statement for every metered point, three kinds of row. It mirrors core/energy._ROWS (private to the engine, so it is
# written out here and a test compares the two) with one difference: `before`, the last bucket before `start`, is read for
# EVERY point, not only for counters, because it is both a counter's baseline and the last reading a silent meter had.
#   row    the rows of [start, end)
#   before the last bucket before `start`
#   first  the first bucket the point ever had, whenever that was
# The rollup views are real-time and exclude bad-quality samples, exactly as for the energy engine.
_ROWS = text(
    """
    SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value, minutes, 'row' AS kind
    FROM readings_1h
    WHERE point_id = ANY(CAST(:ids AS integer[])) AND bucket >= :start AND bucket < :end
    UNION ALL
    SELECT b.point_id, b.bucket, b.min_value, b.max_value, b.sum_value, b.n, b.last_value, b.minutes, 'before'
    FROM unnest(CAST(:ids AS integer[])) AS c(point_id)
    CROSS JOIN LATERAL (
        SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value, minutes
        FROM readings_1h
        WHERE point_id = c.point_id AND bucket < :start
        ORDER BY bucket DESC
        LIMIT 1
    ) b
    UNION ALL
    SELECT f.point_id, f.bucket, f.min_value, f.max_value, f.sum_value, f.n, f.last_value, f.minutes, 'first'
    FROM unnest(CAST(:ids AS integer[])) AS p(point_id)
    CROSS JOIN LATERAL (
        SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value, minutes
        FROM readings_1h
        WHERE point_id = p.point_id
        ORDER BY bucket
        LIMIT 1
    ) f
    ORDER BY point_id, bucket
    """
)


def _z(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _read_inputs(
    db: AsyncSession, meters: dict[int, Meter], start: datetime, stop: datetime
) -> list[MeterInput]:
    rows: dict[int, list[HourRow]] = defaultdict(list)
    before: dict[int, HourRow] = {}
    first: dict[int, datetime] = {}
    ids = sorted({meter.point_id for meter in meters.values()})
    # Streamed in parts, as the engine's read is, so the event loop is free between parts of a big month (still ONE statement).
    result = await db.stream(_ROWS, {"ids": ids, "start": start, "end": stop})
    try:
        async for part in result.partitions(PART_ROWS):
            for row in part:
                # sum(n) in the rollup is numeric, which asyncpg returns as Decimal.
                hour = HourRow(
                    row.bucket, row.min_value, row.max_value, row.sum_value, int(row.n), row.last_value, int(row.minutes)
                )
                if row.kind == "before":
                    before[row.point_id] = hour
                elif row.kind == "first":
                    first[row.point_id] = row.bucket
                else:
                    rows[row.point_id].append(hour)
    finally:
        await result.close()
    return [
        MeterInput(asset_id, meter, rows.get(meter.point_id, []), before.get(meter.point_id), first.get(meter.point_id))
        for asset_id, meter in meters.items()
    ]


async def _names(db: AsyncSession, meters: dict[int, Meter]) -> dict[int, tuple[str, str]]:
    """asset id -> (point name, source name) for the meters' points. Names only: never the address, the URL or the config."""
    query = (
        select(Point.id, Point.name, Source.name)
        .join(Source, Source.id == Point.source_id)
        .where(Point.id.in_(sorted({meter.point_id for meter in meters.values()})))
    )
    by_point = {point_id: (point_name, source_name) for point_id, point_name, source_name in await db.execute(query)}
    return {asset_id: by_point[meter.point_id] for asset_id, meter in meters.items() if meter.point_id in by_point}


@router.get("/billing/month-check", dependencies=[Depends(require_permission("billing.view"))])
async def month_check(
    month: str | None = Query(default=None, pattern=MONTH_PATTERN),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    """What to look at in one month's readings, from the same hourly rows the energy engine reads. An open month is looked at
    up to the last complete hour; a month that has not begun is not read at all. Point and source NAMES are returned only to an
    account that may view sources."""
    tz_name = await current_timezone(db)
    try:
        validate_whole_hour_zone(tz_name)
    except ValueError as exc:
        raise HTTPException(
            409,
            f"the site timezone {tz_name} cannot be used for billing ({exc}); "
            "choose a zone with whole-hour UTC offsets in Settings",
        ) from None
    zone = ZoneInfo(tz_name)
    now = billing._now()  # through the module: the tests move the clock of both billing endpoints with one patch
    month = month or now.astimezone(zone).strftime("%Y-%m")
    try:
        month_start, month_end = month_bounds(month, tz_name)
    except (ValueError, OverflowError):
        raise HTTPException(422, "month must look like 2026-10") from None
    start, end = month_start.astimezone(timezone.utc), month_end.astimezone(timezone.utc)

    if now < start:
        state, stop = "not_begun", start
    elif now < end:
        state, stop = "open", min(end, now.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0))
    else:
        state, stop = "finished", end
    closed = await db.scalar(
        select(BillingClose.id).where(BillingClose.month == month, BillingClose.reopened_at.is_(None)).limit(1)
    ) is not None

    tree = await AssetTree.load(db)
    inputs: list[MeterInput] = []
    names: dict[int, tuple[str, str]] | None = None
    tariffs: list[TariffRow] = []
    if stop > start:  # nothing to look at yet (the month has not begun, or its first hour has not finished): nothing is read
        meters = await load_meters(db, tree)
        if meters:
            inputs = await _read_inputs(db, meters, start, stop)
            if user.can("sources.view"):
                names = await _names(db, meters)
            tariffs = await load_tariffs(db)
    # The report is pure (the tree, the rows and the tariffs are only read): on the compute thread, the loop stays free.
    report = await compute.run(partial(
        build_report,
        tree, inputs, start=start, stop=stop,
        rate_for=lambda asset_id, day: rate_at(tariffs, tree, asset_id, day),
        zone=zone, names=names,
    ))
    return {
        "month": month,
        "timezone": tz_name,
        "state": state,
        "closed": closed,
        "from": _z(start),
        "to": _z(stop),
        "month_end": _z(end),
        "hours": report["hours"],
        "meters": report["meters"],
        "meter_hours": report["meter_hours"],
        "things": report["things"],
        "limits": dict(LIMITS),
        "groups": report["groups"],
    }
