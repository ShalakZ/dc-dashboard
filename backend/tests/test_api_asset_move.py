"""POST /api/assets/move-preview and POST /api/assets/move (W7p): the routes around the pure decision in core/tree_move.py.

The decision itself is tested in test_tree_move.py; here: who may call, what the bodies look like, that a refusal moves nothing,
what is audited, the `expect` guards, the undo round trip, and that the neighbours of a move (mappings, tariffs, the collector)
are left alone. Two-connection races are in test_api_asset_move_concurrency.py, billing before and after in
test_api_asset_move_billing.py.
"""
import asyncio
from datetime import datetime, timezone

import pytest

from dcdash.core.pg import CONFIG_CHANNEL
from helpers import listening, login_as, make_asset, make_mapping, make_point, make_role, make_source
from test_api_assets import add, add_tariff, rows_for

NOW = datetime(2026, 4, 15, 10, 20, tzinfo=timezone.utc)
MOVE, PREVIEW = "/api/assets/move", "/api/assets/move-preview"


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    monkeypatch.setattr("dcdash.api.billing._now", lambda: NOW)  # "today" of the preview's rates, as billing sees it


def group(ids, parent=None, before=None) -> dict:
    return {"ids": ids, "parent_id": parent, "before_id": before}


def body(*groups, **extra) -> dict:
    return {"moves": list(groups), **extra}


async def build(db) -> dict[str, int]:
    """Other (top level), Site > (Row A > Pump 1, Pump 2), (Row B > Fan), Row C. Every sort_order is 0: siblings sort by name."""
    ids: dict[str, int] = {}
    for name, parent in (
        ("Other", None), ("Site", None), ("Row A", "Site"), ("Row B", "Site"), ("Row C", "Site"),
        ("Pump 1", "Row A"), ("Pump 2", "Row A"), ("Fan", "Row B"),
    ):
        ids[name] = await make_asset(db, name, ids[parent] if parent else None)
    return ids


async def kids(db, parent_id: int | None) -> list[str]:
    """The names of the children of `parent_id` (None = top level) in tree order."""
    rows = await db.fetch(
        "SELECT name FROM assets WHERE parent_id IS NOT DISTINCT FROM $1 ORDER BY sort_order, name, id", parent_id
    )
    return [r["name"] for r in rows]


async def snapshot(db) -> list[tuple]:
    return [tuple(r) for r in await db.fetch("SELECT id, parent_id, name, sort_order FROM assets ORDER BY id")]


async def moved_rows(db) -> list[dict]:
    return [dict(r["detail"]) for r in await rows_for(db, "asset.moved")]


# ---- who may -------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("url", [PREVIEW, MOVE])
async def test_anonymous_is_401_and_only_assets_edit_passes(client, db, url):
    a = await build(db)
    request = body(group([a["Pump 1"]], a["Row C"]))
    assert (await client.post(url, json=request)).status_code == 401
    for role in ("viewer", "operator"):
        await login_as(client, db, role)
        assert (await client.post(url, json=request)).status_code == 403, role
    await make_role(db, "reader", ["assets.view"])
    await make_role(db, "editor", ["assets.view", "assets.edit"])
    await login_as(client, db, "reader")
    assert (await client.post(url, json=request)).status_code == 403
    await login_as(client, db, "editor")
    assert (await client.post(url, json=request)).status_code == 200


async def test_a_refused_caller_changes_nothing(client, db):
    a = await build(db)
    before = await snapshot(db)
    await login_as(client, db, "viewer")
    assert (await client.post(MOVE, json=body(group([a["Pump 1"]], a["Row C"])))).status_code == 403
    assert await snapshot(db) == before and await moved_rows(db) == []


# ---- the preview ---------------------------------------------------------------------------------------------------------


