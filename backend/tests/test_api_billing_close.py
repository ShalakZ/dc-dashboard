"""Close and reopen a billing month (W11): the routes, what they store, and that a closed month stays put.

A close stores the exact output of month_costs() (`billing_closes.figures`); the Billing costs route and the CSV then read that
instead of recomputing it. The freeze tests close a month, change the tree, a rate, a mapping, an asset or a source, and prove
the costs body (minus `live`) and the CSV BYTES are the ones taken before the close. Compared as parsed JSON, not bytes: JSONB
sorts the keys of an object."""
import asyncio
import contextlib
import json
import re
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from auth_probe import silent_client
from billing_helpers import add_counter, add_tariff, at, set_currency, set_zone
from dcdash.api import billing
from dcdash.core.billing_close import root_totals
from helpers import insert_readings, login_as, make_asset, make_role, make_user, settle_rollups
from test_api_asset_move import MOVE, PREVIEW, body, group

NOW = datetime(2026, 4, 15, 10, 20, tzinfo=timezone.utc)
MONTH = "2026-03"
CLOSE, REOPEN = f"/api/billing/months/{MONTH}/close", f"/api/billing/months/{MONTH}/reopen"
COSTS, CSV = "/api/billing/costs", "/api/billing/costs.csv"
CLOSED_KEYS = {"id", "closed_name", "closed_at", "note", "total_kwh", "total_cost"}
LIVE_KEYS = {"total_kwh", "total_cost", "delta_kwh", "delta_cost", "changed_assets", "differs", "currency"}
REASON = "late readings were corrected"


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    monkeypatch.setattr("dcdash.api.billing._now", lambda: NOW)


async def build(db) -> dict[str, int]:
    """Site > (Hall A > Pump 2 kWh an hour, Fan 1 kWh an hour), Hall B (empty), and a second root, Annex (0.5 kWh an hour).
    Meters run from 2 to 8 March 2026, hourly; the site rate is 0.10 and Hall A pays 0.18."""
    await set_zone(db, "UTC")
    await set_currency(db, "USD")
    ids = {"Site": await make_asset(db, "Site")}
    ids["Hall A"] = await make_asset(db, "Hall A", ids["Site"])
    ids["Hall B"] = await make_asset(db, "Hall B", ids["Site"])
    ids["Pump"] = await add_counter(db, "Pump", at(2026, 3, 2), 168, per_hour=2.0, parent_id=ids["Hall A"])
    ids["Fan"] = await add_counter(db, "Fan", at(2026, 3, 2), 168, per_hour=1.0, parent_id=ids["Hall A"])
    ids["Annex"] = await add_counter(db, "Annex", at(2026, 3, 2), 168, per_hour=0.5)
    await add_tariff(db, 0.10, "2026-01-01")
    await add_tariff(db, 0.18, "2026-01-01", ids["Hall A"])
    await settle_rollups(db)
    return ids


async def costs(client, month: str = MONTH) -> dict:
    response = await client.get(COSTS, params={"month": month})
    assert response.status_code == 200, response.text
    return response.json()


def figures_of(payload: dict) -> dict:
    """The month_costs part of a costs body."""
    return {key: value for key, value in payload.items() if key not in ("closed", "live")}


async def csv_bytes(client, month: str = MONTH) -> bytes:
    response = await client.get(CSV, params={"month": month})
    assert response.status_code == 200, response.text
    return response.content


async def close(client, month: str = MONTH, **payload):
    return await client.post(f"/api/billing/months/{month}/close", json=payload)


async def reopen(client, month: str = MONTH, note: str = REASON):
    return await client.post(f"/api/billing/months/{month}/reopen", json={"note": note})


async def rows(db, month: str = MONTH) -> list:
    return await db.fetch("SELECT * FROM billing_closes WHERE month = $1 ORDER BY id", month)


async def audit_rows(db) -> list:
    return await db.fetch("SELECT user_id, action, detail FROM audit_log WHERE action LIKE 'billing.%' ORDER BY id")


@contextlib.asynccontextmanager
async def signed_in(app, db, role: str, username: str):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as other:
        await login_as(other, db, role=role, username=username)
        yield other


# --- who may ----------------------------------------------------------------------------------------------------------


async def test_anonymous_is_refused(client, db):
    await build(db)
    assert (await close(client)).status_code == 401
    assert (await reopen(client)).status_code == 401
    assert await rows(db) == []


