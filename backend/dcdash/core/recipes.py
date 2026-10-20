"""Starter dashboards (w25, w27): the widgets a "recipe" puts on a new dashboard, and the catalog the template gallery shows.
Pure functions, no database.

The caller (`POST /api/dashboards`) loads the asset tree, the kind text of each asset and the ids of the assets that have a
meter of their own, and gets back widget dicts in the shape of `WidgetIn`; the very checks a save uses then run over them.
`template_catalog` is built from those same widget lists, so the preview a person sees is the dashboard they get.
"""
from collections import Counter
from collections.abc import Collection, Mapping, Sequence
from datetime import date
from typing import Any, Literal, get_args

from dcdash.core.asset_kinds import kind_key
from dcdash.core.breakdown import common_spelling, trim_kind
from dcdash.core.cost import TariffRow, rate_at
from dcdash.core.tree import AssetTree
from dcdash.core.widgets import KIND_MAX, MAX_ASSETS

RecipeId = Literal["power", "cost", "areas", "day"]
RECIPES: tuple[str, ...] = get_args(RecipeId)  # the order the gallery shows them in
DEFAULT_RECIPE_RANGE = "this_month"  # a recipe's dashboard starts here unless it says otherwise: its comparisons are of this month
RECIPE_RANGES = {"day": "24h"}

FALLBACK_KIND = "Panel"  # what a site with nothing metered gets: the kind a person will most likely meter first
TITLE_MAX = 100  # the longest widget title the API accepts


def best_kind(tree: AssetTree, kinds: Mapping[int, str], metered: Collection[int]) -> str:
    """The kind of asset the starter's breakdown draws one bar for, as the text to show.

    Kinds are compared with `kind_key`. A Panel wins as soon as any panel has a meter of its own; otherwise the kind with the
    most metered assets wins (a tie goes to the alphabetically first key); a site with nothing metered gets Panel. A blank
    kind and one longer than a breakdown accepts (`KIND_MAX`) are not candidates. `kinds` holds the kind text of each asset
    and `metered` the ids of the assets that have a meter of their own; an id outside `tree` is ignored. The text is the
    kind's most common spelling among the assets that have it.
    """
    spellings: dict[str, list[str]] = {}
    own_meters: Counter[str] = Counter()
    for asset_id, text in kinds.items():
        if asset_id not in tree.nodes:
            continue
        spelling = trim_kind(text)
        key = kind_key(spelling)
        if not key or len(spelling) > KIND_MAX:
            continue
        spellings.setdefault(key, []).append(spelling)
        if asset_id in metered:
            own_meters[key] += 1
    if own_meters["panel"]:
        return common_spelling(spellings["panel"])
    if not own_meters:
        return FALLBACK_KIND
    winner = min(own_meters, key=lambda key: (-own_meters[key], key))
    return common_spelling(spellings[winner])


def _bar_title(kind: str, what: str = "Energy") -> str:
    """"Energy by Panel" or "Cost by Panel", the kind as the assets spell it ("Energy by LV panel", "Energy by UPS"). A title is
    one line of at most TITLE_MAX characters of plain text: a kind that would break that (a very long one, one with a line
    break in it) gives the general title, so the starter can always be created."""
    title = f"{what} by {kind}"
    return title if len(title) <= TITLE_MAX and title.isprintable() else f"{what} by kind"


def _following(source: str, **more: Any) -> dict[str, Any]:
    """The config of a data widget that follows the dashboard's focus (`scope` "focus": the chooser fills the assets in)."""
    config: dict[str, Any] = {
        "scope": "focus", "assets": [], "source": source, "metric": None, "aggregation": "sum", "range": None,
        "bars": "asset", "min": 0, "max": None,
    }
    config.update(more)
    return config


def _widget(type_: str, title: str, config: dict[str, Any], x: int, y: int, w: int, h: int) -> dict[str, Any]:
    return {"type": type_, "title": title, "config": config, "x": x, "y": y, "w": w, "h": h}


