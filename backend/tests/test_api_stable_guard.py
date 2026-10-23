"""The API refuses a second mapping of the same tag when a source reads addresses by their stable form (w34 T4, R4, D3, D4).

With "Stable tag addresses" on, `ns=3;s=20410:Site.X` and `ns=3;s=20403:Site.X` are ONE tag to the poll. PATCH turning the option on,
POST /api/mappings and POST /api/discovery/accept refuse a state where both are mapped; GET /api/discovery/graph marks the unmapped
twin of a mapped point. A source with the option off, and every other kind of source, behaves as before.
"""
import asyncio
import json

import pytest

from dcdash.core.crypto import decrypt
from helpers import login_as, make_asset, make_mapping, make_point, make_source
from test_api_asset_move_concurrency import finished, pending
from test_api_delete_locks import WAIT, holder

OLD = "ns=3;s=20410:Site.PDUA01_PM0_P"  # the same tag under two numbers: what a re-browse after a renumbering leaves
NEW = "ns=3;s=20403:Site.PDUA01_PM0_P"
OTHER = "ns=3;s=20404:Site.PDUA01_PM0_Q"
ENDPOINT = "opc.tcp://scada:4840/plantscada"


async def opcua(db, stable: bool | None, name="scada", **config) -> int:
    settings = {"endpoint": ENDPOINT, **config}
    if stable is not None:
        settings["stable_addresses"] = stable
    return await make_source(db, name, "opcua", settings)


async def two_twins(db, stable=False, mapped_both=True):
    """A source with the twin points OLD and NEW, each on its own asset; OLD mapped, NEW mapped when asked."""
    source = await opcua(db, stable)
    old, new = await make_point(db, source, OLD), await make_point(db, source, NEW)
    await make_mapping(db, old, await make_asset(db, "Meter A"))
    if mapped_both:
        await make_mapping(db, new, await make_asset(db, "Meter B"))
    return source, old, new


def mapping_body(point_id: int, asset_id: int, metric="active_power_kw") -> dict:
    return {"point_id": point_id, "asset_id": asset_id, "metric": metric}


def turn_on(config: dict | None = None) -> dict:
    return {"config": {"endpoint": ENDPOINT, **(config or {}), "stable_addresses": True}}


async def stored_config(db, source: int) -> dict:
    return json.loads(await db.fetchval("SELECT config::text FROM sources WHERE id = $1", source))


# ---- PATCH: turning the option on ------------------------------------------------------------------------------------------------


async def test_turning_it_on_with_two_mapped_points_of_one_tag_is_refused_in_words_and_changes_nothing(client, db):
    await login_as(client, db)
    source, old, new = await two_twins(db)
    response = await client.patch(f"/api/sources/{source}", json=turn_on())
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == (
        f"PDUA01_PM0_P is mapped twice: point {old} ({OLD}) and point {new} ({NEW}). "
        "Delete one of the two mappings, then try again."
    )
    assert await stored_config(db, source) == {"endpoint": ENDPOINT, "stable_addresses": False}  # as it was
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'source.updated'") == 0


async def test_the_refusal_names_the_first_five_pairs_by_point_id(client, db):
    await login_as(client, db)
    source = await opcua(db, False)
    firsts = []
    for n in range(7):
        a = await make_point(db, source, f"ns=3;s=2{n}000:Site.T{n}_P")
        b = await make_point(db, source, f"ns=3;s=3{n}000:Site.T{n}_P")
        await make_mapping(db, a, await make_asset(db, f"A{n}"))
        await make_mapping(db, b, await make_asset(db, f"B{n}"))
        firsts.append(a)
    detail = (await client.patch(f"/api/sources/{source}", json=turn_on())).json()["detail"]
    assert detail.count(" is mapped twice: ") == 5
    assert all(f"T{n}_P is mapped twice: point {firsts[n]} " in detail for n in range(5))
    assert "T5_P" not in detail
    assert detail.endswith("Delete one mapping of each pair, then try again.")