async def test_viewer_operator_and_a_role_without_billing_close_get_403_and_nothing_is_stored(app, db):
    await build(db)
    await make_role(db, "no closer", ["billing.view", "billing.export", "tariffs.view", "tariffs.edit"])
    for role in ("viewer", "operator", "no closer"):
        async with signed_in(app, db, role, f"user of {role}") as client:
            assert (await close(client)).status_code == 403, role
            assert (await reopen(client)).status_code == 403, role
            assert (await close(client, "1900-01")).status_code == 403, role  # the gate comes before the validation
            assert (await reopen(client, "999999", note="")).status_code == 403, role
    assert await rows(db) == []
    assert await audit_rows(db) == []


async def test_a_viewer_cannot_reopen_a_closed_month(app, client, db):
    await build(db)
    await login_as(client, db)
    assert (await close(client)).status_code == 201
    async with signed_in(app, db, "viewer", "just a viewer") as viewer:
        assert (await reopen(viewer)).status_code == 403
    assert (await rows(db))[0]["reopened_at"] is None


@pytest.mark.parametrize("who", ["admin", "custom"])
async def test_admin_and_a_custom_role_with_billing_close_can_close_and_reopen(app, db, who):
    await build(db)
    if who == "custom":
        await make_role(db, "closer", ["billing.view", "billing.close"])
    async with signed_in(app, db, "admin" if who == "admin" else "closer", f"the {who}") as client:
        response = await close(client)
        assert response.status_code == 201, response.text
        assert (await reopen(client)).status_code == 200


# --- what a close stores ----------------------------------------------------------------------------------------------


async def test_a_close_stores_exactly_what_month_costs_returned(client, db):
    ids = await build(db)
    await login_as(client, db)
    before = await costs(client)
    assert before["closed"] is None and "live" not in before
    response = await close(client, note="  September bill  ")
    assert response.status_code == 201, response.text
    closed = response.json()
    assert set(closed) == CLOSED_KEYS
    assert closed["closed_name"] == "admin" and closed["note"] == "September bill"
    [row] = await rows(db)
    assert json.loads(json.dumps(row["figures"])) == figures_of(before)  # the stored object IS the open body
    assert (row["month"], row["timezone"], row["currency"], row["closed_name"]) == (MONTH, "UTC", "USD", "admin")
    assert row["closed_by"] == await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    assert row["note"] == "September bill" and row["reopened_at"] is None
    # The header totals are the sums of the ROOT assets (Site and Annex), not of every asset in the tree.
    by_name = {asset["name"]: asset for asset in before["assets"]}
    roots = (by_name["Site"]["total"], by_name["Annex"]["total"])
    assert row["total_kwh"] == pytest.approx(sum(total["kwh"] for total in roots))
    assert row["total_cost"] == pytest.approx(sum(total["cost"] for total in roots))
    assert (row["total_kwh"], row["total_cost"]) == root_totals(before)
    every_asset = sum(asset["total"]["kwh"] for asset in before["assets"] if asset["total"] is not None)
    assert row["total_kwh"] < every_asset
    assert closed["total_kwh"] == row["total_kwh"] and closed["total_cost"] == row["total_cost"]
    assert ids["Site"] in {asset["asset_id"] for asset in row["figures"]["assets"]}


async def test_reading_a_closed_month_gives_the_snapshot_a_closed_object_and_a_quiet_live(client, db):
    await build(db)
    await login_as(client, db)
    before = await costs(client)
    created = (await close(client)).json()
    after = await costs(client)
    assert figures_of(after) == figures_of(before)
    assert after["closed"] == created  # the 201 body is the `closed` object of the page
    assert set(after["live"]) == LIVE_KEYS
    assert after["live"]["differs"] is False and after["live"]["changed_assets"] == 0
    assert (after["live"]["delta_kwh"], after["live"]["delta_cost"]) == (0.0, 0.0)
    assert (after["live"]["total_kwh"], after["live"]["total_cost"]) == (created["total_kwh"], created["total_cost"])
    assert after["live"]["currency"] == "USD"


async def test_a_note_is_optional_and_a_body_is_not_needed(client, db):
    await build(db)
    await login_as(client, db)
    response = await client.post(CLOSE)  # no body at all
    assert response.status_code == 201 and response.json()["note"] == ""
    await reopen(client)
    response = await client.post(CLOSE, json={"note": None})
    assert response.status_code == 201 and response.json()["note"] == ""


