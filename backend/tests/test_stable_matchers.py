"""w34: the tag list and the file import find a point of a source with "Stable tag addresses" by the stable spelling of its address.

A stored point `ns=3;s=20403:Site.PDUA01_PM0_P` is named by a list or a file as `ns=3;s=Site.PDUA01_PM0_P` (the option on); with the
option off the two spellings are two addresses, exactly as before. Two stored points that are one tag (`20403:` and `20410:` of the
same tag) are refused as a tag, also by their exact spelling: mapping one of them would map one tag twice. Both matchers take the key
from `address_key_for`, so they agree with the read and the browse about what a tag is.
"""
from datetime import UTC, datetime

from dcdash.connectors.opcua_ids import AddressIndex, address_key_for, identity_key, stable_address
from dcdash.ingest import importer
from dcdash.ingest import tag_list as tl
from helpers import login_as, make_asset, make_point, make_source
from importer_helpers import make_profile, make_world, parse, reasons
from test_api_asset_move_concurrency import finished, pending
from test_api_delete_locks import holder
from test_api_tag_lists import body_of, counts, dry, real
from test_ingest_importer import run as run_import
from test_ingest_importer import text as csv_text

NUMBERED = "ns=3;s=20403:Site.PDUA01_PM0_P"
TWIN = "ns=3;s=20410:Site.PDUA01_PM0_P"  # the same tag after the SCADA project changed
STABLE = "ns=3;s=Site.PDUA01_PM0_P"
OTHER = "ns=3;s=20404:Site.PDUA01_PM0_E"
OTHER_STABLE = "ns=3;s=Site.PDUA01_PM0_E"


def on(*stored: tuple[str, int]) -> AddressIndex[int]:
    return AddressIndex(stored, stable_address)


def off(*stored: tuple[str, int]) -> AddressIndex[int]:
    return AddressIndex(stored, identity_key)


def planned(*lines: str, points, mapped=(), connector="opcua"):
    """Plan a list of `tag,asset,metric,unit` lines against an existing asset `Hall` (id 1) and the given points."""
    parsed = tl.parse_tag_list(("tag,asset,metric,unit\n" + "\n".join(lines) + "\n").encode())
    keys = {part: part.casefold() for part in tl.segments_of(parsed)}
    index = tl.AssetIndex.build([(1, None, "hall")])
    return tl.plan(
        parsed, connector_type=connector, create_assets=True, index=index, points=points, seg_keys=keys,
        mapped_points=set(mapped), asset_metrics=set(),
    )


def problems(result) -> list[tuple[int, str]]:
    return [(p.line, p.reason) for p in result.problems]


# ---- the key: one function for every matcher ----------------------------------------------------------------------------------------


def test_the_matchers_take_their_key_from_the_source_and_the_option_is_the_real_boolean():
    assert address_key_for("opcua", {"stable_addresses": True})(NUMBERED) == STABLE
    for config in ({}, {"stable_addresses": False}, {"stable_addresses": "true"}, {"stable_addresses": 1}, None):
        assert address_key_for("opcua", config)(NUMBERED) == NUMBERED
    assert address_key_for("modbus", {"stable_addresses": True})(NUMBERED) == NUMBERED  # another kind of source never strips a number


# ---- the tag list ----------------------------------------------------------------------------------------------------------------------


def test_a_stable_tag_names_the_numbered_point_with_the_option_on_and_the_plan_creates_no_point():
    result = planned(f"{STABLE},Hall,active_power_kw,kW", points=on((NUMBERED, 7)))
    assert result.ok and not result.points
    assert [(m.line, m.point_id) for m in result.mappings] == [(2, 7)]


def test_the_numbered_tag_names_the_point_stored_in_the_stable_spelling_too():
    assert planned(f"{NUMBERED},Hall,active_power_kw,kW", points=on((STABLE, 7))).mappings[0].point_id == 7


def test_with_the_option_off_the_same_tag_is_still_no_point_of_the_source():
    result = planned(f"{STABLE},Hall,active_power_kw,kW", points=off((NUMBERED, 7)))
    assert problems(result) == [(2, "no point with this address on this source: run Browse first")]
    assert problems(planned(f"{STABLE},Hall,active_power_kw,kW", points={NUMBERED: 7})) == problems(result)  # a plain mapping is the same


