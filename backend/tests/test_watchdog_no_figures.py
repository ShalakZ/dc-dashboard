"""The data freshness watchdog moves no figure and no bill (w35 R2).

Two proofs. The code that makes the figures never names `point_latest`. And the same readings, written through the one write
function, give byte-identical hourly energy and month figures whatever the three new columns of `point_latest` hold.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path

import dcdash
from billing_helpers import add_tariff
from dcdash.connectors.base import BAD, GOOD
from dcdash.core import figures
from dcdash.core.db import get_sessionmaker
from dcdash.core.energy import hourly_energy
from dcdash.core.timeutil import month_bounds
from dcdash.core.tree import AssetTree
from dcdash.ingest.store import insert_readings
from helpers import make_asset, make_mapping, make_point, make_source, settle_rollups

PACKAGE = Path(dcdash.__file__).resolve().parent
FIGURE_CODE = ("core/energy.py", "core/figures.py", "core/compute.py", "api/billing_check.py")
T0 = datetime(2026, 6, 10, 0, 0, tzinfo=timezone.utc)
HOUR = timedelta(hours=1)


def test_the_code_that_makes_the_figures_never_names_point_latest():
    for name in FIGURE_CODE:
        source = (PACKAGE / name).read_text(encoding="utf-8")
        assert "point_latest" not in source, f"{name} reads point_latest"
        assert "PointLatest" not in source, f"{name} reads PointLatest"


async def store(db, rows) -> None:
    async with db.acquire() as conn, conn.transaction():
        await insert_readings(conn, rows, notify=False)


async def figures_now() -> tuple[str, str]:
    """Hourly energy over the day and the month's day entries, as text (so a -0.0 or a changed order counts)."""
    start, end = month_bounds("2026-06", "UTC")
    async with get_sessionmaker()() as session:
        tree = await AssetTree.load(session)
        energy = await hourly_energy(session, tree, T0, T0 + 24 * HOUR)
        month = await figures.compute_month_days(session, "UTC", start, end)
    hourly = repr((energy.hours, sorted(energy.own), energy.own_from))
    days = repr((month.entries, month.days, sorted(month.own), month.own_from, month.config_fp))
    return hourly, days


async def test_the_figures_are_byte_equal_whatever_the_freshness_columns_hold(db):
    source = await make_source(db, "live")
    site = await make_asset(db, "Site")
    points = {}
    for name, metric, interval in (
        ("rising", "energy_kwh", 60), ("frozen", "energy_kwh", 60), ("reset", "energy_kwh", 60),
        ("flapping", "energy_kwh", 60), ("power", "active_power_kw", 600),
    ):
        asset = await make_asset(db, name, site)
        points[name] = await make_point(db, source, name)
        await make_mapping(db, points[name], asset, metric, interval)
    await add_tariff(db, 0.5, "2026-06-01")

    # eight hours of batches, one per hour, each through the one write function
    for hour in range(8):
        base = T0 + hour * HOUR
        rows = [
            (points["rising"], base + timedelta(minutes=30), 1000.0 + 2.5 * hour, GOOD),
            (points["frozen"], base + timedelta(minutes=30), 500.0, GOOD),
            (points["reset"], base + timedelta(minutes=30), (400.0 + 3 * hour) if hour < 4 else (10.0 + 3 * hour), GOOD),
            (points["flapping"], base + timedelta(minutes=10), 77.0 + hour // 3, GOOD),
            (points["flapping"], base + timedelta(minutes=40), None, BAD),
            (points["flapping"], base + timedelta(minutes=50), 77.0 + hour // 3, GOOD),
            *[(points["power"], base + timedelta(minutes=5 + 10 * i), 6.0 + (hour % 3), GOOD) for i in range(6)],
        ]
        await store(db, rows)
    await settle_rollups(db)

    # the writer filled the three columns of every point
    filled = await db.fetchval(
        "SELECT count(*) FROM point_latest WHERE good_at IS NOT NULL AND good_value IS NOT NULL AND changed_at IS NOT NULL"
    )
    assert filled == len(points)

    with_columns = await figures_now()
    hourly = with_columns[0]
    assert "HourEnergy" in hourly and "2.5" in hourly  # the figures are real, not empty

    await db.execute("UPDATE point_latest SET good_at = NULL, good_value = NULL, changed_at = NULL")
    assert await figures_now() == with_columns

    await db.execute(
        "UPDATE point_latest SET good_at = TIMESTAMPTZ '2000-01-01 00:00+00', good_value = 123456.789, "
        "changed_at = TIMESTAMPTZ '2031-01-01 00:00+00', value = -1, quality = 1"
    )
    assert await figures_now() == with_columns

    # the table is not read at all: with it empty the figures are the same
    await db.execute("DELETE FROM point_latest")
    assert await figures_now() == with_columns
