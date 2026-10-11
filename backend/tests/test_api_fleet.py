from datetime import datetime, timedelta, timezone

import pytest

from billing_helpers import add_tariff, set_currency
from helpers import login_as, make_asset, make_mapping, make_point, make_source, settle_rollups
from test_api_summary_cost import todays_panel, yesterdays_panel

NOW = datetime(2026, 3, 10, 10, 20, tzinfo=timezone.utc)  # the site zone is UTC in these tests
EMPTY_POWER = {"kw": None, "counted": 0, "of": 0}


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    monkeypatch.setattr("dcdash.api.data._now", lambda: NOW)


async def fleet(client) -> dict:
    response = await client.get("/api/fleet/summary")
    assert response.status_code == 200, response.text
    return response.json()


async def asset_summary(client, asset_id: int) -> dict:
    response = await client.get(f"/api/assets/{asset_id}/summary")
    assert response.status_code == 200, response.text
    return response.json()


async def source_for(db, enabled: bool = True) -> int:
    if enabled:
        return await db.fetchval("SELECT id FROM sources WHERE enabled LIMIT 1") or await make_source(db)
    return await make_source(db, name="switched-off", enabled=False)


async def mapped(
    db, name: str, parent_id: int | None = None, *, age: float | None = None, value: float | None = 1.0,
    quality: int = 0, metric: str = "active_power_kw", interval: int = 5, scale: float = 1.0, enabled: bool = True,
) -> int:
    """An asset with one mapped point, last read `age` seconds before the frozen NOW (never when None). The
    timestamp is NOW - age, never the database's now(): the clock under test is the frozen one."""
    asset = await make_asset(db, name, parent_id)
    point = await make_point(db, await source_for(db, enabled), f"{name}_{metric}")
    await make_mapping(db, point, asset, metric, interval, scale=scale)
    if age is not None:
        await db.execute(
            "INSERT INTO point_latest (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)",
            point, NOW - timedelta(seconds=age), value, quality,
        )
    return asset


async def test_needs_a_session_and_a_viewer_may_read_it(client, db):
    assert (await client.get("/api/fleet/summary")).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get("/api/fleet/summary")).status_code == 200


async def test_an_empty_site(client, db):
    await login_as(client, db, "viewer")
    assert await fleet(client) == {
        "power": EMPTY_POWER, "energy_today": None, "cost_today": None, "currency": None,
        "attention": {"total": 0, "items": []},
    }


async def test_the_currency_appears(client, db):
    await set_currency(db, "QAR")
    await login_as(client, db, "viewer")
    assert (await fleet(client))["currency"] == "QAR"


# ---- today's energy and cost: the roots' figures added up ----


async def test_two_roots_add_up_and_a_tariff_prices_them(client, db):
    await todays_panel(db, "Hall A")
    await todays_panel(db, "Hall B")
    await add_tariff(db, 0.25, "2026-03-01")
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    body = await fleet(client)
    assert body["energy_today"] == {"kwh": pytest.approx(8.0), "estimated": False, "no_data": False}
    assert body["cost_today"] == {"cost": pytest.approx(2.0), "estimated": False, "partial": False, "no_data": False}
    assert body["power"] == EMPTY_POWER  # counters are not power meters


async def test_without_a_tariff_the_cost_is_null_and_partial_as_on_the_asset_page(client, db):
    panel = await todays_panel(db, "Hall A")
    await todays_panel(db, "Hall B")
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    body = await fleet(client)
    assert body["energy_today"]["kwh"] == pytest.approx(8.0)
    assert body["cost_today"] == {"cost": None, "estimated": False, "partial": True, "no_data": False}
    assert (await asset_summary(client, panel))["cost_today"]["partial"] is True


async def test_a_tariff_that_starts_tomorrow_does_not_price_today(client, db):
    await todays_panel(db, "Hall A")
    await todays_panel(db, "Hall B")
    await add_tariff(db, 0.25, "2026-03-11")
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    assert (await fleet(client))["cost_today"] == {"cost": None, "estimated": False, "partial": True, "no_data": False}


