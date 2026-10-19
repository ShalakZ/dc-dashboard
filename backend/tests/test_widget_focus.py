"""w25: a widget that follows the dashboard's focus (`scope`, the request's `focus`, the answer's `focus` block, the 403).

Three layers: the config rules (no database), `_resolve_focus` as a pure function over a small tree (no database), and the
endpoints over one seeded tree. A following widget must answer exactly what the plain widget it stands for answers, so most
endpoint tests set one against the other and compare everything but the `focus` block.

The tree (kinds in brackets; a counter rises `n` kWh an hour, 47 counted hours from 1 April 01:00 to 2 April 23:00):
Site (Site) > Hall 1 (Hall) > Rack A1 (counter 3: 141 kWh), Rack A2 (counter 1: 47), Rack A3 (counter 5: 235), each with a Feed
(Feed) that holds the counter; their sort_order puts them in the order A3, A1, A2.
Site > Hall 2 (Hall) > Rack B1 (counter 6: 282). Site > Spare (Room), a leaf. So Hall 1 holds 423 kWh and the Site 705.
"""
import csv
import io
from datetime import datetime, timezone

import pytest
from billing_helpers import add_counter, at, set_currency, set_zone
from helpers import login_as, make_asset, make_role, settle_rollups

from dcdash.core.tree import AssetNode, AssetTree
from dcdash.core.widgets import MAX_ASSETS, _resolve_focus, validate_config

UTC = timezone.utc
NOW = datetime(2026, 4, 8, 10, 0, tzinfo=UTC)
START = at(2026, 4, 1)
HOURS = 48
PATHS = ("/api/widget-data", "/api/widget-data/csv")
GONE_BLOCK = {"asset": None, "state": "gone", "children": None, "top_level": None}
MAX_ID = 2_147_483_647


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr("dcdash.api.widget_data._now", lambda: NOW)


# ---- the config -------------------------------------------------------------------------------------------

BASE = {"assets": [], "source": "energy", "aggregation": "sum"}
METRIC = {"assets": [], "source": "metric", "metric": "active_power_kw", "aggregation": "avg"}
GAUGE = {"assets": [], "source": "metric", "metric": "active_power_kw", "aggregation": "last", "max": 100.0}
KIND = {**BASE, "bars": "kind", "kind": "Rack"}


def following(scope: str, **extra) -> dict:
    return {**BASE, "scope": scope, **extra}


def reject(widget_type: str, config: dict) -> str:
    with pytest.raises(ValueError) as caught:
        validate_config(widget_type, config)
    return str(caught.value)


def test_scope_is_left_out_of_the_dump_while_it_is_fixed():
    fixed = validate_config("stat", {**BASE, "assets": [1]})
    assert fixed.scope == "fixed" and "scope" not in fixed.model_dump(mode="json")
    given = validate_config("stat", {**BASE, "assets": [1], "scope": "fixed"})  # as good as absent
    assert given.model_dump(mode="json") == fixed.model_dump(mode="json")
    assert set(fixed.model_dump(mode="json")) == {"assets", "source", "metric", "aggregation", "range", "bars", "min", "max"}


@pytest.mark.parametrize("scope", ["focus", "children"])
def test_scope_is_dumped_once_it_follows_the_focus(scope):
    dumped = validate_config("table", following(scope)).model_dump(mode="json")
    assert dumped["scope"] == scope and dumped["assets"] == []
    assert validate_config("table", dumped).scope == scope  # a fixed point of the normalisation


def test_a_scope_that_is_not_one_of_the_three_is_refused_naming_the_field():
    assert reject("stat", {**BASE, "scope": "everything"}).startswith("scope:")


@pytest.mark.parametrize(
    "widget_type,config",
    [
        ("stat", following("focus")),
        ("gauge", {**GAUGE, "scope": "focus"}),
        ("timeseries", following("focus")),
        ("bar", following("focus")),
        ("bar", following("focus", bars="time")),
        ("table", following("focus")),
        ("bar", following("focus", bars="kind", kind="Rack")),
        ("stat", following("focus", range="this_month", compare="same_days_last_month")),
        ("timeseries", following("focus", range="this_month", compare="same_days_last_month")),
        ("timeseries", following("children")),
        ("bar", following("children")),
        ("bar", following("children", bars="time")),
        ("table", following("children")),
        ("table", {**METRIC, "scope": "children"}),
    ],
)
def test_a_following_widget_needs_no_assets_and_each_allowed_pairing_is_accepted(widget_type, config):
    assert validate_config(widget_type, config).assets == []


