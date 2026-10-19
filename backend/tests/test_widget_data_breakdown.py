"""w24: a bar widget with one bar per asset of a kind (core/breakdown.py, core/widgets.py `_fill_breakdown`).

The figures of a bar are the very ones a plain bar widget draws for that asset, so most tests set the breakdown against a plain
bar widget asked for the same assets. Every test seeds ONE tree (the rollups are refreshed once) and asks it several questions.
The clock is fixed in the past of the real one, so the refresh never runs ahead of the wall clock.

The tree (kinds in brackets; a counter rises `n` kWh an hour, 47 counted hours from 1 April 01:00 to 2 April 23:00):
Site (Site) > Hall 1 (Hall) > Rack A1..A5 (Rack), each with a Feed (Feed): counters 3, 1, 5, then A4 a power-only meter of 2 kW
(estimated: 96 kWh), then counter 4. That is 141, 47, 235, 96 and 188 kWh.
Hall 2 (Hall) > Rack B1 (counter 6) which holds a Rack B1 inner (kind "rack", counter 7): 611 kWh together; Rack B2 (a feed with
no mapping: no data). Rack C1 (counter 8: 376 kWh) sits straight under the Site. Spare (Room) > Panel P1 ("Panel") and Panel P2
("panel "), which meter nothing.
"""
import csv
import io
from datetime import datetime, timedelta, timezone

import pytest
from billing_helpers import add_counter, add_power, add_tariff, at, set_currency, set_zone
from helpers import login_as, make_asset, settle_rollups

UTC = timezone.utc
NOW = datetime(2026, 4, 8, 10, 0, tzinfo=UTC)
START = at(2026, 4, 1)
HOURS = 48  # readings of a counter: the first has no baseline, so 47 hours count
CSV_HEADER = ["asset", "source", "unit", "timestamp", "value", "estimated", "partial", "no_data"]
NO_MORE = {"count": 0, "with_value": 0, "value": None, "estimated": False, "partial": False}


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr("dcdash.api.widget_data._now", lambda: NOW)
    monkeypatch.setattr("dcdash.api.billing._now", lambda: NOW)


async def node(db, name: str, kind: str, parent: int | None = None) -> int:
    asset = await make_asset(db, name, parent)
    await db.execute("UPDATE assets SET kind = $2 WHERE id = $1", asset, kind)
    return asset


async def feed(db, rack: int, name: str, per_hour: float) -> int:
    asset = await add_counter(db, name, START, HOURS, per_hour, parent_id=rack)
    await db.execute("UPDATE assets SET kind = 'Feed' WHERE id = $1", asset)
    return asset


async def seed_tree(db, *, readings: bool = True, tariffs: bool = False) -> dict:
    """The tree above. `tariffs`: Hall 1 pays 0.30 from 1 January, Hall 2 pays 0.10 from 2 April, nobody else has a rate."""
    await set_zone(db, "UTC")
    await set_currency(db, "USD")
    site = await node(db, "Site", "Site")
    hall1, hall2 = await node(db, "Hall 1", "Hall", site), await node(db, "Hall 2", "Hall", site)
    ids: dict = {"site": site, "hall1": hall1, "hall2": hall2, "racks": []}
    for name, per_hour in (("A1", 3.0), ("A2", 1.0), ("A3", 5.0), ("A4", None), ("A5", 4.0)):
        rack = await node(db, f"Rack {name}", "Rack", hall1)
        ids[name] = rack
        ids["racks"].append(rack)
        if per_hour is not None:
            await feed(db, rack, f"Feed {name}", per_hour)
        else:  # a meter that only reports power: its energy is an estimate
            power = await add_power(db, "Feed A4", [START + timedelta(hours=h) for h in range(HOURS)], kw=2.0, parent_id=rack)
            await db.execute("UPDATE assets SET kind = 'Feed' WHERE id = $1", power)
    ids["B1"] = b1 = await node(db, "Rack B1", "Rack", hall2)
    await feed(db, b1, "Feed B1", 6.0)
    ids["B1i"] = inner = await node(db, "Rack B1 inner", "rack", b1)
    await feed(db, inner, "Feed B1 inner", 7.0)
    ids["B2"] = b2 = await node(db, "Rack B2", "Rack", hall2)
    await node(db, "Feed B2", "Feed", b2)
    ids["C1"] = c1 = await node(db, "Rack C1", "Rack", site)
    await feed(db, c1, "Feed C1", 8.0)
    spare = await node(db, "Spare", "Room", site)
    ids["panels"] = [await node(db, "Panel P1", "Panel", spare), await node(db, "Panel P2", "panel ", spare)]
    ids["racks"] += [b1, b2, c1]
    if tariffs:
        await add_tariff(db, 0.30, "2026-01-01", hall1)
        await add_tariff(db, 0.10, "2026-04-02", hall2)
    if readings:
        await settle_rollups(db)
    return ids