def test_a_tag_two_stored_points_share_is_refused_in_either_spelling_and_for_an_exact_address_too():
    points = on((NUMBERED, 7), (TWIN, 8), (OTHER, 9))
    assert tl.TWO_POINTS == "two points of this source have the same stable address"
    for tag in (STABLE, NUMBERED, TWIN):
        result = planned(f"{tag},Hall,active_power_kw,kW", points=points)
        assert problems(result) == [(2, tl.TWO_POINTS)] and not result.mappings, tag
    assert planned(f"{OTHER_STABLE},Hall,active_power_kw,kW", points=points).mappings[0].point_id == 9  # a tag nobody shares is served


def test_the_same_two_stored_addresses_are_two_tags_with_the_option_off():
    result = planned(f"{NUMBERED},Hall,active_power_kw,kW", f"{TWIN},Hall,energy_kwh,kWh", points=off((NUMBERED, 7), (TWIN, 8)))
    assert result.ok and [m.point_id for m in result.mappings] == [7, 8]


def test_two_lines_that_are_one_tag_are_refused_like_a_repeated_tag():
    result = planned(
        f"{NUMBERED},Hall,active_power_kw,kW", f"{STABLE},Hall,energy_kwh,kWh", points=on((NUMBERED, 7)),
    )
    assert problems(result) == [(3, "this tag is already on line 2")]
    # with the option off the two spellings are two tags, and the second is not a point of the source
    off_result = planned(f"{NUMBERED},Hall,active_power_kw,kW", f"{STABLE},Hall,energy_kwh,kWh", points=off((NUMBERED, 7)))
    assert problems(off_result) == [(3, "no point with this address on this source: run Browse first")]


def test_a_point_that_is_mapped_already_is_refused_by_either_spelling():
    result = planned(f"{STABLE},Hall,active_power_kw,kW", points=on((NUMBERED, 7)), mapped=[7])
    assert problems(result) == [(2, "this point is already mapped")]


def test_touched_names_the_point_a_stable_tag_finds_and_none_for_a_shared_tag():
    parsed = tl.parse_tag_list(f"tag,asset,metric\n{STABLE},Hall,energy_kwh\n{OTHER_STABLE},Hall,energy_kwh\n".encode())
    index = tl.AssetIndex.build([(1, None, "hall")])
    keys = {"Hall": "hall"}
    assert tl.touched(parsed, index, keys, on((NUMBERED, 7), (OTHER, 9))) == ({7, 9}, {1})
    assert tl.touched(parsed, index, keys, on((NUMBERED, 7), (TWIN, 8), (OTHER, 9))) == ({9}, {1})


# ---- the tag list through the route ---------------------------------------------------------------------------------------------------


async def scada(db, option: bool, name: str = "scada") -> int:
    return await make_source(db, name, "opcua", {"endpoint": "opc.tcp://scada:4840", "stable_addresses": option})


async def test_a_list_in_the_stable_spelling_maps_the_numbered_point_with_the_option_on(client, db):
    await login_as(client, db)
    source = await scada(db, True)
    point = await make_point(db, source, NUMBERED)
    body = body_of(f"{STABLE},Hall 1 / Meter 01,active_power_kw,kW,meter")
    report = (await dry(client, source, body)).json()
    assert report["ok"] and report["points_to_create"] == 0 and report["mappings_to_create"] == 1, report
    created = await real(client, source, body, report)
    assert created.status_code == 200, created.text
    assert await db.fetchval("SELECT point_id FROM mappings") == point
    assert await db.fetchval("SELECT count(*) FROM points") == 1  # an OPC UA list never creates a point
    assert await db.fetchval("SELECT address FROM points WHERE id = $1", point) == NUMBERED  # the stored address is not rewritten


async def test_the_same_list_is_a_problem_line_and_nothing_with_the_option_off(client, db):
    await login_as(client, db)
    source = await scada(db, False)
    await make_point(db, source, NUMBERED)
    body = body_of(f"{STABLE},Hall 1 / Meter 01,active_power_kw,kW,meter")
    report = (await dry(client, source, body)).json()
    assert not report["ok"]
    assert report["problems"][0]["reason"] == "no point with this address on this source: run Browse first"
    base = await counts(db)
    refused = await real(client, source, body, report)
    assert refused.status_code == 422 and "no point with this address" in refused.json()["detail"]
    assert await counts(db) == base


