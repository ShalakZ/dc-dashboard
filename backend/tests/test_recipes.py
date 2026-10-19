"""w25: the starter "Power" dashboard (core/recipes.py) and the `recipe` of POST /api/dashboards.

The first half is pure (no database): `best_kind` and `power_widgets` over a hand-built tree. The second half creates the
dashboard through the API and checks what is stored, what is audited and that a refusal leaves nothing behind.
"""
import pytest
from helpers import login_as, make_asset, make_mapping, make_point, make_source

from dcdash.api.dashboards import GRID_COLUMNS, MAX_WIDGETS, WidgetIn, checked_configs
from dcdash.core.recipes import best_kind, power_widgets
from dcdash.core.tree import AssetNode, AssetTree
from dcdash.core.widgets import KIND_MAX, validate_config

LAYOUT = [  # (type, title, x, y, w, h) with the bar's title filled in for a Panel site
    ("text", "Power use and cost", 0, 0, 12, 1),
    ("stat", "Energy this month", 0, 1, 3, 3),
    ("stat", "Cost this month", 3, 1, 3, 3),
    ("bar", "Energy by panel", 6, 1, 6, 3),
    ("timeseries", "Energy by day, against last month", 0, 4, 12, 4),
]


def world(*assets: tuple[str, str, bool], parent: bool = True) -> tuple[AssetTree, dict[int, str], set[int]]:
    """A tree of one Site and `assets` (name, kind, has its own meter) under it, the kinds by id and the metered ids.
    Ids start at 1 for the Site, then 2, 3 and so on in the order given."""
    nodes = [AssetNode(1, None, "Site", 0)]
    kinds = {1: "Site"}
    metered: set[int] = set()
    for number, (name, kind, has_meter) in enumerate(assets, start=2):
        nodes.append(AssetNode(number, 1 if parent else None, name, number))
        kinds[number] = kind
        if has_meter:
            metered.add(number)
    return AssetTree(nodes), kinds, metered


# ---- best_kind ------------------------------------------------------------------------------------------------------


def test_panels_with_their_own_meter_make_the_kind_panel():
    tree, kinds, metered = world(("P1", "Panel", True), ("P2", "Panel", True), ("F1", "Feed", True), ("F2", "Feed", True),
                                 ("F3", "Feed", True))
    assert best_kind(tree, kinds, metered) == "Panel"  # Panel wins even though Feed has more meters


def test_one_metered_panel_among_many_metered_feeds_is_enough():
    tree, kinds, metered = world(("P1", "Panel", True), ("P2", "Panel", False), *[(f"F{n}", "Feed", True) for n in range(6)])
    assert best_kind(tree, kinds, metered) == "Panel"


def test_a_meter_that_only_reports_power_counts_like_any_other():
    # `metered` is the set of assets with a meter of any sort (load_meters: a kWh counter, else a kW reading); the recipe
    # cannot tell the two apart and does not need to.
    tree, kinds, metered = world(("P1", "Panel", True), ("P2", "Panel", False))
    assert best_kind(tree, kinds, metered) == "Panel"


def test_only_the_feeds_are_metered_gives_the_feeds_kind():
    tree, kinds, metered = world(("P1", "Panel", False), ("F1", "Feed", True), ("F2", "Feed", True), ("R1", "Rack", False))
    assert best_kind(tree, kinds, metered) == "Feed"


def test_the_kind_with_the_most_meters_wins():
    tree, kinds, metered = world(("F1", "Feed", True), ("R1", "Rack", True), ("R2", "Rack", True), ("R3", "Rack", False))
    assert best_kind(tree, kinds, metered) == "Rack"


def test_a_tie_between_two_kinds_goes_to_the_alphabetical_key():
    tree, kinds, metered = world(("R1", "Rack", True), ("F1", "Feed", True), ("U1", "UPS", True))
    assert best_kind(tree, kinds, metered) == "Feed"
    tree, kinds, metered = world(("R1", "rack", True), ("F1", "Zone feed", True))
    assert best_kind(tree, kinds, metered) == "rack"  # the key is compared, so "rack" < "zone feed"


def test_no_meter_at_all_gives_panel():
    tree, kinds, metered = world(("F1", "Feed", False), ("R1", "Rack", False))
    assert best_kind(tree, kinds, metered) == "Panel"


def test_an_empty_tree_gives_panel():
    assert best_kind(AssetTree([]), {}, set()) == "Panel"