def kind_config(**extra) -> dict:
    return {"assets": [], "source": "energy", "aggregation": "sum", "bars": "kind", "kind": "Rack", **extra}


async def breakdown_of(client, **extra) -> dict:
    response = await client.post("/api/widget-data", json={"type": "bar", "config": kind_config(**extra), "range": "this_month"})
    assert response.status_code == 200, response.text
    return response.json()


async def plain_bars(client, assets: list[int], source: str = "energy") -> dict[int, dict]:
    """What a plain bar widget draws for the assets: asset id -> its value."""
    config = {"assets": assets, "source": source, "aggregation": "sum"}
    response = await client.post("/api/widget-data", json={"type": "bar", "config": config, "range": "this_month"})
    assert response.status_code == 200, response.text
    return {value["asset_id"]: value for value in response.json()["values"]}


def names(data: dict) -> list[str]:
    return [value["name"] for value in data["values"]]


async def test_a_hall_by_rack_orders_the_bars_cuts_the_top_and_sums_the_rest(client, db):
    ids = await seed_tree(db)
    await login_as(client, db, "admin")
    plain = await plain_bars(client, ids["racks"])
    data = await breakdown_of(client, root=ids["hall1"], top=3, kind=" rack ")
    assert (data["type"], data["mode"], data["unit"], data["bucket"], data["tier"]) == ("bar", "values", "kWh", None, None)
    assert data["series"] == [] and data["missing"] == [] and data["no_metric"] == [] and data["compare"] is None
    # A3 235, A5 188, A1 141 | A4 96 (estimated), A2 47
    assert names(data) == ["Rack A3", "Rack A5", "Rack A1"]
    assert [value["value"] for value in data["values"]] == [235.0, 188.0, 141.0]
    assert not any(value["estimated"] or value["partial"] or value["no_data"] for value in data["values"])
    for value in data["values"]:
        assert value == plain[value["asset_id"]]  # the very figure of a plain bar widget on that asset
    assert plain[ids["A4"]]["estimated"] and plain[ids["A4"]]["value"] == 96.0
    block = data["breakdown"]
    assert block["kind"] == "Rack"  # the most frequent spelling among the candidates, not the requested one
    assert block["root"] == {"id": ids["hall1"], "name": "Hall 1"}
    assert (block["count"], block["shown"], block["no_data"], block["inside_others"]) == (5, 3, 0, 0)
    assert block["more"] == {"count": 2, "with_value": 2, "value": 96.0 + 47.0, "estimated": True, "partial": False}
    assert block["kinds"] == [{"kind": "Feed", "count": 5}, {"kind": "Rack", "count": 5}]  # under Hall 1 only
    full = await breakdown_of(client, root=ids["hall1"])  # ten bars is the default: all five fit
    assert names(full) == ["Rack A3", "Rack A5", "Rack A1", "Rack A4", "Rack A2"]
    assert full["values"][3]["estimated"] is True  # the estimate travels with the bar
    assert (full["breakdown"]["shown"], full["breakdown"]["more"]) == (5, NO_MORE)
    # The root itself is never a bar: under Rack B1 only the rack inside it is one.
    inside = await breakdown_of(client, root=ids["B1"])
    assert names(inside) == ["Rack B1 inner"] and inside["values"][0]["value"] == 7.0 * 47
    assert inside["breakdown"]["root"] == {"id": ids["B1"], "name": "Rack B1"}


