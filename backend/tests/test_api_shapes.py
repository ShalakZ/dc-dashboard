"""GET /api/sources/{id}/shapes (w36): a source's points as a few dozen tag shapes. The pure grouping is tests/test_shapes.py."""
from __future__ import annotations

import time

from dcdash.simulator.scada import ScadaConfig, _build_tags, unit_of
from helpers import login_as, make_asset, make_mapping, make_source


async def add_points(db, source: int, rows: list[tuple[str, str, str | None]]) -> list[int]:
    """(address, name, unit hint) rows, in order; the ids come back in the same order."""
    await db.executemany("INSERT INTO points (source_id, address, name, unit_hint) VALUES ($1, $2, $3, $4)", [(source, *row) for row in rows])
    ids = await db.fetch("SELECT id FROM points WHERE source_id = $1 ORDER BY id", source)
    return [r["id"] for r in ids][-len(rows):]


def scada_rows(pdus: int, branch_tags: int) -> list[tuple[str, str, str | None]]:
    tags, _ = _build_tags(ScadaConfig(pdus=pdus, branch_tags=branch_tags))
    return [(f"ns=3;s={20000 + i}:Site.{tag}", tag, unit_of(tag)) for i, tag in enumerate(tags)]


async def small_source(db) -> int:
    """Six PDUs on feed A: energy and power (two shapes with six members each), a one-member tag and a status."""
    source = await make_source(db, "Hall A SCADA", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    rows = []
    for n in range(1, 7):
        rows.append((f"ns=3;s={20000 + n}:Site.PDUA{n:02d}_PM0_PENRG", f"PDUA{n:02d}_PM0_PENRG", "kWh"))
        rows.append((f"ns=3;s={20100 + n}:Site.PDUA{n:02d}_PM0_P", f"PDUA{n:02d}_PM0_P", "kW"))
    rows.append(("ns=3;s=20900:Site.Lonely", "Lonely", None))
    await add_points(db, source, rows)
    return source


# -- the gate and the id ----------------------------------------------------------------------------------------------------------

async def test_roles_discovery_view_opens_it_and_viewer_and_anonymous_do_not(client, db):
    source = await small_source(db)
    assert (await client.get(f"/api/sources/{source}/shapes")).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get(f"/api/sources/{source}/shapes")).status_code == 403
    await client.post("/api/logout")
    await login_as(client, db, "operator")  # holds discovery.view (not discovery.accept)
    assert (await client.get(f"/api/sources/{source}/shapes")).status_code == 200
    await client.post("/api/logout")
    await login_as(client, db, "admin")
    assert (await client.get(f"/api/sources/{source}/shapes")).status_code == 200


async def test_an_unknown_source_is_a_404_and_a_bad_id_is_a_422(client, db):
    await login_as(client, db, "admin")
    response = await client.get("/api/sources/9999/shapes")
    assert response.status_code == 404 and response.json()["detail"] == "source not found"
    assert (await client.get("/api/sources/0/shapes")).status_code == 422
    assert (await client.get("/api/sources/2147483648/shapes")).status_code == 422