async def test_a_tag_two_points_share_is_refused_by_both_runs_and_maps_neither(client, db):
    await login_as(client, db)
    source = await scada(db, True)
    await make_point(db, source, NUMBERED)
    await make_point(db, source, TWIN)
    body = body_of(f"{STABLE},Hall 1 / Meter 01,active_power_kw,kW,meter", f"{OTHER},Hall 1 / Meter 02,energy_kwh,kWh,meter")
    report = (await dry(client, source, body)).json()
    assert [(p["line"], p["reason"]) for p in report["problems"]] == [
        (2, tl.TWO_POINTS), (3, "no point with this address on this source: run Browse first"),
    ]
    exact = (await dry(client, source, body_of(f"{TWIN},Hall 1 / Meter 01,active_power_kw,kW,meter"))).json()
    assert [(p["line"], p["reason"]) for p in exact["problems"]] == [(2, tl.TWO_POINTS)]
    base = await counts(db)
    refused = await real(client, source, body, report)
    assert refused.status_code == 422 and tl.TWO_POINTS in refused.json()["detail"], refused.text
    assert await counts(db) == base and await db.fetchval("SELECT count(*) FROM mappings") == 0


async def test_a_list_for_a_source_that_is_not_opcua_ignores_the_option(client, db):
    await login_as(client, db)
    source = await make_source(db, "modbus", "modbus", {"host": "10.0.0.1", "port": 502, "stable_addresses": True})
    await make_point(db, source, NUMBERED)
    report = (await dry(client, source, body_of(f"{STABLE},Hall,active_power_kw,kW,meter"))).json()
    assert not report["ok"] and "no point with this address" in report["problems"][0]["reason"]


async def test_the_real_run_still_takes_the_source_row_before_the_asset_locks(client, db):
    """The source row is taken first (w31): while another transaction holds it, the run has locked no asset. It is still the order
    after the matcher changed, and the run goes on and maps the numbered point once the holder lets go."""
    await login_as(client, db)
    source = await scada(db, True)
    point = await make_point(db, source, NUMBERED)
    hall = await make_asset(db, "Hall 1")
    body = body_of(f"{STABLE},Hall 1,voltage_v,V,")
    report = (await dry(client, source, body, create=False)).json()
    assert report["ok"], report
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM sources WHERE id = $1 FOR UPDATE", source)
        run = await pending(db, 1, real(client, source, body, report, create=False))
        # The run waits at the source row. Had it locked the asset (FOR KEY SHARE) first, this FOR UPDATE would not get it.
        assert await conn.fetchval("SELECT id FROM assets WHERE id = $1 FOR UPDATE NOWAIT", hall) == hall
        await tx.rollback()
        (response,) = await finished(run)
    assert response.status_code == 200, response.text
    assert await db.fetchval("SELECT asset_id FROM mappings WHERE point_id = $1", point) == hall


# ---- the file import -------------------------------------------------------------------------------------------------------------------


def power(info_id: int = 1):
    return importer.point_info(info_id, "active_power_kw", 1.0, "counter")


def test_a_file_in_the_stable_spelling_feeds_the_numbered_point_with_the_option_on():
    points = on((NUMBERED, power(1)), (OTHER, importer.point_info(2, "energy_kwh", 1.0, "counter")))
    result = parse([f"{STABLE},2026-10-20T10:00:00Z,5,kW,good", f"{OTHER_STABLE},2026-10-20T10:00:00Z,6,kWh,good"], points=points)
    assert [(row.tag, row.point_id) for row in result.kept] == [(STABLE, 1), (OTHER_STABLE, 2)] and not result.unknown_rows


def test_the_same_file_names_no_point_with_the_option_off():
    result = parse([f"{STABLE},2026-10-20T10:00:00Z,5,kW,good"], points={NUMBERED: power(1)})
    assert not result.kept and result.unknown_rows == 1 and list(result.unknown) == [STABLE]
    assert parse([f"{STABLE},2026-10-20T10:00:00Z,5,kW,good"], points=off((NUMBERED, power(1)))).unknown_rows == 1


def test_a_plain_mapping_of_points_keeps_its_series_under_the_tag_as_written():
    result = parse(["P.kW,2026-10-20T10:00:00Z,5,kW,good"])
    assert list(result.last) == ["P.kW"] and [row.tag for row in result.kept] == ["P.kW"]


