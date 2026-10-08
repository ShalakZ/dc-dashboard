from datetime import date, datetime, timedelta
from decimal import Decimal

import asyncpg
import pytest
from sqlalchemy import select

from dcdash.core.db import get_sessionmaker
from dcdash.core.models import Dashboard, Tariff, Widget
from tests.helpers import make_asset, refresh_policies

PRESETS = ["1h", "6h", "24h", "7d", "30d", "today", "yesterday", "this_month", "last_month"]
WIDGET_TYPES = ["timeseries", "bar", "stat", "gauge", "table"]
DAY = date(2026, 10, 1)


async def add_tariff(db, asset_id, day=DAY, rate="0.12") -> int:
    return await db.fetchval(
        "INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) VALUES ($1, $2, $3) RETURNING id",
        asset_id, Decimal(rate), day,
    )


async def add_dashboard(db, name="Ops", range_=None) -> int:
    if range_ is None:
        return await db.fetchval("INSERT INTO dashboards (name) VALUES ($1) RETURNING id", name)
    return await db.fetchval("INSERT INTO dashboards (name, range) VALUES ($1, $2) RETURNING id", name, range_)


async def add_widget(db, dashboard_id, type_="stat", x=0, y=0, w=3, h=2) -> int:
    return await db.fetchval(
        "INSERT INTO widgets (dashboard_id, type, title, config, x, y, w, h) VALUES ($1, $2, 'T', $3, $4, $5, $6, $7) RETURNING id",
        dashboard_id, type_, {"assets": [1], "source": "metric"}, x, y, w, h,
    )


# ---- tariffs ----

async def test_a_negative_rate_is_rejected_and_zero_is_allowed(db):
    asset = await make_asset(db, "Panel")
    with pytest.raises(asyncpg.CheckViolationError):
        await add_tariff(db, asset, rate="-0.01")
    await add_tariff(db, asset, rate="0")


async def test_the_rate_ceiling_is_one_million_inclusive(db):
    asset = await make_asset(db, "Panel")
    await add_tariff(db, asset, DAY, "1000000")  # the contract rejects only rates ABOVE 1000000
    with pytest.raises(asyncpg.CheckViolationError):
        await add_tariff(db, asset, date(2026, 10, 2), "1000000.000001")


async def test_one_rate_per_asset_and_day(db):
    a, b = await make_asset(db, "A"), await make_asset(db, "B")
    await add_tariff(db, a, DAY)
    with pytest.raises(asyncpg.UniqueViolationError):
        await add_tariff(db, a, DAY, "0.50")
    await add_tariff(db, a, date(2026, 10, 2))  # same asset, another day
    await add_tariff(db, b, DAY)                # same day, another asset


async def test_two_site_defaults_for_the_same_day_are_rejected(db):
    await add_tariff(db, None, DAY)
    with pytest.raises(asyncpg.UniqueViolationError):  # NULLS NOT DISTINCT: NULL asset counts as one
        await add_tariff(db, None, DAY, "0.50")
    await add_tariff(db, None, date(2026, 10, 2))


async def test_the_site_default_and_an_override_coexist_on_one_date(db):
    asset = await make_asset(db, "Panel")
    await add_tariff(db, None, DAY)
    await add_tariff(db, asset, DAY, "0.20")
    assert await db.fetchval("SELECT count(*) FROM tariffs") == 2


async def test_deleting_an_asset_deletes_its_tariffs_but_not_the_site_default(db):
    asset, other = await make_asset(db, "Panel"), await make_asset(db, "Other")
    site_default = await add_tariff(db, None, DAY)
    await add_tariff(db, asset, DAY)  # goes with the asset
    kept = await add_tariff(db, other, DAY)
    await db.execute("DELETE FROM assets WHERE id = $1", asset)
    assert sorted(r["id"] for r in await db.fetch("SELECT id FROM tariffs")) == sorted([site_default, kept])


async def test_deleting_a_user_keeps_their_tariffs_and_dashboards(db):
    user = await db.fetchval("INSERT INTO users (username, password_hash, role) VALUES ('u', 'x', 'admin') RETURNING id")
    tariff = await add_tariff(db, None, DAY)
    dashboard = await add_dashboard(db)
    await db.execute("UPDATE tariffs SET created_by = $1 WHERE id = $2", user, tariff)
    await db.execute("UPDATE dashboards SET created_by = $1 WHERE id = $2", user, dashboard)
    await db.execute("DELETE FROM users WHERE id = $1", user)
    assert await db.fetchval("SELECT created_by FROM tariffs WHERE id = $1", tariff) is None
    assert await db.fetchval("SELECT created_by FROM dashboards WHERE id = $1", dashboard) is None


