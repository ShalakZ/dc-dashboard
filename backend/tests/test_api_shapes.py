"""GET /api/sources/{id}/shapes (w36): a source's points as a few dozen tag shapes. The pure grouping is tests/test_shapes.py."""
from __future__ import annotations

import hashlib
import json
import time

import pytest

from dcdash.simulator.scada import ScadaConfig, _build_tags, unit_of
from helpers import login_as, make_asset, make_mapping, make_role, make_source


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


# computed on main's code (w38 T0), before the rule changed
HASH_OF_THE_ANSWER = "e55b3874dc2faf5ff2d07b48814e95dffdd94418996e4b430b7939e8d34ae27d"  # no q
HASH_OF_THE_ANSWER_FOR_PENRG = "fe672db748b59541280a47037d8aa349dc469dc37a920a8e9e09a584b3d49a5b"  # q=penrg


async def test_the_answer_is_byte_identical_to_main_for_a_numbered_source(client, db):
    # Protects w38: a source of numbered node ids whose names are the tags answers the same bytes as before the tag-text rule changed.
    source = await make_source(db, "Hall A SCADA", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)  # its own copy of small_source's rows
    rows: list[tuple[str, str, str | None]] = []
    for n in range(1, 7):
        rows.append((f"ns=3;s={20000 + n}:Site.PDUA{n:02d}_PM0_PENRG", f"PDUA{n:02d}_PM0_PENRG", "kWh"))
        rows.append((f"ns=3;s={20100 + n}:Site.PDUA{n:02d}_PM0_P", f"PDUA{n:02d}_PM0_P", "kW"))
    rows.append(("ns=3;s=20900:Site.Lonely", "Lonely", None))
    await add_points(db, source, rows)
    await login_as(client, db, "admin")
    digests = []
    for params in ({}, {"q": "penrg"}):
        answer = (await client.get(f"/api/sources/{source}/shapes", params=params)).json()
        for key in ("source_id", "assets"):  # the ids of this run
            del answer[key]
        digests.append(hashlib.sha256(json.dumps(answer, sort_keys=True).encode("utf-8")).hexdigest())
    assert digests == [HASH_OF_THE_ANSWER, HASH_OF_THE_ANSWER_FOR_PENRG]


# ======================================================================================================================================
# POST /api/sources/{id}/shapes/lines: the decisions as tag-list lines and the checks. The pure rules are tests/test_shapes_lines.py.
# ======================================================================================================================================

ANSWER_KEYS = ["csv", "lines", "blocking", "by_shape", "checks", "samples", "plan_assets", "parent_path"]


def lines_url(source: int) -> str:
    return f"/api/sources/{source}/shapes/lines"


def decision(shape: str = "pdua#_pm#_penrg", metric: str = "energy_kwh", name_from: str = "part1", **more) -> dict:
    return {"shape": shape, "metric": metric, "name_from": name_from, **more}


def body_of(*decisions: dict, parent_id: int | None = None, create_assets: bool = True) -> dict:
    return {"decisions": list(decisions), "parent_id": parent_id, "create_assets": create_assets}


async def table_counts(db) -> list[int]:
    return [await db.fetchval(f"SELECT count(*) FROM {table}") for table in ("points", "mappings", "assets", "audit_log", "sources")]


def checks_of(answer: dict, kind: str) -> list[dict]:
    return [check for check in answer["checks"] if check["kind"] == kind]


async def tag_list(client, source: int, csv: str, *, dry_run: bool = True, **expect):
    params = {"dry_run": "1" if dry_run else "0", "create_assets": "1", **expect}
    return await client.post(f"/api/sources/{source}/tag-list", params=params, content=csv.encode(), headers={"content-type": "text/csv"})


# -- who may, which ids and bodies ------------------------------------------------------------------------------------------------

async def test_lines_need_discovery_accept_and_the_gate_comes_before_the_body_is_looked_at(client, db):
    source = await small_source(db)
    good = body_of(decision())
    assert (await client.post(lines_url(source), json=good)).status_code == 401
    for role in ("viewer", "operator"):  # the Operator holds discovery.view (it may read the shapes) and not discovery.accept
        await login_as(client, db, role)
        assert (await client.post(lines_url(source), json=good)).status_code == 403, role
        assert (await client.post(lines_url(source), json={"nonsense": 1})).status_code == 403, role  # not a 422: the gate is first
        await client.post("/api/logout")
    await make_role(db, "looker", ["discovery.view"])
    await login_as(client, db, "looker", "look")
    assert (await client.post(lines_url(source), json=good)).status_code == 403
    await client.post("/api/logout")
    await make_role(db, "accepter", ["discovery.accept", "discovery.view"])
    await login_as(client, db, "accepter", "acc")
    assert (await client.post(lines_url(source), json=good)).status_code == 200
    await client.post("/api/logout")
    await login_as(client, db, "admin")
    assert (await client.post(lines_url(source), json=good)).status_code == 200


async def test_an_unknown_source_is_a_404_and_a_bad_id_is_a_422_for_the_lines(client, db):
    await login_as(client, db, "admin")
    response = await client.post(lines_url(9999), json=body_of(decision()))
    assert response.status_code == 404 and response.json()["detail"] == "source not found"
    assert (await client.post(lines_url(0), json=body_of(decision()))).status_code == 422
    assert (await client.post(lines_url(2147483648), json=body_of(decision()))).status_code == 422