def test_a_following_widget_with_assets_is_refused():
    message = "assets: leave the assets empty; the focus chooses them"
    assert reject("stat", {**following("focus"), "assets": [1]}) == message
    assert reject("table", {**following("children"), "assets": [1, 2]}) == message
    assert reject("bar", {**following("focus", bars="kind", kind="Rack"), "assets": [1]}) == message


@pytest.mark.parametrize(
    "widget_type,config,message",
    [
        ("stat", following("children"), "scope: 'children' only applies to a time series, a bar chart or a table, not to a stat"),
        ("gauge", {**GAUGE, "scope": "children"}, "scope: 'children' only applies to a time series, a bar chart or a table, not to a gauge"),
        ("bar", following("children", bars="kind", kind="Rack"), "scope: 'children' does not apply to a breakdown by kind"),
        (
            "timeseries", following("children", range="this_month", compare="same_days_last_month"),
            "scope: 'children' cannot be compared with last month",
        ),
    ],
)
def test_children_only_fits_a_time_series_a_bar_by_asset_or_time_and_a_table(widget_type, config, message):
    assert reject(widget_type, config) == message


def test_a_breakdown_that_follows_the_focus_looks_under_the_focus_so_it_has_no_root():
    message = "root: leave it empty; a breakdown that follows the focus looks under the focus"
    assert reject("bar", following("focus", bars="kind", kind="Rack", root=7)) == message
    assert validate_config("bar", {**KIND, "root": 7}).root == 7  # a fixed breakdown keeps its root
    assert validate_config("bar", following("focus", bars="kind", kind="Rack", root=None)).root is None


def test_a_comparison_that_follows_the_focus_still_needs_the_range_this_month():
    assert reject("stat", following("focus", compare="same_days_last_month")) == "range: a comparison needs the range this month"
    assert reject("stat", following("focus", compare="same_days_last_month", range="7d")) == (
        "range: a comparison needs the range this month"
    )


def test_the_messages_of_a_fixed_widget_are_the_ones_they_were():
    assert reject("table", BASE) == "assets: choose at least one asset"
    assert reject("stat", {**BASE, "assets": [1, 2]}) == "assets: a stat shows exactly one asset (got 2)"
    assert reject("stat", {**BASE, "assets": []}) == "assets: choose at least one asset"
    assert reject("gauge", {**GAUGE, "assets": [1, 2]}) == "assets: a gauge shows exactly one asset (got 2)"
    assert reject("stat", {**BASE, "assets": [1, 2], "range": "this_month", "compare": "same_days_last_month"}) == (
        "assets: a comparison shows exactly one asset (got 2)"
    )
    assert reject("bar", {**BASE, "assets": [1], "bars": "kind", "kind": "Rack"}).startswith("assets: leave the assets empty for")
    assert reject("bar", {**BASE, "assets": [1], "root": 3}) == "root: only applies when the bars are one per asset of a kind"


# ---- _resolve_focus, over a small tree ----------------------------------------------------------------------

def tree_of(*nodes: tuple[int, int | None, str]) -> AssetTree:
    return AssetTree(AssetNode(asset_id, parent, name, 0) for asset_id, parent, name in nodes)


SMALL = tree_of(
    (1, None, "Site"), (2, 1, "Hall 1"), (3, 2, "Rack A"), (4, 2, "Rack B"), (5, 1, "Spare"),
)
STAT = validate_config("stat", following("focus"))
SERIES = validate_config("timeseries", following("children"))
BREAKDOWN = validate_config("bar", following("focus", bars="kind", kind="Rack"))
SITE = {"id": 1, "name": "Site", "path": "Site"}


def test_a_fixed_widget_is_returned_as_it_is_whatever_the_focus_says():
    config = validate_config("stat", {**BASE, "assets": [3]})
    for focus in (None, 2, 999):
        resolved = _resolve_focus(SMALL, config, focus)
        assert resolved.config is config
        assert (resolved.block, resolved.empty, resolved.missing) == (None, False, [])