def power_widgets(tree: AssetTree, kinds: Mapping[int, str], metered: Collection[int]) -> list[dict[str, Any]]:
    """The starter "Power" dashboard, on the 12-column grid: a heading, this month's energy and cost each against the same
    days of last month, the energy of every asset of the best kind, and the energy by day against last month. Everything
    but the heading follows the dashboard's focus; the comparisons carry their own range (a comparison needs this month)
    and the breakdown inherits the dashboard's. An empty tree gets the same five widgets."""
    compare = {"range": "this_month", "compare": "same_days_last_month"}
    kind = best_kind(tree, kinds, metered)
    return [
        _widget("text", "Power use and cost", {"style": "heading", "text": "Power use and cost"}, 0, 0, 12, 1),
        # Short titles: a 3-wide card clips a longer one at 1024 px, and the window line under the figure already says "1 to 18 Oct".
        _widget("stat", "Energy", _following("energy", **compare), 0, 1, 3, 3),
        _widget("stat", "Cost", _following("cost", **compare), 3, 1, 3, 3),
        _widget("bar", _bar_title(kind), _following("energy", bars="kind", kind=kind), 6, 1, 6, 3),
        _widget("timeseries", "Energy by day, against last month", _following("energy", **compare), 0, 4, 12, 4),
    ]


def _heading(text: str) -> dict[str, Any]:
    """The heading across the top of a template: a text widget, 12 wide and one row high."""
    return _widget("text", text, {"style": "heading", "text": text}, 0, 0, 12, 1)


def cost_widgets(tree: AssetTree, kinds: Mapping[int, str], metered: Collection[int]) -> list[dict[str, Any]]:
    """The "Cost" template: this month's cost against the same days of last month, the cost of every asset of the best kind,
    the cost by day against last month, and a table of the focus's areas. The table follows the dashboard's range (a
    comparison needs this month, a table of children cannot compare)."""
    compare = {"range": "this_month", "compare": "same_days_last_month"}
    kind = best_kind(tree, kinds, metered)
    return [
        _heading("Cost and where it goes"),
        _widget("stat", "Cost", _following("cost", **compare), 0, 1, 3, 3),
        _widget("bar", _bar_title(kind, "Cost"), _following("cost", bars="kind", kind=kind), 3, 1, 9, 3),
        _widget("timeseries", "Cost by day, against last month", _following("cost", **compare), 0, 4, 12, 4),
        _widget("table", "Cost by area", _following("cost", scope="children"), 0, 8, 12, 4),
    ]


def areas_widgets(tree: AssetTree, kinds: Mapping[int, str], metered: Collection[int]) -> list[dict[str, Any]]:
    """The "Energy by area" template: the focus's direct children side by side, as a table, a bar each and a line each by day.
    Children cannot be compared with last month, so none of these compares; they follow the dashboard's range. No card
    shares a title with another card or with the heading (a card's title is a heading to a screen reader)."""
    return [
        _heading("Where the energy goes"),
        _widget("table", "Energy by area", _following("energy", scope="children"), 0, 1, 6, 4),
        _widget("bar", "Energy per area", _following("energy", scope="children", bars="asset"), 6, 1, 6, 4),
        _widget("timeseries", "Energy by day", _following("energy", scope="children"), 0, 5, 12, 4),
    ]


def day_widgets(tree: AssetTree, kinds: Mapping[int, str], metered: Collection[int]) -> list[dict[str, Any]]:
    """The "Last 24 hours" template: the focus's energy hour by hour and a table of its areas. Both cards carry the range
    "24h" themselves, so their titles stay true on a dashboard that a visit sets to another range. Energy, never power: a
    site's or a hall's kW is not a sum of its children's readings."""
    return [
        _heading("Last 24 hours"),
        _widget("timeseries", "Energy per hour", _following("energy", range="24h"), 0, 1, 12, 4),
        _widget("table", "Energy by area", _following("energy", scope="children", range="24h"), 0, 5, 12, 4),
    ]


_BUILDERS = {"power": power_widgets, "cost": cost_widgets, "areas": areas_widgets, "day": day_widgets}


