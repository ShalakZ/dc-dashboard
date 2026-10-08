from datetime import datetime, timezone

import pytest

from billing_helpers import add_counter, add_tariff, at, set_currency
from helpers import login_as, make_asset, settle_rollups

NOW = datetime(2026, 3, 10, 10, 20, tzinfo=timezone.utc)  # the site zone is UTC in these tests


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    monkeypatch.setattr("dcdash.api.data._now", lambda: NOW)


async def summary(client, asset_id: int) -> dict:
    response = await client.get(f"/api/assets/{asset_id}/summary")
    assert response.status_code == 200, response.text
    return response.json()


async def todays_panel(db, name: str = "Panel", parent_id: int | None = None) -> int:
    """Counter readings at 07:30, 08:30 and 09:30Z on 10 March (+2 kWh in each of the 08:00 and 09:00 hours):
    4 kWh by the time NOW (10:20Z) comes."""
    return await add_counter(db, name, at(2026, 3, 10, 7), 3, per_hour=2.0, parent_id=parent_id)


async def yesterdays_panel(db, name: str = "Panel") -> int:
    """A counter that was read yesterday only, so it is silent for the whole of today (an exact zero)."""
    return await add_counter(db, name, at(2026, 3, 9, 7), 3, per_hour=2.0)


async def test_cost_today_prices_the_engines_energy_with_the_rate_in_effect(client, db):
    panel = await todays_panel(db)
    await add_tariff(db, 0.25, "2026-03-01")
    await set_currency(db, "QAR")
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    body = await summary(client, panel)
    assert body["energy_today"] == {"kwh": pytest.approx(4.0), "estimated": False}
    assert body["cost_today"] == {"cost": pytest.approx(1.0), "estimated": False, "partial": False}
    assert body["currency"] == "QAR"
    assert {"asset", "metrics", "energy_today", "cost_today", "currency"} <= set(body)  # existing keys stay


async def test_without_a_tariff_the_cost_is_null_and_partial_never_zero(client, db):  # Review Focus 3
    panel = await todays_panel(db)
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    body = await summary(client, panel)
    assert body["cost_today"] == {"cost": None, "estimated": False, "partial": True}
    assert body["currency"] is None


async def test_a_tariff_that_starts_tomorrow_does_not_price_today(client, db):  # Review Focus 3
    panel = await todays_panel(db)
    await add_tariff(db, 0.25, "2026-03-11")
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    assert (await summary(client, panel))["cost_today"] == {"cost": None, "estimated": False, "partial": True}


async def test_a_parent_without_a_meter_sums_its_children_including_an_override(client, db):  # Review Focus 3
    site = await make_asset(db, "Site")
    panel = await todays_panel(db, "LV Panel 1", site)
    await add_tariff(db, 0.25, "2026-03-01")
    await add_tariff(db, 0.50, "2026-03-10", asset_id=panel)
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    body = await summary(client, site)
    assert body["energy_today"] == {"kwh": pytest.approx(4.0), "estimated": False}
    assert body["cost_today"] == {"cost": pytest.approx(2.0), "estimated": False, "partial": False}  # 4 kWh x 0.50


async def test_a_silent_meter_costs_zero_today_under_a_rate_and_nothing_without_one(client, db):  # Review Focus 3
    # An exact zero for today (no readings since yesterday): 0 kWh costs 0 where a rate is in effect, never a dash.
    priced = await yesterdays_panel(db, "Priced")
    unpriced = await yesterdays_panel(db, "Unpriced")
    await add_tariff(db, 0.25, "2026-03-10", asset_id=priced)  # starts today
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    body = await summary(client, priced)
    assert body["energy_today"] == {"kwh": 0.0, "estimated": False}
    assert body["cost_today"] == {"cost": 0.0, "estimated": False, "partial": False}
    body = await summary(client, unpriced)
    assert body["energy_today"] == {"kwh": 0.0, "estimated": False}
    assert body["cost_today"] == {"cost": None, "estimated": False, "partial": False}


async def test_a_tariff_that_starts_tomorrow_does_not_price_a_silent_today(client, db):  # Review Focus 3
    panel = await yesterdays_panel(db)
    await add_tariff(db, 0.25, "2026-03-11")
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    assert (await summary(client, panel))["cost_today"] == {"cost": None, "estimated": False, "partial": False}


async def test_an_asset_without_energy_has_no_cost_but_still_reports_the_currency(client, db):
    bare = await make_asset(db, "Bare")
    await set_currency(db, "QAR")
    await login_as(client, db, "viewer")
    body = await summary(client, bare)
    assert body["energy_today"] is None and body["cost_today"] is None and body["currency"] == "QAR"