async def test_the_preview_says_what_would_happen_and_changes_nothing(client, db):
    a = await build(db)
    await login_as(client, db)
    audit_before = await db.fetchval("SELECT count(*) FROM audit_log")
    before = await snapshot(db)

    response = await client.post(PREVIEW, json=body(group([a["Pump 1"], a["Fan"]], a["Row C"])))

    assert response.status_code == 200, response.text
    assert response.json() == {
        "assets": 2,
        "unchanged": [],
        "currency": None,
        "rate_changes": False,
        "roots": [
            {
                "id": a["Pump 1"], "name": "Pump 1", "subtree_assets": 1,
                "from_parent_id": a["Row A"], "from_parent_name": "Row A", "to_parent_id": a["Row C"], "to_parent_name": "Row C",
                "change": "parent", "rate_before": None, "rate_after": None,
                "rate_changes_today": False, "rate_changes_other_days": False,
            },
            {
                "id": a["Fan"], "name": "Fan", "subtree_assets": 1,
                "from_parent_id": a["Row B"], "from_parent_name": "Row B", "to_parent_id": a["Row C"], "to_parent_name": "Row C",
                "change": "parent", "rate_before": None, "rate_after": None,
                "rate_changes_today": False, "rate_changes_other_days": False,
            },
        ],
        "expect": {"assets": 2, "parents": {str(a["Pump 1"]): a["Row A"], str(a["Fan"]): a["Row B"]}, "rate_changes": False},
    }
    assert await snapshot(db) == before and await db.fetchval("SELECT count(*) FROM audit_log") == audit_before


async def test_the_preview_names_the_site_currency(client, db):
    a = await build(db)
    await db.execute("UPDATE settings SET value = '{\"currency\": \"QAR\"}'::jsonb WHERE key = 'billing'")
    await login_as(client, db)
    assert (await client.post(PREVIEW, json=body(group([a["Pump 1"]], a["Row C"])))).json()["currency"] == "QAR"


async def test_a_preview_of_a_reorder_says_order_and_the_top_level_has_no_name(client, db):
    a = await build(db)
    await login_as(client, db)
    reorder = (await client.post(PREVIEW, json=body(group([a["Pump 1"]], a["Row A"])))).json()["roots"][0]
    assert (reorder["change"], reorder["from_parent_name"], reorder["to_parent_name"]) == ("order", "Row A", "Row A")
    top = (await client.post(PREVIEW, json=body(group([a["Pump 1"]], None)))).json()["roots"][0]
    assert (top["to_parent_id"], top["to_parent_name"]) == (None, None)


async def test_a_preview_refuses_as_the_move_would(client, db):
    a = await build(db)
    await login_as(client, db)
    response = await client.post(PREVIEW, json=body(group([a["Site"]], a["Pump 1"])))
    assert response.status_code == 422 and response.json()["refusals"][0]["code"] == "cycle"


# ---- the move ------------------------------------------------------------------------------------------------------------


async def test_a_move_changes_parents_numbers_the_new_siblings_and_answers_with_what_it_did(client, db):
    a = await build(db)
    await login_as(client, db)

    response = await client.post(MOVE, json=body(group([a["Fan"], a["Pump 2"]], a["Row A"], a["Pump 1"])))

    assert response.status_code == 200, response.text
    result = response.json()
    assert len(result["request_id"]) == 36 and result["assets"] == 2 and result["unchanged"] == []
    assert result["moved"] == [
        {
            "id": a["Pump 2"], "name": "Pump 2", "from_parent_id": a["Row A"], "to_parent_id": a["Row A"],
            "from_parent_name": "Row A", "to_parent_name": "Row A", "change": "order",
        },
        {
            "id": a["Fan"], "name": "Fan", "from_parent_id": a["Row B"], "to_parent_id": a["Row A"],
            "from_parent_name": "Row B", "to_parent_name": "Row A", "change": "parent",
        },
    ]
    assert await kids(db, a["Row A"]) == ["Pump 2", "Fan", "Pump 1"]  # the marker said: before Pump 1
    assert await db.fetch("SELECT name, sort_order FROM assets WHERE parent_id = $1 ORDER BY sort_order", a["Row A"]) == [
        ("Pump 2", 0), ("Fan", 1), ("Pump 1", 2)
    ]
    assert await kids(db, a["Row B"]) == []
    assert result["undo"]["expect"] == {"assets": 2, "parents": {str(a["Pump 2"]): a["Row A"], str(a["Fan"]): a["Row A"]}}