async def test_an_unmapped_twin_does_not_stop_the_option(client, db):
    await login_as(client, db)
    source, *_ = await two_twins(db, mapped_both=False)
    response = await client.patch(f"/api/sources/{source}", json=turn_on())
    assert response.status_code == 200, response.text
    assert (await stored_config(db, source))["stable_addresses"] is True


async def test_two_mapped_points_of_different_tags_do_not_stop_the_option(client, db):
    await login_as(client, db)
    source = await opcua(db, False)
    for address, asset in ((NEW, "A"), (OTHER, "B")):
        await make_mapping(db, await make_point(db, source, address), await make_asset(db, asset))
    assert (await client.patch(f"/api/sources/{source}", json=turn_on())).status_code == 200


async def test_the_option_is_checked_only_when_it_goes_from_off_to_on(client, db):
    await login_as(client, db)
    source, *_ = await two_twins(db, stable=True)  # a state the guards never create; here it is put there by hand
    renamed = await client.patch(f"/api/sources/{source}", json={"name": "renamed", **turn_on()})
    assert renamed.status_code == 200, renamed.text
    off = await client.patch(f"/api/sources/{source}", json={"config": {"endpoint": ENDPOINT}})  # the option goes off: allowed
    assert off.status_code == 200
    assert (await stored_config(db, source))["stable_addresses"] is False
    again = await client.patch(f"/api/sources/{source}", json=turn_on())  # and on again: now it is refused
    assert again.status_code == 422


async def test_the_option_on_a_source_that_is_not_opcua_is_not_looked_at(client, db):
    await login_as(client, db)
    source = await make_source(db, "other", "simulator", {"url": "http://simulator:9000"})
    a, b = await make_point(db, source, "ns=3;s=1:Site.X"), await make_point(db, source, "ns=3;s=2:Site.X")
    await make_mapping(db, a, await make_asset(db, "A"))
    await make_mapping(db, b, await make_asset(db, "B"))
    response = await client.patch(f"/api/sources/{source}", json={"config": {"url": "http://simulator:9000", "stable_addresses": True}})
    assert response.status_code == 200, response.text


async def test_the_masked_form_round_trip_keeps_username_secret_and_url_credentials(client, db):
    await login_as(client, db)
    created = await client.post(
        "/api/sources",
        json={
            "name": "scada", "connector_type": "opcua", "secret": "s3cret-word",
            "config": {"endpoint": "opc.tcp://svc:pw-in-url@scada:4840/plantscada", "username": "operator"},
        },
    )
    assert created.status_code == 201, created.text
    source = created.json()["id"]
    before = await stored_config(db, source)
    stored_secret = await db.fetchval("SELECT secret FROM sources WHERE id = $1", source)
    assert "pw-in-url" in before["endpoint"] and before["username"] == "operator"

    shown = created.json()["config"]  # what the edit form was opened with: the endpoint's credentials are masked
    assert "pw-in-url" not in shown["endpoint"]
    sent = {"config": {**shown, "stable_addresses": True}, "expect_config": shown}
    patched = await client.patch(f"/api/sources/{source}", json=sent)
    assert patched.status_code == 200, patched.text

    after = await stored_config(db, source)
    assert after == {**before, "stable_addresses": True}  # URL credentials, username and everything else as they were
    assert decrypt(await db.fetchval("SELECT secret FROM sources WHERE id = $1", source)) == "s3cret-word"
    assert await db.fetchval("SELECT secret FROM sources WHERE id = $1", source) == stored_secret
    assert "pw-in-url" not in json.dumps(patched.json()) and "s3cret-word" not in json.dumps(patched.json())

    # off again, sent the same way: only the flag moves
    reopened = patched.json()["config"]
    off = await client.patch(
        f"/api/sources/{source}", json={"config": {**reopened, "stable_addresses": False}, "expect_config": reopened}
    )
    assert off.status_code == 200, off.text
    assert await stored_config(db, source) == {**before, "stable_addresses": False}
    assert await db.fetchval("SELECT secret FROM sources WHERE id = $1", source) == stored_secret


