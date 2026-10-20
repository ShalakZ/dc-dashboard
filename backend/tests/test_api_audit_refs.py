"""`refs` on the audit list and entry: the current names of the things an entry's detail points at (W7l Task 1)."""
import csv
import io
import json
import re

import pytest
from sqlalchemy import event

from dcdash.api.audit import _ref_ids
from dcdash.core.db import get_engine
from helpers import login_as, make_asset, make_point, make_role, make_source, make_user
from test_api_audit_filters import add, at

KINDS = {"asset", "user", "source", "dashboard", "point"}
# The name lookup of one kind, as SQLAlchemy writes it: SELECT assets.id, assets.name FROM assets WHERE assets.id IN (...)
LOOKUP = re.compile(r"SELECT (assets|users|sources|dashboards|points)\.id, \1\.\w+\s+FROM \1\s+WHERE \1\.id IN")


# ---- _ref_ids: pure -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "key, kind",
    [
        ("asset_id", "asset"), ("parent_id", "asset"), ("user_id", "user"),
        ("source_id", "source"), ("dashboard_id", "dashboard"), ("point_id", "point"),
        ("display_id", "display"), ("playlist_id", "playlist"),
    ],
)
def test_each_key_is_read_from_the_detail_and_from_before_and_after(key, kind):
    assert _ref_ids({key: 3}) == {kind: {3}}
    assert _ref_ids({"before": {key: 4}}) == {kind: {4}}
    assert _ref_ids({"after": {key: 5}}) == {kind: {5}}
    assert _ref_ids({key: 3, "before": {key: 4}, "after": {key: 5}}) == {kind: {3, 4, 5}}


def test_a_moved_mapping_an_asset_parent_and_a_changed_default_dashboard():
    assert _ref_ids({"before": {"asset_id": 1, "metric": "m"}, "after": {"asset_id": 2, "metric": "m"}}) == {"asset": {1, 2}}
    assert _ref_ids({"before": {"parent_id": None}, "after": {"parent_id": 7, "name": "Panel"}}) == {"asset": {7}}
    assert _ref_ids({"before": {"dashboard_id": 8}, "after": {"dashboard_id": 9}, "name": "D"}) == {"dashboard": {8, 9}}


def test_the_two_asset_keys_and_the_other_kinds_are_told_apart():
    found = _ref_ids({"asset_id": 1, "parent_id": 2, "user_id": 3, "source_id": 4, "dashboard_id": 5, "point_id": 6})
    assert found == {"asset": {1, 2}, "user": {3}, "source": {4}, "dashboard": {5}, "point": {6}}


@pytest.mark.parametrize(
    "value",
    [True, False, 0, -1, 2**31, 10**30, "5", 5.0, 5.5, [5], {"id": 5}, None],
    ids=repr,
)
def test_only_a_real_positive_integer_in_range_counts(value):
    assert _ref_ids({"asset_id": value}) == {}
    assert _ref_ids({"before": {"asset_id": value}, "after": {"asset_id": value}}) == {}


def test_the_largest_database_integer_and_one_count():
    assert _ref_ids({"asset_id": 2**31 - 1, "user_id": 1}) == {"asset": {2**31 - 1}, "user": {1}}


def test_a_null_id_is_skipped_and_the_rest_of_the_detail_still_counts():
    assert _ref_ids({"asset_id": None, "source_id": 2}) == {"source": {2}}  # a site default tariff has asset_id: null


@pytest.mark.parametrize("detail", [[], [{"asset_id": 3}], "asset_id", 5, 5.5, True, None])
def test_a_detail_that_is_not_an_object_has_no_ids(detail):
    assert _ref_ids(detail) == {}


@pytest.mark.parametrize("scope", ["x", ["asset_id"], [{"asset_id": 3}], 4, None, True])
def test_before_and_after_that_are_not_objects_are_skipped(scope):
    assert _ref_ids({"before": scope, "after": scope, "asset_id": 1}) == {"asset": {1}}