async def test_a_subtree_moves_whole_and_a_picked_child_travels_inside_its_picked_parent(client, db):
    a = await build(db)
    await login_as(client, db)
    response = await client.post(MOVE, json=body(group([a["Pump 1"], a["Row A"]], a["Other"])))
    assert response.status_code == 200
    assert [m["id"] for m in response.json()["moved"]] == [a["Row A"]] and response.json()["assets"] == 3
    assert await kids(db, a["Other"]) == ["Row A"] and await kids(db, a["Row A"]) == ["Pump 1", "Pump 2"]
    assert await db.fetchval("SELECT parent_id FROM assets WHERE id = $1", a["Pump 1"]) == a["Row A"]  # untouched
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'asset.moved'") == 1


async def test_a_move_to_the_top_level_and_the_old_parents_other_children_keep_their_numbers(client, db):
    a = await build(db)
    await db.execute("UPDATE assets SET sort_order = 4 WHERE id = $1", a["Row A"])
    await db.execute("UPDATE assets SET sort_order = 5 WHERE id = $1", a["Row B"])
    await db.execute("UPDATE assets SET sort_order = 6 WHERE id = $1", a["Row C"])
    await login_as(client, db)
    assert (await client.post(MOVE, json=body(group([a["Row B"]], None)))).status_code == 200
    assert await db.fetchval("SELECT parent_id FROM assets WHERE id = $1", a["Row B"]) is None
    assert await kids(db, a["Site"]) == ["Row A", "Row C"]
    assert await db.fetch("SELECT sort_order FROM assets WHERE parent_id = $1 ORDER BY sort_order", a["Site"]) == [(4,), (6,)]
    (row,) = await moved_rows(db)
    assert row["before"]["parent_name"] == "Site" and row["after"] == {"parent_id": None, "parent_name": None, "sort_order": 2}


async def test_nothing_else_changes_mappings_tariffs_and_the_collector_are_left_alone(client, db, database_url):
    a = await build(db)
    point = await make_point(db, await make_source(db), "kw")
    mapping = await make_mapping(db, point, a["Pump 1"])
    await add_tariff(db, a["Row A"])
    tariffs = await db.fetch("SELECT id, asset_id FROM tariffs")
    await login_as(client, db)
    async with listening(database_url, CONFIG_CHANNEL) as received:
        assert (await client.post(MOVE, json=body(group([a["Pump 1"]], a["Row C"])))).status_code == 200
        await asyncio.sleep(0.3)
        assert received.empty()  # no mapping changed: the collector has nothing to reload
    assert await db.fetchval("SELECT asset_id FROM mappings WHERE id = $1", mapping) == a["Pump 1"]
    assert await db.fetch("SELECT id, asset_id FROM tariffs") == tariffs


async def test_a_large_move_is_one_request(client, db):
    a = await build(db)
    await db.executemany("INSERT INTO assets (name, parent_id) VALUES ($1, $2)", [(f"Rack {n:03d}", a["Other"]) for n in range(300)])
    ids = [r["id"] for r in await db.fetch("SELECT id FROM assets WHERE parent_id = $1 ORDER BY id", a["Other"])]
    await login_as(client, db)
    response = await client.post(MOVE, json=body(group(ids, a["Row C"])))
    assert response.status_code == 200 and response.json()["assets"] == 300
    assert await kids(db, a["Other"]) == [] and len(await kids(db, a["Row C"])) == 300
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'asset.moved'") == 300
    assert await db.fetchval("SELECT max(sort_order) FROM assets WHERE parent_id = $1", a["Row C"]) == 299


