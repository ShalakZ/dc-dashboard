"""Billing follows the tree (W7p): what a move does to the figures is what its preview said it would.

Billing reads the live hierarchy on every request and stores nothing per place, so a move re-bills the WHOLE past at the new place:
the moved asset is priced by the nearest tariff above it NOW, and its energy and cost leave the old ancestors' sums and enter the new
ones. These tests compare /api/billing/costs before and after a real move with the numbers of POST /api/assets/move-preview, on a real
database, for a rate that changes today, only in the past, only from a future date, to nothing at all, and for a move that changes
no rate (the totals still move).
"""
from datetime import datetime, timezone

import pytest

from billing_helpers import add_counter, add_tariff, at, set_currency, set_zone
from helpers import login_as, make_asset, settle_rollups
from test_api_asset_move import MOVE, PREVIEW, body, group

NOW = datetime(2026, 4, 15, 10, 20, tzinfo=timezone.utc)
MONTH = "2026-04"


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    monkeypatch.setattr("dcdash.api.billing._now", lambda: NOW)


async def costs(client) -> dict[str, dict]:
    response = await client.get("/api/billing/costs", params={"month": MONTH})
    assert response.status_code == 200, response.text
    return {asset["name"]: asset for asset in response.json()["assets"]}


async def build(db) -> dict[str, int]:
    """Site > (Hall A > Pump (2 kWh an hour), Fan (1 kWh an hour)), Hall B (empty). The meters run from 2 to 8 April, hourly."""
    await set_zone(db, "UTC")
    await set_currency(db, "USD")
    ids = {"Site": await make_asset(db, "Site")}
    ids["Hall A"] = await make_asset(db, "Hall A", ids["Site"])
    ids["Hall B"] = await make_asset(db, "Hall B", ids["Site"])
    ids["Pump"] = await add_counter(db, "Pump", at(2026, 4, 2), 168, per_hour=2.0, parent_id=ids["Hall A"])
    ids["Fan"] = await add_counter(db, "Fan", at(2026, 4, 2), 168, per_hour=1.0, parent_id=ids["Hall A"])
    return ids


async def previewed(client, ids) -> dict:
    response = await client.post(PREVIEW, json=body(group([ids["Pump"]], ids["Hall B"])))
    assert response.status_code == 200, response.text
    return response.json()


async def moved(client, ids, preview) -> None:
    response = await client.post(MOVE, json=body(group([ids["Pump"]], ids["Hall B"]), expect=preview["expect"]))
    assert response.status_code == 200, response.text


def day_costs(asset: dict) -> list[float | None]:
    return [None if day is None else day["cost"] for day in asset["days"]]


def total(asset: dict, key: str = "cost"):
    return None if asset["total"] is None else asset["total"][key]


async def test_a_rate_that_changes_today_is_what_the_preview_said_and_both_branches_follow_the_pump(client, db):
    ids = await build(db)
    await add_tariff(db, 0.10, "2026-01-01")
    await add_tariff(db, 0.18, "2026-01-01", ids["Hall A"])
    await settle_rollups(db)
    await login_as(client, db)
    before = await costs(client)
    preview = await previewed(client, ids)
    (root,) = preview["roots"]
    assert (root["rate_before"], root["rate_after"]) == (0.18, 0.10)
    assert root["rate_changes_today"] is True and preview["rate_changes"] is True and preview["currency"] == "USD"
    assert before["Pump"]["rate_per_kwh"] == root["rate_before"]

    await moved(client, ids, preview)
    after = await costs(client)

    assert after["Pump"]["rate_per_kwh"] == root["rate_after"]  # what billing prices it at now is what the preview promised
    pump_kwh = total(before["Pump"], "kwh")
    assert total(after["Pump"], "kwh") == pytest.approx(pump_kwh)  # the energy does not change, only its price
    assert total(before["Pump"]) == pytest.approx(pump_kwh * 0.18) and total(after["Pump"]) == pytest.approx(pump_kwh * 0.10)
    # every day is re-priced, the whole past included (the override started in January)
    for day_before, day_after in zip(before["Pump"]["days"], after["Pump"]["days"]):
        if day_before is not None and day_before["kwh"]:
            assert day_after["cost"] == pytest.approx(day_before["kwh"] * 0.10)
    # the branches: Hall A lost the pump, Hall B gained it, the site gained the difference of the two prices
    assert total(after["Hall A"]) == pytest.approx(total(before["Hall A"]) - total(before["Pump"]))
    assert total(after["Hall A"]) == pytest.approx(total(before["Fan"]))
    assert total(before["Hall B"]) is None and total(after["Hall B"]) == pytest.approx(total(after["Pump"]))
    assert total(after["Site"]) == pytest.approx(total(before["Site"]) - pump_kwh * (0.18 - 0.10))
    assert after["Pump"]["path"] == "Site / Hall B / Pump" and after["Hall A"]["total"]["kwh"] == pytest.approx(total(before["Fan"], "kwh"))