def test_before_an_object_with_after_missing_is_read():
    assert _ref_ids({"before": {"asset_id": 3}}) == {"asset": {3}}
    assert _ref_ids({"before": {"asset_id": 3}, "after": None}) == {"asset": {3}}


def test_ids_deeper_than_before_and_after_are_not_read():
    assert _ref_ids({"changes": {"asset_id": 3}, "before": {"inner": {"asset_id": 4}}}) == {}
    assert _ref_ids({"items": [{"asset_id": 3}], "after": {"after": {"asset_id": 4}}}) == {}


def test_an_empty_detail_has_no_ids():
    assert _ref_ids({}) == {}


# ---- the API ------------------------------------------------------------------------------------


async def make_dashboard(db, name: str) -> int:
    return await db.fetchval("INSERT INTO dashboards (name) VALUES ($1) RETURNING id", name)


async def entries_by_action(client) -> dict[str, dict]:
    response = await client.get("/api/audit?limit=200")
    assert response.status_code == 200, response.text
    return {item["action"]: item for item in response.json()["items"]}


async def test_refs_hold_the_current_names_and_follow_before_and_after(client, db):
    await login_as(client, db, "admin")
    parent = await make_asset(db, "Hall A")
    panel = await make_asset(db, "Panel 02", parent)
    source = await make_source(db, "Gateway")
    point = await make_point(db, source, "40001")
    await db.execute("UPDATE points SET name = 'Voltage L1' WHERE id = $1", point)
    dash = await make_dashboard(db, "Overview")
    user = await make_user(db, "dora")
    await add(db, "tariff.created", detail={"asset_id": panel, "rate": 0.16})
    await add(db, "asset.updated", detail={"before": {"parent_id": None}, "after": {"parent_id": parent, "name": "Panel 02"}})
    await add(db, "mapping.updated", detail={"before": {"point_id": point, "asset_id": panel}, "after": {"point_id": point, "asset_id": parent}})
    await add(db, "user.updated", detail={"user_id": user})
    await add(db, "source.updated", detail={"source_id": source})
    await add(db, "dashboard.default_changed", detail={"before": {"dashboard_id": None}, "after": {"dashboard_id": dash}})
    by_action = await entries_by_action(client)
    assert by_action["tariff.created"]["refs"] == {"asset": {str(panel): "Panel 02"}}
    assert by_action["asset.updated"]["refs"] == {"asset": {str(parent): "Hall A"}}
    assert by_action["mapping.updated"]["refs"] == {
        "point": {str(point): "Voltage L1"}, "asset": {str(panel): "Panel 02", str(parent): "Hall A"},
    }
    assert by_action["user.updated"]["refs"] == {"user": {str(user): "dora"}}
    assert by_action["source.updated"]["refs"] == {"source": {str(source): "Gateway"}}
    assert by_action["dashboard.default_changed"]["refs"] == {"dashboard": {str(dash): "Overview"}}


async def test_refs_follow_a_rename_but_the_stored_detail_is_left_alone(client, db):
    await login_as(client, db, "admin")
    asset = await make_asset(db, "Old name")
    await add(db, "tariff.created", detail={"asset_id": asset})
    await db.execute("UPDATE assets SET name = 'New name' WHERE id = $1", asset)
    item = (await client.get("/api/audit?limit=1")).json()["items"][0]
    assert item["refs"] == {"asset": {str(asset): "New name"}} and item["detail"] == {"asset_id": asset}