def test_a_meter_on_the_site_alone_is_not_special():
    tree, kinds, metered = world(("F1", "Feed", False))
    assert best_kind(tree, kinds, {1}) == "Site"  # the root is an asset like any other; the empty breakdown says so on the card


def test_spelling_variants_are_one_kind_shown_in_the_most_common_spelling():
    tree, kinds, metered = world(("P1", "panel", True), ("P2", "panel", True), ("P3", "Panel", True), ("P4", " PANEL ", False))
    assert best_kind(tree, kinds, metered) == "panel"
    tree, kinds, metered = world(("F1", "feed", True), ("F2", "Feed", True), ("F3", "Feed", True), ("R1", "Rack", True))
    assert best_kind(tree, kinds, metered) == "Feed"  # three feeds against one rack; "Feed" is the commoner spelling


def test_variants_add_up_before_kinds_are_compared():
    tree, kinds, metered = world(("F1", "Feed", True), ("F2", "feed", True), ("R1", "Rack", True), ("R2", "Rack", True),
                                 ("R3", "Rack", False))
    assert best_kind(tree, kinds, metered) == "Feed"  # 2 feeds under one key and 2 racks tie; "feed" < "rack"


def test_blank_and_too_long_kinds_are_ignored():
    blank = "  \t"
    too_long = "K" * (KIND_MAX + 1)
    tree, kinds, metered = world(("A", blank, True), ("B", blank, True), ("C", too_long, True), ("D", too_long, True),
                                 ("F1", "Feed", True))
    assert best_kind(tree, kinds, metered) == "Feed"
    tree, kinds, metered = world(("A", blank, True), ("C", too_long, True))
    assert best_kind(tree, kinds, metered) == "Panel"
    exact = "K" * KIND_MAX
    tree, kinds, metered = world(("E", exact, True))
    assert best_kind(tree, kinds, metered) == exact


def test_an_asset_outside_the_tree_or_without_a_kind_is_not_counted():
    tree, kinds, metered = world(("F1", "Feed", True))
    kinds[99] = "Rack"  # not in the tree
    kinds.pop(2)  # F1 has no kind text now
    assert best_kind(tree, kinds, metered | {99}) == "Panel"


# ---- power_widgets --------------------------------------------------------------------------------------------------


def rectangles_overlap(a: dict, b: dict) -> bool:
    return a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"] and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"]


def test_the_starter_is_five_widgets_in_the_agreed_layout():
    widgets = power_widgets(*world(("P1", "Panel", True)))
    assert [(w["type"], w["title"], w["x"], w["y"], w["w"], w["h"]) for w in widgets] == LAYOUT
    assert all(set(w) == {"type", "title", "config", "x", "y", "w", "h"} for w in widgets)


def test_the_heading_is_a_plain_text_widget():
    heading = power_widgets(*world())[0]
    assert heading["config"] == {"style": "heading", "text": "Power use and cost"}


def test_every_widget_but_the_heading_follows_the_focus():
    for widget in power_widgets(*world())[1:]:
        assert widget["config"]["scope"] == "focus" and widget["config"]["assets"] == [], widget["title"]


def test_the_two_stats_and_the_chart_compare_with_the_same_days_of_last_month():
    widgets = {w["title"]: w["config"] for w in power_widgets(*world())}
    for title in ("Energy this month", "Cost this month", "Energy by day, against last month"):
        config = widgets[title]
        assert config["range"] == "this_month" and config["compare"] == "same_days_last_month", title
        assert config["aggregation"] == "sum"
    assert widgets["Energy this month"]["source"] == "energy"
    assert widgets["Cost this month"]["source"] == "cost"
    assert widgets["Energy by day, against last month"]["source"] == "energy"


def test_the_bar_is_a_breakdown_of_energy_by_the_best_kind_that_inherits_the_range():
    tree, kinds, metered = world(("F1", "Feed", True), ("F2", "Feed", True))
    bar = power_widgets(tree, kinds, metered)[3]
    assert bar["type"] == "bar" and bar["title"] == "Energy by feed"
    config = bar["config"]
    assert config["bars"] == "kind" and config["kind"] == "Feed" and config["source"] == "energy"
    assert config["range"] is None and "root" not in config and "top" not in config


def test_every_config_passes_the_server_checks():
    for built in (world(), world(("P1", "Panel", True)), world(("F1", "Feed", True)), world(("R1", "Rack", False))):
        for widget in power_widgets(*built):
            validate_config(widget["type"], widget["config"])
        checked_configs([WidgetIn(**widget) for widget in power_widgets(*built)])  # the title rules and the grid too