# ---- refusals move nothing -----------------------------------------------------------------------------------------------


async def test_one_refusal_anywhere_refuses_the_whole_request_and_writes_nothing(client, db):
    a = await build(db)
    await login_as(client, db)
    before = await snapshot(db)
    # Group 1 is fine; group 2 puts Site into Row C, which sits inside Site.
    response = await client.post(MOVE, json=body(group([a["Pump 1"]], a["Row C"]), group([a["Site"]], a["Row C"])))
    assert response.status_code == 422, response.text
    assert response.json()["refusals"] == [{
        "id": a["Site"], "name": "Site", "code": "cycle", "reason": 'Cannot move "Site" into "Row C", which is inside it.',
    }]
    assert response.json()["detail"] == 'Cannot move "Site" into "Row C", which is inside it.'
    assert await snapshot(db) == before and await moved_rows(db) == []


async def test_a_move_into_a_place_that_has_the_name_is_refused_with_both_names(client, db):
    a = await build(db)
    await make_asset(db, "pump  1", a["Row C"])
    await login_as(client, db)
    response = await client.post(MOVE, json=body(group([a["Pump 1"]], a["Row C"])))
    assert response.status_code == 422
    (refusal,) = response.json()["refusals"]
    assert refusal["code"] == "name_clash" and refusal["name"] == "Pump 1"
    assert '"Pump 1"' in refusal["reason"] and '"pump  1"' in refusal["reason"] and '"Row C"' in refusal["reason"]
    assert await db.fetchval("SELECT parent_id FROM assets WHERE id = $1", a["Pump 1"]) == a["Row A"]


async def test_a_before_id_that_is_not_a_child_of_the_target_is_refused(client, db):
    a = await build(db)
    await login_as(client, db)
    response = await client.post(MOVE, json=body(group([a["Pump 1"]], a["Row B"], a["Row C"])))
    assert response.status_code == 422 and response.json()["refusals"][0]["code"] == "bad_before"


async def test_an_asset_or_a_target_that_is_gone_is_409_stale(client, db):
    a = await build(db)
    await login_as(client, db)
    for request in (body(group([999_999], a["Row C"])), body(group([a["Pump 1"]], 999_999))):
        response = await client.post(MOVE, json=request)
        assert response.status_code == 409 and response.json()["stale"] is True, response.text
    assert await moved_rows(db) == []


async def test_a_request_where_everything_is_already_there_is_422_already_there(client, db):
    a = await build(db)
    await login_as(client, db)
    for url in (MOVE, PREVIEW):
        response = await client.post(url, json=body(group([a["Pump 1"]], a["Row A"], a["Pump 2"])))  # Pump 1 before Pump 2
        assert response.status_code == 422, response.text
        assert response.json() == {
            "detail": "Already there: nothing needs to move.", "refusals": [], "unchanged": [a["Pump 1"]],
        }
    assert await moved_rows(db) == []


async def test_what_is_already_in_place_is_skipped_and_listed_while_the_rest_moves(client, db):
    a = await build(db)
    await login_as(client, db)
    response = await client.post(MOVE, json=body(group([a["Pump 1"]], a["Row A"], a["Pump 2"]), group([a["Fan"]], a["Row C"])))
    assert response.status_code == 200
    assert response.json()["unchanged"] == [a["Pump 1"]] and [m["id"] for m in response.json()["moved"]] == [a["Fan"]]
    assert [row["asset_id"] for row in await moved_rows(db)] == [a["Fan"]]