# ---- dashboards and widgets ----

async def test_a_dashboard_defaults_to_24h_and_its_name_is_unique(db):
    dashboard = await add_dashboard(db, "Ops")
    row = await db.fetchrow("SELECT range, created_at, updated_at FROM dashboards WHERE id = $1", dashboard)
    assert row["range"] == "24h" and row["created_at"].tzinfo is not None and row["updated_at"].tzinfo is not None
    with pytest.raises(asyncpg.UniqueViolationError):
        await add_dashboard(db, "Ops")


@pytest.mark.parametrize("preset", PRESETS)
async def test_every_range_preset_is_accepted(db, preset):
    await add_dashboard(db, f"d-{preset}", preset)


@pytest.mark.parametrize("bad", ["2d", "", "Today", "custom", "12h"])
async def test_a_range_that_is_not_a_preset_is_rejected(db, bad):
    with pytest.raises(asyncpg.CheckViolationError):
        await add_dashboard(db, "x", bad)


@pytest.mark.parametrize("type_", WIDGET_TYPES)
async def test_every_widget_type_is_accepted(db, type_):
    await add_widget(db, await add_dashboard(db), type_)


@pytest.mark.parametrize("bad", ["pie", "", "Stat", "line"])
async def test_a_widget_type_outside_the_five_is_rejected(db, bad):
    dashboard = await add_dashboard(db)
    with pytest.raises(asyncpg.CheckViolationError):
        await add_widget(db, dashboard, bad)


@pytest.mark.parametrize("geometry", [{"x": -1}, {"y": -1}, {"w": 0}, {"h": 0}])
async def test_widget_geometry_must_be_on_the_grid(db, geometry):
    dashboard = await add_dashboard(db)
    with pytest.raises(asyncpg.CheckViolationError):
        await add_widget(db, dashboard, **geometry)


async def test_a_widget_needs_an_existing_dashboard(db):
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await add_widget(db, 999)


async def test_deleting_a_dashboard_deletes_its_widgets_only(db):
    first, second = await add_dashboard(db, "First"), await add_dashboard(db, "Second")
    await add_widget(db, first)
    await add_widget(db, first, "bar")
    kept = await add_widget(db, second)
    await db.execute("DELETE FROM dashboards WHERE id = $1", first)
    assert [r["id"] for r in await db.fetch("SELECT id FROM widgets")] == [kept]


# ---- refresh windows ----

async def test_both_refresh_policies_look_back_seven_days_and_keep_their_other_settings(db):
    policies = await refresh_policies(db)
    assert set(policies) == {"readings_1m", "readings_1h"}
    # (start_offset, end_offset, schedule_interval): only the start offset changed from 0002 (3 hours / 2 days)
    assert policies["readings_1m"] == (timedelta(days=7), timedelta(minutes=1), timedelta(minutes=1))
    assert policies["readings_1h"] == (timedelta(days=7), timedelta(hours=1), timedelta(minutes=10))


# ---- ORM ----

async def test_orm_round_trip_applies_defaults(db):
    async with get_sessionmaker()() as session:
        dashboard = Dashboard(name="Ops")
        session.add(dashboard)
        await session.flush()
        session.add(Widget(dashboard_id=dashboard.id, type="stat", title="Power", config={"assets": [1], "source": "metric"}, x=0, y=0, w=3, h=2))
        session.add(Tariff(asset_id=None, rate_per_kwh=Decimal("0.125"), effective_from=date(2026, 10, 1)))
        await session.commit()
    async with get_sessionmaker()() as session:
        dashboard = (await session.execute(select(Dashboard))).scalar_one()
        widget = (await session.execute(select(Widget))).scalar_one()
        tariff = (await session.execute(select(Tariff))).scalar_one()
    assert dashboard.range == "24h" and dashboard.created_at.tzinfo is not None and dashboard.updated_at.tzinfo is not None
    assert widget.dashboard_id == dashboard.id and widget.title == "Power" and widget.config == {"assets": [1], "source": "metric"}
    assert (widget.x, widget.y, widget.w, widget.h) == (0, 0, 3, 2)
    assert tariff.asset_id is None and tariff.rate_per_kwh == Decimal("0.125") and tariff.effective_from == date(2026, 10, 1)
    assert isinstance(tariff.created_at, datetime) and tariff.created_at.tzinfo is not None and tariff.created_by is None