@pytest.mark.parametrize("config", [STAT, SERIES, BREAKDOWN])
def test_a_focus_that_is_not_in_the_tree_resolves_to_nothing_and_a_deleted_id_looks_like_one_never_used(config):
    first, second = _resolve_focus(SMALL, config, 999), _resolve_focus(SMALL, config, 123456)
    assert first.block == second.block == GONE_BLOCK
    assert first.empty and second.empty
    assert (first.missing, second.missing) == ([999], [123456])
    assert first.config.scope == "fixed" and first.config.assets == [] and first.config.root is None


def test_a_focus_on_a_stat_gives_exactly_that_one_asset():
    resolved = _resolve_focus(SMALL, STAT, 3)
    assert resolved.config.assets == [3] and resolved.config.scope == "fixed" and not resolved.empty
    assert resolved.block == {
        "asset": {"id": 3, "name": "Rack A", "path": "Site / Hall 1 / Rack A"}, "state": "ok", "children": None, "top_level": None,
    }
    assert (STAT.scope, STAT.assets) == ("focus", [])  # the validated config itself is not touched


def test_a_focus_on_a_breakdown_becomes_its_root_and_leaves_the_assets_empty():
    resolved = _resolve_focus(SMALL, BREAKDOWN, 2)
    assert (resolved.config.root, resolved.config.assets, resolved.config.scope) == (2, [], "fixed")
    assert resolved.block["asset"]["id"] == 2 and not resolved.empty


def test_children_are_the_direct_children_in_tree_order_and_a_leaf_has_none():
    resolved = _resolve_focus(SMALL, SERIES, 2)
    assert resolved.config.assets == [3, 4] and not resolved.empty
    assert resolved.block["children"] == {"shown": 2, "count": 2}
    leaf = _resolve_focus(SMALL, SERIES, 5)
    assert leaf.config.assets == [] and leaf.empty and leaf.missing == []
    assert leaf.block == {"asset": {"id": 5, "name": "Spare", "path": "Site / Spare"}, "state": "ok",
                          "children": {"shown": 0, "count": 0}, "top_level": None}
    assert _resolve_focus(SMALL, STAT, 5).config.assets == [5]  # a leaf is a fine focus for a figure


def test_more_children_than_a_widget_can_hold_are_cut_to_twenty_and_the_block_says_so():
    wide = tree_of((1, None, "Hall"), *[(index + 2, 1, f"Rack {index:02d}") for index in range(34)])
    resolved = _resolve_focus(wide, SERIES, 1)
    assert len(resolved.config.assets) == MAX_ASSETS == 20
    assert resolved.config.assets == wide.children(1)[:20]
    assert resolved.block["children"] == {"shown": 20, "count": 34}
    # The cap holds for the top-level assets as well.
    many = tree_of(*[(index + 1, None, f"Site {index:02d}") for index in range(25)])
    roots = _resolve_focus(many, SERIES, None)
    assert roots.config.assets == many.roots()[:20] and roots.block["children"] == {"shown": 20, "count": 25}


def test_with_no_focus_and_one_top_level_asset_that_asset_is_the_focus():
    stat = _resolve_focus(SMALL, STAT, None)
    assert stat.config.assets == [1] and not stat.empty
    assert stat.block == {"asset": SITE, "state": "ok", "children": None, "top_level": 1}
    assert _resolve_focus(SMALL, BREAKDOWN, None).config.root == 1
    series = _resolve_focus(SMALL, SERIES, None)
    assert series.config.assets == [2, 5] and series.block["children"] == {"shown": 2, "count": 2}
    assert series.block["asset"] == SITE and series.block["top_level"] == 1


TWO_ROOTS = tree_of((1, None, "Site"), (2, 1, "Hall 1"), (6, None, "Annex"))


def test_with_no_focus_and_several_top_level_assets_a_figure_asks_for_a_focus_and_nothing_is_computed():
    resolved = _resolve_focus(TWO_ROOTS, STAT, None)
    assert resolved.empty and resolved.config.assets == [] and resolved.missing == []
    assert resolved.block == {"asset": None, "state": "choose", "children": None, "top_level": 2}