async def test_the_whole_site_counts_a_rack_inside_a_rack_once_and_puts_a_rack_without_readings_last(client, db):
    ids = await seed_tree(db)
    await login_as(client, db, "admin")
    data = await breakdown_of(client, top=3)
    block = data["breakdown"]
    assert block["root"] is None
    assert (block["count"], block["shown"], block["no_data"], block["inside_others"]) == (8, 3, 1, 1)
    assert names(data) == ["Rack B1", "Rack C1", "Rack A3"]
    assert [value["value"] for value in data["values"]] == [611.0, 376.0, 235.0]  # B1 holds its inner rack's energy
    # A5 188, A1 141, A4 96 (estimated), A2 47, B2 (no data: it adds nothing and counts as no number)
    assert block["more"] == {"count": 5, "with_value": 4, "value": 188.0 + 141.0 + 96.0 + 47.0, "estimated": True, "partial": False}
    assert block["kinds"] == [  # before the nested rule: nine racks, the one inside a rack included
        {"kind": "Feed", "count": 9}, {"kind": "Rack", "count": 9}, {"kind": "Hall", "count": 2}, {"kind": "Panel", "count": 2},
        {"kind": "Room", "count": 1}, {"kind": "Site", "count": 1},
    ]
    everything = await breakdown_of(client, top=50)
    assert names(everything) == [
        "Rack B1", "Rack C1", "Rack A3", "Rack A5", "Rack A1", "Rack A4", "Rack A2", "Rack B2",
    ]
    numbers = [value["value"] for value in everything["values"][:-1]]
    assert numbers == [611.0, 376.0, 235.0, 188.0, 141.0, 96.0, 47.0]
    last = everything["values"][-1]
    assert (last["value"], last["no_data"], last["estimated"], last["partial"]) == (None, True, False, False)  # a gap, never 0
    assert [value["estimated"] for value in everything["values"]] == [False] * 5 + [True] + [False] * 2
    site = (await plain_bars(client, [ids["site"]]))[ids["site"]]["value"]
    assert sum(numbers) == site == 1694.0  # no energy shown twice: the inner rack is inside B1's bar only
    # The CSV lists every candidate (more rows than `top`), in the same order, with the header it always had.
    response = await client.post(
        "/api/widget-data/csv", json={"type": "bar", "config": kind_config(top=3), "range": "this_month"}
    )
    assert response.status_code == 200, response.text
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))
    assert rows[0] == CSV_HEADER and len(rows) == 1 + 8
    assert [row[0].rsplit(" / ", 1)[1] for row in rows[1:]] == names(everything)
    assert float(rows[1][4]) == 611.0 and float(rows[-2][4]) == 47.0
    assert rows[-1][4] == ""  # the last bar has no value: an empty cell, never a 0
    assert [row[5:] for row in (rows[1], rows[6], rows[-1])] == [  # B1, A4 (estimated), B2 (no data)
        ["false", "false", "false"], ["true", "false", "false"], ["false", "false", "true"],
    ]
    assert {row[1] for row in rows[1:]} == {"energy"} and {row[2] for row in rows[1:]} == {"kWh"}


async def test_cost_gives_cost_figures_with_the_partial_mark_and_an_unrated_rack_that_is_not_a_zero(client, db):
    ids = await seed_tree(db, tariffs=True)
    await login_as(client, db, "admin")
    plain = await plain_bars(client, ids["racks"], "cost")
    data = await breakdown_of(client, source="cost", top=3)
    assert data["unit"] == "USD"
    # A3 70.5, A5 56.4, A1 42.3 | B1 31.2 (partial: 1 April has no rate), A4 28.8 (estimated), A2 14.1, then B2 (no data) and C1 (no rate)
    assert names(data) == ["Rack A3", "Rack A5", "Rack A1"]
    assert [value["value"] for value in data["values"]] == pytest.approx([70.5, 56.4, 42.3])
    for value in data["values"]:
        assert value == plain[value["asset_id"]]
    assert plain[ids["B1"]]["partial"] is True and plain[ids["B1"]]["value"] == pytest.approx(31.2)
    assert plain[ids["A4"]]["estimated"] is True and plain[ids["A4"]]["partial"] is False
    more = data["breakdown"]["more"]
    assert (more["count"], more["with_value"], more["estimated"], more["partial"]) == (5, 3, True, True)
    assert more["value"] == pytest.approx(31.2 + 28.8 + 14.1)
    assert (data["breakdown"]["count"], data["breakdown"]["no_data"]) == (8, 1)
    everything = await breakdown_of(client, source="cost", top=50)
    assert names(everything) == [
        "Rack A3", "Rack A5", "Rack A1", "Rack B1", "Rack A4", "Rack A2", "Rack B2", "Rack C1",
    ]
    for value in everything["values"]:
        assert value == plain[value["asset_id"]]
    unrated, no_data = everything["values"][-1], everything["values"][-2]
    assert (no_data["value"], no_data["no_data"]) == (None, True)  # no readings
    assert (unrated["value"], unrated["no_data"]) == (None, False)  # readings but no rate: a dash, never a 0
    # B1 had a day without a rate; C1 has no rate at all, so every hour it recorded is unpriced
    assert [value["partial"] for value in everything["values"]] == [False, False, False, True, False, False, False, True]