async def test_the_fleet_is_the_sum_of_the_asset_pages_of_its_roots(client, db):
    hall_a = await todays_panel(db, "Hall A")
    hall_b = await todays_panel(db, "Hall B")
    await add_tariff(db, 0.25, "2026-03-01")
    await add_tariff(db, 0.50, "2026-03-10", asset_id=hall_b)  # an override that starts today
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    a, b = await asset_summary(client, hall_a), await asset_summary(client, hall_b)
    body = await fleet(client)
    assert body["energy_today"]["kwh"] == pytest.approx(a["energy_today"]["kwh"] + b["energy_today"]["kwh"])
    assert body["cost_today"]["cost"] == pytest.approx(1.0 + 2.0)
    assert body["cost_today"]["cost"] == pytest.approx(a["cost_today"]["cost"] + b["cost_today"]["cost"])


async def test_a_root_is_counted_once_with_its_descendants(client, db):
    site = await make_asset(db, "Site")
    await todays_panel(db, "Panel 1", site)
    await todays_panel(db, "Panel 2", site)
    await add_tariff(db, 0.25, "2026-03-01")
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    body = await fleet(client)
    assert body["energy_today"]["kwh"] == pytest.approx(8.0)
    assert body["cost_today"]["cost"] == pytest.approx(2.0)
    assert body["energy_today"] == (await asset_summary(client, site))["energy_today"]  # the page of the root agrees


async def test_one_silent_root_beside_one_with_data_is_not_no_data(client, db):
    await todays_panel(db, "Hall A")
    await yesterdays_panel(db, "Hall B")
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    body = await fleet(client)
    assert body["energy_today"] == {"kwh": pytest.approx(4.0), "estimated": False, "no_data": False}
    assert body["cost_today"]["no_data"] is False


async def test_every_root_silent_is_no_data(client, db):
    await yesterdays_panel(db, "Hall A")
    await yesterdays_panel(db, "Hall B")
    await add_tariff(db, 0.25, "2026-03-01")
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    body = await fleet(client)
    assert body["energy_today"] == {"kwh": 0.0, "estimated": False, "no_data": True}
    assert body["cost_today"] == {"cost": 0.0, "estimated": False, "partial": False, "no_data": True}


async def test_a_bare_root_with_a_rate_does_not_turn_a_silent_unpriced_root_into_a_priced_zero(client, db):
    bare = await make_asset(db, "Bare")  # no meter anywhere below it, so it has no figure to price
    silent = await yesterdays_panel(db, "Silent")  # a figure (an exact zero) but no rate in effect
    await add_tariff(db, 0.25, "2026-03-10", asset_id=bare)
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    body = await fleet(client)
    assert body["energy_today"] == {"kwh": 0.0, "estimated": False, "no_data": True}
    assert body["cost_today"] == {"cost": None, "estimated": False, "partial": False, "no_data": True}
    assert (await asset_summary(client, silent))["cost_today"]["cost"] is None  # its own page says "no rate" too


async def test_a_silent_root_under_a_rate_costs_zero(client, db):
    await yesterdays_panel(db, "Silent")
    await add_tariff(db, 0.25, "2026-03-10")
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    assert (await fleet(client))["cost_today"] == {"cost": 0.0, "estimated": False, "partial": False, "no_data": True}


async def test_assets_without_any_meter_give_no_figures(client, db):
    await make_asset(db, "Bare 1")
    await make_asset(db, "Bare 2")
    await add_tariff(db, 0.25, "2026-03-01")
    await login_as(client, db, "viewer")
    body = await fleet(client)
    assert body["energy_today"] is None and body["cost_today"] is None


# ---- live power ----


async def test_power_adds_the_fresh_good_meters_below_an_unmetered_site(client, db):
    site = await make_asset(db, "Site")
    await mapped(db, "P1", site, age=5, value=10.0)
    await mapped(db, "P2", site, age=500, value=4.0)  # stale (3 x 5 s is below the 60 s floor)
    await mapped(db, "P3", site, age=5, value=3.0, scale=2.0)  # 3.0 x 2
    await mapped(db, "P4", site, age=5, value=9.0, quality=192)  # bad
    await login_as(client, db, "viewer")
    assert (await fleet(client))["power"] == {"kw": pytest.approx(16.0), "counted": 2, "of": 4}