def test_with_no_focus_and_several_top_level_assets_a_breakdown_looks_at_the_whole_site():
    resolved = _resolve_focus(TWO_ROOTS, BREAKDOWN, None)
    assert not resolved.empty and resolved.config.root is None and resolved.config.assets == []
    assert resolved.block == {"asset": None, "state": "ok", "children": None, "top_level": 2}


def test_with_no_focus_and_several_top_level_assets_children_lists_the_top_level_assets():
    resolved = _resolve_focus(TWO_ROOTS, SERIES, None)
    assert not resolved.empty and resolved.config.assets == TWO_ROOTS.roots() == [6, 1]  # by name: Annex first
    assert resolved.block == {"asset": None, "state": "ok", "children": {"shown": 2, "count": 2}, "top_level": 2}


def test_an_empty_site_has_no_top_level_asset_at_all():
    empty = AssetTree([])
    assert _resolve_focus(empty, STAT, None).block == {"asset": None, "state": "choose", "children": None, "top_level": 0}
    assert _resolve_focus(empty, STAT, None).empty
    whole = _resolve_focus(empty, BREAKDOWN, None)
    assert not whole.empty and whole.block == {"asset": None, "state": "ok", "children": None, "top_level": 0}
    nothing = _resolve_focus(empty, SERIES, None)
    assert nothing.empty and nothing.block["children"] == {"shown": 0, "count": 0} and nothing.block["top_level"] == 0


# ---- the endpoints --------------------------------------------------------------------------------------------

async def node(db, name: str, kind: str, parent: int | None = None, sort_order: int = 0) -> int:
    asset = await make_asset(db, name, parent)
    await db.execute("UPDATE assets SET kind = $2, sort_order = $3 WHERE id = $1", asset, kind, sort_order)
    return asset


async def seed_tree(db) -> dict:
    await set_zone(db, "UTC")
    await set_currency(db, "USD")
    site = await node(db, "Site", "Site")
    hall1, hall2 = await node(db, "Hall 1", "Hall", site), await node(db, "Hall 2", "Hall", site)
    ids: dict = {"site": site, "hall1": hall1, "hall2": hall2}
    for name, per_hour, order in (("A1", 3.0, 2), ("A2", 1.0, 3), ("A3", 5.0, 1)):
        rack = await node(db, f"Rack {name}", "Rack", hall1, order)
        ids[name] = rack
        feed = await add_counter(db, f"Feed {name}", START, HOURS, per_hour, parent_id=rack)
        await db.execute("UPDATE assets SET kind = 'Feed' WHERE id = $1", feed)
    ids["B1"] = rack = await node(db, "Rack B1", "Rack", hall2)
    feed = await add_counter(db, "Feed B1", START, HOURS, 6.0, parent_id=rack)
    await db.execute("UPDATE assets SET kind = 'Feed' WHERE id = $1", feed)
    ids["spare"] = await node(db, "Spare", "Room", site)
    await settle_rollups(db)
    return ids


def energy(assets: list[int], **extra) -> dict:
    return {**BASE, "assets": assets, **extra}


async def ask(client, widget_type: str, config: dict, path: str = "/api/widget-data", range_: str = "this_month", **extra):
    return await client.post(path, json={"type": widget_type, "config": config, "range": range_, **extra})


async def answer(client, widget_type: str, config: dict, **extra) -> dict:
    response = await ask(client, widget_type, config, **extra)
    assert response.status_code == 200, response.text
    return response.json()


def without_focus(data: dict) -> dict:
    return {key: value for key, value in data.items() if key != "focus"}


async def test_a_request_without_scope_answers_as_before_with_a_null_focus_block(client, db):
    ids = await seed_tree(db)
    await login_as(client, db, "viewer")
    data = await answer(client, "stat", energy([ids["hall1"]]))
    assert data["focus"] is None and data["values"][0]["value"] == 423.0
    assert await answer(client, "stat", energy([ids["hall1"]]), focus=ids["hall2"]) == data  # a fixed widget ignores a focus
    assert (await answer(client, "stat", energy([ids["hall1"]]), focus=None)) == data  # null is as good as absent