async def test_a_deleted_root_is_missing_and_a_kind_with_no_energy_is_all_no_data(client, db):
    ids = await seed_tree(db, readings=False)
    ghost = await node(db, "Old hall", "Hall", ids["site"])
    await db.execute("DELETE FROM assets WHERE id = $1", ghost)
    await login_as(client, db, "admin")
    whole_tree = [
        {"kind": "Feed", "count": 9}, {"kind": "Rack", "count": 9}, {"kind": "Hall", "count": 2}, {"kind": "Panel", "count": 2},
        {"kind": "Room", "count": 1}, {"kind": "Site", "count": 1},
    ]
    gone = await breakdown_of(client, root=ghost, kind=" Rack ")
    assert (gone["missing"], gone["values"], gone["unit"]) == ([ghost], [], "kWh")
    assert gone["breakdown"] == {
        "kind": "Rack", "root": None, "count": 0, "shown": 0, "more": NO_MORE, "no_data": 0, "inside_others": 0,
        "kinds": whole_tree,
    }
    response = await client.post(
        "/api/widget-data/csv", json={"type": "bar", "config": kind_config(root=ghost), "range": "this_month"}
    )
    assert list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline=""))) == [CSV_HEADER]
    # Panels meter nothing: every bar is no data, and the two spellings are one kind.
    for source, unit in (("energy", "kWh"), ("cost", "USD")):
        panels = await breakdown_of(client, kind="PANEL", source=source)
        assert (names(panels), panels["unit"]) == (["Panel P1", "Panel P2"], unit)
        assert all(value["value"] is None and value["no_data"] for value in panels["values"])
        block = panels["breakdown"]
        assert (block["kind"], block["count"], block["no_data"], block["more"]) == ("Panel", 2, 2, NO_MORE)
        assert block["kinds"] == whole_tree
    # A kind no asset has gives no bar and is still listed, last, so the widget can say what it is set to.
    pumps = await breakdown_of(client, kind="Pump", root=ids["hall2"])
    assert (pumps["values"], pumps["missing"], pumps["breakdown"]["kind"], pumps["breakdown"]["count"]) == ([], [], "Pump", 0)
    assert pumps["breakdown"]["kinds"] == [{"kind": "Feed", "count": 3}, {"kind": "Rack", "count": 3}, {"kind": "Pump", "count": 0}]


@pytest.mark.parametrize("path", ["/api/widget-data", "/api/widget-data/csv"])
async def test_the_endpoint_refuses_a_breakdown_that_breaks_a_rule_naming_the_field(client, db, path):
    await login_as(client, db, "admin")
    metric = {"source": "metric", "metric": "active_power_kw", "aggregation": "avg"}
    refused = [
        ("bar", kind_config(assets=[1]), "assets:"),
        ("bar", {key: value for key, value in kind_config().items() if key != "kind"}, "kind:"),
        ("bar", kind_config(**metric), "bars:"),
        ("stat", kind_config(), "bars:"),
        ("bar", {"assets": [1], "source": "energy", "aggregation": "sum", "kind": "Rack"}, "kind:"),
        ("bar", {"assets": [1], "source": "energy", "aggregation": "sum", "top": 5}, "top:"),
        ("bar", kind_config(top=2), "top:"),
        ("bar", kind_config(top=51), "top:"),
        ("bar", kind_config(kind="x" * 101), "kind:"),
    ]
    for widget_type, config, field in refused:
        response = await client.post(path, json={"type": widget_type, "config": config, "range": "this_month"})
        assert response.status_code == 422, (config, response.text)
        assert response.json()["detail"].startswith(field), (config, response.json()["detail"])
    for top in (3, 50):  # the limits themselves are fine (nothing is seeded: no bars)
        response = await client.post(path, json={"type": "bar", "config": kind_config(top=top), "range": "this_month"})
        assert response.status_code == 200, response.text