def test_an_empty_tree_still_gets_all_five_widgets_with_the_kind_panel():
    widgets = power_widgets(AssetTree([]), {}, set())
    assert [w["title"] for w in widgets] == [row[1] for row in LAYOUT]
    assert widgets[3]["config"]["kind"] == "Panel"


def test_the_widgets_fit_the_grid_and_do_not_overlap():
    widgets = power_widgets(*world(("P1", "Panel", True)))
    assert 0 < len(widgets) <= MAX_WIDGETS
    for widget in widgets:
        assert widget["x"] + widget["w"] <= GRID_COLUMNS
    for index, first in enumerate(widgets):
        for second in widgets[index + 1:]:
            assert not rectangles_overlap(first, second), (first["title"], second["title"])


def test_titles_stay_within_a_title_even_for_a_long_or_odd_kind():
    for kind in ("K" * KIND_MAX, "Line\nbreak"):
        tree, kinds, metered = world(("A", kind, True))
        widgets = power_widgets(tree, kinds, metered)
        assert all(len(w["title"]) <= 100 for w in widgets), kind
        checked_configs([WidgetIn(**widget) for widget in widgets])  # never a 422 that a person cannot fix
    assert power_widgets(*world(("A", "Rack", True)))[3]["title"] == "Energy by rack"


def test_the_recipe_hands_out_fresh_dicts():
    first = power_widgets(*world())
    first[1]["config"]["scope"] = "fixed"
    assert power_widgets(*world())[1]["config"]["scope"] == "focus"


# ---- creating it through the API ------------------------------------------------------------------------------------


async def seed(db, *kind_and_meter: tuple[str, str, bool]) -> list[int]:
    """A Site and, under it, assets of the given (name, kind, has a kWh counter) in order; returns their ids."""
    site = await make_asset(db, "Site")
    source = await make_source(db)
    ids = []
    for name, kind, has_meter in kind_and_meter:
        asset = await make_asset(db, name, site)
        await db.execute("UPDATE assets SET kind = $2 WHERE id = $1", asset, kind)
        if has_meter:
            await make_mapping(db, await make_point(db, source, f"{name}_kWh"), asset, "energy_kwh", 60)
        ids.append(asset)
    return ids


async def power(client, name="Power", **extra):
    return await client.post("/api/dashboards", json={"name": name, "recipe": "power", **extra})


async def created_rows(db):
    return await db.fetch("SELECT user_id, detail FROM audit_log WHERE action = 'dashboard.created' ORDER BY id")


async def test_a_power_dashboard_is_made_with_its_five_widgets(client, db):
    await login_as(client, db, "operator")
    await seed(db, ("Panel A", "Panel", True), ("Panel B", "Panel", True), ("Feed A", "Feed", True))
    response = await power(client)
    assert response.status_code == 201, response.text
    dash = response.json()
    assert dash["name"] == "Power" and dash["range"] == "this_month"
    assert [(w["type"], w["title"], w["x"], w["y"], w["w"], w["h"]) for w in dash["widgets"]] == LAYOUT
    again = (await client.get(f"/api/dashboards/{dash['id']}")).json()
    assert again == dash  # what was answered is what is stored


async def test_the_stored_configs_are_the_validated_dumps(client, db):
    await login_as(client, db, "operator")
    await seed(db, ("Panel A", "Panel", True))
    dash = (await power(client)).json()
    by_title = {w["title"]: w["config"] for w in dash["widgets"]}
    for widget in dash["widgets"]:
        assert widget["config"] == validate_config(widget["type"], widget["config"]).model_dump(mode="json")
    stat = by_title["Energy this month"]
    assert stat["scope"] == "focus" and stat["assets"] == []
    assert "root" not in by_title["Energy by panel"] and "top" not in by_title["Energy by panel"]  # defaults are left out
    assert "scope" not in by_title["Power use and cost"]
    rows = await db.fetch("SELECT config FROM widgets WHERE dashboard_id = $1 ORDER BY y, x", dash["id"])
    assert [row["config"] for row in rows] == [w["config"] for w in dash["widgets"]]


async def test_the_bar_looks_for_the_kind_the_site_meters(client, db):
    await login_as(client, db, "operator")
    await seed(db, ("Panel A", "Panel", False), ("Feed A", "Feed", True), ("Feed B", "feed", True))
    dash = (await power(client)).json()
    bar = next(w for w in dash["widgets"] if w["type"] == "bar")
    assert bar["title"] == "Energy by feed" and bar["config"]["kind"] == "Feed"