@pytest.mark.parametrize("widget_type,extra", [("stat", {}), ("table", {}), ("bar", {}), ("bar", {"bars": "time"}), ("timeseries", {})])
async def test_a_widget_that_follows_the_focus_answers_what_the_widget_on_that_asset_answers(client, db, widget_type, extra):
    ids = await seed_tree(db)
    await login_as(client, db, "viewer")
    for source, aggregation in (("energy", "sum"), ("cost", "sum")):
        base = {"source": source, "aggregation": aggregation, **extra}
        plain = await answer(client, widget_type, {**base, "assets": [ids["hall1"]]})
        data = await answer(client, widget_type, {**base, "assets": [], "scope": "focus"}, focus=ids["hall1"])
        assert without_focus(data) == without_focus(plain)
        assert data["focus"] == {
            "asset": {"id": ids["hall1"], "name": "Hall 1", "path": "Site / Hall 1"}, "state": "ok",
            "children": None, "top_level": None,
        }
    if widget_type == "stat":
        assert (await answer(client, "stat", following("focus"), focus=ids["hall1"]))["values"][0]["value"] == 423.0


async def test_a_gauge_that_follows_the_focus_reads_the_metric_of_that_asset(client, db):
    ids = await seed_tree(db)
    await login_as(client, db, "viewer")
    plain = await answer(client, "gauge", {**GAUGE, "assets": [ids["A1"]]})
    data = await answer(client, "gauge", {**GAUGE, "scope": "focus"}, focus=ids["A1"])
    assert without_focus(data) == without_focus(plain) and data["no_metric"] == [ids["A1"]]  # a rack with no power reading


async def test_a_children_time_series_has_one_series_per_child_in_tree_order(client, db):
    ids = await seed_tree(db)
    await login_as(client, db, "viewer")
    order = [ids["A3"], ids["A1"], ids["A2"]]  # sort_order, not the names
    plain = await answer(client, "timeseries", energy(order))
    data = await answer(client, "timeseries", following("children"), focus=ids["hall1"])
    assert [series["asset_id"] for series in data["series"]] == order
    assert without_focus(data) == without_focus(plain)
    assert data["focus"]["children"] == {"shown": 3, "count": 3} and data["focus"]["asset"]["id"] == ids["hall1"]
    bars = await answer(client, "bar", following("children"), focus=ids["hall1"])
    assert [value["asset_id"] for value in bars["values"]] == order


async def test_a_breakdown_that_follows_the_focus_is_the_breakdown_under_that_asset(client, db):
    ids = await seed_tree(db)
    await login_as(client, db, "viewer")
    plain = await answer(client, "bar", {**KIND, "root": ids["hall1"]})
    data = await answer(client, "bar", following("focus", bars="kind", kind="Rack"), focus=ids["hall1"])
    assert data["values"] == plain["values"] and data["breakdown"] == plain["breakdown"]
    assert without_focus(data) == without_focus(plain)
    assert [value["name"] for value in data["values"]] == ["Rack A3", "Rack A1", "Rack A2"]
    assert data["breakdown"]["root"] == {"id": ids["hall1"], "name": "Hall 1"}


async def test_a_comparison_that_follows_the_focus_compares_that_asset(client, db):
    ids = await seed_tree(db)
    await login_as(client, db, "viewer")
    for widget_type, source in (("stat", "energy"), ("stat", "cost"), ("timeseries", "energy")):
        base = {"source": source, "aggregation": "sum", "range": "this_month", "compare": "same_days_last_month"}
        plain = await answer(client, widget_type, {**base, "assets": [ids["hall1"]]})
        data = await answer(client, widget_type, {**base, "assets": [], "scope": "focus"}, focus=ids["hall1"])
        assert without_focus(data) == without_focus(plain)
        assert data["compare"]["assets"][0]["asset_id"] == ids["hall1"]
    refused = await ask(client, "stat", {**base, "assets": [], "scope": "focus"}, range_="7d", focus=ids["hall1"])
    assert refused.status_code == 422 and refused.json()["detail"] == "range: a comparison needs the range this month"