@pytest.mark.parametrize("request_body", [
    {},
    {"moves": []},
    {"moves": [{"ids": [], "parent_id": None}]},
    {"moves": [{"ids": [1]}]},  # no parent_id: it must be said (null for the top level), never assumed
    {"moves": [{"ids": [1, 1], "parent_id": None}]},
    {"moves": [{"ids": [1], "parent_id": None}, {"ids": [2, 1], "parent_id": None}]},
    {"moves": [{"ids": list(range(1, 502)), "parent_id": None}]},
    {"moves": [{"ids": [n], "parent_id": None} for n in range(1, 502)]},
    {"moves": [{"ids": list(range(1, 251)), "parent_id": None}, {"ids": list(range(251, 502)), "parent_id": None}]},
    {"moves": [{"ids": [0], "parent_id": None}]},
    {"moves": [{"ids": [2_147_483_648], "parent_id": None}]},
    {"moves": [{"ids": [1], "parent_id": 0}]},
    {"moves": [{"ids": [1], "parent_id": 2_147_483_648}]},
    {"moves": [{"ids": [1], "parent_id": None, "before_id": -1}]},
    {"moves": [{"ids": [1], "parent_id": None, "beforeId": 2}]},
    {"moves": [{"ids": [1], "parent_id": None}], "bogus": True},
    {"moves": [{"ids": [1], "parent_id": None}], "undo_of": "not a request id"},
    {"moves": [{"ids": [1], "parent_id": None}], "expect": {"parents": {"x": 1}}},
    {"moves": [{"ids": [1], "parent_id": None}], "expect": {"assets": -1}},
    {"moves": [{"ids": [1], "parent_id": None}], "expect": {"surprise": 1}},
])
async def test_a_malformed_body_is_422_before_any_work(client, db, request_body):
    await login_as(client, db)
    for url in (MOVE, PREVIEW):
        assert (await client.post(url, json=request_body)).status_code == 422, (url, request_body)
    assert await moved_rows(db) == []


# ---- the audit ----------------------------------------------------------------------------------------------------------


async def test_every_moved_root_is_audited_in_names_and_the_rows_of_one_request_share_a_request_id(client, db):
    a = await build(db)
    await login_as(client, db)
    response = await client.post(MOVE, json=body(group([a["Row A"], a["Fan"], a["Pump 1"]], a["Other"])))
    assert response.status_code == 200
    request_id = response.json()["request_id"]

    rows = await rows_for(db, "asset.moved")
    assert [r["actor_name"] for r in rows] == ["admin", "admin"]
    assert [dict(r["detail"]) for r in rows] == [
        {
            "asset_id": a["Row A"], "name": "Row A", "request_id": request_id, "moved_with": 1, "subtree_assets": 3,
            "before": {"parent_id": a["Site"], "parent_name": "Site", "sort_order": 0},
            "after": {"parent_id": a["Other"], "parent_name": "Other", "sort_order": 0},
        },
        {
            "asset_id": a["Fan"], "name": "Fan", "request_id": request_id, "moved_with": 1, "subtree_assets": 1,
            "before": {"parent_id": a["Row B"], "parent_name": "Row B", "sort_order": 0},
            "after": {"parent_id": a["Other"], "parent_name": "Other", "sort_order": 1},
        },
    ]
    assert isinstance(rows[0]["detail"]["moved_with"], int) and "undo_of" not in rows[0]["detail"]


async def test_the_audit_log_reads_the_move_in_current_names(client, db):
    a = await build(db)
    await login_as(client, db)
    await client.post(MOVE, json=body(group([a["Pump 1"]], a["Row C"])))
    await client.patch(f"/api/assets/{a['Row C']}", json={"name": "Row Z"})  # renamed afterwards

    items = (await client.get("/api/audit", params={"action": "asset.moved"})).json()["items"]
    (entry,) = items
    assert entry["refs"]["asset"] == {str(a["Pump 1"]): "Pump 1", str(a["Row A"]): "Row A", str(a["Row C"]): "Row Z"}