async def test_the_closed_csv_is_the_open_csv_and_is_named_closed(client, db):
    await build(db)
    await login_as(client, db)
    opened = await client.get(CSV, params={"month": MONTH})
    assert opened.headers["content-disposition"] == f'attachment; filename="billing-{MONTH}.csv"'
    await close(client)
    closed = await client.get(CSV, params={"month": MONTH})
    assert closed.headers["content-disposition"] == f'attachment; filename="billing-{MONTH}-closed.csv"'
    assert closed.content == opened.content and closed.content.startswith(b"\xef\xbb\xbf")
    assert closed.headers["content-type"].startswith("text/csv")


async def test_the_default_month_finds_a_closed_month_too(client, db, monkeypatch):
    await build(db)
    await login_as(client, db)
    await close(client)
    monkeypatch.setattr("dcdash.api.billing._now", lambda: datetime(2026, 3, 20, 12, tzinfo=timezone.utc))  # March is "now"
    body_now = (await client.get(COSTS)).json()
    assert body_now["month"] == MONTH and body_now["closed"] is not None and body_now["live"] is not None
    csv = await client.get(CSV)
    assert csv.headers["content-disposition"] == f'attachment; filename="billing-{MONTH}-closed.csv"'


async def test_an_open_month_has_a_null_closed_and_no_live(client, db):
    await build(db)
    await login_as(client, db)
    payload = await costs(client, "2026-04")
    assert payload["closed"] is None and "live" not in payload
    assert (await client.get(COSTS)).json()["closed"] is None  # the default month, April


# --- what a close refuses ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("month", ["2026-13", "2026-00", "26-03", "2026-3", "march", "2026-03-01"])
async def test_a_bad_month_is_422_for_both_routes(client, db, month):
    await login_as(client, db)
    assert (await close(client, month)).status_code == 422
    assert (await reopen(client, month)).status_code == 422


async def test_a_month_in_arabic_indic_digits_is_422(client, db):
    await login_as(client, db)
    month = "٢٠٢٦-٠٣"  # 2026-03
    assert re.fullmatch(r"\d{4}-\d{2}", month)  # the digits \d accepts
    assert (await close(client, month)).status_code == 422
    assert (await reopen(client, month)).status_code == 422
    assert await db.fetchval("SELECT count(*) FROM billing_closes") == 0


@pytest.mark.parametrize("month", ["1969-01", "2101-01"])
async def test_a_year_outside_1970_to_2100_is_422_with_the_months_sentence(client, db, month):
    await login_as(client, db)
    response = await close(client, month)
    assert response.status_code == 422 and response.json()["detail"] == "month must look like 2026-10"


@pytest.mark.parametrize(
    "note", ["", "abcd", "    ", " ab ", "\t\n abc \n", "x" * 4 + " " * 10, "a" * 501], ids=lambda n: repr(n)[:12]
)
async def test_a_reopen_note_must_have_5_to_500_characters_after_stripping(client, db, note):
    await build(db)
    await login_as(client, db)
    await close(client)
    assert (await reopen(client, note=note)).status_code == 422
    assert (await rows(db))[0]["reopened_at"] is None


async def test_a_missing_or_null_reopen_note_and_unknown_fields_are_422(client, db):
    await build(db)
    await login_as(client, db)
    await close(client)
    assert (await client.post(REOPEN, json={})).status_code == 422
    assert (await client.post(REOPEN)).status_code == 422
    assert (await client.post(REOPEN, json={"note": None})).status_code == 422
    assert (await client.post(REOPEN, json={"note": REASON, "extra": 1})).status_code == 422
    assert (await client.post(CLOSE, json={"note": "ok", "extra": 1})).status_code == 422
    assert (await close(client, "2026-02", note="x" * 501)).status_code == 422
    assert (await rows(db))[0]["reopened_at"] is None


async def test_a_reopen_note_of_exactly_5_and_500_characters_is_kept_stripped(client, db):
    await build(db)
    await login_as(client, db)
    await close(client, note="n" * 500)
    assert (await rows(db))[0]["note"] == "n" * 500
    assert (await reopen(client, note="  fixed  ")).status_code == 200
    assert (await rows(db))[0]["reopen_note"] == "fixed"
    await close(client)
    assert (await reopen(client, note="r" * 500)).status_code == 200


@pytest.mark.parametrize("month", ["2026-04", "2026-05", "2099-01"])
async def test_the_current_and_a_future_month_cannot_be_closed(client, db, month):
    await build(db)
    await login_as(client, db)
    response = await close(client, month)
    assert response.status_code == 409 and response.json()["detail"] == "that month is not over yet"
    assert await rows(db, month) == []


