"""w27: the dashboard templates (core/recipes.py) and `GET /api/dashboard-templates`.

The first half is pure: every recipe passes the checks a save runs on an empty tree, a pilot-hall-shaped tree and a
panels-shaped one, and `template_catalog` recommends what is true of the site (D6). The second half goes through the API: the
catalog's widget list is the list a create stores, position by position, and the route is gated by `dashboards.edit`.
"""
import json
from datetime import date, timedelta

import pytest
from billing_helpers import add_tariff, set_zone
from helpers import login_as, make_asset, make_mapping, make_point, make_role, make_source

from dcdash.api.dashboards import WidgetIn, checked_configs
from dcdash.core.cost import TariffRow
from dcdash.core.recipes import RECIPES, recipe_range, recipe_widgets, template_catalog
from dcdash.core.tree import AssetNode, AssetTree

TODAY = date(2026, 10, 20)
NEEDS_RATE = "Needs a rate in Tariffs."
NEEDS_AREAS = "Needs at least two areas with a meter."
PREVIEW_KEYS = {"type", "x", "y", "w", "h", "source", "compare", "bars", "scope"}
TEMPLATE_KEYS = {"id", "title", "description", "range", "recommended", "needs", "widgets"}

# id, parent id, name, kind: a small pilot hall (a site, two halls with racks, an electrical room with panels)
PILOT_ROWS = [
    (1, None, "Site", "Site"), (2, 1, "Hall 1", "Hall"), (3, 1, "Hall 2", "Hall"), (4, 1, "Electrical", "Electrical"),
    (5, 2, "Rack 01", "Rack"), (6, 2, "Rack 02", "Rack"), (7, 3, "Rack 01", "Rack"), (8, 3, "Rack 02", "Rack"),
    (9, 4, "Panel 1A", "Panel"), (10, 4, "Panel 1B", "Panel"),
]


def tree_of(rows) -> tuple[AssetTree, dict[int, str]]:
    return AssetTree([AssetNode(i, parent, name, i) for i, parent, name, _ in rows]), {i: kind for i, _, _, kind in rows}


def pilot():
    tree, kinds = tree_of(PILOT_ROWS)
    return tree, kinds, {5, 6, 7, 8, 9, 10}


def panels():
    """The same tree where only the electrical room carries meters (`--metering panels`)."""
    tree, kinds = tree_of(PILOT_ROWS)
    return tree, kinds, {9, 10}


def empty():
    return AssetTree([]), {}, set()


def catalog(shape, tariffs=(), today=TODAY) -> dict:
    tree, kinds, metered = shape
    return template_catalog(tree, kinds, metered, list(tariffs), today)


def by_id(result: dict) -> dict[str, dict]:
    return {template["id"]: template for template in result["templates"]}


def site_rate(day="2000-01-01") -> TariffRow:
    return TariffRow(None, 0.1, date.fromisoformat(day))


def of_asset(asset_id: int, day="2000-01-01") -> TariffRow:
    return TariffRow(asset_id, 0.2, date.fromisoformat(day))


# ---- the recipes ----------------------------------------------------------------------------------------------------


def test_the_recipes_are_these_four_in_this_order():
    assert RECIPES == ("power", "cost", "areas", "day")


@pytest.mark.parametrize("recipe", RECIPES)
@pytest.mark.parametrize("shape", [empty, pilot, panels], ids=["empty", "pilot", "panels"])
def test_every_recipe_passes_the_checks_a_save_runs(recipe, shape):
    widgets = recipe_widgets(recipe, *shape())
    assert 0 < len(widgets) <= 24
    configs = checked_configs([WidgetIn(**widget) for widget in widgets])
    assert len(configs) == len(widgets)
    assert all(len(widget["title"]) <= 100 for widget in widgets)


@pytest.mark.parametrize("recipe", RECIPES)
def test_the_widgets_fit_the_grid_and_do_not_overlap(recipe):
    widgets = recipe_widgets(recipe, *pilot())
    for widget in widgets:
        assert widget["x"] + widget["w"] <= 12
    for index, first in enumerate(widgets):
        for second in widgets[index + 1:]:
            apart = (
                first["x"] + first["w"] <= second["x"] or second["x"] + second["w"] <= first["x"]
                or first["y"] + first["h"] <= second["y"] or second["y"] + second["h"] <= first["y"]
            )
            assert apart, (recipe, first["title"], second["title"])