async def test_a_move_that_changes_no_rate_still_moves_the_totals_and_the_preview_stays_silent(client, db):
    ids = await build(db)
    await add_tariff(db, 0.10, "2026-01-01")
    await add_tariff(db, 0.18, "2026-01-01", ids["Hall A"])
    await add_tariff(db, 0.18, "2026-01-01", ids["Hall B"])  # the same rate on the other side
    await settle_rollups(db)
    await login_as(client, db)
    before = await costs(client)
    preview = await previewed(client, ids)
    assert preview["rate_changes"] is False
    (root,) = preview["roots"]
    assert (root["rate_before"], root["rate_after"], root["rate_changes_today"], root["rate_changes_other_days"]) == (0.18, 0.18, False, False)

    await moved(client, ids, preview)
    after = await costs(client)

    assert day_costs(after["Pump"]) == pytest.approx(day_costs(before["Pump"]))  # its own figures are untouched
    assert total(after["Hall A"]) == pytest.approx(total(before["Hall A"]) - total(before["Pump"]))
    assert total(after["Hall B"]) == pytest.approx(total(before["Pump"]))
    assert total(after["Site"]) == pytest.approx(total(before["Site"]))  # the branches change, the whole does not


async def test_a_rate_that_differs_only_in_the_past_warns_for_other_days_and_reprices_those_days_only(client, db):
    ids = await build(db)
    await add_tariff(db, 0.10, "2026-01-01")
    await add_tariff(db, 0.18, "2026-01-01", ids["Hall A"])
    await add_tariff(db, 0.10, "2026-04-05", ids["Hall A"])  # Hall A fell back to the default on the 5th
    await settle_rollups(db)
    await login_as(client, db)
    before = await costs(client)
    preview = await previewed(client, ids)
    (root,) = preview["roots"]
    assert (root["rate_before"], root["rate_after"]) == (0.10, 0.10)
    assert root["rate_changes_today"] is False and root["rate_changes_other_days"] is True and preview["rate_changes"] is True

    await moved(client, ids, preview)
    after = await costs(client)

    changed = [i for i, (b, a) in enumerate(zip(day_costs(before["Pump"]), day_costs(after["Pump"]))) if b is not None and a != pytest.approx(b)]
    assert changed == [1, 2, 3]  # 2, 3 and 4 April were priced at 0.18; the 5th onwards at 0.10 either way
    assert after["Pump"]["rate_per_kwh"] == before["Pump"]["rate_per_kwh"] == 0.10


async def test_a_row_dated_in_the_future_changes_nothing_billed_so_far_and_the_preview_still_says_so(client, db):
    ids = await build(db)
    await add_tariff(db, 0.10, "2026-01-01")
    await add_tariff(db, 0.30, "2026-06-01", ids["Hall B"])  # starts after "today" (15 April)
    await settle_rollups(db)
    await login_as(client, db)
    before = await costs(client)
    preview = await previewed(client, ids)
    (root,) = preview["roots"]
    assert root["rate_changes_today"] is False and root["rate_changes_other_days"] is True and preview["rate_changes"] is True

    await moved(client, ids, preview)
    after = await costs(client)

    assert day_costs(after["Pump"]) == pytest.approx(day_costs(before["Pump"]))  # April is all at the default either way
    assert total(after["Site"]) == pytest.approx(total(before["Site"]))


async def test_a_move_to_a_place_with_no_tariff_leaves_the_pump_without_a_rate_and_the_preview_says_no_rate(client, db):
    ids = await build(db)
    await add_tariff(db, 0.18, "2026-01-01", ids["Hall A"])  # no site default
    await settle_rollups(db)
    await login_as(client, db)
    before = await costs(client)
    preview = await previewed(client, ids)
    (root,) = preview["roots"]
    assert (root["rate_before"], root["rate_after"], root["rate_changes_today"]) == (0.18, None, True)

    await moved(client, ids, preview)
    after = await costs(client)

    assert after["Pump"]["rate_per_kwh"] is None and total(after["Pump"]) is None  # its energy shows without a cost
    assert total(after["Pump"], "kwh") == pytest.approx(total(before["Pump"], "kwh"))
    assert after["Pump"]["total"]["partial"] is True
    assert total(after["Hall A"]) == pytest.approx(total(before["Fan"]))
    assert total(after["Hall B"]) is None and after["Hall B"]["total"]["partial"] is True


async def test_the_site_default_prices_a_pump_that_moves_out_from_under_an_override(client, db):
    ids = await build(db)
    await add_tariff(db, 0.25, "2026-01-01")
    await add_tariff(db, 0.18, "2026-01-01", ids["Pump"])  # the pump's own rate: it follows the pump wherever it goes
    await settle_rollups(db)
    await login_as(client, db)
    preview = await previewed(client, ids)
    assert preview["rate_changes"] is False
    before = await costs(client)
    await moved(client, ids, preview)
    assert (await costs(client))["Pump"]["rate_per_kwh"] == before["Pump"]["rate_per_kwh"] == 0.18


async def test_a_reorder_inside_one_parent_never_warns_even_with_overrides_around(client, db):
    ids = await build(db)
    await add_tariff(db, 0.10, "2026-01-01")
    await add_tariff(db, 0.18, "2026-01-01", ids["Hall A"])
    await add_tariff(db, 0.30, "2026-02-01", ids["Fan"])
    await settle_rollups(db)
    await login_as(client, db)
    response = await client.post(PREVIEW, json=body(group([ids["Fan"]], ids["Hall A"])))  # Fan after Pump: by name Fan comes first
    assert response.status_code == 200 and response.json()["roots"][0]["change"] == "order"
    assert response.json()["rate_changes"] is False