@pytest.mark.parametrize(("bad", "field"), [
    (body_of(), "decisions"),  # 0 decisions
    (body_of(*[decision()] * 61), "decisions"),  # 61 decisions
    ({**body_of(decision()), "extra": 1}, "extra"),  # an extra key
    (body_of(decision(colour="red")), "colour"),  # an extra key inside a decision
    (body_of(decision(scale=0)), "scale"), (body_of(decision(scale=-1)), "scale"), (body_of(decision(scale=1e13)), "scale"),
    (body_of(decision(scale="abc")), "scale"),
    (body_of(decision(interval_seconds=0)), "interval_seconds"), (body_of(decision(interval_seconds=2_678_401)), "interval_seconds"),
    (body_of(decision(interval_seconds=1.5)), "interval_seconds"),
    (body_of(decision(metric="nonsense")), "metric"), (body_of(decision(name_from="part3")), "name_from"),
    (body_of(decision(unit="x" * 21)), "unit"), (body_of(decision(unit="a\u200bb")), "unit"), (body_of(decision(unit="a\nb")), "unit"),
    ({**body_of(), "decisions": [{"metric": "energy_kwh", "name_from": "part1"}]}, "shape"),
    ({**body_of(), "decisions": [{"shape": "x#_p", "name_from": "part1"}]}, "metric"),
    ({**body_of(), "decisions": [{"shape": "x#_p", "metric": "energy_kwh"}]}, "name_from"),  # name_from is required
    (body_of(decision(shape="")), "shape"), (body_of(decision(shape="x" * 2001)), "shape"),
    (body_of(decision(), parent_id=0), "parent_id"), (body_of(decision(), parent_id=2147483648), "parent_id"),
    ({**body_of(decision()), "parent_id": "one"}, "parent_id"), ({**body_of(decision()), "create_assets": "maybe"}, "create_assets"),
    ({"decisions": [decision()], "create_assets": True}, "parent_id"),  # parent_id is required (null is the top level)
    ({"decisions": [decision()], "parent_id": None}, "create_assets"),  # create_assets is required
    ({}, "decisions"), ({"decisions": "x"}, "decisions"),
])
async def test_a_bad_body_is_a_422_that_names_the_field(client, db, bad, field):
    source = await small_source(db)
    await login_as(client, db, "admin")
    response = await client.post(lines_url(source), json=bad)
    assert response.status_code == 422
    assert field in response.json()["detail"][0]["loc"], response.json()["detail"]


@pytest.mark.parametrize("scale", ["Infinity", "-Infinity", "NaN"])
async def test_a_scale_that_is_not_a_finite_number_is_a_422(client, db, scale):
    source = await small_source(db)
    await login_as(client, db, "admin")
    raw = (
        '{"decisions": [{"shape": "pdua#_pm#_penrg", "metric": "energy_kwh", "name_from": "part1", "scale": %s}], '
        '"parent_id": null, "create_assets": true}' % scale
    ).encode()
    response = await client.post(lines_url(source), content=raw, headers={"content-type": "application/json"})
    assert response.status_code == 422 and "scale" in response.json()["detail"][0]["loc"]