async def test_a_month_is_open_to_close_from_its_last_second(client, db, monkeypatch):
    await build(db)
    await login_as(client, db)
    monkeypatch.setattr("dcdash.api.billing._now", lambda: datetime(2026, 3, 31, 23, 59, 59, tzinfo=timezone.utc))
    assert (await close(client)).status_code == 409
    monkeypatch.setattr("dcdash.api.billing._now", lambda: datetime(2026, 4, 1, tzinfo=timezone.utc))
    assert (await close(client)).status_code == 201


async def test_the_site_timezone_decides_when_a_month_is_over(client, db, monkeypatch):
    await build(db)
    await set_zone(db, "Pacific/Auckland")  # still on summer time (UTC+13) on 31 March 2026: March ends at 11:00 UTC
    await login_as(client, db)
    monkeypatch.setattr("dcdash.api.billing._now", lambda: datetime(2026, 3, 31, 10, 59, 59, tzinfo=timezone.utc))
    assert (await close(client)).status_code == 409  # 23:59:59 in Auckland
    monkeypatch.setattr("dcdash.api.billing._now", lambda: datetime(2026, 3, 31, 11, 0, 0, tzinfo=timezone.utc))
    assert (await close(client)).status_code == 201


async def test_a_month_without_energy_data_cannot_be_closed(client, db):
    await build(db)
    await login_as(client, db)
    response = await close(client, "2026-01")
    assert response.status_code == 409 and response.json()["detail"] == "no energy data was recorded for that month"
    assert await rows(db, "2026-01") == []


async def test_a_month_with_no_assets_at_all_cannot_be_closed(client, db):
    await set_zone(db, "UTC")
    await login_as(client, db)
    response = await close(client)
    assert response.status_code == 409 and response.json()["detail"] == "no energy data was recorded for that month"
    assert await rows(db) == []


async def test_a_zone_billing_refuses_stops_the_close_with_billings_own_409(client, db):
    await build(db)
    await set_zone(db, "Asia/Kolkata")
    await login_as(client, db)
    response = await close(client)
    assert response.status_code == 409 and "Asia/Kolkata" in response.json()["detail"]
    assert await rows(db) == []


async def test_figures_that_cannot_be_stored_are_a_409(client, db, monkeypatch):
    await build(db)
    await login_as(client, db)
    real = billing.month_costs

    async def poisoned(session, month):
        found = await real(session, month)
        found["assets"][0]["total"]["kwh"] = float("nan")
        return found

    monkeypatch.setattr("dcdash.api.billing.month_costs", poisoned)
    response = await close(client)
    assert response.status_code == 409 and "cannot be stored" in response.json()["detail"]
    assert await rows(db) == [] and await audit_rows(db) == []


async def test_a_second_close_is_409_and_names_who_closed_it_and_when(app, client, db):
    await build(db)
    await login_as(client, db)
    assert (await close(client)).status_code == 201
    response = await close(client)
    assert response.status_code == 409
    assert re.fullmatch(r"that month is already closed by admin on \d{4}-\d{2}-\d{2}", response.json()["detail"])
    await make_role(db, "closer", ["billing.view", "billing.close"])
    async with signed_in(app, db, "closer", "carol") as carol:
        assert "closed by admin on" in (await close(carol)).json()["detail"]
    assert len(await rows(db)) == 1 and len(await audit_rows(db)) == 1


async def test_reopening_a_month_that_is_open_or_was_never_closed_is_409(client, db):
    await build(db)
    await login_as(client, db)
    for month in (MONTH, "2026-04", "2026-01"):
        response = await reopen(client, month)
        assert response.status_code == 409 and response.json()["detail"] == "that month is not closed"
    await close(client)
    assert (await reopen(client)).status_code == 200
    assert (await reopen(client)).status_code == 409  # already reopened
    assert await audit_rows(db) != [] and [r["action"] for r in await audit_rows(db)] == ["billing.closed", "billing.reopened"]


# --- two at once ------------------------------------------------------------------------------------------------------


async def test_two_closes_at_once_give_one_201_one_409_and_one_row(client, db):
    # Whether the two requests really overlap depends on the event loop; the index path itself is proven by the "check is
    # blind" test below. This one proves the outcome whichever way they interleave.
    await build(db)
    await login_as(client, db)
    first, second = await asyncio.gather(close(client, note="one"), close(client, note="two"))
    assert sorted((first.status_code, second.status_code)) == [201, 409]
    loser = first if first.status_code == 409 else second
    assert "already closed by admin" in loser.json()["detail"]
    assert len(await rows(db)) == 1
    assert [r["action"] for r in await audit_rows(db)] == ["billing.closed"]  # the loser's audit row was rolled back