@pytest.mark.parametrize("recipe", RECIPES)
def test_no_card_title_repeats_and_none_equals_the_heading(recipe):
    titles = [widget["title"] for widget in recipe_widgets(recipe, *pilot())]
    assert len(titles) == len(set(titles))


def test_an_unknown_recipe_is_refused():
    with pytest.raises(ValueError):
        recipe_widgets("solar", *empty())


def test_recipe_widgets_hands_out_fresh_dicts():
    first = recipe_widgets("cost", *pilot())
    first[1]["config"]["scope"] = "fixed"
    assert recipe_widgets("cost", *pilot())[1]["config"]["scope"] == "focus"


def test_the_range_of_a_new_dashboard_is_this_month_except_for_the_last_24_hours():
    assert [recipe_range(recipe) for recipe in RECIPES] == ["this_month", "this_month", "this_month", "24h"]


def test_the_cost_template_layout():
    widgets = recipe_widgets("cost", *pilot())
    assert [(w["type"], w["title"], w["x"], w["y"], w["w"], w["h"]) for w in widgets] == [
        ("text", "Cost and where it goes", 0, 0, 12, 1),
        ("stat", "Cost", 0, 1, 3, 3),
        ("bar", "Cost by Panel", 3, 1, 9, 3),  # a Panel wins as soon as one has a meter
        ("timeseries", "Cost by day, against last month", 0, 4, 12, 4),
        ("table", "Cost by area", 0, 8, 12, 4),
    ]
    stat, bar, series, table = (w["config"] for w in widgets[1:])
    for config in (stat, bar, series, table):
        assert config["source"] == "cost" and config["assets"] == []
    for config in (stat, series):
        assert config["range"] == "this_month" and config["compare"] == "same_days_last_month" and config["scope"] == "focus"
    assert bar["bars"] == "kind" and bar["kind"] == "Panel" and bar["scope"] == "focus" and bar["range"] is None
    assert table["scope"] == "children" and table["range"] is None and table["bars"] == "asset"


def test_the_areas_template_layout():
    widgets = recipe_widgets("areas", *pilot())
    assert [(w["type"], w["title"], w["x"], w["y"], w["w"], w["h"]) for w in widgets] == [
        ("text", "Where the energy goes", 0, 0, 12, 1),
        ("table", "Energy by area", 0, 1, 6, 4),
        ("bar", "Energy per area", 6, 1, 6, 4),
        ("timeseries", "Energy by day", 0, 5, 12, 4),
    ]
    for widget in widgets[1:]:
        config = widget["config"]
        assert config["source"] == "energy" and config["scope"] == "children" and config["range"] is None
        assert config.get("compare", "none") == "none"
    assert widgets[2]["config"]["bars"] == "asset"


def test_the_last_24_hours_template_layout():
    widgets = recipe_widgets("day", *pilot())
    assert [(w["type"], w["title"], w["x"], w["y"], w["w"], w["h"]) for w in widgets] == [
        ("text", "Last 24 hours", 0, 0, 12, 1),
        ("timeseries", "Energy per hour", 0, 1, 12, 4),
        ("table", "Energy by area", 0, 5, 12, 4),
    ]
    series, table = widgets[1]["config"], widgets[2]["config"]
    assert series["scope"] == "focus" and series["range"] == "24h" and series["source"] == "energy"
    assert table["scope"] == "children" and table["range"] == "24h" and table["source"] == "energy"
    assert all("power" not in widget["title"].lower() for widget in widgets)


def test_the_cost_breakdown_uses_the_best_kind_and_a_title_that_always_saves():
    tree, kinds = tree_of([(1, None, "Site", "Site"), (2, 1, "F1", "Feed")])
    assert recipe_widgets("cost", tree, kinds, {2})[2]["title"] == "Cost by Feed"
    assert recipe_widgets("cost", *empty())[2]["title"] == "Cost by Panel"
    for kind in ("K" * 100, "Line\nbreak"):
        tree, kinds = tree_of([(1, None, "Site", "Site"), (2, 1, "A", kind)])
        widgets = recipe_widgets("cost", tree, kinds, {2})
        assert widgets[2]["title"] == "Cost by kind"
        checked_configs([WidgetIn(**widget) for widget in widgets])  # never a 422 that a person cannot fix