# ---- POST /api/mappings -----------------------------------------------------------------------------------------------------------


async def test_a_mapping_of_the_twin_of_a_mapped_point_is_refused(client, db):
    await login_as(client, db)
    source, old, new = await two_twins(db, stable=True, mapped_both=False)
    asset = await make_asset(db, "Meter B")
    response = await client.post("/api/mappings", json=mapping_body(new, asset))
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == (
        f"PDUA01_PM0_P is already mapped as point {old} ({OLD}): this source reads both as one tag. Unmap that one first."
    )
    assert await db.fetchval("SELECT count(*) FROM mappings") == 1
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'mapping.created'") == 0


async def test_the_twin_can_be_mapped_after_the_first_mapping_is_deleted(client, db):
    await login_as(client, db)
    source, old, new = await two_twins(db, stable=True, mapped_both=False)
    asset = await make_asset(db, "Meter B")
    assert (await client.post("/api/mappings", json=mapping_body(new, asset))).status_code == 409
    mapping = await db.fetchval("SELECT id FROM mappings WHERE point_id = $1", old)
    assert (await client.delete(f"/api/mappings/{mapping}")).status_code == 204
    assert (await client.post("/api/mappings", json=mapping_body(new, asset))).status_code == 201


async def test_a_mapping_of_a_point_that_is_not_a_twin_is_allowed_with_the_option_on(client, db):
    await login_as(client, db)
    source, *_ = await two_twins(db, stable=True, mapped_both=False)
    other = await make_point(db, source, OTHER)
    assert (await client.post("/api/mappings", json=mapping_body(other, await make_asset(db, "Meter Q")))).status_code == 201


@pytest.mark.parametrize("stable", [None, False])  # a stored config without the key, and with the option off
async def test_an_option_off_source_maps_both_numbers_as_it_always_did(client, db, stable):
    await login_as(client, db)
    source, old, new = await two_twins(db, stable=stable, mapped_both=False)
    response = await client.post("/api/mappings", json=mapping_body(new, await make_asset(db, "Meter B")))
    assert response.status_code == 201, response.text


async def test_a_source_that_is_not_opcua_maps_identical_looking_addresses(client, db):
    await login_as(client, db)
    source = await make_source(db, "other", "simulator", {"url": "http://simulator:9000", "stable_addresses": True})
    a, b = await make_point(db, source, OLD), await make_point(db, source, NEW)
    await make_mapping(db, a, await make_asset(db, "A"))
    assert (await client.post("/api/mappings", json=mapping_body(b, await make_asset(db, "B")))).status_code == 201


async def test_a_mapping_of_a_point_that_is_already_mapped_is_still_the_old_clash(client, db):
    await login_as(client, db)
    source, old, _ = await two_twins(db, stable=True, mapped_both=False)
    response = await client.post("/api/mappings", json=mapping_body(old, await make_asset(db, "Meter Z")))
    assert response.status_code == 409
    assert response.json()["detail"] == "this point is already mapped, or the asset already has this metric"


async def test_a_mapping_for_an_opcua_point_waits_for_the_source_row_before_anything_else(client, db):
    await login_as(client, db)
    source, old, new = await two_twins(db, stable=True, mapped_both=False)
    other = await make_point(db, source, OTHER)
    asset = await make_asset(db, "Meter Q")
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM sources WHERE id = $1 FOR UPDATE", source)  # what a PATCH of the source holds
        waiting = await pending(db, 1, client.post("/api/mappings", json=mapping_body(other, asset)))
        assert not waiting.done()
        await asyncio.sleep(0.5)
        assert not waiting.done(), "the mapping did not wait for the source row"
        assert await db.fetchval("SELECT count(*) FROM mappings") == 1
        await tx.rollback()
        (response,) = await finished(waiting)
    assert response.status_code == 201, response.text