async def test_the_unique_index_decides_when_the_check_is_blind(client, db, monkeypatch):
    """Both requests pass the 'already closed' check before either commits: the second INSERT hits the partial unique index."""
    await build(db)
    await login_as(client, db)
    assert (await close(client)).status_code == 201
    real, calls = billing._active_close, []

    async def blind_once(session, month):
        calls.append(month)
        return None if len(calls) == 1 else await real(session, month)

    monkeypatch.setattr("dcdash.api.billing._active_close", blind_once)
    response = await close(client, note="second")
    assert response.status_code == 409
    assert re.fullmatch(r"that month is already closed by admin on \d{4}-\d{2}-\d{2}", response.json()["detail"])
    assert len(calls) == 2  # the check, then the winner read after the rollback
    assert len(await rows(db)) == 1 and (await rows(db))[0]["note"] == ""
    assert len(await audit_rows(db)) == 1


async def test_two_reopens_at_once_give_one_200_one_409(client, db):
    await build(db)
    await login_as(client, db)
    await close(client)
    first, second = await asyncio.gather(reopen(client, note="first reason"), reopen(client, note="second reason"))
    assert sorted((first.status_code, second.status_code)) == [200, 409]
    assert [r["action"] for r in await audit_rows(db)] == ["billing.closed", "billing.reopened"]


# --- the freeze -------------------------------------------------------------------------------------------------------


async def move_pump(client, db, ids):
    plan = body(group([ids["Pump"]], ids["Hall B"]))
    preview = await client.post(PREVIEW, json=plan)
    assert preview.status_code == 200, preview.text
    moved = await client.post(MOVE, json={**plan, "expect": preview.json()["expect"]})
    assert moved.status_code == 200, moved.text


async def change_a_rate(client, db, ids):
    response = await client.post(
        "/api/tariffs", json={"asset_id": ids["Hall A"], "rate_per_kwh": 0.45, "effective_from": "2026-03-01"}
    )
    assert response.status_code == 201, response.text


async def change_the_site_rate(client, db, ids):
    response = await client.post("/api/tariffs", json={"asset_id": None, "rate_per_kwh": 0.9, "effective_from": "2026-03-05"})
    assert response.status_code == 201, response.text


async def unmap_a_point(client, db, ids):
    mapping = await db.fetchval("SELECT m.id FROM mappings m JOIN points p ON p.id = m.point_id WHERE p.address = 'Pump_kWh'")
    assert (await client.delete(f"/api/mappings/{mapping}")).status_code == 204


async def delete_an_asset(client, db, ids):
    assert (await client.delete(f"/api/assets/{ids['Fan']}?confirm=true")).status_code == 204


async def delete_a_branch(client, db, ids):
    assert (await client.delete(f"/api/assets/{ids['Hall A']}?confirm=true")).status_code == 204


async def delete_the_source(client, db, ids):
    source = await db.fetchval("SELECT id FROM sources")
    assert (await client.delete(f"/api/sources/{source}?confirm=true")).status_code == 204


def rename(name: str):
    async def rename_an_asset(client, db, ids):
        assert (await client.patch(f"/api/assets/{ids[name]}", json={"name": "Renamed"})).status_code == 200

    return rename_an_asset


CHANGES = [
    move_pump, change_a_rate, change_the_site_rate, unmap_a_point, delete_an_asset, delete_a_branch, delete_the_source,
]


@pytest.mark.parametrize("change", CHANGES, ids=lambda f: f.__name__)
async def test_a_closed_month_does_not_move_when_the_configuration_changes(client, db, change):
    ids = await build(db)
    await login_as(client, db)
    open_body, open_csv = await costs(client), await csv_bytes(client)
    assert (await close(client)).status_code == 201
    closed_body = await costs(client)
    await change(client, db, ids)
    after = await costs(client)
    assert figures_of(after) == figures_of(open_body) == figures_of(closed_body)
    assert after["closed"] == closed_body["closed"]
    assert await csv_bytes(client) == open_csv  # BYTES
    assert after["live"]["differs"] is True, change.__name__


@pytest.mark.parametrize("name", ["Hall B", "Hall A"])
async def test_a_rename_does_not_move_a_closed_month_and_is_not_a_difference(client, db, name):
    """Hall B has nothing under it; Hall A holds the Pump and the Fan, so their paths change too. No billed number moves."""
    ids = await build(db)
    await login_as(client, db)
    open_body, open_csv = await costs(client), await csv_bytes(client)
    assert (await close(client)).status_code == 201
    await rename(name)(client, db, ids)
    after = await costs(client)
    assert figures_of(after) == figures_of(open_body)
    assert await csv_bytes(client) == open_csv  # BYTES
    assert after["live"]["differs"] is False and after["live"]["changed_assets"] == 0