def recipe_widgets(recipe: str, tree: AssetTree, kinds: Mapping[int, str], metered: Collection[int]) -> list[dict[str, Any]]:
    """The widgets of a recipe, built from the site as it is now. ValueError for a recipe that does not exist."""
    try:
        build = _BUILDERS[recipe]
    except KeyError:
        raise ValueError(f"unknown recipe {recipe!r}; use one of {', '.join(RECIPES)}") from None
    return build(tree, kinds, metered)


def recipe_range(recipe: str) -> str:
    """The range a new dashboard of this recipe starts on when the request names none."""
    return RECIPE_RANGES.get(recipe, DEFAULT_RECIPE_RANGE)


# ---- the catalog ----------------------------------------------------------------------------------------------------

TEMPLATES: dict[str, tuple[str, str]] = {  # id -> (title, description): the gallery's words
    "power": ("Power", "This month's energy and cost against last month, and the energy of each asset of the kind you meter."),
    "cost": ("Cost", "What this month's energy costs against last month, by kind of asset, by day and by area."),
    "areas": ("Energy by area", "The areas inside the focus side by side: a table, a bar for each and a line for each by day."),
    "day": ("Last 24 hours", "The energy of the focus hour by hour over the last 24 hours, and of each area."),
}
NEEDS_RATE = "Needs a rate in Tariffs."
NEEDS_AREAS = "Needs at least two areas with a meter."


def _preview(widget: Mapping[str, Any]) -> dict[str, Any]:
    """What a card of the gallery draws for one widget: its place and size and the four config words that decide its look. A
    text widget has none of the four of its own: its `source` is None and the other three get the plain defaults."""
    config = widget["config"]
    return {
        "type": widget["type"], "x": widget["x"], "y": widget["y"], "w": widget["w"], "h": widget["h"],
        "source": config.get("source"), "compare": config.get("compare", "none"), "bars": config.get("bars", "asset"),
        "scope": config.get("scope", "fixed"),
    }


def _areas_with_a_meter(tree: AssetTree, metered: Collection[int]) -> int:
    """How many of the default focus's children have a meter at or under them. The default focus is the sole top-level asset
    when there is exactly one (its children are the areas), else the top-level assets themselves; a card lists at most
    MAX_ASSETS of them, so only those count."""
    roots = tree.roots()
    areas = (tree.children(roots[0]) if len(roots) == 1 else roots)[:MAX_ASSETS]
    covered = {owner for asset in metered for owner in tree.ancestors_or_self(asset)}
    return sum(1 for area in areas if area in covered)


def template_catalog(
    tree: AssetTree, kinds: Mapping[int, str], metered: Collection[int], tariffs: Sequence[TariffRow], today: date
) -> dict[str, Any]:
    """The template gallery's data: every template with the widgets it creates and whether it is recommended for THIS site.

    `metered` holds the ids of the assets that have a meter of their own, `tariffs` the rows of `load_tariffs` and `today`
    the site's local date. Nothing metered: nothing is recommended and nothing asks for anything (every template would draw
    "no data"). Otherwise Power is recommended; Cost when at least one metered asset has a rate in effect today (`rate_at`: the
    site default counts, a row for an unmetered branch or one that has not started does not); Energy by area when at least two
    of the default focus's children have a meter at or under them; Last 24 hours never."""
    own = {asset for asset in metered if asset in tree.nodes}
    nothing_metered = not own
    verdicts: dict[str, tuple[bool, str | None]] = {recipe: (False, None) for recipe in RECIPES}
    if not nothing_metered:
        priced = any(rate_at(tariffs, tree, asset, today) is not None for asset in own)
        areas = _areas_with_a_meter(tree, own) >= 2
        verdicts["power"] = (True, None)
        verdicts["cost"] = (True, None) if priced else (False, NEEDS_RATE)
        verdicts["areas"] = (True, None) if areas else (False, NEEDS_AREAS)
    templates = []
    for recipe in RECIPES:
        title, description = TEMPLATES[recipe]
        recommended, needs = verdicts[recipe]
        templates.append({
            "id": recipe, "title": title, "description": description, "range": recipe_range(recipe),
            "recommended": recommended, "needs": needs,
            "widgets": [_preview(widget) for widget in recipe_widgets(recipe, tree, kinds, own)],
        })
    return {"nothing_metered": nothing_metered, "templates": templates}