async def test_a_deleted_target_is_left_out_and_so_is_a_kind_with_nothing_left(client, db):
    await login_as(client, db, "admin")
    kept = await make_asset(db, "Kept")
    gone = await make_asset(db, "Gone")
    gone_user = await make_user(db, "gone")
    await add(db, "x.both", detail={"asset_id": kept, "parent_id": gone, "user_id": gone_user})
    await db.execute("DELETE FROM assets WHERE id = $1", gone)
    await db.execute("DELETE FROM users WHERE id = $1", gone_user)
    refs = (await client.get("/api/audit?limit=1")).json()["items"][0]["refs"]
    assert refs == {"asset": {str(kept): "Kept"}}  # the deleted asset is not in its kind, the deleted user's kind is gone
    await db.execute("DELETE FROM assets WHERE id = $1", kept)
    assert (await client.get("/api/audit?limit=1")).json()["items"][0]["refs"] == {}


async def test_an_entry_without_ids_has_empty_refs_and_the_key_is_always_there(client, db):
    await login_as(client, db, "admin")
    await add(db, "x.plain", detail={"name": "Panel", "n": 3})
    await add(db, "x.empty")
    await add(db, "x.null_id", detail={"asset_id": None})
    items = (await client.get("/api/audit")).json()["items"]
    assert len(items) == 3 and all(item["refs"] == {} for item in items)


async def test_stored_ids_that_cannot_be_ids_still_return_200_with_no_refs(client, db):
    await login_as(client, db, "admin")
    real = await make_asset(db, "Real")
    bad = [True, 0, -4, 2**31, 10**30, "5", 5.5, [real], {"id": real}]
    for value in bad:
        await add(db, "x.bad", detail={"asset_id": value, "parent_id": value, "user_id": value, "before": {"source_id": value}})
    await add(db, "x.list", detail=[1, 2, 3])
    await add(db, "x.text", detail="asset_id")
    response = await client.get("/api/audit?limit=200")
    assert response.status_code == 200, response.text
    assert [item["refs"] for item in response.json()["items"]] == [{}] * (len(bad) + 2)
    entry = await db.fetchval("SELECT max(id) FROM audit_log")
    single = await client.get(f"/api/audit/{entry}")
    assert single.status_code == 200 and single.json()["refs"] == {}


async def test_the_single_entry_carries_the_same_refs_as_the_list(client, db):
    await login_as(client, db, "admin")
    asset = await make_asset(db, "Panel")
    source = await make_source(db, "Gateway")
    entry = await add(db, "x.mixed", at(2026, 10, 5, 10), detail={"asset_id": asset, "before": {"source_id": source}})
    in_list = (await client.get("/api/audit?limit=1")).json()["items"][0]
    single = (await client.get(f"/api/audit/{entry}")).json()
    assert single["refs"] == in_list["refs"] == {"asset": {str(asset): "Panel"}, "source": {str(source): "Gateway"}}
    assert single == in_list


async def test_a_page_of_fifty_entries_does_the_same_lookups_as_a_page_of_one(client, db):
    await login_as(client, db, "admin")
    assets = [await make_asset(db, f"Asset {i}") for i in range(6)]
    sources = [await make_source(db, f"Source {i}") for i in range(4)]
    points = [await make_point(db, sources[i % 4], f"4{i:04d}") for i in range(8)]
    dashboards = [await make_dashboard(db, f"Dash {i}") for i in range(3)]
    users = [await make_user(db, f"user{i}") for i in range(5)]
    for i in range(50):
        await add(db, "x.all_kinds", detail={
            "asset_id": assets[i % 6], "parent_id": assets[(i + 1) % 6], "user_id": users[i % 5],
            "source_id": sources[i % 4], "dashboard_id": dashboards[i % 3], "point_id": points[i % 8],
        })

    async def lookups(path: str) -> list[str]:
        statements: list[str] = []

        def record(conn, cursor, statement, parameters, context, executemany):
            statements.append(statement)

        sync_engine = get_engine().sync_engine
        event.listen(sync_engine, "before_cursor_execute", record)
        try:
            response = await client.get(path)
        finally:
            event.remove(sync_engine, "before_cursor_execute", record)
        assert response.status_code == 200, response.text
        return [statement for statement in statements if LOOKUP.match(statement)]

    one = await lookups("/api/audit?limit=1")
    fifty = await lookups("/api/audit?limit=50")
    entry = await lookups(f"/api/audit/{await db.fetchval('SELECT max(id) FROM audit_log')}")
    for found in (one, fifty, entry):
        assert sorted(LOOKUP.match(s).group(1) for s in found) == ["assets", "dashboards", "points", "sources", "users"]
    assert len(fifty) == len(one) == len(entry) == 5

    items = (await client.get("/api/audit?limit=50")).json()["items"]
    assert len(items) == 50 and all(set(item["refs"]) == KINDS for item in items)
    newest = items[0]["detail"]  # one entry lists exactly its own targets
    assert items[0]["refs"]["asset"].keys() == {str(newest["asset_id"]), str(newest["parent_id"])}