def test_a_file_that_carries_both_spellings_of_one_tag_has_one_series_not_two():
    """A copy of the line under the other spelling is the same row repeated, not a second series for the same point: the series
    state (the last instant and the last text, which settle the repeated autumn hour) is shared."""
    profile = make_profile(unit=None, quality=None, zone="Europe/Berlin")
    lines = [f"{NUMBERED},2026-10-25T01:45,1", f"{NUMBERED},2026-10-25T02:30,4", f"{STABLE},2026-10-25T02:30,4"]
    ctx_points = on((NUMBERED, power(1)))
    result = parse(lines, points=ctx_points, profile=profile, now=datetime(2026, 10, 26, 12, tzinfo=UTC), header="tag,timestamp,value")
    assert len(result.kept) == 2 and reasons(result) == {importer.DUPLICATE: 1}  # the copy under the other spelling is the duplicate
    assert list(result.last) == [STABLE] and list(result.echo) == [STABLE]  # one series, filed under the tag's stable spelling


async def opcua_world(db, tags: dict, option: bool, name: str = "scada") -> tuple[int, dict[str, int]]:
    source, ids = await make_world(db, tags, name=name, connector_type="opcua")
    await db.execute("UPDATE sources SET config = $1 WHERE id = $2", {"stable_addresses": option}, source)
    return source, ids


async def test_an_import_in_the_stable_spelling_stores_readings_on_the_numbered_points_with_the_option_on(db):
    source, ids = await opcua_world(db, {NUMBERED: ("active_power_kw", 1.0), OTHER: ("energy_kwh", 1.0)}, True)
    body = csv_text(f"{STABLE},2026-10-20T10:00:00Z,5,kW,good", f"{OTHER_STABLE},2026-10-20T10:00:00Z,6,kWh,good")
    dry_report = await run_import(db, source, body, dry=True)
    report = await run_import(db, source, body, dry=False)
    assert (dry_report.new, dry_report.unknown_rows) == (report.new, report.unknown_rows) == (2, 0)
    rows = await db.fetch("SELECT point_id, value FROM readings ORDER BY value")
    assert [(row["point_id"], row["value"]) for row in rows] == [(ids[NUMBERED], 5.0), (ids[OTHER], 6.0)]


async def test_the_same_import_stores_nothing_and_names_the_tags_with_the_option_off(db):
    source, _ = await opcua_world(db, {NUMBERED: ("active_power_kw", 1.0)}, False)
    report = await run_import(db, source, csv_text(f"{STABLE},2026-10-20T10:00:00Z,5,kW,good"), dry=False)
    assert (report.new, report.unknown_rows, report.unknown_names) == (0, 1, [STABLE])
    assert await db.fetchval("SELECT count(*) FROM readings") == 0


async def test_rows_for_a_tag_two_points_share_are_unknown_rows_and_the_other_points_are_served(db):
    source, ids = await opcua_world(
        db, {NUMBERED: ("active_power_kw", 1.0), TWIN: (None, 1.0), OTHER: ("energy_kwh", 1.0)}, True
    )
    body = csv_text(
        f"{STABLE},2026-10-20T10:00:00Z,5,kW,good", f"{TWIN},2026-10-20T11:00:00Z,7,kW,good",
        f"{NUMBERED},2026-10-20T12:00:00Z,8,kW,good", f"{OTHER_STABLE},2026-10-20T10:00:00Z,6,kWh,good",
    )
    report = await run_import(db, source, body, dry=False)
    assert (report.new, report.unknown_rows) == (1, 3)
    assert sorted(report.unknown_names) == sorted([STABLE, TWIN, NUMBERED])
    assert [row["point_id"] for row in await db.fetch("SELECT point_id FROM readings")] == [ids[OTHER]]


async def test_another_source_with_the_same_addresses_is_not_touched_by_the_option_of_this_one(db):
    on_source, on_ids = await opcua_world(db, {NUMBERED: ("active_power_kw", 1.0)}, True, name="on")
    off_source, off_ids = await opcua_world(db, {NUMBERED: ("active_power_kw", 1.0)}, False, name="off")
    body = csv_text(f"{STABLE},2026-10-20T10:00:00Z,5,kW,good")
    assert (await run_import(db, off_source, body, dry=False)).new == 0
    assert (await run_import(db, on_source, body, dry=False)).new == 1
    assert [row["point_id"] for row in await db.fetch("SELECT point_id FROM readings")] == [on_ids[NUMBERED]]
    assert off_ids[NUMBERED] != on_ids[NUMBERED]