# ---- the catalog: its shape -----------------------------------------------------------------------------------------


def test_the_catalog_lists_power_cost_areas_day_with_plain_text():
    result = catalog(pilot(), [site_rate()])
    assert set(result) == {"nothing_metered", "templates"}
    assert [template["id"] for template in result["templates"]] == ["power", "cost", "areas", "day"]
    assert [template["title"] for template in result["templates"]] == ["Power", "Cost", "Energy by area", "Last 24 hours"]
    for template in result["templates"]:
        assert set(template) == TEMPLATE_KEYS
        assert 10 < len(template["description"]) <= 120 and template["description"].isprintable()
        assert all(set(widget) == PREVIEW_KEYS for widget in template["widgets"])
    assert [template["range"] for template in result["templates"]] == ["this_month", "this_month", "this_month", "24h"]
    json.dumps(result)  # plain data, ready for the response model


def test_the_preview_is_the_widget_list_a_create_uses():
    shape = pilot()
    for template in catalog(shape, [site_rate()])["templates"]:
        built = recipe_widgets(template["id"], *shape)
        assert [(w["type"], w["x"], w["y"], w["w"], w["h"]) for w in template["widgets"]] == [
            (w["type"], w["x"], w["y"], w["w"], w["h"]) for w in built
        ]
        config_of = [w["config"] for w in built]
        assert [w["source"] for w in template["widgets"]] == [c.get("source") for c in config_of]
        assert [w["compare"] for w in template["widgets"]] == [c.get("compare", "none") for c in config_of]
        assert [w["bars"] for w in template["widgets"]] == [c.get("bars", "asset") for c in config_of]
        assert [w["scope"] for w in template["widgets"]] == [c.get("scope", "fixed") for c in config_of]


def test_a_text_widget_previews_with_no_source_and_the_plain_defaults():
    for template in catalog(pilot())["templates"]:
        heading = template["widgets"][0]
        assert heading["type"] == "text"
        assert (heading["source"], heading["compare"], heading["bars"], heading["scope"]) == (None, "none", "asset", "fixed")
        assert all(widget["source"] in ("metric", "energy", "cost") for widget in template["widgets"][1:])


def test_the_power_preview_shows_the_comparisons_and_the_breakdown():
    widgets = by_id(catalog(pilot()))["power"]["widgets"]
    assert [(w["type"], w["source"], w["compare"], w["bars"], w["scope"]) for w in widgets] == [
        ("text", None, "none", "asset", "fixed"),
        ("stat", "energy", "same_days_last_month", "asset", "focus"),
        ("stat", "cost", "same_days_last_month", "asset", "focus"),
        ("bar", "energy", "none", "kind", "focus"),
        ("timeseries", "energy", "same_days_last_month", "asset", "focus"),
    ]


# ---- the catalog: what is recommended -------------------------------------------------------------------------------


def tags(result: dict) -> dict[str, tuple[bool, str | None]]:
    return {template["id"]: (template["recommended"], template["needs"]) for template in result["templates"]}


def test_nothing_metered_recommends_nothing_and_asks_for_nothing():
    for shape in (empty(), (pilot()[0], pilot()[1], set())):
        result = catalog(shape, [site_rate()])
        assert result["nothing_metered"] is True
        assert tags(result) == {recipe: (False, None) for recipe in RECIPES}


def test_a_meter_id_outside_the_tree_is_not_a_meter():
    tree, kinds, _ = pilot()
    result = catalog((tree, kinds, {99, 100}), [site_rate()])
    assert result["nothing_metered"] is True and not any(t["recommended"] for t in result["templates"])


def test_power_is_recommended_as_soon_as_anything_is_metered():
    tree, kinds, _ = pilot()
    result = catalog((tree, kinds, {5}))
    assert result["nothing_metered"] is False
    assert tags(result)["power"] == (True, None)


def test_the_last_24_hours_is_never_recommended():
    for shape in (empty(), pilot(), panels()):
        assert tags(catalog(shape, [site_rate()]))["day"] == (False, None)


def test_cost_needs_a_rate_somewhere_a_meter_can_use_it():
    assert tags(catalog(pilot()))["cost"] == (False, NEEDS_RATE)
    assert tags(catalog(pilot(), [site_rate()]))["cost"] == (True, None)  # the site default counts
    assert tags(catalog(pilot(), [of_asset(5)]))["cost"] == (True, None)  # a rate for one metered asset
    assert tags(catalog(pilot(), [of_asset(2)]))["cost"] == (True, None)  # a rate on a hall covers the racks under it