async def test_with_one_top_level_asset_and_no_focus_a_following_widget_shows_that_asset(client, db):
    ids = await seed_tree(db)
    await login_as(client, db, "viewer")
    plain = await answer(client, "stat", energy([ids["site"]]))
    data = await answer(client, "stat", following("focus"))
    assert without_focus(data) == without_focus(plain) and data["values"][0]["value"] == 705.0
    assert data["focus"] == {
        "asset": {"id": ids["site"], "name": "Site", "path": "Site"}, "state": "ok", "children": None, "top_level": 1,
    }
    breakdown = await answer(client, "bar", following("focus", bars="kind", kind="Rack"))
    assert without_focus(breakdown) == without_focus(await answer(client, "bar", {**KIND, "root": ids["site"]}))
    halls = await answer(client, "bar", following("children"))
    assert [value["asset_id"] for value in halls["values"]] == [ids["hall1"], ids["hall2"], ids["spare"]]
    assert halls["focus"]["children"] == {"shown": 3, "count": 3} and halls["focus"]["top_level"] == 1


async def test_with_several_top_level_assets_and_no_focus_nothing_is_more_than_one_assets_figure(client, db):
    ids = await seed_tree(db)
    annex = await make_asset(db, "Annex")
    await login_as(client, db, "viewer")
    # A figure asks for a focus: no asset, no unit, nothing computed.
    for widget_type, config in (
        ("stat", following("focus")), ("table", following("focus")),
        ("stat", following("focus", range="this_month", compare="same_days_last_month")),
    ):
        data = await answer(client, widget_type, config)
        assert data["focus"] == {"asset": None, "state": "choose", "children": None, "top_level": 2}
        assert (data["values"], data["series"], data["missing"], data["unit"], data["compare"]) == ([], [], [], None, None)
    # A breakdown looks at the whole site, as a breakdown with no root does.
    whole = await answer(client, "bar", following("focus", bars="kind", kind="Rack"))
    assert whole["focus"] == {"asset": None, "state": "ok", "children": None, "top_level": 2}
    assert without_focus(whole) == without_focus(await answer(client, "bar", KIND)) and whole["breakdown"]["root"] is None
    # Children lists the top-level assets, in tree order (Annex before Site by name).
    tops = await answer(client, "bar", following("children"))
    assert [value["asset_id"] for value in tops["values"]] == [annex, ids["site"]]
    assert tops["focus"] == {"asset": None, "state": "ok", "children": {"shown": 2, "count": 2}, "top_level": 2}
    # A focus still names its asset, whatever the number of top-level assets.
    assert (await answer(client, "stat", following("focus"), focus=ids["hall1"]))["values"][0]["value"] == 423.0


async def test_more_children_than_a_widget_holds_are_cut_to_twenty_with_the_count_kept(client, db):
    ids = await seed_tree(db)
    wide = await node(db, "Wide hall", "Hall", ids["site"])
    racks = [await node(db, f"Rack W{index:02d}", "Rack", wide) for index in range(34)]
    await login_as(client, db, "viewer")
    data = await answer(client, "bar", following("children"), focus=wide)
    assert [value["asset_id"] for value in data["values"]] == racks[:20]
    assert data["focus"]["children"] == {"shown": 20, "count": 34}


async def test_a_leaf_has_no_children_and_nothing_is_computed(client, db):
    ids = await seed_tree(db)
    await login_as(client, db, "viewer")
    for widget_type in ("timeseries", "bar", "table"):
        data = await answer(client, widget_type, following("children"), focus=ids["spare"])
        assert (data["series"], data["values"], data["missing"], data["unit"]) == ([], [], [], None)
        assert data["focus"] == {
            "asset": {"id": ids["spare"], "name": "Spare", "path": "Site / Spare"}, "state": "ok",
            "children": {"shown": 0, "count": 0}, "top_level": None,
        }
    csv_response = await ask(client, "table", following("children"), path="/api/widget-data/csv", focus=ids["spare"])
    assert csv_response.status_code == 200 and rows_of(csv_response) == []