async def test_a_mapping_that_waited_behind_a_patch_sees_the_option_the_patch_turned_on(client, db):
    await login_as(client, db)
    source, old, new = await two_twins(db, stable=False, mapped_both=False)
    asset = await make_asset(db, "Meter B")
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM sources WHERE id = $1 FOR UPDATE", source)
        waiting = await pending(db, 1, client.post("/api/mappings", json=mapping_body(new, asset)))
        await conn.execute(
            "UPDATE sources SET config = config || '{\"stable_addresses\": true}'::jsonb WHERE id = $1", source
        )  # the PATCH's write, committed while the mapping waits
        await tx.commit()
        (response,) = await finished(waiting)
    assert response.status_code == 409, response.text  # the config was read again under the lock, not before it
    assert "is already mapped as point" in response.json()["detail"]


async def test_a_mapping_of_a_point_of_another_kind_of_source_does_not_wait_for_the_source_row(client, db):
    await login_as(client, db)
    source = await make_source(db, "sim", "simulator", {"url": "http://simulator:9000"})
    point = await make_point(db, source, "LVP01_kW")
    asset = await make_asset(db, "Panel")
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM sources WHERE id = $1 FOR UPDATE", source)
        response = await asyncio.wait_for(client.post("/api/mappings", json=mapping_body(point, asset)), WAIT)
        await tx.rollback()
    assert response.status_code == 201, response.text


async def test_two_mappings_of_twins_started_together_end_with_one_mapped(client, db):
    await login_as(client, db)
    source = await opcua(db, True)
    old, new = await make_point(db, source, OLD), await make_point(db, source, NEW)
    one, two = await make_asset(db, "Meter A"), await make_asset(db, "Meter B")
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM sources WHERE id = $1 FOR UPDATE", source)
        first = await pending(db, 1, client.post("/api/mappings", json=mapping_body(old, one)))
        second = await pending(db, 2, client.post("/api/mappings", json=mapping_body(new, two)))
        await tx.rollback()
        responses = await finished(first, second)
    assert sorted(r.status_code for r in responses) == [201, 409], [r.text for r in responses]
    assert await db.fetchval("SELECT count(*) FROM mappings") == 1


# ---- POST /api/discovery/accept ---------------------------------------------------------------------------------------------------


def accept_body(source: int, asset: int, point_ids) -> dict:
    metrics = ("active_power_kw", "apparent_power_kva", "energy_kwh")  # one asset takes each metric once
    return {"source_id": source, "asset_id": asset, "points": [{"point_id": p, "metric": metrics[i]} for i, p in enumerate(point_ids)]}


async def test_accept_refuses_a_twin_of_a_mapped_point_and_writes_nothing(client, db):
    await login_as(client, db)
    source, old, new = await two_twins(db, stable=True, mapped_both=False)
    asset = await make_asset(db, "Meter B")
    response = await client.post("/api/discovery/accept", json=accept_body(source, asset, [new]))
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == (
        f"PDUA01_PM0_P is already mapped as point {old} ({OLD}): this source reads both as one tag. Unmap that one first."
    )
    assert await db.fetchval("SELECT count(*) FROM mappings") == 1
    assert await db.fetchval("SELECT enabled FROM sources WHERE id = $1", source) is True  # unchanged by the refused request


async def test_accept_refuses_two_twins_inside_one_request_before_it_creates_anything(client, db):
    await login_as(client, db)
    source = await opcua(db, True)
    old, new = await make_point(db, source, OLD), await make_point(db, source, NEW)
    other = await make_point(db, source, OTHER)
    response = await client.post(
        "/api/discovery/accept",
        json={
            "source_id": source, "new_asset": {"name": "Fresh"},
            "points": [{"point_id": p, "metric": "active_power_kw"} for p in (other, old, new)],
        },
    )
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == (
        f"PDUA01_PM0_P is in this request twice: point {new} ({NEW}) and point {old} ({OLD}). "
        "This source reads both as one tag. Map only one of them."
    )
    assert await db.fetchval("SELECT count(*) FROM assets") == 0  # not even the new asset
    assert await db.fetchval("SELECT count(*) FROM mappings") == 0