def test_a_rate_on_an_unmetered_branch_does_not_count():
    # Only the electrical panels (9, 10) are metered; a rate for Hall 1 and for the site's other branches covers none of them.
    assert tags(catalog(panels(), [of_asset(2), of_asset(3), of_asset(5)]))["cost"] == (False, NEEDS_RATE)
    assert tags(catalog(panels(), [of_asset(4)]))["cost"] == (True, None)  # the electrical room covers its panels
    assert tags(catalog(panels(), [of_asset(9)]))["cost"] == (True, None)


def test_a_rate_that_has_not_started_does_not_count():
    tomorrow = (TODAY + timedelta(days=1)).isoformat()
    assert tags(catalog(pilot(), [site_rate(tomorrow)]))["cost"] == (False, NEEDS_RATE)
    assert tags(catalog(pilot(), [of_asset(5, tomorrow)]))["cost"] == (False, NEEDS_RATE)
    assert tags(catalog(pilot(), [site_rate(TODAY.isoformat())]))["cost"] == (True, None)  # in effect from today
    assert tags(catalog(pilot(), [site_rate(tomorrow)], today=TODAY + timedelta(days=1)))["cost"] == (True, None)


def test_areas_on_the_pilot_hall_and_not_on_the_panels_layout():
    assert tags(catalog(pilot()))["areas"] == (True, None)  # Hall 1, Hall 2 and Electrical, each with a meter under it
    assert tags(catalog(panels()))["areas"] == (False, NEEDS_AREAS)  # only Electrical carries meters


def shape_of(rows, metered):
    tree, kinds = tree_of(rows)
    return tree, kinds, set(metered)


@pytest.mark.parametrize(
    ("rows", "metered", "expected"),
    [
        # a sole top-level asset: its children are the areas
        ([(1, None, "S", "Site"), (2, 1, "A", "Hall"), (3, 1, "B", "Hall")], {2}, False),  # one child with a meter
        ([(1, None, "S", "Site"), (2, 1, "A", "Hall"), (3, 1, "B", "Hall")], {2, 3}, True),
        ([(1, None, "S", "Site"), (2, 1, "A", "Hall"), (3, 1, "B", "Hall")], {1}, False),  # the site's own meter is not a child
        ([(1, None, "S", "Site"), (2, 1, "A", "Hall"), (3, 1, "B", "Hall")], {1, 2}, False),
        ([(1, None, "S", "Site"), (2, 1, "A", "Hall"), (3, 1, "B", "Hall"), (4, 1, "C", "Hall")], {2, 3, 4}, True),
        ([(1, None, "S", "Site"), (2, 1, "A", "Hall")], {2}, False),  # one child only
        # metered grandchildren count for their child
        ([(1, None, "S", "Site"), (2, 1, "A", "Hall"), (3, 1, "B", "Hall"), (4, 2, "a", "Rack"), (5, 3, "b", "Rack")], {4, 5}, True),
        ([(1, None, "S", "Site"), (2, 1, "A", "Hall"), (3, 1, "B", "Hall"), (4, 2, "a", "Rack"), (5, 2, "b", "Rack")], {4, 5}, False),
        # no single top-level asset: the top-level assets themselves are the areas
        ([(1, None, "A", "Site"), (2, None, "B", "Site")], {1}, False),
        ([(1, None, "A", "Site"), (2, None, "B", "Site")], {1, 2}, True),
        ([(1, None, "A", "Site"), (2, None, "B", "Site"), (3, None, "C", "Site")], {2, 3}, True),
        ([(1, None, "A", "Site"), (2, None, "B", "Site"), (3, 1, "a", "Hall"), (4, 1, "b", "Hall")], {3, 4}, False),  # both under A
        ([(1, None, "A", "Site"), (2, None, "B", "Site"), (3, 1, "a", "Hall"), (4, 2, "b", "Hall")], {3, 4}, True),
    ],
)
def test_areas_counts_children_with_a_meter_at_or_under_them(rows, metered, expected):
    recommended, needs = tags(catalog(shape_of(rows, metered)))["areas"]
    assert recommended is expected
    assert needs == (None if expected else NEEDS_AREAS)