async def test_the_tariff_table_and_the_audit_show_the_new_path_after_a_move(client, db):
    a = await build(db)
    await add_tariff(db, a["Pump 1"])
    await login_as(client, db)
    assert (await client.get("/api/tariffs")).json()[0]["asset_path"] == "Site / Row A / Pump 1"
    await client.post(MOVE, json=body(group([a["Pump 1"]], a["Row C"])))
    assert (await client.get("/api/tariffs")).json()[0]["asset_path"] == "Site / Row C / Pump 1"


# ---- expect: what the person saw must still be true ----------------------------------------------------------------------


async def preview_expect(client, *groups) -> dict:
    response = await client.post(PREVIEW, json=body(*groups))
    assert response.status_code == 200, response.text
    return response.json()["expect"]


async def test_a_child_added_under_a_moved_asset_after_the_preview_is_refused_and_the_new_numbers_succeed(client, db):
    a = await build(db)
    await login_as(client, db)
    request = group([a["Row A"]], a["Other"])
    expect = await preview_expect(client, request)
    assert expect["assets"] == 3
    await add(client, "Pump 3", a["Row A"])

    response = await client.post(MOVE, json=body(request, expect=expect))
    assert response.status_code == 409 and response.json()["stale"] is True and "More assets" in response.json()["detail"]
    assert await db.fetchval("SELECT parent_id FROM assets WHERE id = $1", a["Row A"]) == a["Site"]

    fresh = await preview_expect(client, request)
    assert fresh["assets"] == 4
    assert (await client.post(MOVE, json=body(request, expect=fresh))).status_code == 200


async def test_an_asset_moved_by_somebody_else_after_the_preview_is_refused(client, db):
    a = await build(db)
    await login_as(client, db)
    request = group([a["Pump 1"]], a["Row C"])
    expect = await preview_expect(client, request)
    await client.patch(f"/api/assets/{a['Pump 1']}", json={"parent_id": a["Row B"]})
    response = await client.post(MOVE, json=body(request, expect=expect))
    assert response.status_code == 409 and response.json()["stale"] is True
    assert await db.fetchval("SELECT parent_id FROM assets WHERE id = $1", a["Pump 1"]) == a["Row B"]


async def test_a_picked_child_moved_out_from_under_its_picked_parent_changes_the_roots_and_is_refused(client, db):
    a = await build(db)
    await login_as(client, db)
    request = group([a["Row A"], a["Pump 1"]], a["Other"])  # roots: Row A alone
    expect = await preview_expect(client, request)
    assert list(expect["parents"]) == [str(a["Row A"])]
    await client.patch(f"/api/assets/{a['Pump 1']}", json={"parent_id": a["Row C"]})  # now Pump 1 is a root of its own
    response = await client.post(MOVE, json=body(request, expect=expect))
    assert response.status_code == 409 and response.json()["stale"] is True
    assert await moved_rows(db) == []


async def test_a_tariff_added_after_a_preview_without_a_rate_change_does_not_slip_past_it(client, db):
    a = await build(db)
    await login_as(client, db)
    request = group([a["Pump 1"]], a["Row C"])
    expect = await preview_expect(client, request)
    assert expect["rate_changes"] is False
    await add_tariff(db, a["Row A"])  # Pump 1 is billed at Row A's rate today; at Row C it would have none

    response = await client.post(MOVE, json=body(request, expect=expect))
    assert response.status_code == 409 and "rate" in response.json()["detail"]
    assert await db.fetchval("SELECT parent_id FROM assets WHERE id = $1", a["Pump 1"]) == a["Row A"]

    fresh = await client.post(PREVIEW, json=body(request))
    assert fresh.json()["rate_changes"] is True
    assert (await client.post(MOVE, json=body(request, expect=fresh.json()["expect"]))).status_code == 200