async def test_accept_maps_one_of_two_twins_and_every_point_of_other_tags(client, db):
    await login_as(client, db)
    source = await opcua(db, True)
    old, other = await make_point(db, source, OLD), await make_point(db, source, OTHER)
    response = await client.post(
        "/api/discovery/accept", json=accept_body(source, await make_asset(db, "Meter"), [old, other])
    )
    assert response.status_code == 201, response.text
    assert await db.fetchval("SELECT count(*) FROM mappings") == 2


async def test_accept_on_an_option_off_source_maps_both_numbers_as_it_always_did(client, db):
    await login_as(client, db)
    source = await opcua(db, None)
    old, new = await make_point(db, source, OLD), await make_point(db, source, NEW)
    response = await client.post("/api/discovery/accept", json=accept_body(source, await make_asset(db, "Meter"), [old, new]))
    assert response.status_code == 201, response.text
    assert await db.fetchval("SELECT count(*) FROM mappings") == 2


# ---- GET /api/discovery/graph: same_tag_as -----------------------------------------------------------------------------------------


def graph_points(graph: dict, source: int) -> dict[int, dict]:
    [one] = [s for s in graph["sources"] if s["id"] == source]
    return {p["id"]: p for p in [*(p for c in one["clusters"] for p in c["points"]), *one["ungrouped"]]}


async def test_the_graph_marks_the_unmapped_twin_of_a_mapped_point(client, db):
    await login_as(client, db)
    source, old, new = await two_twins(db, stable=True, mapped_both=False)
    other = await make_point(db, source, OTHER)
    points = graph_points((await client.get("/api/discovery/graph")).json(), source)
    assert points[new]["same_tag_as"] == old  # the unmapped twin points at the mapped point
    assert points[old]["same_tag_as"] is None and points[old]["mapping_id"] is not None  # the mapped point itself
    assert points[other]["same_tag_as"] is None  # an unrelated unmapped point


async def test_the_graph_has_no_same_tag_as_for_a_source_with_the_option_off_or_another_kind(client, db):
    await login_as(client, db)
    off, old_off, new_off = await two_twins(db, stable=False, mapped_both=False)
    unset = await opcua(db, None, name="unset")
    await make_mapping(db, await make_point(db, unset, OLD), await make_asset(db, "Unset A"))
    twin_unset = await make_point(db, unset, NEW)
    sim = await make_source(db, "sim", "simulator", {"url": "http://simulator:9000", "stable_addresses": True})
    await make_mapping(db, await make_point(db, sim, OLD), await make_asset(db, "Sim A"))
    twin_sim = await make_point(db, sim, NEW)
    graph = (await client.get("/api/discovery/graph")).json()
    assert graph_points(graph, off)[new_off]["same_tag_as"] is None
    assert graph_points(graph, unset)[twin_unset]["same_tag_as"] is None
    assert graph_points(graph, sim)[twin_sim]["same_tag_as"] is None


async def test_the_graph_names_the_lowest_mapped_point_when_there_are_several(client, db):
    await login_as(client, db)
    source, old, new = await two_twins(db, stable=True, mapped_both=True)  # a hand-made state: two mapped twins
    third = await make_point(db, source, "ns=3;s=20999:Site.PDUA01_PM0_P")
    points = graph_points((await client.get("/api/discovery/graph")).json(), source)
    assert points[third]["same_tag_as"] == min(old, new)
    assert points[old]["same_tag_as"] is None and points[new]["same_tag_as"] is None