async def test_a_focus_that_is_gone_answers_the_same_as_one_that_never_existed_and_computes_nothing(client, db):
    ids = await seed_tree(db)
    await login_as(client, db, "viewer")
    candidate = 2_000_000
    configs = (
        ("stat", following("focus")), ("timeseries", following("children")),
        ("bar", following("focus", bars="kind", kind="Rack")),
        ("stat", following("focus", range="this_month", compare="same_days_last_month")),
    )
    never = [(await ask(client, widget_type, config, focus=candidate)).content for widget_type, config in configs]
    await db.execute("INSERT INTO assets (id, name) VALUES ($1, 'Short lived')", candidate)
    assert (await answer(client, "stat", following("focus"), focus=candidate))["focus"]["state"] == "ok"
    await db.execute("DELETE FROM assets WHERE id = $1", candidate)
    gone = [(await ask(client, widget_type, config, focus=candidate)).content for widget_type, config in configs]
    assert never == gone  # byte for byte: the server keeps no trace of a deleted asset
    data = await answer(client, "stat", following("focus"), focus=candidate)
    assert data["focus"] == GONE_BLOCK and data["missing"] == [candidate]
    assert (data["values"], data["series"], data["unit"], data["metric"]) == ([], [], None, None)
    assert data["range"]["preset"] == "this_month"


@pytest.mark.parametrize("focus", [0, -1, MAX_ID + 1, "5", 1.5, True, [5], {"id": 5}])
async def test_a_focus_that_is_not_an_id_is_refused(client, db, focus):
    await seed_tree(db)
    await login_as(client, db, "viewer")
    for path in PATHS:
        assert (await ask(client, "stat", following("focus"), path=path, focus=focus)).status_code == 422


async def test_the_biggest_id_an_integer_column_holds_is_a_focus_that_is_simply_gone(client, db):
    await seed_tree(db)
    await login_as(client, db, "viewer")
    assert (await answer(client, "stat", following("focus"), focus=MAX_ID))["focus"] == GONE_BLOCK
    assert (await answer(client, "stat", following("focus"), focus=1))["focus"]["state"] == "ok"


# ---- who may send a focus -------------------------------------------------------------------------------------

@pytest.fixture
async def dashboards_only(client, db):
    await make_role(db, "dashboards only", ["dashboards.view"])
    await login_as(client, db, "dashboards only", username="dash")


@pytest.mark.parametrize("path", PATHS)
async def test_a_focus_needs_the_assets_tree_even_on_a_fixed_widget(client, db, dashboards_only, path):
    ids = await seed_tree(db)
    for config in (following("focus"), energy([ids["hall1"]]), following("children"), {"nonsense": True}):
        response = await ask(client, "stat", config, path=path, focus=ids["hall1"])
        assert response.status_code == 403 and response.json() == {"detail": "insufficient permission"}
    # It is the first thing looked at: a text widget, an unknown focus and a broken config get the same refusal.
    assert (await ask(client, "text", {}, path=path, focus=ids["hall1"])).status_code == 403
    assert (await ask(client, "stat", following("focus"), path=path, focus=999)).status_code == 403
    # The refusal does not depend on the type or the shape of the config: a following breakdown and a following comparison get it too.
    breakdown = {**following("focus"), "bars": "kind", "kind": "Rack"}
    compare = {**following("focus"), "compare": "same_days_last_month", "range": "this_month"}
    assert (await ask(client, "bar", breakdown, path=path, focus=ids["hall1"])).status_code == 403
    assert (await ask(client, "timeseries", compare, path=path, focus=ids["hall1"])).status_code == 403


@pytest.mark.parametrize("path", PATHS)
async def test_a_role_with_dashboards_but_not_the_assets_tree_still_gets_figures_without_a_focus(client, db, dashboards_only, path):
    ids = await seed_tree(db)
    response = await ask(client, "stat", following("focus"), path=path)  # one top-level asset: that asset
    assert response.status_code == 200, response.text
    fixed = await ask(client, "stat", energy([ids["hall1"]]), path=path)
    assert fixed.status_code == 200
    if path == "/api/widget-data":
        assert response.json()["focus"]["asset"]["id"] == ids["site"]