async def test_a_closed_month_survives_every_change_at_once(client, db):
    ids = await build(db)
    await login_as(client, db)
    open_body, open_csv = await costs(client), await csv_bytes(client)
    await close(client)
    for change in (move_pump, change_a_rate, change_the_site_rate, unmap_a_point, delete_an_asset, delete_the_source):
        await change(client, db, ids)
        assert figures_of(await costs(client)) == figures_of(open_body), change.__name__
        assert await csv_bytes(client) == open_csv, change.__name__
    live = (await costs(client))["live"]
    assert live["differs"] is True and live["total_kwh"] == 0.0 and live["delta_kwh"] < 0  # nothing is left to measure
    assert live["total_cost"] is None and live["delta_cost"] is None  # and nothing to price


async def test_what_a_change_does_to_the_live_line(client, db):
    ids = await build(db)
    await login_as(client, db)
    await close(client)
    await move_pump(client, db, ids)  # a move inside one root: the totals agree, the assets do not
    live = (await costs(client))["live"]
    assert live["delta_kwh"] == pytest.approx(0.0)
    assert live["delta_cost"] < 0  # Hall B pays the site rate, which is lower than Hall A's
    assert live["changed_assets"] >= 3 and live["differs"] is True  # Hall A, Hall B and Pump
    await change_the_site_rate(client, db, ids)
    live = (await costs(client))["live"]
    assert live["delta_cost"] > 0 and live["delta_kwh"] == pytest.approx(0.0)


async def test_an_empty_asset_added_or_deleted_after_the_close_is_not_a_difference(client, db):
    ids = await build(db)
    await login_as(client, db)
    await close(client)
    for body in ({"name": "New room", "parent_id": ids["Site"]}, {"name": "New root", "parent_id": None}):
        assert (await client.post("/api/assets", json=body)).status_code == 201
        live = (await costs(client))["live"]
        assert live["differs"] is False and live["changed_assets"] == 0, body
    assert (await client.delete(f"/api/assets/{ids['Hall B']}?confirm=true")).status_code == 204  # unmetered, in the close
    live = (await costs(client))["live"]
    assert live["differs"] is False and live["changed_assets"] == 0
    assert (await client.delete(f"/api/assets/{ids['Fan']}?confirm=true")).status_code == 204  # metered: this one counts
    live = (await costs(client))["live"]
    assert live["differs"] is True and live["changed_assets"] >= 1


async def test_late_readings_change_only_the_live_line(client, db):
    ids = await build(db)
    await login_as(client, db)
    open_body, open_csv = await costs(client), await csv_bytes(client)
    await close(client)
    point = await db.fetchval("SELECT id FROM points WHERE address = 'Pump_kWh'")
    start = at(2026, 3, 9) + timedelta(minutes=30)  # the counter's next hour after its last reading
    await insert_readings(db, point, start, 3600, [1000.0 + (168 + i) * 2.0 for i in range(8)])  # eight more hours, 2 kWh each
    await settle_rollups(db)
    after = await costs(client)
    assert figures_of(after) == figures_of(open_body)
    assert await csv_bytes(client) == open_csv
    assert after["live"]["differs"] is True and after["live"]["changed_assets"] >= 1
    assert after["live"]["delta_kwh"] == pytest.approx(16.0, abs=2.5)
    assert after["live"]["delta_cost"] > 0
    assert after["closed"]["total_kwh"] == pytest.approx(after["live"]["total_kwh"] - after["live"]["delta_kwh"], abs=5e-4)


async def test_months_keeps_a_closed_month_reachable_after_its_source_is_deleted(client, db):
    ids = await build(db)
    await login_as(client, db)
    assert (await client.get("/api/billing/months")).json() == {"first_month": MONTH}
    await close(client)
    await delete_the_source(client, db, ids)
    assert (await client.get("/api/billing/months")).json() == {"first_month": MONTH}
    assert (await client.get("/api/billing/months")).status_code == 200
    await reopen(client)
    assert (await client.get("/api/billing/months")).json() == {"first_month": MONTH}  # a reopened month can still be opened and closed again


