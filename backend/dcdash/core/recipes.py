"""Starter dashboards (w25): the widgets a "recipe" puts on a new dashboard. Pure functions, no database.

The caller (`POST /api/dashboards`) loads the asset tree, the kind text of each asset and the ids of the assets that have a
meter of their own, and gets back widget dicts in the shape of `WidgetIn`; the very checks a save uses then run over them.
"""
from collections import Counter
from collections.abc import Collection, Mapping
from typing import Any

from dcdash.core.asset_kinds import kind_key
from dcdash.core.breakdown import common_spelling, trim_kind
from dcdash.core.tree import AssetTree
from dcdash.core.widgets import KIND_MAX

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


def _bar_title(kind: str) -> str:
    """"Energy by Panel", the kind as the assets spell it ("Energy by LV panel", "Energy by UPS"). A title is one line of at most
    TITLE_MAX characters of plain text: a kind that would break that (a very long one, one with a line break in it) gives the
    general title, so the starter can always be created."""
    title = f"Energy by {kind}"
    return title if len(title) <= TITLE_MAX and title.isprintable() else "Energy by kind"


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