def test_areas_only_counts_the_children_a_card_would_show():
    # The card lists at most 20 children; metered areas past the twentieth are not on it.
    rows = [(1, None, "S", "Site")] + [(n, 1, f"Area {n:02d}", "Hall") for n in range(2, 30)]
    assert tags(catalog(shape_of(rows, {22, 23})))["areas"] == (False, NEEDS_AREAS)
    assert tags(catalog(shape_of(rows, {2, 23})))["areas"] == (False, NEEDS_AREAS)
    assert tags(catalog(shape_of(rows, {2, 3})))["areas"] == (True, None)


def test_the_pilot_hall_is_tagged_power_cost_and_areas_and_the_panels_layout_power_and_cost():
    assert tags(catalog(pilot(), [site_rate()])) == {
        "power": (True, None), "cost": (True, None), "areas": (True, None), "day": (False, None),
    }
    assert tags(catalog(panels(), [site_rate()])) == {
        "power": (True, None), "cost": (True, None), "areas": (False, NEEDS_AREAS), "day": (False, None),
    }


# ---- through the API ------------------------------------------------------------------------------------------------


async def seed_pilot(db) -> dict[int, int]:
    """The PILOT_ROWS in the database (ids differ from the rows' numbers); every leaf has a kWh counter. Returns row -> id."""
    source = await make_source(db)
    ids: dict[int, int] = {}
    for number, parent, name, kind in PILOT_ROWS:
        ids[number] = await make_asset(db, name, ids[parent] if parent else None)
        await db.execute("UPDATE assets SET kind = $2 WHERE id = $1", ids[number], kind)
        if number >= 5:
            await make_mapping(db, await make_point(db, source, f"{name}-{number}_kWh"), ids[number], "energy_kwh", 60)
    return ids


async def get_templates(client):
    return await client.get("/api/dashboard-templates")


def preview_of(widget: dict) -> tuple:
    config = widget["config"]
    return (
        widget["type"], widget["x"], widget["y"], widget["w"], widget["h"], config.get("source"),
        config.get("compare", "none"), config.get("bars", "asset"), config.get("scope", "fixed"),
    )