async def test_months_starts_at_the_earlier_of_the_data_and_any_close(client, db):
    await build(db)
    await login_as(client, db)
    await db.execute(
        "INSERT INTO billing_closes (month, closed_name, timezone, total_kwh, figures) VALUES ('2025-12', 'Old', 'UTC', 0, '{}')"
    )
    assert (await client.get("/api/billing/months")).json() == {"first_month": "2025-12"}
    await db.execute("DELETE FROM billing_closes")
    await db.execute(  # a reopened close still counts: its month stays reachable
        "INSERT INTO billing_closes (month, closed_name, timezone, total_kwh, figures, reopened_at, reopened_name, reopen_note) "
        "VALUES ('2025-11', 'Old', 'UTC', 0, '{}', now(), 'Old', 'because')"
    )
    assert (await client.get("/api/billing/months")).json() == {"first_month": "2025-11"}
    await db.execute("DELETE FROM billing_closes")
    await db.execute(
        "INSERT INTO billing_closes (month, closed_name, timezone, total_kwh, figures) VALUES ('2026-06', 'Late', 'UTC', 0, '{}')"
    )
    assert (await client.get("/api/billing/months")).json() == {"first_month": MONTH}  # the data is earlier


async def test_an_unusable_zone_after_the_close_gives_no_live_line_and_the_closed_month_still_loads(client, db):
    await build(db)
    await login_as(client, db)
    open_body, open_csv = await costs(client), await csv_bytes(client)
    await close(client)
    await set_zone(db, "Asia/Kolkata")  # billing refuses half-hour zones
    after = await costs(client)
    assert after["live"] is None and figures_of(after) == figures_of(open_body) and after["closed"] is not None
    assert await csv_bytes(client) == open_csv
    assert (await client.get(COSTS, params={"month": "2026-04"})).status_code == 409  # an open month still refuses


async def test_the_site_currency_changing_later_does_not_change_the_closed_month(client, db):
    await build(db)
    await login_as(client, db)
    open_csv = await csv_bytes(client)
    await close(client)
    await set_currency(db, "EUR")
    after = await costs(client)
    assert after["currency"] == "USD" and after["live"]["currency"] == "EUR"
    assert after["live"]["delta_cost"] is None and after["live"]["differs"] is True  # two currencies do not subtract
    assert await csv_bytes(client) == open_csv


async def test_a_closed_month_with_unreadable_figures_fails_and_never_shows_live_figures(app, db):
    """Only the close route writes `figures`, always the full object. If a row is damaged (manual SQL, a bad restore) the
    page and the CSV answer 500; they must not fall back to today's figures, which would pass off live numbers as billed."""
    await build(db)
    await db.execute(
        "INSERT INTO billing_closes (month, closed_name, timezone, total_kwh, figures) "
        "VALUES ($1, 'Old', 'UTC', 0, '{}')",
        MONTH,
    )
    async with silent_client(app) as quiet:
        await login_as(quiet, db)
        for url in (COSTS, CSV):
            response = await quiet.get(url, params={"month": MONTH})
            assert response.status_code == 500, url
            assert "assets" not in response.text and "Hall A" not in response.text, url
        assert (await quiet.get(COSTS, params={"month": "2026-04"})).status_code == 200  # an open month is not affected


# --- reopen -----------------------------------------------------------------------------------------------------------


async def test_a_reopen_goes_back_to_live_figures_and_keeps_the_old_snapshot(client, db):
    ids = await build(db)
    await login_as(client, db)
    open_body = await costs(client)
    await close(client, note="first")
    old_figures = (await rows(db))[0]["figures"]
    await change_the_site_rate(client, db, ids)
    reopened = await reopen(client)
    assert reopened.status_code == 200
    assert set(reopened.json()) == {"month", "reopened_at"} and reopened.json()["month"] == MONTH
    after = await costs(client)
    assert after["closed"] is None and "live" not in after
    assert figures_of(after) != figures_of(open_body)  # live again: the new site rate shows
    assert (await csv_bytes(client)) != b"" and (await client.get(CSV, params={"month": MONTH})).headers[
        "content-disposition"] == f'attachment; filename="billing-{MONTH}.csv"'
    [old] = await rows(db)  # the row is kept
    assert old["figures"] == old_figures and old["note"] == "first"
    assert old["reopened_at"] is not None and old["reopen_note"] == REASON
    assert old["reopened_name"] == "admin" and old["reopened_by"] == old["closed_by"]