async def test_the_bounds_themselves_are_accepted(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    edge = decision(scale=1e12, interval_seconds=2_678_400, unit="u" * 20)
    assert (await client.post(lines_url(source), json=body_of(*[edge] * 60))).status_code == 200


# -- the answer -------------------------------------------------------------------------------------------------------------------

async def test_the_answer_is_the_contract_and_the_asset_path_is_the_parents_names_from_the_root(client, db):
    source = await small_source(db)
    site = await make_asset(db, "Site")
    hall = await make_asset(db, "Hall A", site)
    row = await make_asset(db, "Row 1", hall)
    await login_as(client, db, "admin")
    response = await client.post(lines_url(source), json=body_of(decision(), parent_id=row))
    assert response.status_code == 200
    answer = response.json()
    assert list(answer) == ANSWER_KEYS
    assert answer["lines"] == 6 and answer["blocking"] is False and answer["checks"] == []
    assert answer["plan_assets"] == 6 and answer["parent_path"] == ["Site", "Hall A", "Row 1"]  # six PDUs to create below the parent
    assert answer["by_shape"] == [{
        "shape": "pdua#_pm#_penrg", "label": "PDUA#_PM0_PENRG", "lines": 6, "assets": 6, "skipped_mapped": 0, "skipped_twins": 0,
    }]
    assert len(answer["samples"]) == 5 and answer["samples"][0] == {
        "shape": "pdua#_pm#_penrg", "tag": "PDUA01_PM0_PENRG", "address": "ns=3;s=20001:Site.PDUA01_PM0_PENRG",
        "asset": "Site/Hall A/Row 1/PDUA01", "unit_hint": "kWh", "metric": "energy_kwh", "scale": 1.0,
    }
    lines = answer["csv"].splitlines()
    assert lines[0] == "tag,asset,metric,unit,scale,interval_seconds"
    assert lines[1] == '"ns=3;s=20001:Site.PDUA01_PM0_PENRG","Site/Hall A/Row 1/PDUA01","energy_kwh","","",""' and len(lines) == 7


async def test_a_parent_that_is_gone_is_a_name_check_not_a_404(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    response = await client.post(lines_url(source), json=body_of(decision(), parent_id=424242))
    assert response.status_code == 200
    answer = response.json()
    assert answer["blocking"] is True and answer["csv"] == ""
    [name] = checks_of(answer, "name")
    assert name["severity"] == "blocking" and name["shape"] is None and "no longer exists" in name["text"]


async def test_a_parent_with_a_slash_in_its_name_is_a_name_check(client, db):
    source = await small_source(db)
    parent = await make_asset(db, "North/South")
    await login_as(client, db, "admin")
    answer = (await client.post(lines_url(source), json=body_of(decision(), parent_id=parent))).json()
    assert answer["blocking"] is True and checks_of(answer, "name")[0]["text"].startswith('The asset "North/South"')


async def test_lines_write_nothing_and_audit_nothing_even_when_they_block(client, db):
    source = await small_source(db)
    parent = await make_asset(db, "Hall A")
    await login_as(client, db, "admin")
    before = await table_counts(db)
    for body in (body_of(decision(), parent_id=parent), body_of(decision("pdua#_pm#_p", "active_power_kw", "part1_part2")), body_of(decision("gone#"))):
        assert (await client.post(lines_url(source), json=body)).status_code == 200
    assert await table_counts(db) == before


async def test_a_decision_on_a_shape_that_is_not_there_is_gone(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    answer = (await client.post(lines_url(source), json=body_of(decision(), decision("vanished#_x")))).json()
    [gone] = checks_of(answer, "gone")
    assert gone["severity"] == "blocking" and gone["shape"] == "vanished#_x"
    assert answer["blocking"] is True and answer["csv"] == "" and answer["lines"] == 6


async def test_the_server_reads_the_points_again_on_every_call(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    first = (await client.post(lines_url(source), json=body_of(decision()))).json()
    assert first["lines"] == 6
    await add_points(db, source, [("ns=3;s=20007:Site.PDUA07_PM0_PENRG", "PDUA07_PM0_PENRG", "kWh")])  # a re-browse found one more
    second = (await client.post(lines_url(source), json=body_of(decision()))).json()
    assert second["lines"] == 7 and second["csv"].count("PDUA07_PM0_PENRG") == 1
    pid = await db.fetchval("SELECT id FROM points WHERE source_id = $1 AND name = 'PDUA01_PM0_PENRG'", source)
    await make_mapping(db, pid, await make_asset(db, "Elsewhere"), "energy_kwh", 60)  # and somebody mapped one
    third = (await client.post(lines_url(source), json=body_of(decision()))).json()
    assert third["lines"] == 6 and third["by_shape"][0]["skipped_mapped"] == 1 and "PDUA01" not in third["csv"]


# -- the database key, and what only the planner can see ---------------------------------------------------------------------------

async def test_names_that_differ_only_in_case_collide_by_the_database_key(client, db):
    source = await make_source(db, "Cases", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    await add_points(db, source, [("a1", "PDUA01_P", "kW"), ("a2", "pdua01_P", "kW"), ("a3", "PDUA02_P", "kW"), ("a4", "PDUA03_P", "kW")])
    await login_as(client, db, "admin")
    answer = (await client.post(lines_url(source), json=body_of(decision("pdua#_p", "active_power_kw")))).json()
    [collision] = checks_of(answer, "collision")
    assert collision["severity"] == "blocking" and collision["shape"] == "pdua#_p" and answer["csv"] == ""
    assert collision["text"].startswith("2 tags of this shape would land on each asset (PDUA01 gets PDUA01_P and pdua01_P)")
    custom = (await client.post(lines_url(source), json=body_of(decision("pdua#_p", "custom", unit="kW")))).json()
    assert custom["blocking"] is False and custom["lines"] == 4


async def test_the_database_key_decides_not_python_casefold(client, db):
    # One shape for the shapes code (it casefolds: ss = ß), but two different asset names for PostgreSQL's lower(): Straße1 is not
    # STRASSE1 there, so these are three assets and no collision. Python's casefold would call two of them one.
    source = await make_source(db, "Casing", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    await add_points(db, source, [("a1", "Straße1_P", "kW"), ("a2", "STRASSE1_P", "kW"), ("a3", "STRASSE2_P", "kW")])
    await login_as(client, db, "admin")
    answer = (await client.post(lines_url(source), json=body_of(decision("strasse#_p", "active_power_kw")))).json()
    assert answer["checks"] == [] and answer["blocking"] is False and answer["lines"] == 3
    report = (await tag_list(client, source, answer["csv"])).json()
    assert report["ok"] is True and report["assets_to_create_total"] == 3 and report["mappings_to_create"] == 3


async def test_a_member_whose_derived_asset_already_holds_the_metric_is_a_planner_check(client, db):
    source = await small_source(db)
    other = await make_source(db, "Other", "opcua", {"endpoint": "opc.tcp://o:4840/"}, enabled=False)
    [pid] = await add_points(db, other, [("o1", "taken", "kWh")])
    await make_mapping(db, pid, await make_asset(db, "PDUA01"), "energy_kwh", 60)  # the asset the first line would land on
    await login_as(client, db, "admin")
    answer = (await client.post(lines_url(source), json=body_of(decision()))).json()
    [planner] = checks_of(answer, "planner")
    assert answer["blocking"] is True and answer["csv"] == "" and planner["severity"] == "blocking"
    assert planner["shape"] == "pdua#_pm#_penrg"
    assert planner["text"] == (
        'ns=3;s=20001:Site.PDUA01_PM0_PENRG would go on "PDUA01", but the asset "PDUA01" already has a mapping for energy_kwh'
    )
    assert answer["lines"] == 6


async def test_without_create_assets_every_missing_asset_is_refused_by_the_planner_five_shown_and_the_rest_counted(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    answer = (await client.post(lines_url(source), json=body_of(decision(), create_assets=False))).json()
    planner = checks_of(answer, "planner")
    assert answer["blocking"] is True and len(planner) == 6 and "does not exist" in planner[0]["text"]
    assert planner[5]["text"] == "1 more lines are refused as well; fix the ones above and check again" and planner[5]["shape"] is None


async def test_two_unmapped_points_of_one_tag_are_a_renumbered_check_under_every_metric_and_the_planner_is_not_asked(client, db):
    source = await make_source(db, "Stable", "opcua", {"endpoint": "opc.tcp://h:4840/", "stable_addresses": True}, enabled=False)
    await add_points(db, source, [
        ("ns=3;s=20403:Site.X01_P", "X01_P", "kW"), ("ns=3;s=Site.X01_P", "ns=3;s=Site.X01_P", "kW"),  # one tag, two spellings, both unmapped
        ("ns=3;s=20404:Site.X02_P", "X02_P", "kW"), ("ns=3;s=20405:Site.X03_P", "X03_P", "kW"),
    ])
    await login_as(client, db, "admin")
    for metric in ("active_power_kw", "custom"):  # a custom metric used to get through to the planner; it is the same tag either way
        answer = (await client.post(lines_url(source), json=body_of(decision("x#_p", metric)))).json()
        assert [c["kind"] for c in answer["checks"]] == ["renumbered"] and answer["csv"] == "", metric  # shown instead of a collision
        assert answer["checks"][0]["text"].startswith('1 tag of this shape appears twice (the SCADA renumbered it)'), metric
        assert answer["lines"] == 4 and answer["blocking"] is True and answer["plan_assets"] is None, metric


async def test_a_renumbered_tag_next_to_other_tags_of_its_asset_is_found_under_a_custom_metric_through_the_route(client, db):
    source = await make_source(db, "Next to", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)  # "Stable tag addresses" off: no twins
    await add_points(db, source, [
        ("ns=3;s=101:Site.PDUA01_T1", "PDUA01_T1", "degC"), ("ns=3;s=201:Site.PDUA01_T1", "PDUA01_T1", "degC"),
        ("ns=3;s=102:Site.PDUA01_T2", "PDUA01_T2", "degC"), ("ns=3;s=103:Site.PDUA02_T1", "PDUA02_T1", "degC"),
    ])
    await login_as(client, db, "admin")
    custom = (await client.post(lines_url(source), json=body_of(decision("pdua#_t#", "custom")))).json()
    assert [c["kind"] for c in custom["checks"]] == ["renumbered"] and custom["blocking"] is True and custom["csv"] == ""
    assert custom["checks"][0]["text"].startswith("1 tag of this shape appears twice (the SCADA renumbered it)") and custom["plan_assets"] is None
    power = (await client.post(lines_url(source), json=body_of(decision("pdua#_t#", "active_power_kw")))).json()  # the unit degC is not a power unit
    assert sorted(c["kind"] for c in power["checks"]) == ["collision", "renumbered", "units"]


async def test_a_stated_scale_or_unit_never_makes_a_unit_of_another_reading_right_through_the_route(client, db):
    source = await make_source(db, "Power as energy", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    await add_points(db, source, [(f"m{n}", f"M{n}_E", "kW") for n in (1, 2, 3)])
    await login_as(client, db, "admin")
    for extra in ({"scale": 1}, {"scale": 1000}, {}):
        answer = (await client.post(lines_url(source), json=body_of(decision("m#_e", "energy_kwh", **extra)))).json()
        assert [c["kind"] for c in answer["checks"]] == ["units"] and answer["blocking"] is True and answer["csv"] == "", extra
        assert answer["checks"][0]["text"].endswith("is not one that energy_kwh knows; decide those tags on the Points page")
    chosen = (await client.post(lines_url(source), json=body_of(decision("m#_e", "active_power_kw", unit="Wh")))).json()
    assert [c["kind"] for c in chosen["checks"]] == ["units"] and "chosen is not one that active_power_kw knows" in chosen["checks"][0]["text"]
    assert (await client.post(lines_url(source), json=body_of(decision("m#_e", "active_power_kw", unit="kW")))).json()["blocking"] is False


async def test_the_twin_of_a_mapped_tag_is_left_out_and_counted_on_a_stable_source(client, db):
    source = await make_source(db, "Stable", "opcua", {"endpoint": "opc.tcp://h:4840/", "stable_addresses": True}, enabled=False)
    ids = await add_points(db, source, [
        ("ns=3;s=20403:Site.X01_P", "X01_P", "kW"), ("ns=3;s=Site.X01_P", "ns=3;s=Site.X01_P", "kW"),
        ("ns=3;s=20404:Site.X02_P", "X02_P", "kW"), ("ns=3;s=20405:Site.X03_P", "X03_P", "kW"),
    ])
    await make_mapping(db, ids[0], await make_asset(db, "X01"), "active_power_kw")
    await login_as(client, db, "admin")
    answer = (await client.post(lines_url(source), json=body_of(decision("x#_p", "active_power_kw")))).json()
    assert answer["blocking"] is False and answer["lines"] == 2 and "Site.X01_P" not in answer["csv"]
    assert (answer["by_shape"][0]["skipped_mapped"], answer["by_shape"][0]["skipped_twins"]) == (1, 1)


async def test_a_line_over_1024_bytes_is_refused_by_the_parser_and_arrives_as_a_planner_check(client, db):
    source = await make_source(db, "Long", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    await add_points(db, source, [("ns=3;s=" + "a" * 492 + str(n), f"Z{n}_P", "kW") for n in (1, 2, 3)])  # 500-character tags
    parent = None
    for n in range(5):  # five levels of 100-character names: the asset cell alone is over 500 characters
        parent = await make_asset(db, f"{n}" * 100, parent)
    await login_as(client, db, "admin")
    answer = (await client.post(lines_url(source), json=body_of(decision("z#_p", "active_power_kw"), parent_id=parent))).json()
    [planner] = checks_of(answer, "planner")
    assert answer["blocking"] is True and answer["csv"] == "" and answer["lines"] == 3
    assert "is longer than 1,024 bytes" in planner["text"] and planner["shape"] is None


async def test_a_parent_seven_levels_deep_fits_part_1_and_not_part_1_part_2(client, db):
    source = await small_source(db)
    parent = None
    for n in range(1, 8):
        parent = await make_asset(db, f"Level {n}", parent)
    await login_as(client, db, "admin")
    fits = (await client.post(lines_url(source), json=body_of(decision(), parent_id=parent))).json()
    assert fits["blocking"] is False and fits["checks"] == []  # eight levels: the limit
    deep = (await client.post(lines_url(source), json=body_of(decision(name_from="part1_part2"), parent_id=parent))).json()
    planner = checks_of(deep, "planner")
    assert deep["blocking"] is True and "the asset path is 9 levels deep; at most 8" in planner[0]["text"]


async def test_a_tag_with_a_line_break_in_its_address_is_blocked_not_misattributed(client, db):
    source = await make_source(db, "Breaks", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    await add_points(db, source, [("ns=3;s=a\nb", "Z1_P", "kW"), ("ns=3;s=c", "Z2_P", "kW"), ("ns=3;s=d", "Z3_P", "kW")])
    await login_as(client, db, "admin")
    answer = (await client.post(lines_url(source), json=body_of(decision("z#_p", "active_power_kw")))).json()
    [check] = checks_of(answer, "address")  # the tag is not offered at all: the parser would split its line
    assert answer["blocking"] is True and answer["csv"] == "" and answer["lines"] == 2 and check["shape"] == "z#_p"
    assert check["text"].startswith("1 tag of this shape has an address a tag list cannot name exactly") and checks_of(answer, "planner") == []
    assert answer["plan_assets"] is None


async def test_an_address_with_a_space_at_its_end_is_not_mapped_onto_the_point_that_has_the_trimmed_address(client, db):
    source = await make_source(db, "Spaces", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    await add_points(db, source, [
        ("PDUA01_P ", "PDUA01_P", "kW"), ("PDUA01_P", "Other tag", "kW"),  # the list would read the first as the second
        ("PDUA02_P", "PDUA02_P", "kW"), ("PDUA03_P", "PDUA03_P", "kW"),
    ])
    await login_as(client, db, "admin")
    answer = (await client.post(lines_url(source), json=body_of(decision("pdua#_p", "active_power_kw")))).json()
    [check] = checks_of(answer, "address")
    assert answer["blocking"] is True and answer["csv"] == "" and answer["lines"] == 2 and check["severity"] == "blocking"
    assert checks_of(answer, "planner") == [] and "PDUA01" not in "".join(s["asset"] for s in answer["samples"])


async def test_mixed_units_and_custom_units_come_through_the_route(client, db):
    source = await make_source(db, "Units", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    await add_points(db, source, [("m1", "M1_E", "kWh"), ("m2", "M2_E", "kWh"), ("m3", "M3_E", "Wh")])
    await login_as(client, db, "admin")
    blocked = (await client.post(lines_url(source), json=body_of(decision("m#_e")))).json()
    assert [c["kind"] for c in blocked["checks"]] == ["mixed_units"] and blocked["checks"][0]["text"].startswith("This shape has the units kWh and Wh")
    custom = (await client.post(lines_url(source), json=body_of(decision("m#_e", "custom", unit="kWh")))).json()
    assert custom["blocking"] is False and '"kWh"' in custom["csv"].splitlines()[1]
    needs = (await client.post(lines_url(source), json=body_of(decision("m#_e", "custom")))).json()
    assert [c["kind"] for c in needs["checks"]] == ["custom_unit"]


async def test_the_unit_of_the_tags_reaches_the_scale_through_the_whole_route_and_into_the_mapping(client, db):
    source = await make_source(db, "Mega", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    await add_points(db, source, [(f"m{n}", f"M{n}_E", "MWh") for n in (1, 2, 3)])  # a counter in MWh mapped as kWh counts 1,000 times
    await login_as(client, db, "admin")
    answer = (await client.post(lines_url(source), json=body_of(decision("m#_e")))).json()
    assert answer["blocking"] is False and answer["checks"] == [] and answer["samples"][0]["scale"] == 1000.0
    assert answer["csv"].splitlines()[1] == '"m1","M1","energy_kwh","","1000.0",""'
    wrong = (await client.post(lines_url(source), json=body_of(decision("m#_e", scale=1)))).json()  # a scale of 1 for MWh: a bill 1,000 times too low
    assert [c["kind"] for c in wrong["checks"]] == ["units"] and wrong["blocking"] is True and wrong["csv"] == ""
    report = (await tag_list(client, source, answer["csv"])).json()
    assert report["ok"] is True
    real = await tag_list(client, source, answer["csv"], dry_run=False, expect_points=0, expect_assets=3, expect_mappings=3, expect_plan=report["plan_digest"])
    assert real.status_code == 200, real.text
    assert [float(row["scale"]) for row in await db.fetch("SELECT scale FROM mappings ORDER BY id")] == [1000.0] * 3


async def test_the_answer_says_how_many_assets_the_planner_would_create_so_a_renamed_parent_is_noticed(client, db):
    source = await small_source(db)
    hall = await make_asset(db, "Hall A")
    await login_as(client, db, "admin")
    answer = (await client.post(lines_url(source), json=body_of(decision(), parent_id=hall))).json()
    assert answer["plan_assets"] == 6 and answer["parent_path"] == ["Hall A"]
    assert (await tag_list(client, source, answer["csv"])).json()["assets_to_create_total"] == answer["plan_assets"]
    await db.execute("UPDATE assets SET name = 'Hall B' WHERE id = $1", hall)  # renamed after the lines were made
    later = (await tag_list(client, source, answer["csv"])).json()
    assert later["assets_to_create_total"] == 7 and later["assets_to_create_total"] != answer["plan_assets"]  # a second "Hall A" tree
    top = (await client.post(lines_url(source), json=body_of(decision()))).json()
    assert top["parent_path"] == [] and top["plan_assets"] == 6
    gone = (await client.post(lines_url(source), json=body_of(decision(), parent_id=424242))).json()
    assert gone["blocking"] is True and gone["parent_path"] == [] and gone["plan_assets"] is None  # nothing was asked of the planner
    blocked = (await client.post(lines_url(source), json=body_of(decision(), decision("vanished#_x")))).json()
    assert blocked["plan_assets"] is None
    nothing = (await client.post(lines_url(source), json=body_of(decision("vanished#_x")))).json()
    assert nothing["lines"] == 0 and nothing["plan_assets"] is None
    refused = (await client.post(lines_url(source), json=body_of(decision(), create_assets=False))).json()
    assert refused["blocking"] is True and refused["plan_assets"] == 0  # the planner ran, and would create no asset


# -- all the way through the tag-list route ---------------------------------------------------------------------------------------

async def test_the_lines_go_through_the_tag_list_dry_run_and_real_run_and_the_next_call_has_nothing_left(client, db):
    source = await small_source(db)
    parent = await make_asset(db, "Hall A")
    await login_as(client, db, "admin")
    both = body_of(decision(), decision("pdua#_pm#_p", "active_power_kw"), parent_id=parent)
    answer = (await client.post(lines_url(source), json=both)).json()
    assert answer["blocking"] is False and answer["lines"] == 12 and answer["checks"] == []
    dry = await tag_list(client, source, answer["csv"])
    report = dry.json()
    assert dry.status_code == 200 and report["ok"] is True and report["problems"] == []
    assert (report["mappings_to_create"], report["assets_to_create_total"], report["points_to_create"]) == (12, 6, 0)
    real = await tag_list(
        client, source, answer["csv"], dry_run=False, expect_points=0, expect_assets=6, expect_mappings=12, expect_plan=report["plan_digest"],
    )
    assert real.status_code == 200, real.text
    assert await db.fetchval("SELECT count(*) FROM mappings") == 12
    energy = await db.fetchval(
        "SELECT count(*) FROM mappings m JOIN assets a ON a.id = m.asset_id JOIN assets p ON p.id = a.parent_id "
        "WHERE m.metric = 'energy_kwh' AND p.name = 'Hall A' AND a.name LIKE 'PDUA0%'"
    )
    assert energy == 6
    again = (await client.post(lines_url(source), json=both)).json()
    assert again["lines"] == 0 and again["csv"] == "" and again["blocking"] is False
    assert [c["kind"] for c in again["checks"]] == ["nothing", "nothing"]
    assert [(s["lines"], s["skipped_mapped"]) for s in again["by_shape"]] == [(0, 6), (0, 6)]


async def test_a_thousand_lines_of_a_15000_tag_source_pass_the_real_dry_run_with_no_problem(client, db):
    source = await make_source(db, "Big", "opcua", {"endpoint": "opc.tcp://h:4840/"}, enabled=False)
    await add_points(db, source, scada_rows(200, 4190))
    await login_as(client, db, "admin")
    chosen = [  # one metric per shape, so no two lines share an asset and a metric
        decision("pdua#_pm#_penrg"), decision("pdub#_pm#_penrg"), decision("pdua#_pm#_p", "active_power_kw"),
        decision("pdua#_pm#_s", "apparent_power_kva"), decision("pdua#_pm#_q", "reactive_power_kvar"),
    ]
    started = time.perf_counter()
    response = await client.post(lines_url(source), json=body_of(*chosen))
    took = time.perf_counter() - started
    answer = response.json()
    print(f"POST shapes/lines of 1,000 lines on 15,000 points took {took:.2f} s, {len(response.content):,} bytes")
    assert response.status_code == 200 and answer["lines"] == 1000 and answer["blocking"] is False, answer["checks"]
    assert answer["checks"] == [] and len(answer["samples"]) == 25 and took < 10.0  # loose: other lanes share the machine
    report = (await tag_list(client, source, answer["csv"])).json()
    assert report["ok"] is True and report["mappings_to_create"] == 1000 and report["assets_to_create_total"] == 400
    too_many = (await client.post(lines_url(source), json=body_of(decision("pdua#_q#_p", "active_power_kw", "parts12")))).json()
    assert too_many["lines"] == 4190 and too_many["blocking"] is True and [c["kind"] for c in too_many["checks"]] == ["too_many"]


# -- saved rules: GET and PUT /api/sources/{id}/shape-rules (T7a) -------------------------------------------------------------------

def rules_url(source: int) -> str:
    return f"/api/sources/{source}/shape-rules"


ENERGY_RULE = {"metric": "energy_kwh", "name_from": "part1"}
POWER_RULE = {"metric": "active_power_kw", "unit": "kW", "scale": 0.001, "interval_seconds": 30, "name_from": "parts12"}


async def stored_rules(db, source: int):
    return await db.fetchval("SELECT value FROM settings WHERE key = $1", f"shape_rules:{source}")


async def test_a_source_without_rules_answers_an_empty_set(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    response = await client.get(rules_url(source))
    assert response.status_code == 200 and response.json() == {"rules": {}}
    assert await stored_rules(db, source) is None  # reading writes nothing


async def test_rules_round_trip_and_the_put_answers_what_the_get_will(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    body = {"rules": {"pdua#_pm#_penrg": ENERGY_RULE, "pdua#_pm#_p": POWER_RULE}}
    put = await client.put(rules_url(source), json=body)
    assert put.status_code == 200 and put.json() == body
    assert (await client.get(rules_url(source))).json() == body
    stored = await stored_rules(db, source)
    assert (json.loads(stored) if isinstance(stored, str) else stored) == body  # one settings row, under the documented key


async def test_a_put_replaces_the_whole_rule_set_and_an_empty_set_forgets_everything(client, db):
    source = await small_source(db)
    other = await make_source(db, "Other", "opcua", {"endpoint": "opc.tcp://o:4840/"}, enabled=False)
    await login_as(client, db, "admin")
    await client.put(rules_url(other), json={"rules": {"x#": ENERGY_RULE}})
    await client.put(rules_url(source), json={"rules": {"pdua#_pm#_penrg": ENERGY_RULE, "pdua#_pm#_p": POWER_RULE}})
    await client.put(rules_url(source), json={"rules": {"pdua#_pm#_p": ENERGY_RULE}})  # the energy rule is gone, the power rule is replaced
    assert (await client.get(rules_url(source))).json() == {"rules": {"pdua#_pm#_p": ENERGY_RULE}}
    assert (await client.put(rules_url(source), json={"rules": {}})).json() == {"rules": {}}
    assert (await client.get(rules_url(source))).json() == {"rules": {}}
    assert (await client.get(rules_url(other))).json() == {"rules": {"x#": ENERGY_RULE}}  # another source's rules are its own


async def test_an_empty_unit_is_not_kept_and_the_optional_keys_are_left_out(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    sent = {"rules": {"pdua#_pm#_penrg": {"metric": "energy_kwh", "unit": "  ", "name_from": "part1_part2"}}}
    assert (await client.put(rules_url(source), json=sent)).json() == {"rules": {"pdua#_pm#_penrg": {"metric": "energy_kwh", "name_from": "part1_part2"}}}


async def test_rules_for_an_unknown_source_are_a_404_and_a_bad_id_a_422(client, db):
    await login_as(client, db, "admin")
    for call in (client.get("/api/sources/9999/shape-rules"), client.put("/api/sources/9999/shape-rules", json={"rules": {}})):
        response = await call
        assert response.status_code == 404 and response.json()["detail"] == "source not found"
    assert (await client.get("/api/sources/0/shape-rules")).status_code == 422
    assert (await client.put("/api/sources/2147483648/shape-rules", json={"rules": {}})).status_code == 422
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key LIKE 'shape_rules:%'") == 0  # a 404 stores nothing


@pytest.mark.parametrize(
    "body",
    [
        {},  # `rules` is required
        {"rules": {}, "extra": 1},  # extra keys are forbidden
        {"rules": {"k#": {**ENERGY_RULE, "shape": "k#"}}},  # a rule is not a decision: it has no `shape`
        {"rules": {"k#": {**ENERGY_RULE, "extra": 1}}},
        {"rules": {"k#": {"metric": "energy_kwh"}}},  # name_from is required
        {"rules": {"k#": {"metric": "bogus", "name_from": "part1"}}},
        {"rules": {"k#": {**ENERGY_RULE, "name_from": "part3"}}},
        {"rules": {"k#": {**ENERGY_RULE, "scale": 0}}},
        {"rules": {"k#": {**ENERGY_RULE, "scale": -1}}},
        {"rules": {"k#": {**ENERGY_RULE, "scale": 1e30}}},
        {"rules": {"k#": {**ENERGY_RULE, "interval_seconds": 0}}},
        {"rules": {"k#": {**ENERGY_RULE, "interval_seconds": 2_678_401}}},
        {"rules": {"k#": {**ENERGY_RULE, "unit": "x" * 21}}},
        {"rules": {"k#": {**ENERGY_RULE, "unit": "k\nW"}}},
        {"rules": {"": ENERGY_RULE}},  # an empty key names no shape
        {"rules": {"k" * 2001: ENERGY_RULE}},
        {"rules": {f"k{i}#": ENERGY_RULE for i in range(301)}},  # at most 300 rules
        {"rules": [ENERGY_RULE]},
    ],
    ids=lambda body: str(body)[:60],
)
async def test_a_bad_rule_body_is_a_422_and_stores_nothing(client, db, body):
    source = await small_source(db)
    await login_as(client, db, "admin")
    assert (await client.put(rules_url(source), json=body)).status_code == 422
    assert await stored_rules(db, source) is None


async def test_exactly_300_rules_are_accepted(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    body = {"rules": {f"k{i}#": ENERGY_RULE for i in range(300)}}
    assert (await client.put(rules_url(source), json=body)).status_code == 200
    assert len((await client.get(rules_url(source))).json()["rules"]) == 300


async def test_the_gates_operator_reads_rules_and_cannot_write_them(client, db):
    source = await small_source(db)
    body = {"rules": {"pdua#_pm#_penrg": ENERGY_RULE}}
    assert (await client.get(rules_url(source))).status_code == 401
    assert (await client.put(rules_url(source), json=body)).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get(rules_url(source))).status_code == 403
    assert (await client.put(rules_url(source), json=body)).status_code == 403
    await client.post("/api/logout")
    await login_as(client, db, "operator")  # holds discovery.view, not discovery.accept
    assert (await client.get(rules_url(source))).status_code == 200
    assert (await client.put(rules_url(source), json=body)).status_code == 403
    assert await stored_rules(db, source) is None
    await client.post("/api/logout")
    await login_as(client, db, "admin")
    assert (await client.put(rules_url(source), json=body)).status_code == 200


@pytest.mark.parametrize(
    "stored",
    [
        "[1, 2]",  # not an object
        '"text"',
        "5",
        "null",
        '{"rules": 5}',
        '{"rules": [1]}',
        '{"other": {}}',  # no `rules`
        '{"rules": {"k#": {"metric": "bogus", "name_from": "part1"}}}',
        '{"rules": {"k#": {"metric": "energy_kwh"}}}',
        '{"rules": {"k#": {"metric": "energy_kwh", "name_from": "part1", "scale": -3}}}',
        '{"rules": {"good#": {"metric": "energy_kwh", "name_from": "part1"}, "bad#": 7}}',  # one broken rule spoils the stored value
    ],
)
async def test_a_broken_stored_value_reads_as_no_rules_and_never_raises(client, db, stored):
    source = await small_source(db)
    await db.execute("INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)", f"shape_rules:{source}", stored)
    await login_as(client, db, "admin")
    assert (await client.get(rules_url(source))).json() == {"rules": {}}
    shapes = await client.get(f"/api/sources/{source}/shapes")
    assert shapes.status_code == 200 and all(s["rule"] is None for s in shapes.json()["shapes"])


async def test_the_shapes_answer_carries_the_saved_rule_of_each_key_or_null(client, db):
    source = await small_source(db)  # shapes pdua#_pm#_penrg (energy) and pdua#_pm#_p (power)
    await login_as(client, db, "admin")
    assert all(s["rule"] is None for s in (await client.get(f"/api/sources/{source}/shapes")).json()["shapes"])
    await client.put(rules_url(source), json={"rules": {"pdua#_pm#_penrg": ENERGY_RULE, "gone#": POWER_RULE}})
    energy, power = (await client.get(f"/api/sources/{source}/shapes")).json()["shapes"]
    assert (energy["key"], energy["rule"]) == ("pdua#_pm#_penrg", ENERGY_RULE)
    assert (power["key"], power["rule"]) == ("pdua#_pm#_p", None)  # a rule of a shape the source no longer has is simply not shown
    filtered = (await client.get(f"/api/sources/{source}/shapes", params={"q": "PENRG"})).json()["shapes"]
    assert [(s["key"], s["rule"]) for s in filtered] == [("pdua#_pm#_penrg", ENERGY_RULE)]


# -- w38: a rule saved under the key the old text built (the cluster in the key) is kept and not shown --------------------------------
# The cap of 300 rules is not tested again here: it is pinned by the `range(301)` case of `test_a_bad_rule_body_is_a_422_and_stores_nothing`
# and by `test_exactly_300_rules_are_accepted`. An orphan counts toward it, as any rule does.

OLD_POWER_KEY = "qatarmv#.pdua#_pm#_p"  # w36 built this from the DisplayName `QatarMV2.PDUA01_PM0_P` of a stable-address source
NEW_POWER_KEY = "pdua#_pm#_p"  # w38 builds this from the address, whatever the DisplayName says
COUNTER_RULE = {"metric": "energy_kwh", "name_from": "parts12"}  # unlike ENERGY_RULE, so a rule under the wrong key shows


async def cluster_source(db) -> int:
    """A source with Stable tag addresses whose DisplayNames carry the cluster: power and energy tags of four PDUs."""
    source = await make_source(db, "Qatar MV2", "opcua", {"endpoint": "opc.tcp://h:4840/plantscada", "stable_addresses": True}, enabled=False)
    rows = [(f"ns=3;s=QatarMV2.PDUA{n:02d}_PM0_P", f"QatarMV2.PDUA{n:02d}_PM0_P", "kW") for n in range(1, 5)]
    rows += [(f"ns=3;s=QatarMV2.PDUA{n:02d}_PM0_PENRG", f"QatarMV2.PDUA{n:02d}_PM0_PENRG", "kWh") for n in range(1, 5)]
    await add_points(db, source, rows)
    return source


async def test_a_rule_under_the_old_key_is_kept_and_listed_and_only_the_new_key_shows_a_rule(client, db):
    source = await cluster_source(db)
    numbered = await small_source(db)
    await login_as(client, db, "admin")
    reference = (await client.get(f"/api/sources/{numbered}/shapes")).json()
    saved = {"rules": {OLD_POWER_KEY: POWER_RULE, NEW_POWER_KEY: ENERGY_RULE}}
    assert (await client.put(rules_url(source), json=saved)).status_code == 200
    body = (await client.get(f"/api/sources/{source}/shapes")).json()
    assert [s["key"] for s in body["shapes"]] == ["pdua#_pm#_penrg", NEW_POWER_KEY]  # as for a numbered source: the cluster is not in the key
    assert [s["count"] for s in body["shapes"]] == [4, 4] and body["points"] == 8 and body["other_tags"] == 0
    assert {s["key"]: s["rule"] for s in body["shapes"]} == {"pdua#_pm#_penrg": None, NEW_POWER_KEY: ENERGY_RULE}  # the old key shows nowhere
    shape_fields = {frozenset(s) for s in reference["shapes"]}
    assert list(body) == list(reference)  # no new field in the answer ...
    assert len(shape_fields) == 1 and {frozenset(s) for s in body["shapes"]} == shape_fields  # ... nor in a shape
    assert (await client.get(rules_url(source))).json() == saved  # the orphan is kept and listed beside the rule that shows


async def test_a_put_of_the_merged_rules_keeps_the_orphan(client, db):
    source = await cluster_source(db)
    await login_as(client, db, "admin")
    await client.put(rules_url(source), json={"rules": {OLD_POWER_KEY: POWER_RULE, NEW_POWER_KEY: ENERGY_RULE}})
    merged = {"rules": {OLD_POWER_KEY: POWER_RULE, NEW_POWER_KEY: ENERGY_RULE, "pdua#_pm#_penrg": COUNTER_RULE}}  # what the page sends (mergeRules)
    put = await client.put(rules_url(source), json=merged)
    assert put.status_code == 200 and put.json() == merged
    assert (await client.get(rules_url(source))).json() == merged
    stored = await stored_rules(db, source)
    assert (json.loads(stored) if isinstance(stored, str) else stored) == merged
    shapes = (await client.get(f"/api/sources/{source}/shapes")).json()["shapes"]
    assert {s["key"]: s["rule"] for s in shapes} == {"pdua#_pm#_penrg": COUNTER_RULE, NEW_POWER_KEY: ENERGY_RULE}


async def test_the_shapes_answer_reads_the_settings_once(client, db):
    from test_moves_freshness import statements

    source = await small_source(db)
    await login_as(client, db, "admin")
    await client.put(rules_url(source), json={"rules": {"pdua#_pm#_penrg": ENERGY_RULE}})
    await client.get(f"/api/sources/{source}/shapes")  # one unmeasured request: a session touch is written once
    with statements() as sql:
        assert (await client.get(f"/api/sources/{source}/shapes")).status_code == 200
    assert sum("FROM settings" in statement for statement in sql) == 1, sql


async def test_saving_rules_changes_no_mapping_asset_or_point(client, db):
    source = await small_source(db)
    await login_as(client, db, "admin")
    before = [await db.fetchval(f"SELECT count(*) FROM {table}") for table in ("mappings", "assets", "points", "audit_log")]
    await client.put(rules_url(source), json={"rules": {"pdua#_pm#_penrg": ENERGY_RULE}})
    assert [await db.fetchval(f"SELECT count(*) FROM {table}") for table in ("mappings", "assets", "points", "audit_log")] == before