async def test_a_preview_that_warned_may_proceed_when_the_rates_are_as_shown_and_expect_is_optional(client, db):
    a = await build(db)
    await add_tariff(db, a["Row A"])
    await login_as(client, db)
    request = group([a["Pump 1"]], a["Row C"])
    expect = await preview_expect(client, request)
    assert expect["rate_changes"] is True
    assert (await client.post(MOVE, json=body(request, expect=expect))).status_code == 200
    assert (await client.post(MOVE, json=body(group([a["Pump 2"]], a["Row C"])))).status_code == 200  # no expect at all


# ---- undo ----------------------------------------------------------------------------------------------------------------

# Site holds A, X, B, C in that order (explicit sort orders: by name they would read A B C X), and Z is at the top.
async def neighbours(db) -> dict[str, int]:
    ids = {"Site": await make_asset(db, "Site"), "Z": await make_asset(db, "Z")}
    for number, name in enumerate(("A", "X", "B", "C")):
        ids[name] = await make_asset(db, name, ids["Site"])
        await db.execute("UPDATE assets SET sort_order = $1 WHERE id = $2", number, ids[name])
    return ids


async def test_the_undo_of_a_move_restores_the_parents_and_the_sibling_order(client, db):
    n = await neighbours(db)
    await login_as(client, db)
    moved = (await client.post(MOVE, json=body(group([n["A"], n["B"], n["C"]], n["Z"])))).json()
    assert await kids(db, n["Site"]) == ["X"] and await kids(db, n["Z"]) == ["A", "B", "C"]

    undo = moved["undo"]
    assert [(g["ids"], g["before_id"]) for g in undo["moves"]] == [([n["A"]], n["X"]), ([n["B"], n["C"]], None)]
    response = await client.post(MOVE, json=body(*undo["moves"], expect=undo["expect"], undo_of=moved["request_id"]))

    assert response.status_code == 200, response.text
    assert await kids(db, n["Site"]) == ["A", "X", "B", "C"] and await kids(db, n["Z"]) == []
    rows = await moved_rows(db)
    assert {row.get("undo_of") for row in rows[:3]} == {None} and {row["undo_of"] for row in rows[3:]} == {moved["request_id"]}
    assert len({row["request_id"] for row in rows}) == 2


async def test_an_undo_puts_assets_last_when_the_sibling_it_remembered_has_gone(client, db):
    n = await neighbours(db)
    await login_as(client, db)
    moved = (await client.post(MOVE, json=body(group([n["A"]], n["Z"])))).json()
    await client.delete(f"/api/assets/{n['X']}")  # the sibling the undo would go before
    undo = moved["undo"]
    response = await client.post(MOVE, json=body(*undo["moves"], expect=undo["expect"], undo_of=moved["request_id"]))
    assert response.status_code == 200, response.text
    assert await kids(db, n["Site"]) == ["B", "C", "A"]


async def test_an_undo_of_something_moved_again_in_the_meantime_is_refused(client, db):
    n = await neighbours(db)
    await login_as(client, db)
    moved = (await client.post(MOVE, json=body(group([n["A"]], n["Z"])))).json()
    await client.patch(f"/api/assets/{n['A']}", json={"parent_id": n["B"]})
    undo = moved["undo"]
    response = await client.post(MOVE, json=body(*undo["moves"], expect=undo["expect"], undo_of=moved["request_id"]))
    assert response.status_code == 409 and response.json()["stale"] is True
    assert await kids(db, n["B"]) == ["A"]


async def test_the_undo_of_a_reorder_goes_back_before_the_sibling_that_followed(client, db):
    a = await build(db)
    await login_as(client, db)
    moved = (await client.post(MOVE, json=body(group([a["Pump 1"]], a["Row A"])))).json()  # Pump 1 last in Row A
    assert await kids(db, a["Row A"]) == ["Pump 2", "Pump 1"] and moved["moved"][0]["change"] == "order"
    undo = moved["undo"]
    assert (await client.post(MOVE, json=body(*undo["moves"], expect=undo["expect"], undo_of=moved["request_id"]))).status_code == 200
    assert await kids(db, a["Row A"]) == ["Pump 1", "Pump 2"]