async def test_q_must_be_between_two_and_a_hundred_characters(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    assert (await client.get(f"/api/sources/{source}/shapes", params={"q": "P"})).status_code == 422
    assert (await client.get(f"/api/sources/{source}/shapes", params={"q": "x" * 101})).status_code == 422
    assert (await client.get(f"/api/sources/{source}/shapes", params={"q": "PE"})).status_code == 200
    assert (await client.get(f"/api/sources/{source}/shapes", params={"q": "x" * 100})).status_code == 200


# -- the answer -------------------------------------------------------------------------------------------------------------------

async def test_the_answer_is_the_contract(client, db):
    source = await small_source(db)
    asset = await make_asset(db, "Hall A")
    child = await make_asset(db, "Row 1", asset)
    await login_as(client, db, "admin")
    body = (await client.get(f"/api/sources/{source}/shapes")).json()
    assert list(body) == [
        "source_id", "source_name", "points", "mapped", "other_tags", "other_examples", "shapes_total", "shapes", "more_shapes", "assets",
    ]
    assert (body["source_id"], body["source_name"], body["points"], body["mapped"]) == (source, "Hall A SCADA", 13, 0)
    assert body["other_tags"] == 1 and body["other_examples"] == [{"name": "Lonely", "address": "ns=3;s=20900:Site.Lonely"}]
    assert body["shapes_total"] == 2 and body["more_shapes"] == 0
    energy, power = body["shapes"]  # counters first
    assert energy["label"] == "PDUA#_PM0_PENRG" and energy["key"] == "pdua#_pm#_penrg" and energy["billing"] == "counter"
    assert power["label"] == "PDUA#_PM0_P" and power["billing"] == "power"
    assert (energy["count"], energy["mapped"], energy["twins"], energy["duplicates"]) == (6, 0, 0, 0)
    assert energy["examples"][0] == {"name": "PDUA01_PM0_PENRG", "address": "ns=3;s=20001:Site.PDUA01_PM0_PENRG"}
    assert len(energy["examples"]) == 3 and energy["unit_hints"] == ["kWh"] and energy["mixed_units"] is False
    assert energy["suggestion"] == {
        "metric": "energy_kwh", "scale": 1.0, "interval_seconds": 60, "custom_unit": None, "guess": True, "mixed": False,
    }
    assert energy["per_equipment"] == 1 and energy["equipment"] == {"population": 6, "with_shape": 6, "missing": [], "missing_total": 0}
    assert energy["similar"] == [] and energy["rule"] is None
    assert body["assets"] == [
        {"id": asset, "parent_id": None, "name": "Hall A", "kind": "generic", "icon": None},
        {"id": child, "parent_id": asset, "name": "Row 1", "kind": "generic", "icon": None},
    ]
    assert "matches" not in body


async def test_an_empty_source_has_no_shapes(client, db):
    source = await make_source(db, "Empty", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    await login_as(client, db, "admin")
    body = (await client.get(f"/api/sources/{source}/shapes")).json()
    assert (body["points"], body["mapped"], body["other_tags"], body["shapes_total"], body["shapes"], body["more_shapes"]) == (0, 0, 0, 0, [], 0)
    assert body["other_examples"] == [] and body["assets"] == []


async def test_other_tags_are_counted_and_three_are_shown_in_the_order_of_the_browse(client, db):
    source = await make_source(db, "Mixed", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    await add_points(db, source, [(f"a{i}", name, None) for i, name in enumerate(["Zed", "Alpha", "Mid", "Last", "T1_x", "T2_x"])])
    await login_as(client, db, "admin")
    body = (await client.get(f"/api/sources/{source}/shapes")).json()
    assert body["other_tags"] == 4 and [e["name"] for e in body["other_examples"]] == ["Zed", "Alpha", "Mid"]


async def test_another_sources_points_and_mappings_are_not_counted(client, db):
    source = await small_source(db)
    other = await make_source(db, "Other", "opcua", {"endpoint": "opc.tcp://other:4840/"}, enabled=False)
    ids = await add_points(db, other, [("a1", "PDUA01_PM0_PENRG", "kWh"), ("a2", "PDUA02_PM0_PENRG", "kWh")])
    await make_mapping(db, ids[0], await make_asset(db, "Elsewhere"), "energy_kwh")
    await login_as(client, db, "admin")
    body = (await client.get(f"/api/sources/{source}/shapes")).json()
    assert body["points"] == 13 and body["mapped"] == 0 and body["shapes"][0]["count"] == 6 and body["shapes"][0]["mapped"] == 0


async def test_mapped_points_count_in_their_shape_and_in_the_source(client, db):
    source = await small_source(db)
    ids = [r["id"] for r in await db.fetch("SELECT id FROM points WHERE source_id = $1 AND name LIKE '%PENRG' ORDER BY id", source)]
    for pid, name in zip(ids[:2], ("Feed 1", "Feed 2"), strict=True):
        await make_mapping(db, pid, await make_asset(db, name), "energy_kwh", 60)
    await login_as(client, db, "admin")
    body = (await client.get(f"/api/sources/{source}/shapes")).json()
    assert body["mapped"] == 2 and body["points"] == 13
    assert (body["shapes"][0]["count"], body["shapes"][0]["mapped"], body["shapes"][0]["twins"]) == (6, 2, 0)


async def test_twins_of_a_mapped_point_are_counted_on_a_source_with_stable_addresses(client, db):
    source = await make_source(db, "Stable", "opcua", {"endpoint": "opc.tcp://h:4840/", "stable_addresses": True}, enabled=False)
    ids = await add_points(db, source, [
        ("ns=3;s=20403:Site.X01_P", "X01_P", "kW"),  # mapped, under the numbered address
        ("ns=3;s=Site.X01_P", "ns=3;s=Site.X01_P", "kW"),  # its twin: the stable address, the name fell back to the node id
        ("ns=3;s=20404:Site.X02_P", "X02_P", "kW"),
        ("ns=3;s=20405:Site.X03_P", "X03_P", "kW"),
    ])
    await make_mapping(db, ids[0], await make_asset(db, "X01"), "active_power_kw")
    await login_as(client, db, "admin")
    body = (await client.get(f"/api/sources/{source}/shapes")).json()
    [shape] = body["shapes"]  # the name that fell back to the node id still joins the shape of its tag
    assert shape["key"] == "x#_p" and (shape["count"], shape["mapped"], shape["twins"]) == (4, 1, 1)
    assert shape["duplicates"] == 2  # the two members that are the same tag
    assert body["mapped"] == 1 and body["points"] == 4 and body["other_tags"] == 0


async def test_without_stable_addresses_a_twin_is_not_a_twin(client, db):
    source = await make_source(db, "Plain", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    ids = await add_points(db, source, [("ns=3;s=20403:Site.X01_P", "X01_P", "kW"), ("ns=3;s=Site.X01_P", "X01_P", "kW"), ("a3", "X02_P", "kW")])
    await make_mapping(db, ids[0], await make_asset(db, "X01"), "active_power_kw")
    await login_as(client, db, "admin")
    [shape] = (await client.get(f"/api/sources/{source}/shapes")).json()["shapes"]
    assert (shape["count"], shape["mapped"], shape["twins"], shape["duplicates"]) == (3, 1, 0, 2)


# -- q and matches ----------------------------------------------------------------------------------------------------------------

async def test_q_keeps_the_shapes_with_a_matching_tag_and_says_where_the_tags_are(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    body = (await client.get(f"/api/sources/{source}/shapes", params={"q": "penrg"})).json()  # case-insensitive
    assert [s["label"] for s in body["shapes"]] == ["PDUA#_PM0_PENRG"]
    assert body["shapes_total"] == 2 and body["more_shapes"] == 0 and body["points"] == 13 and body["other_tags"] == 1  # source-wide
    assert body["matches"]["count"] == 6 and len(body["matches"]["first"]) == 5
    assert body["matches"]["first"][0] == {
        "name": "PDUA01_PM0_PENRG", "address": "ns=3;s=20001:Site.PDUA01_PM0_PENRG", "shape": "pdua#_pm#_penrg",
    }


async def test_q_matches_the_address_too_and_a_tag_in_no_shape_has_a_null_shape(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    body = (await client.get(f"/api/sources/{source}/shapes", params={"q": "lonely"})).json()
    assert body["shapes"] == [] and body["matches"] == {
        "count": 1, "first": [{"name": "Lonely", "address": "ns=3;s=20900:Site.Lonely", "shape": None}],
    }
    body = (await client.get(f"/api/sources/{source}/shapes", params={"q": "s=20003:"})).json()  # only in the address
    assert body["matches"]["count"] == 1 and [s["label"] for s in body["shapes"]] == ["PDUA#_PM0_PENRG"]
    assert (await client.get(f"/api/sources/{source}/shapes", params={"q": "nothing like this"})).json()["matches"] == {"count": 0, "first": []}


async def test_q_is_plain_text_percent_and_underscore_are_not_wildcards(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    assert (await client.get(f"/api/sources/{source}/shapes", params={"q": "%%"})).json()["matches"]["count"] == 0
    assert (await client.get(f"/api/sources/{source}/shapes", params={"q": "__"})).json()["matches"]["count"] == 0
    assert (await client.get(f"/api/sources/{source}/shapes", params={"q": "M0_P"})).json()["matches"]["count"] == 12  # P and PENRG


async def test_q_can_match_tags_of_several_shapes_and_the_cap_applies_after_it(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    body = (await client.get(f"/api/sources/{source}/shapes", params={"q": "pdua0"})).json()
    assert [s["label"] for s in body["shapes"]] == ["PDUA#_PM0_PENRG", "PDUA#_PM0_P"] and body["matches"]["count"] == 12


# -- the cap ----------------------------------------------------------------------------------------------------------------------

async def test_at_most_300_shapes_are_returned_and_the_rest_is_counted(client, db):
    source = await make_source(db, "Many", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    letters = "abcdefghijklmnopqrstuvwxyz"
    rows = []
    for a in letters:
        for b in letters:
            if len(rows) >= 1204:
                break
            rows += [(f"{a}{b}1", f"{a}{b}1_x", "kW"), (f"{a}{b}2", f"{a}{b}2_x", "kW")]  # shapes differ in LETTERS: digits collapse
    await add_points(db, source, rows)
    await login_as(client, db, "admin")
    body = (await client.get(f"/api/sources/{source}/shapes")).json()
    assert body["shapes_total"] == 602 and len(body["shapes"]) == 300 and body["more_shapes"] == 302
    assert body["points"] == 1204 and body["other_tags"] == 0
    narrowed = (await client.get(f"/api/sources/{source}/shapes", params={"q": "ab1"})).json()
    assert [s["key"] for s in narrowed["shapes"]] == ["ab#_x"] and narrowed["more_shapes"] == 0 and narrowed["shapes_total"] == 602
    wide = (await client.get(f"/api/sources/{source}/shapes", params={"q": "_x"})).json()
    assert len(wide["shapes"]) == 300 and wide["more_shapes"] == 302 and wide["matches"]["count"] == 1204


# -- a real size ------------------------------------------------------------------------------------------------------------------

async def test_a_15000_tag_source_is_29_shapes_and_quick(client, db):
    source = await make_source(db, "Big", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    await add_points(db, source, scada_rows(200, 4190))
    await login_as(client, db, "admin")
    started = time.perf_counter()
    response = await client.get(f"/api/sources/{source}/shapes")
    took = time.perf_counter() - started
    print(f"GET shapes of 15,000 points took {took:.2f} s, {len(response.content):,} bytes")
    body = response.json()
    assert response.status_code == 200 and body["points"] == 15_000 and body["shapes_total"] == 29 and len(body["shapes"]) == 29
    assert [s["label"] for s in body["shapes"][:2]] == ["PDUA#_PM0_PENRG", "PDUB#_PM0_PENRG"] and body["other_tags"] == 0
    assert len(response.content) < 60_000 and took < 3.0  # loose: other lanes share the machine


async def test_reading_shapes_writes_nothing(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    before = [await db.fetchval(f"SELECT count(*) FROM {table}") for table in ("points", "mappings", "assets", "audit_log", "sources")]
    assert (await client.get(f"/api/sources/{source}/shapes", params={"q": "pdu"})).status_code == 200
    assert [await db.fetchval(f"SELECT count(*) FROM {table}") for table in ("points", "mappings", "assets", "audit_log", "sources")] == before