@pytest.mark.parametrize("path", PATHS)
async def test_a_role_with_both_permissions_can_send_a_focus(client, db, path):
    ids = await seed_tree(db)
    await make_role(db, "both", ["dashboards.view", "assets.view"])
    await login_as(client, db, "both", username="both")
    assert (await ask(client, "stat", following("focus"), path=path, focus=ids["hall1"])).status_code == 200
    await client.post("/api/logout")
    await login_as(client, db, "viewer")
    assert (await ask(client, "stat", following("focus"), path=path, focus=ids["hall1"])).status_code == 200


@pytest.mark.parametrize("path", PATHS)
async def test_a_focus_still_needs_a_session_and_dashboards_view(client, db, path):
    ids = await seed_tree(db)
    assert (await ask(client, "stat", following("focus"), path=path, focus=ids["hall1"])).status_code == 401
    await make_role(db, "assets only", ["assets.view"])
    await login_as(client, db, "assets only", username="a")
    assert (await ask(client, "stat", following("focus"), path=path, focus=ids["hall1"])).status_code == 403


# ---- the CSV ----------------------------------------------------------------------------------------------------

def rows_of(response) -> list[list[str]]:
    assert response.headers["content-type"].startswith("text/csv")
    table = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))
    assert table[0] == ["asset", "source", "unit", "timestamp", "value", "estimated", "partial", "no_data"]
    return table[1:]


async def test_the_csv_of_a_following_widget_lists_the_rows_of_the_focus_asset(client, db):
    ids = await seed_tree(db)
    await login_as(client, db, "viewer")
    path = "/api/widget-data/csv"
    one = rows_of(await ask(client, "stat", following("focus"), path=path, focus=ids["hall1"]))
    assert [(row[0], row[2], row[4]) for row in one] == [("Site / Hall 1", "kWh", "423")]
    plain = await ask(client, "stat", energy([ids["hall1"]]), path=path)
    assert rows_of(plain) == one
    kids = rows_of(await ask(client, "bar", following("children"), path=path, focus=ids["hall1"]))
    assert [row[0] for row in kids] == ["Site / Hall 1 / Rack A3", "Site / Hall 1 / Rack A1", "Site / Hall 1 / Rack A2"]
    whole = rows_of(await ask(client, "stat", following("focus"), path=path))  # one top-level asset, no focus
    assert [row[0] for row in whole] == ["Site"]
    assert (await ask(client, "stat", following("focus"), path=path, focus=999999)).status_code == 200


async def test_the_csv_of_a_following_widget_that_asks_for_a_focus_has_only_its_header(client, db):
    await seed_tree(db)
    await make_asset(db, "Annex")
    await login_as(client, db, "viewer")
    response = await ask(client, "stat", following("focus"), path="/api/widget-data/csv")
    assert response.status_code == 200 and rows_of(response) == []


# ---- stored with a dashboard --------------------------------------------------------------------------------------

async def test_a_following_widget_is_stored_with_its_scope_and_a_fixed_one_without_the_key(client, db):
    ids = await seed_tree(db)
    await login_as(client, db, "operator")
    created = (await client.post("/api/dashboards", json={"name": "Ops"})).json()

    def widget(title, config, y, widget_type="stat"):
        return {"type": widget_type, "title": title, "config": config, "x": 0, "y": y, "w": 4, "h": 3}

    async def save(widgets):
        body = {"name": "Ops", "range": created["range"], "updated_at": created["updated_at"], "widgets": widgets}
        return await client.put(f"/api/dashboards/{created['id']}", json=body)

    response = await save([
        widget("Fixed", energy([ids["hall1"]]), 0),
        widget("Following", following("focus"), 3),
        widget("Children", following("children"), 6, "table"),
    ])
    assert response.status_code == 200, response.text
    by_title = {w["title"]: w["config"] for w in response.json()["widgets"]}
    assert "scope" not in by_title["Fixed"] and by_title["Fixed"]["assets"] == [ids["hall1"]]
    assert (by_title["Following"]["scope"], by_title["Following"]["assets"]) == ("focus", [])
    assert (by_title["Children"]["scope"], by_title["Children"]["assets"]) == ("children", [])
    bad = await save([widget("Both", {**following("focus"), "assets": [ids["hall1"]]}, 0)])
    assert bad.status_code == 422 and "assets: leave the assets empty; the focus chooses them" in str(bad.json()["detail"])