async def test_a_metered_root_counts_its_own_meter_only(client, db):
    root = await mapped(db, "Main", age=5, value=20.0)
    await mapped(db, "Sub", root, age=5, value=7.0)
    other = await make_asset(db, "Other")
    await mapped(db, "Sub 2", other, age=5, value=1.5)
    await login_as(client, db, "viewer")
    assert (await fleet(client))["power"] == {"kw": pytest.approx(21.5), "counted": 2, "of": 2}


async def test_no_meter_reporting_is_null_not_zero(client, db):
    site = await make_asset(db, "Site")
    await mapped(db, "P1", site, age=500, value=4.0)
    await mapped(db, "P2", site, age=None)
    await login_as(client, db, "viewer")
    assert (await fleet(client))["power"] == {"kw": None, "counted": 0, "of": 2}


# ---- attention ----


async def test_attention_lists_bad_and_stale_readings_only(client, db):
    site = await make_asset(db, "Site")
    stale = await mapped(db, "Stale panel", site, age=500, metric="voltage_v")
    bad = await mapped(db, "Bad panel", site, age=20, quality=192, metric="voltage_v")
    await mapped(db, "Fine panel", site, age=5, metric="voltage_v")
    await mapped(db, "Never read", site, age=None, metric="voltage_v")
    await mapped(db, "Switched off", site, age=5000, metric="voltage_v", enabled=False)  # disabled: not a problem
    loose = await make_point(db, await source_for(db), "loose")  # read, but mapped to no asset
    await db.execute(
        "INSERT INTO point_latest (point_id, ts, value, quality) VALUES ($1, $2, 1.0, 0)",
        loose, NOW - timedelta(days=1),
    )
    await login_as(client, db, "viewer")
    attention = (await fleet(client))["attention"]
    assert attention["total"] == 2
    assert [(i["asset_id"], i["name"], i["path"], i["problem"], i["points"]) for i in attention["items"]] == [
        (bad, "Bad panel", "Site / Bad panel", "bad", 1),
        (stale, "Stale panel", "Site / Stale panel", "stale", 1),
    ]
    assert datetime.fromisoformat(attention["items"][0]["last_ts"]) == NOW - timedelta(seconds=20)
    assert datetime.fromisoformat(attention["items"][1]["last_ts"]) == NOW - timedelta(seconds=500)


async def test_an_asset_with_a_bad_and_a_stale_mapping_is_one_bad_item_with_two_points(client, db):
    asset = await mapped(db, "Meter", age=500, metric="voltage_v")
    point = await make_point(db, await source_for(db), "Meter_bad")
    await make_mapping(db, point, asset, "current_a", 5)
    await db.execute(
        "INSERT INTO point_latest (point_id, ts, value, quality) VALUES ($1, $2, NULL, 0)",
        point, NOW - timedelta(seconds=30),
    )  # fresh but no value: bad
    await login_as(client, db, "viewer")
    attention = (await fleet(client))["attention"]
    assert attention["total"] == 1
    assert attention["items"][0]["problem"] == "bad" and attention["items"][0]["points"] == 2
    assert datetime.fromisoformat(attention["items"][0]["last_ts"]) == NOW - timedelta(seconds=30)


async def test_thirty_problem_assets_give_a_total_of_thirty_and_the_first_twenty_five(client, db):
    ids = [await mapped(db, f"Stale {i:02d}", age=100 + i, metric="voltage_v") for i in range(29)]
    bad = await mapped(db, "Bad", age=1, quality=192, metric="voltage_v")  # the newest, and still first
    await login_as(client, db, "viewer")
    attention = (await fleet(client))["attention"]
    assert attention["total"] == 30 and len(attention["items"]) == 25
    # bad first, then the oldest: Stale 28 (128 s ago) down to Stale 05 (105 s ago)
    assert [i["asset_id"] for i in attention["items"]] == [bad, *reversed(ids[5:])]