async def test_a_second_close_after_a_reopen_inserts_a_new_row_and_keeps_the_old_one(client, db):
    ids = await build(db)
    await login_as(client, db)
    await close(client, note="first")
    await reopen(client)
    await change_the_site_rate(client, db, ids)
    again = await close(client, note="second")
    assert again.status_code == 201
    first, second = await rows(db)
    assert (first["note"], second["note"]) == ("first", "second")
    assert first["reopened_at"] is not None and second["reopened_at"] is None
    assert first["figures"] != second["figures"] and first["id"] != second["id"]
    assert figures_of(await costs(client)) == second["figures"]  # the page shows the NEW snapshot
    assert (await reopen(client, note="again please")).status_code == 200
    assert [r["reopened_at"] is not None for r in await rows(db)] == [True, True]


# --- audit ------------------------------------------------------------------------------------------------------------


async def test_close_and_reopen_are_audited_with_their_numbers_and_notes(client, db):
    await build(db)
    await login_as(client, db)
    created = (await close(client, note="monthly bill")).json()
    reopened = await reopen(client)
    closed_row, reopened_row = await audit_rows(db)
    admin_id = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    assert (closed_row["action"], closed_row["user_id"]) == ("billing.closed", admin_id)
    assert dict(closed_row["detail"]) == {
        "month": MONTH, "close_id": created["id"], "total_kwh": created["total_kwh"], "total_cost": created["total_cost"],
        "currency": "USD", "note": "monthly bill",
    }
    assert (reopened_row["action"], reopened_row["user_id"]) == ("billing.reopened", admin_id)
    detail = dict(reopened_row["detail"])
    assert set(detail) == {
        "month", "close_id", "closed_name", "closed_at", "total_kwh", "total_cost", "currency", "note",
    }
    assert (detail["month"], detail["close_id"], detail["closed_name"]) == (MONTH, created["id"], "admin")
    assert (detail["total_kwh"], detail["total_cost"], detail["currency"]) == (
        created["total_kwh"], created["total_cost"], "USD")
    assert detail["note"] == REASON
    assert datetime.fromisoformat(detail["closed_at"]) == (await rows(db))[0]["closed_at"]
    assert reopened.json()["month"] == MONTH


async def test_a_refused_close_or_reopen_writes_no_audit_row(client, db):
    await build(db)
    await login_as(client, db)
    await close(client, "2026-04")
    await close(client, "2026-01")
    await reopen(client, "2026-02")
    assert await audit_rows(db) == []


# --- the people -------------------------------------------------------------------------------------------------------


async def test_the_closers_name_survives_the_deletion_of_the_account(app, client, db):
    await build(db)
    await login_as(client, db)
    carol = await make_user(db, "carol", "admin")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as other:
        await login_as(other, db, role="admin", username="carol")
        assert (await close(other)).status_code == 201
    assert (await client.delete(f"/api/users/{carol}")).status_code == 204
    [row] = await rows(db)
    assert row["closed_by"] is None and row["closed_name"] == "carol"
    after = await costs(client)
    assert after["closed"]["closed_name"] == "carol"
    assert (await close(client)).json()["detail"].startswith("that month is already closed by carol on ")
    assert (await reopen(client)).status_code == 200
    assert (await rows(db))[0]["reopened_name"] == "admin"


@pytest.mark.parametrize("blank", ["\t  ", "   "], ids=["tab and spaces", "spaces only"])
async def test_an_account_whose_name_is_only_blanks_can_still_close_and_reopen(client, db, blank):
    await build(db)
    await login_as(client, db)
    admin_id = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    await db.execute("UPDATE users SET username = $1 WHERE id = $2", blank, admin_id)  # the session cookie stays valid
    response = await close(client)
    assert response.status_code == 201, response.text
    assert response.json()["closed_name"] == f"user {admin_id}"
    assert (await reopen(client)).status_code == 200
    [row] = await rows(db)
    assert (row["closed_name"], row["reopened_name"]) == (f"user {admin_id}", f"user {admin_id}")
    assert (await costs(client))["closed"] is None


# --- the sentences the delete asks about ------------------------------------------------------------------------------

SENTENCE = "except in closed months, which keep their billed figures."


async def test_the_asset_delete_confirmation_says_closed_months_keep_their_figures(client, db):
    await build(db)
    await login_as(client, db)
    site = await db.fetchval("SELECT id FROM assets WHERE name = 'Site'")
    response = await client.delete(f"/api/assets/{site}")
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "disappear from billing and dashboards, " + SENTENCE in detail and detail.endswith("to go ahead.")


async def test_the_source_delete_confirmation_says_closed_months_keep_their_figures(client, db):
    await build(db)
    await login_as(client, db)
    source = await db.fetchval("SELECT id FROM sources")
    response = await client.delete(f"/api/sources/{source}")
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "disappear from billing and dashboards, " + SENTENCE in detail and detail.endswith("to go ahead.")