async def test_an_empty_site_still_gets_the_dashboard(client, db):
    await login_as(client, db, "operator")
    response = await power(client)
    assert response.status_code == 201, response.text
    widgets = response.json()["widgets"]
    assert len(widgets) == 5 and widgets[3]["title"] == "Energy by panel"


async def test_one_audit_row_names_the_recipe_and_the_real_widget_count(client, db):
    await login_as(client, db, "operator")
    operator = await db.fetchval("SELECT id FROM users WHERE username = 'operator'")
    await seed(db, ("Panel A", "Panel", True))
    dash = (await power(client)).json()
    rows = await created_rows(db)
    assert len(rows) == 1 and rows[0]["user_id"] == operator
    assert rows[0]["detail"] == {"dashboard_id": dash["id"], "name": "Power", "widgets": 5, "recipe": "power"}


async def test_a_blank_dashboard_is_audited_exactly_as_before(client, db):
    await login_as(client, db, "operator")
    response = await client.post("/api/dashboards", json={"name": "Ops"})
    assert response.status_code == 201
    dash = response.json()
    assert dash["range"] == "24h" and dash["widgets"] == []
    rows = await created_rows(db)
    assert [row["detail"] for row in rows] == [{"dashboard_id": dash["id"], "name": "Ops", "widgets": 0}]
    nothing = await client.post("/api/dashboards", json={"name": "Ops 2", "recipe": None})
    assert nothing.status_code == 201 and nothing.json()["widgets"] == [] and nothing.json()["range"] == "24h"


async def test_the_range_is_this_month_unless_the_body_says_otherwise(client, db):
    await login_as(client, db, "operator")
    assert (await power(client, "A")).json()["range"] == "this_month"
    assert (await power(client, "B", range="7d")).json()["range"] == "7d"
    assert (await power(client, "C", range="24h")).json()["range"] == "24h"  # the old default, but asked for
    assert (await client.post("/api/dashboards", json={"name": "D"})).json()["range"] == "24h"
    assert (await power(client, "E", range="nonsense")).status_code == 422


async def test_two_power_dashboards_need_two_names(client, db):
    await login_as(client, db, "operator")
    assert (await power(client)).status_code == 201
    taken = await power(client)
    assert taken.status_code == 409 and "already exists" in taken.json()["detail"]
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 1
    assert await db.fetchval("SELECT count(*) FROM widgets") == 5  # the refused one added none
    assert len(await created_rows(db)) == 1


async def test_the_dashboard_cap_still_applies_and_leaves_no_widgets(client, db):
    await login_as(client, db, "operator")
    await db.executemany("INSERT INTO dashboards (name) VALUES ($1)", [(f"Seed {n:02d}",) for n in range(50)])
    response = await power(client)
    assert response.status_code == 422 and "50" in response.json()["detail"]
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 50
    assert await db.fetchval("SELECT count(*) FROM widgets") == 0
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'dashboard.created'") == 0


async def test_a_widget_that_fails_the_checks_leaves_no_dashboard_behind(client, db, monkeypatch):
    await login_as(client, db, "operator")
    broken = power_widgets(AssetTree([]), {}, set())
    broken[2]["config"]["aggregation"] = "avg"  # a cost cannot be averaged
    monkeypatch.setattr("dcdash.api.dashboards.power_widgets", lambda *_args: broken)
    response = await power(client)
    assert response.status_code == 422 and "aggregation" in response.json()["detail"]
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 0
    assert await db.fetchval("SELECT count(*) FROM widgets") == 0
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'dashboard.created'") == 0


async def test_an_error_after_the_rows_are_added_takes_them_all_back(client, db, monkeypatch):
    await login_as(client, db, "operator")

    async def broken_audit(*_args, **_kwargs):
        raise RuntimeError("the audit write failed")

    monkeypatch.setattr("dcdash.api.dashboards.audit", broken_audit)
    with pytest.raises(RuntimeError):
        await power(client)
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 0
    assert await db.fetchval("SELECT count(*) FROM widgets") == 0


async def test_a_viewer_cannot_make_one(client, db):
    await login_as(client, db, "viewer")
    assert (await power(client)).status_code == 403
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 0


async def test_an_unknown_recipe_is_a_422(client, db):
    await login_as(client, db, "operator")
    for recipe in ("solar", "Power", "", 1, ["power"]):
        response = await client.post("/api/dashboards", json={"name": "X", "recipe": recipe})
        assert response.status_code == 422, recipe
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 0

