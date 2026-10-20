"""The Billing month check (W21): `GET /api/billing/month-check`, a plain list of what to look at before a month is trusted or
closed. It only reads. The maths is core/month_check.py (pure); this module resolves the month, reads the hourly rollup rows
of every metered point with ONE statement, and hands both over. It changes no figure and writes nothing (no audit row)."""
import json
from collections import defaultdict
from collections.abc import Mapping, Sequence
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
from dcdash.core import compute, figure_cache, ledger
from dcdash.core.cost import TariffRow, load_tariffs, rate_at
from dcdash.core.energy import PART_ROWS, HourRow, Meter, load_meters
from dcdash.core.models import BillingClose, Point, Source, User
from dcdash.core.month_check import LIMITS, THINGS, MeterInput, build_report
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

# The fingerprint of what a report was made from (w26b), built from the TEXT of `_ROWS` so that it cannot drift from the
# statement the report reads: the same three kinds of row for the same ids and window, only without the final ORDER BY (a hash
# that adds the rows up does not depend on their order, and a sort of a month of rows is a cost for nothing). If that tail ever
# changes the whole text is wrapped as it is (still the same rows, only slower) and tests/test_api_billing_check_ledger.py fails.
_ROWS_ORDER = "ORDER BY point_id, bucket"
_ROWS_TEXT = _ROWS.text.rstrip()
_ROWS_BODY = _ROWS_TEXT[: -len(_ROWS_ORDER)] if _ROWS_TEXT.endswith(_ROWS_ORDER) else _ROWS_TEXT
# The row hash is the figure cache's own (every column of the row, from the exact bytes, nothing that depends on the session's
# settings), and the hashes of a kind are added as exact numbers with the row count, as `figure_cache._DATA` does: one string
# `before:<count>:<sum>;first:...;row:...` (a kind that has no row has no part; no row at all gives the empty string). The tag
# comment names the statement (the test that counts the statements of a request reads it).
_FINGERPRINT = text(
    "/* billing_check data fingerprint */ "
    "SELECT coalesce(string_agg(t.kind || ':' || t.cnt || ':' || t.hsum, ';' ORDER BY t.kind), '') FROM ("
    f"SELECT x.kind, count(*) AS cnt, coalesce(sum({figure_cache._ROW_HASH}), 0) AS hsum FROM ({_ROWS_BODY}) x GROUP BY x.kind"
    ") t"
)
# The keys of the rows the fingerprint hashes, for the test that compares them with what `_ROWS` returns.
_FINGERPRINT_KEYS = text(f"SELECT x.kind, x.point_id, x.bucket FROM ({_ROWS_BODY}) x")


async def check_data_fingerprint(session: AsyncSession, point_ids: Sequence[int], start: datetime, stop: datetime) -> str:
    """A hash of exactly the rows the report of [start, stop) reads for these points: the rows of the window, the last bucket
    before it of EVERY point and the first bucket each point ever had. It covers nothing else, so a silent meter's hash is the
    same for a longer window (the ledger's key carries `stop` for that reason)."""
    return (await session.execute(_FINGERPRINT, {"ids": list(point_ids), "start": start, "end": stop})).scalar_one()


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


async def month_report(session: AsyncSession, tz_name: str, start: datetime, stop: datetime) -> dict[str, Any]:
    """The report of [start, stop) WITHOUT names, computed from `session` (the figures worker gives it one repeatable-read
    snapshot, so the tree, the mappings, the rows and the tariffs are of one moment). It does what the endpoint does when it
    computes, with `names=None`; `apply_names` puts the names in for an account that may see them. The result is plain JSON
    (lists, dicts with str keys, str, int, float, bool, None): the live answer goes through the same JSON encoding, so this
    changes no byte of a response, and the ledger codec accepts nothing else."""
    zone = ZoneInfo(tz_name)
    tree = await AssetTree.load(session)
    inputs: list[MeterInput] = []
    tariffs: list[TariffRow] = []
    if stop > start:  # as in the endpoint: an empty range reads nothing
        meters = await load_meters(session, tree)
        if meters:
            inputs = await _read_inputs(session, meters, start, stop)
            tariffs = await load_tariffs(session)
    report = await compute.run(partial(
        build_report,
        tree, inputs, start=start, stop=stop,
        rate_for=lambda asset_id, day: rate_at(tariffs, tree, asset_id, day),
        zone=zone, names=None,
    ))
    return json.loads(json.dumps(report))