async def test_a_kind_without_ids_costs_no_lookup(client, db):
    await login_as(client, db, "admin")
    asset = await make_asset(db, "Panel")
    await add(db, "x.asset_only", detail={"asset_id": asset})
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    sync_engine = get_engine().sync_engine
    event.listen(sync_engine, "before_cursor_execute", record)
    try:
        assert (await client.get("/api/audit")).status_code == 200
        await add(db, "x.plain")
        assert (await client.get("/api/audit?action=x.plain")).status_code == 200
    finally:
        event.remove(sync_engine, "before_cursor_execute", record)
    assert [LOOKUP.match(s).group(1) for s in statements if LOOKUP.match(s)] == ["assets"]  # none for the second request


# ---- who may read them, and what they never contain -----------------------------------------------


async def test_audit_view_alone_gets_refs_and_without_it_both_routes_stay_403(client, db):
    asset = await make_asset(db, "Panel")
    entry = await add(db, "x.did", detail={"asset_id": asset})
    await make_role(db, "auditor", ["audit.view"])
    await login_as(client, db, "auditor")
    assert (await client.get("/api/audit")).json()["items"][0]["refs"] == {"asset": {str(asset): "Panel"}}
    assert (await client.get(f"/api/audit/{entry}")).json()["refs"] == {"asset": {str(asset): "Panel"}}
    await client.post("/api/logout")
    await make_role(db, "exporter", ["audit.export", "assets.view"])
    await login_as(client, db, "exporter")
    assert (await client.get("/api/audit")).status_code == 403
    assert (await client.get(f"/api/audit/{entry}")).status_code == 403


async def test_refs_never_carry_anything_but_the_five_names(client, db):
    await login_as(client, db, "admin")
    source = await make_source(db, "Gateway", config={"host": "10.0.0.9", "password": "hunter2"}, secret="s3cret-token")
    user = await make_user(db, "dora")
    password_hash = await db.fetchval("SELECT password_hash FROM users WHERE id = $1", user)
    await add(db, "x.did", detail={"source_id": source, "user_id": user})
    response = await client.get("/api/audit")
    item = response.json()["items"][0]
    assert set(item["refs"]) <= KINDS
    assert item["refs"] == {"source": {str(source): "Gateway"}, "user": {str(user): "dora"}}
    for leaked in ("hunter2", "s3cret-token", "10.0.0.9", "password", password_hash):
        assert leaked not in response.text
        assert leaked not in (await client.get(f"/api/audit/{item['id']}")).text


async def test_the_csv_is_untouched_by_refs(client, db):
    await login_as(client, db, "admin")
    asset = await make_asset(db, "Panel")
    detail = {"asset_id": asset, "before": {"parent_id": None}}
    await add(db, "x.did", at(2026, 10, 5, 10), actor_id=7, actor_name="seven", detail=detail)
    response = await client.get("/api/audit.csv")
    assert response.status_code == 200
    text = response.content.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text, newline="")))
    assert rows[0] == ["id", "time", "user", "action", "detail"] and len(rows) == 2
    assert len(rows[1]) == 5 and json.loads(rows[1][4]) == detail
    assert "refs" not in text and "Panel" not in text