async def test_the_route_answers_the_catalog_for_this_site(client, db):
    await login_as(client, db, "operator")
    await seed_pilot(db)
    await add_tariff(db, 0.1, "2000-01-01")
    response = await get_templates(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["nothing_metered"] is False
    assert [t["id"] for t in body["templates"]] == ["power", "cost", "areas", "day"]
    assert {t["id"]: t["recommended"] for t in body["templates"]} == {"power": True, "cost": True, "areas": True, "day": False}
    assert all(set(t) == TEMPLATE_KEYS for t in body["templates"])
    assert all(set(w) == PREVIEW_KEYS for t in body["templates"] for w in t["widgets"])


async def test_an_empty_site_says_nothing_is_metered(client, db):
    await login_as(client, db, "operator")
    body = (await get_templates(client)).json()
    assert body["nothing_metered"] is True
    assert [(t["recommended"], t["needs"]) for t in body["templates"]] == [(False, None)] * 4
    assert all(t["widgets"] for t in body["templates"])  # the previews still draw


async def test_without_a_rate_cost_asks_for_one(client, db):
    await login_as(client, db, "operator")
    await seed_pilot(db)
    cost = by_id(( await get_templates(client)).json())["cost"]
    assert cost["recommended"] is False and cost["needs"] == NEEDS_RATE


async def test_a_rate_is_read_on_the_sites_own_date(client, db):
    # Etc/GMT+12 is 12 hours behind UTC and Pacific/Kiritimati 14 hours ahead: their dates differ by one or two days at any
    # moment, so a rate that starts on Kiritimati's date has not started yet in Etc/GMT+12 and has in Kiritimati.
    from datetime import UTC, datetime
    from zoneinfo import ZoneInfo

    await login_as(client, db, "admin")
    await seed_pilot(db)
    ahead = datetime.now(UTC).astimezone(ZoneInfo("Pacific/Kiritimati")).date().isoformat()
    await add_tariff(db, 0.1, ahead)
    await set_zone(db, "Etc/GMT+12")
    assert by_id((await get_templates(client)).json())["cost"]["recommended"] is False
    await set_zone(db, "Pacific/Kiritimati")
    assert by_id((await get_templates(client)).json())["cost"]["recommended"] is True


async def test_a_viewer_and_a_dashboards_view_role_are_refused_and_an_anonymous_caller_is_not_known(client, db):
    assert (await get_templates(client)).status_code == 401
    await login_as(client, db, "viewer")
    assert (await get_templates(client)).status_code == 403
    await make_role(db, "only dashboards", ["dashboards.view"])
    await login_as(client, db, "only dashboards", username="reader")
    assert (await get_templates(client)).status_code == 403


async def test_an_operator_and_an_admin_may_read_them(client, db):
    await login_as(client, db, "operator")
    assert (await get_templates(client)).status_code == 200
    await login_as(client, db, "admin")
    assert (await get_templates(client)).status_code == 200


@pytest.mark.parametrize("recipe", RECIPES)
async def test_the_created_widgets_are_the_previewed_ones_position_by_position(client, db, recipe):
    await login_as(client, db, "operator")
    await seed_pilot(db)
    template = by_id((await get_templates(client)).json())[recipe]
    response = await client.post("/api/dashboards", json={"name": f"From {recipe}", "recipe": recipe})
    assert response.status_code == 201, response.text
    dash = response.json()
    created = sorted(dash["widgets"], key=lambda w: (w["y"], w["x"]))
    preview = [
        (w["type"], w["x"], w["y"], w["w"], w["h"], w["source"], w["compare"], w["bars"], w["scope"])
        for w in sorted(template["widgets"], key=lambda w: (w["y"], w["x"]))
    ]
    assert [preview_of(w) for w in created] == preview
    assert dash["range"] == template["range"]


@pytest.mark.parametrize(("recipe", "range_"), [("power", "this_month"), ("cost", "this_month"), ("areas", "this_month"), ("day", "24h")])
async def test_each_recipe_starts_on_its_own_range_and_a_range_in_the_body_wins(client, db, recipe, range_):
    await login_as(client, db, "operator")
    assert (await client.post("/api/dashboards", json={"name": "A", "recipe": recipe})).json()["range"] == range_
    assert (await client.post("/api/dashboards", json={"name": "B", "recipe": recipe, "range": "7d"})).json()["range"] == "7d"
    assert (await client.post("/api/dashboards", json={"name": "C", "recipe": recipe, "range": "24h"})).json()["range"] == "24h"
    assert (await client.post("/api/dashboards", json={"name": "D", "recipe": recipe, "range": "this_month"})).json()["range"] == "this_month"


async def test_the_last_24_hours_cards_keep_24_hours_on_a_dashboard_of_another_range(client, db):
    await login_as(client, db, "operator")
    dash = (await client.post("/api/dashboards", json={"name": "Day", "recipe": "day", "range": "7d"})).json()
    ranges = {w["title"]: w["config"].get("range") for w in dash["widgets"]}
    assert ranges == {"Last 24 hours": None, "Energy per hour": "24h", "Energy by area": "24h"}


@pytest.mark.parametrize("recipe", RECIPES)
async def test_every_recipe_can_be_created_on_an_empty_site_and_the_audit_names_it(client, db, recipe):
    await login_as(client, db, "operator")
    response = await client.post("/api/dashboards", json={"name": "Starter", "recipe": recipe})
    assert response.status_code == 201, response.text
    dash = response.json()
    rows = await db.fetch("SELECT detail FROM audit_log WHERE action = 'dashboard.created'")
    assert [row["detail"] for row in rows] == [
        {"dashboard_id": dash["id"], "name": "Starter", "widgets": len(dash["widgets"]), "recipe": recipe}
    ]


async def test_a_blank_dashboard_is_audited_without_a_recipe(client, db):
    await login_as(client, db, "operator")
    dash = (await client.post("/api/dashboards", json={"name": "Blank"})).json()
    rows = await db.fetch("SELECT detail FROM audit_log WHERE action = 'dashboard.created'")
    assert [row["detail"] for row in rows] == [{"dashboard_id": dash["id"], "name": "Blank", "widgets": 0}]


async def test_an_unknown_recipe_is_a_422_and_the_new_names_are_case_sensitive(client, db):
    await login_as(client, db, "operator")
    for recipe in ("solar", "Cost", "AREAS", "live", "", 2, ["cost"]):
        response = await client.post("/api/dashboards", json={"name": "X", "recipe": recipe})
        assert response.status_code == 422, recipe
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 0