def apply_names(report: dict[str, Any], names: Mapping[int, tuple[str, str]]) -> dict[str, Any]:
    """Put the point and source names into a report made without them, in place: the `point` and `source` of every item of the
    groups of `THINGS` (the only ones that have them), looked up as `build_report` looks them up. Nothing else is touched: the
    keys exist already (set to None), so assigning keeps their place, and a name changes neither which items a group lists nor
    their order (the sort keys are paths and ids). Returns the same dict."""
    for group in THINGS:
        for item in report["groups"][group]["items"]:
            item["point"], item["source"] = names.get(item["asset_id"], (None, None))
    return report


def _check_shape(report: dict[str, Any]) -> None:
    """Raise unless `report` has the shape `month_report` makes, as far as the endpoint and `apply_names` read it. The codec
    guarantees the bytes of a stored row, not what they say; a row of a wrong shape must be a miss, not a 500 (or a `point` key
    appended at the end of an item, which would be a different answer)."""
    if not {"hours", "meters", "meter_hours", "things", "groups"} <= set(report):
        raise ValueError("a report without its totals")
    groups = report["groups"]
    if list(groups) != [*THINGS, "unmetered", "later"]:
        raise ValueError("a report without its groups")
    for name in THINGS:
        for item in groups[name]["items"]:
            if "asset_id" not in item or "point" not in item or "source" not in item:
                raise ValueError("an item without its asset or its names")


async def _from_ledger(
    db: AsyncSession, tz_name: str, start: datetime, stop: datetime, meters: dict[int, Meter]
) -> dict[str, Any] | None:
    """The report of [start, stop) without names from the figure ledger, or None. It is used only when the stored row is
    provably the report of the readings and the configuration as they are NOW: made by this build, and the fingerprint of the
    configuration and the one of the rows this window reads (`check_data_fingerprint`) both equal the row's (always exact: a
    window of complete hours has no 60 second rule). It never raises: all of its statements run in ONE savepoint, so a failed
    one (a missing table) leaves the request's transaction usable, and anything that goes wrong is counted, logged once per
    kind of error and means "no row": the caller then computes, as it always did."""
    if not ledger.enabled() or not figure_cache.enabled():
        return None
    try:
        async with db.begin_nested():
            config_fp = await figure_cache.config_fingerprint(db)
            point_ids = sorted({meter.point_id for meter in meters.values()})
            data_fp = await check_data_fingerprint(db, point_ids, start, stop)
            return await ledger.read_check(
                db, start, stop, ledger.check_params(tz_name), config_fp, data_fp, validate=_check_shape
            )
    except Exception as exc:  # (zlib.error, ValueError, KeyError, TypeError and a database error too)
        ledger.record_error("reading the Check month row", exc)
        return None


@router.get("/billing/month-check", dependencies=[Depends(require_permission("billing.view"))])
async def month_check(
    month: str | None = Query(default=None, pattern=MONTH_PATTERN),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    """What to look at in one month's readings, from the same hourly rows the energy engine reads. An open month is looked at
    up to the last complete hour; a month that has not begun is not read at all. Point and source NAMES are returned only to an
    account that may view sources.

    A report that the figure ledger holds for exactly this window, made from exactly these readings and this configuration, is
    served instead of computed (`_from_ledger`; w26b). The answer is the same bytes either way: anything in doubt runs the code
    below, unchanged."""
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
    report: dict[str, Any] | None = None
    if stop > start:  # nothing to look at yet (the month has not begun, or its first hour has not finished): nothing is read
        meters = await load_meters(db, tree)
        if meters:
            report = await _from_ledger(db, tz_name, start, stop, meters)
            if report is not None:  # a row that is provably current: only the names (they are not in the ledger) are put in
                if user.can("sources.view"):
                    apply_names(report, await _names(db, meters))
            else:
                inputs = await _read_inputs(db, meters, start, stop)
                if user.can("sources.view"):
                    names = await _names(db, meters)
                tariffs = await load_tariffs(db)
    if report is None:
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
