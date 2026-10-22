"""POST /api/sources/moves/{audit_id}/undo (w33 R5, P9, F8, F9, F10, F13, F17, F-M4): take a move back.

The Undo must put back EXACTLY what the move changed (the host and port inside the source's CURRENT config, its identity, its name,
the scan findings the move re-pointed) and nothing else, or refuse in words and write nothing at all. It never recreates the removed
duplicate (the next scan finds it again) and it does not undo readings: it counts the ones taken since the move and says they stay.

The world is the owner's screenshot of test_api_moves.py (`owners_case`); the helpers are theirs.
"""
import asyncio
import logging

import pytest

from dcdash.api.scans import SCAN_START_LOCK
from dcdash.core.crypto import encrypt
from dcdash.core.pg import CONFIG_CHANNEL
from dcdash.moves.service import undo_sentence
from helpers import listening, login_as, make_role
from test_api_asset_move_concurrency import finished, pending
from test_api_delete_locks import holder
from test_api_moves import (
    OWNERS_NEW_NAME, OWNERS_OLD_NAME, audit_rows, counts, credentialed_case, everything_said, move, row_of, same_server_case, with_hint,
)
from test_api_scans import create_scope, start_scan
from test_moves_freshness import finished_at, make_finding, make_scan
from test_moves_load import PAIRS, add_points, add_source, map_points, new_source, owners_case, open_incident

UNDO = "/api/sources/moves/{}/undo"
NOT_A_MOVE = "that move was not found"
TOO_OLD = "that move was made more than 24 hours ago and can no longer be undone here"
ALREADY = "this move was already undone"
DELETED = "the source was deleted after the move"
ADDRESS = "the source's address was changed after the move; edit it by hand"
RENAMED = "the source's name was changed after the move; edit it by hand"
SCAN_RUNNING = "A scan is running. Undo the move when it has finished."
NOT_UNDOABLE = "this audit row does not hold what an undo needs"
TRY_AGAIN = "something changed while the move was being undone; try again"
NAME_RACE = "something changed while the move was being undone (a name was taken); try again"
OLD_URL = "opc.tcp://172.20.0.3:4840/"
NEW_URL = "opc.tcp://172.20.0.5:4840/"


# ---- helpers -------------------------------------------------------------------------------------------------------------------


async def moved(client, db, case=owners_case, address="as_found", **changes) -> tuple[int, int, int]:
    """Sign in, build the case, make the move. Returns (old id, new id, the move's audit id)."""
    await login_as(client, db)
    old, new = await case(db)
    response = await move(client, old, new, address, **changes)
    assert response.status_code == 200, response.text
    return old, new, response.json()["audit_id"]


async def undo(client, audit_id: int):
    return await client.post(UNDO.format(audit_id))


async def state(db, *source_ids: int):
    """Everything an Undo may change, and the audit rows it may add: compared before and after a refusal."""
    return (
        await counts(db),
        [await row_of(db, source_id) for source_id in source_ids],
        await db.fetch("SELECT id, source_id FROM scan_findings ORDER BY id"),
        await db.fetch("SELECT point_id, ts FROM readings ORDER BY point_id, ts"),
        await audit_rows(db, "source.move_undone"),
    )


async def refused(client, db, old: int, audit_id: int, status: int, sentence: str) -> None:
    """The Undo is refused with `status` and `sentence`, and nothing was written."""
    before = await state(db, old)
    response = await undo(client, audit_id)
    assert response.status_code == status, response.text
    detail = response.json()["detail"]
    assert detail == sentence, detail
    assert await state(db, old) == before


async def simulator_case(db) -> tuple[int, int]:
    first = await make_scan(db, day=0)
    config = {"url": "http://172.20.0.3:9000/", "timeout_seconds": 7.5}
    old = await add_source(
        db, "DCDash simulator at 172.20.0.3:9000", "172.20.0.3", kind="simulator", port=9000, origin="discovered", status="offline",
        last_seen=finished_at(0), config=config,
    )
    await map_points(db, await add_points(db, old, PAIRS))
    await open_incident(db, old, "unreachable")
    await make_finding(db, first, "172.20.0.3", 9000, old)
    second = await make_scan(db, day=3)
    new = await new_source(db, "DCDash simulator at 172.20.0.5:9000", "172.20.0.5", second, kind="simulator", port=9000)
    await db.execute("UPDATE sources SET config = $2 WHERE id = $1", new, {"url": "http://172.20.0.5:9000/", "timeout_seconds": 5.0})
    return old, new


# ---- the sentence --------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "host, port, readings, expected",
    [
        ("172.20.0.3", 4840, 0, "Moved back to 172.20.0.3:4840."),
        ("172.20.0.3", 4840, 1, "Moved back to 172.20.0.3:4840. 1 reading taken at the new address stays."),
        ("172.20.0.3", 4840, 4, "Moved back to 172.20.0.3:4840. 4 readings taken at the new address stay."),
        ("172.20.0.3", 4840, 1200, "Moved back to 172.20.0.3:4840. 1,200 readings taken at the new address stay."),
        ("fe80::1", 4841, 0, "Moved back to [fe80::1]:4841."),  # an IPv6 host is written in brackets, as everywhere a person reads one
    ],
)
def test_the_sentence_says_where_the_source_went_back_to_and_what_stays(host, port, readings, expected):
    assert undo_sentence(host, port, readings) == expected


# ---- the Undo restores what the move changed -----------------------------------------------------------------------------------


async def test_the_undo_puts_back_exactly_what_the_move_changed_and_nothing_else(client, db, database_url):
    await login_as(client, db)
    admin = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    old, new = await owners_case(db)
    row_before = await row_of(db, old)
    points_before = await db.fetch("SELECT * FROM points WHERE source_id = $1 ORDER BY id", old)
    mappings_before = await db.fetch("SELECT * FROM mappings ORDER BY id")
    first_finding = await db.fetchval("SELECT id FROM scan_findings WHERE source_id = $1", old)
    new_finding = await db.fetchval("SELECT id FROM scan_findings WHERE source_id = $1", new)
    sources_before = await db.fetchval("SELECT count(*) FROM sources")
    audit_id = (await move(client, old, new)).json()["audit_id"]
    assert await db.fetchval("SELECT count(*) FROM sources") == sources_before - 1  # the duplicate is gone

    async with listening(database_url, CONFIG_CHANNEL) as received:
        response = await undo(client, audit_id)
        assert response.status_code == 200, response.text
        await db.execute("SELECT pg_notify($1, 'sentinel')", CONFIG_CHANNEL)
        announced = []
        while (payload := await asyncio.wait_for(received.get(), timeout=5)) != "sentinel":
            announced.append(payload)
    assert len(announced) == 1  # the collector is told once, at the commit, and polls the old address again at once

    assert response.json() == {
        "source": {"id": old, "name": OWNERS_OLD_NAME},
        "restored": {"host": "172.20.0.3", "port": 4840, "name": OWNERS_OLD_NAME},
        "readings_since_move": 0,
        "text": "Moved back to 172.20.0.3:4840.",
    }
    # the very same row as before the move, the identity as SQL NULL and not as a JSON null
    assert await row_of(db, old) == row_before
    assert await db.fetchval("SELECT identity IS NULL FROM sources WHERE id = $1", old) is True
    assert await db.fetch("SELECT * FROM points WHERE source_id = $1 ORDER BY id", old) == points_before
    assert await db.fetch("SELECT * FROM mappings ORDER BY id") == mappings_before
    # the duplicate is NOT recreated: the next scan finds it again
    assert await db.fetchval("SELECT count(*) FROM sources WHERE id = $1", new) == 0
    assert await db.fetchval("SELECT count(*) FROM sources") == sources_before - 1
    # the findings the move re-pointed to the old source are nobody's again; the old source's own stay
    assert [(r["id"], r["source_id"]) for r in await db.fetch("SELECT id, source_id FROM scan_findings ORDER BY id")] == [
        (first_finding, old), (new_finding, None),
    ]
    # one audit row; its `_before` side is the source as the Undo found it (the moved state), its `_after` side what it restored
    [detail] = await audit_rows(db, "source.move_undone")
    assert detail == {
        "audit_id": audit_id, "source_id": old,
        "name_before": OWNERS_NEW_NAME, "name_after": OWNERS_OLD_NAME,
        "host_before": "172.20.0.5", "port_before": 4840, "host_after": "172.20.0.3", "port_after": 4840,
        "readings_since_move": 0,
    }
    assert await db.fetchval("SELECT user_id FROM audit_log WHERE action = 'source.move_undone'") == admin
    assert len(await audit_rows(db, "source.moved")) == 1  # the move's row stays as it was


async def test_the_undo_gives_the_old_source_the_identity_it_had_before_the_move(client, db):
    old, new, audit_id = await moved(client, db, same_server_case)
    original = {"application_uri": "urn:vendor:meter-7", "thumbprint": "AA:BB:CC:DD"}
    assert (await row_of(db, old))["identity"] != original  # the move gave it the copy's (it carries a name too)
    assert (await undo(client, audit_id)).status_code == 200
    assert (await row_of(db, old))["identity"] == original


async def test_a_source_that_had_no_identity_has_none_again_not_an_empty_one(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    await db.execute("UPDATE sources SET identity = $2 WHERE id = $1", new, {"application_uri": "urn:vendor:other"})
    audit_id = (await move(client, old, new)).json()["audit_id"]
    assert (await row_of(db, old))["identity"] == {"application_uri": "urn:vendor:other"}
    assert (await undo(client, audit_id)).status_code == 200
    assert await db.fetchval("SELECT identity IS NULL FROM sources WHERE id = $1", old) is True


async def test_a_key_changed_after_the_move_survives_and_only_the_address_goes_back(client, db):
    old, new, audit_id = await moved(client, db)
    patched = await client.patch(
        f"/api/sources/{old}", json={"config": {"endpoint": NEW_URL, "timeout_seconds": 12.5, "root_node": "ns=2;s=Plant"}}
    )
    assert patched.status_code == 200, patched.text
    edited = (await row_of(db, old))["config"]
    assert edited["timeout_seconds"] == 12.5 and edited["endpoint"] == NEW_URL
    assert (await undo(client, audit_id)).status_code == 200
    # the config as the edit left it, with the one text of the address changed back
    assert (await row_of(db, old))["config"] == {**edited, "endpoint": OLD_URL}


async def test_credentials_and_the_secret_survive_the_move_and_the_undo_byte_for_byte(client, db, caplog):
    caplog.set_level(logging.DEBUG)
    await login_as(client, db)
    old, new = await credentialed_case(db)
    before = await row_of(db, old)
    assert before["secret"] is not None
    moved_ = await move(client, old, new)
    assert moved_.status_code == 200, moved_.text
    assert (await row_of(db, old))["config"]["endpoint"] == "opc.tcp://user:pass@172.20.0.5:4840/dcdash/"
    response = await undo(client, moved_.json()["audit_id"])
    assert response.status_code == 200, response.text
    after = await row_of(db, old)
    assert after == before  # the whole row: config (credentials, path, security settings), secret, name, identity
    assert after["secret"] == before["secret"]
    for text in (response.text, await everything_said(db)):
        assert "pass" not in text and "user:" not in text and "s3cret" not in text
    assert "user:" not in caplog.text and ":pass@" not in caplog.text and "s3cret" not in caplog.text
    [detail] = await audit_rows(db, "source.move_undone")
    assert "pass" not in str(detail) and "user" not in str(detail)


async def test_a_credentialed_simulator_address_survives_the_move_and_the_undo_byte_for_byte(client, db, caplog):
    caplog.set_level(logging.DEBUG)
    await login_as(client, db)
    old, new = await simulator_case(db)
    config = {"url": "http://user:pass@172.20.0.3:9000/", "timeout_seconds": 7.5}
    await db.execute("UPDATE sources SET config = $2, secret = $3 WHERE id = $1", old, config, encrypt("s3cret-value"))
    before = await row_of(db, old)
    assert before["secret"] is not None
    shown = await client.post(f"/api/sources/{old}/move?dry_run=1", json={"to": new, "address": "as_found"})
    assert shown.status_code == 200, shown.text
    assert shown.json()["from"]["endpoint"] == "http://172.20.0.3:9000"  # no user info in what is shown
    moved_ = await move(client, old, new)
    assert moved_.status_code == 200, moved_.text
    during = await row_of(db, old)
    assert during["config"] == {"url": "http://user:pass@172.20.0.5:9000/", "timeout_seconds": 7.5}  # one text changed
    assert during["secret"] == before["secret"]
    response = await undo(client, moved_.json()["audit_id"])
    assert response.status_code == 200, response.text
    assert await row_of(db, old) == before  # the whole row: the credentialed address, the secret, the name, the identity
    for text in (shown.text, moved_.text, response.text, await everything_said(db)):
        assert "pass" not in text and "user:" not in text and "s3cret" not in text
    assert "user:" not in caplog.text and ":pass@" not in caplog.text and "s3cret" not in caplog.text


async def mixed_case_case(db) -> tuple[int, int]:
    """The old source's address is written the way a person typed it: capitals in the host name and no port. The scan's copy is at an IP."""
    first = await make_scan(db, day=0)
    old = await add_source(
        db, "Plant PLC 7", "plc7.plant", origin="discovered", status="offline", last_seen=finished_at(0),
        config={"endpoint": "opc.tcp://PLC7.Plant/dcdash/"},
    )
    await map_points(db, await add_points(db, old, PAIRS))
    await open_incident(db, old, "unreachable")
    await make_finding(db, first, "plc7.plant", 4840, old)
    second = await make_scan(db, day=3)
    new = await new_source(db, OWNERS_NEW_NAME, "172.20.0.5", second, pairs=PAIRS + [("ns=2;s=LVP03.kW", "LVP03 kW")], path="/dcdash/")
    return old, new


async def test_an_address_written_in_capitals_and_without_a_port_comes_back_byte_for_byte(client, db):
    await login_as(client, db)
    old, new = await mixed_case_case(db)
    before = await row_of(db, old)
    moved_ = await move(client, old, new)
    assert moved_.status_code == 200, moved_.text
    assert (await row_of(db, old))["config"] == {"endpoint": "opc.tcp://172.20.0.5:4840/dcdash/"}
    [recorded] = await audit_rows(db)
    assert (recorded["authority_before"], recorded["authority_after"]) == ("PLC7.Plant", "172.20.0.5:4840")  # as stored, no user info
    assert (recorded["host_before"], recorded["port_before"]) == ("plc7.plant", 4840)  # as the matcher reads it
    response = await undo(client, moved_.json()["audit_id"])
    assert response.status_code == 200, response.text
    assert response.json()["restored"] == {"host": "plc7.plant", "port": 4840, "name": "Plant PLC 7"}
    assert await row_of(db, old) == before
    assert (await row_of(db, old))["config"]["endpoint"] == "opc.tcp://PLC7.Plant/dcdash/"  # not opc.tcp://plc7.plant:4840/dcdash/


async def test_a_move_recorded_before_the_authority_was_kept_is_taken_back_by_host_and_port(client, db):
    await login_as(client, db)
    old, new = await mixed_case_case(db)
    moved_ = await move(client, old, new)
    audit_id = moved_.json()["audit_id"]
    await db.execute("UPDATE audit_log SET detail = detail - 'authority_before' - 'authority_after' WHERE id = $1", audit_id)
    response = await undo(client, audit_id)
    assert response.status_code == 200, response.text
    assert (await row_of(db, old))["config"] == {"endpoint": "opc.tcp://plc7.plant:4840/dcdash/"}  # the same place, written out in full


@pytest.mark.parametrize(
    "authority, status, sentence",
    [
        ('"evil.example:4840"', 409, "the old address could not be written back into this source; edit its address by hand"),  # not host_before
        ('"plc7.plant:4841"', 409, "the old address could not be written back into this source; edit its address by hand"),  # not port_before
        ('"bad/host"', 409, "the old address could not be written back into this source; edit its address by hand"),
        ('5', 409, NOT_UNDOABLE),
        ('""', 409, NOT_UNDOABLE),
    ],
)
async def test_a_recorded_authority_that_is_not_the_recorded_host_and_port_is_refused_and_nothing_is_written(client, db, authority, status, sentence):
    await login_as(client, db)
    old, new = await mixed_case_case(db)
    audit_id = (await move(client, old, new)).json()["audit_id"]
    await db.execute(f"UPDATE audit_log SET detail = jsonb_set(detail, '{{authority_before}}', '{authority}') WHERE id = $1", audit_id)
    await refused(client, db, old, audit_id, status, sentence)


async def test_a_simulator_source_is_taken_back_too(client, db):
    await login_as(client, db)
    old, new = await simulator_case(db)
    before = await row_of(db, old)
    audit_id = (await move(client, old, new)).json()["audit_id"]
    assert (await row_of(db, old))["config"] == {"url": "http://172.20.0.5:9000/", "timeout_seconds": 7.5}
    response = await undo(client, audit_id)
    assert response.status_code == 200, response.text
    assert response.json()["restored"] == {"host": "172.20.0.3", "port": 9000, "name": "DCDash simulator at 172.20.0.3:9000"}
    assert await row_of(db, old) == before


async def test_a_move_by_name_is_taken_back_and_the_host_is_compared_without_regard_to_case(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    await with_hint(db, new)
    audit_id = (await move(client, old, new, "name")).json()["audit_id"]
    assert (await row_of(db, old))["config"] == {"endpoint": "opc.tcp://simulator:4840/"}
    await db.execute("UPDATE sources SET config = $2 WHERE id = $1", old, {"endpoint": "opc.tcp://SIMULATOR:4840/"})  # the same host, spelled otherwise
    response = await undo(client, audit_id)
    assert response.status_code == 200, response.text
    assert response.json()["restored"] == {"host": "172.20.0.3", "port": 4840, "name": OWNERS_OLD_NAME}
    assert (await row_of(db, old))["config"] == {"endpoint": OLD_URL}


async def test_a_name_a_person_typed_is_still_the_name_after_the_undo(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    await db.execute("UPDATE sources SET name = 'Main incomer meter' WHERE id = $1", old)
    audit_id = (await move(client, old, new)).json()["audit_id"]
    response = await undo(client, audit_id)
    assert response.status_code == 200, response.text
    assert response.json()["restored"]["name"] == "Main incomer meter" == (await row_of(db, old))["name"]
    [detail] = await audit_rows(db, "source.move_undone")
    assert detail["name_before"] == detail["name_after"] == "Main incomer meter"


async def test_a_finding_that_belongs_to_another_source_by_now_is_left_alone(client, db):
    old, new, audit_id = await moved(client, db)
    other = await add_source(db, "somebody else", "172.20.0.50", origin="manual")
    new_finding = (await audit_rows(db))[0]["finding_ids"][0]
    await db.execute("UPDATE scan_findings SET source_id = $2 WHERE id = $1", new_finding, other)
    assert (await undo(client, audit_id)).status_code == 200
    assert await db.fetchval("SELECT source_id FROM scan_findings WHERE id = $1", new_finding) == other


# ---- readings_since_move (F13) -------------------------------------------------------------------------------------------------


async def test_the_readings_since_the_move_are_counted_and_only_those(client, db):
    old, new, audit_id = await moved(client, db)
    mapped = [r["id"] for r in await db.fetch("SELECT id FROM points WHERE source_id = $1 ORDER BY id", old)]
    spare = (await add_points(db, old, [("ns=2;s=Spare", "Spare")]))[0]  # a point of the old source that nothing is mapped to
    other = await add_source(db, "another source", "172.20.0.60", origin="manual")
    elsewhere = (await add_points(db, other, [("ns=2;s=E", "E")]))[0]
    for point, shift, value in (
        (mapped[0], "- interval '2 hours'", 1), (mapped[0], "- interval '1 second'", 2),  # before the move: not counted
        (mapped[1], "+ interval '0 seconds'", 3),  # at the very instant of the move: counted
        (mapped[0], "+ interval '1 second'", 4), (mapped[0], "+ interval '2 seconds'", 5), (mapped[2], "+ interval '3 seconds'", 6),
        (spare, "+ interval '4 seconds'", 7), (elsewhere, "+ interval '5 seconds'", 8),  # not mapped / not this source: not counted
    ):
        await db.execute(
            f"INSERT INTO readings (point_id, ts, value) SELECT $1, ts {shift}, {value} FROM audit_log WHERE id = $2", point, audit_id
        )
    response = await undo(client, audit_id)
    assert response.status_code == 200, response.text
    assert response.json()["readings_since_move"] == 4
    assert response.json()["text"] == "Moved back to 172.20.0.3:4840. 4 readings taken at the new address stay."
    [detail] = await audit_rows(db, "source.move_undone")
    assert detail["readings_since_move"] == 4
    assert await db.fetchval("SELECT count(*) FROM readings") == 8  # the Undo deleted none


@pytest.mark.parametrize(
    "number, expected",
    [
        (1, "Moved back to 172.20.0.3:4840. 1 reading taken at the new address stays."),
        (1200, "Moved back to 172.20.0.3:4840. 1,200 readings taken at the new address stay."),
    ],
)
async def test_one_reading_is_said_in_the_singular_and_a_thousand_with_a_comma(client, db, number, expected):
    old, new, audit_id = await moved(client, db)
    point = await db.fetchval("SELECT id FROM points WHERE source_id = $1 ORDER BY id LIMIT 1", old)
    await db.execute(
        "INSERT INTO readings (point_id, ts, value) SELECT $1, ts + n * interval '1 second', 1 "
        "FROM audit_log, generate_series(1, $3) n WHERE id = $2", point, audit_id, number,
    )
    response = await undo(client, audit_id)
    assert response.status_code == 200, response.text
    assert response.json()["readings_since_move"] == number and response.json()["text"] == expected


# ---- refusals: each in words, none writes anything ------------------------------------------------------------------------------


async def test_a_row_that_is_not_a_move_is_not_found(client, db):
    old, new, audit_id = await moved(client, db)
    await refused(client, db, old, 999999, 404, NOT_A_MOVE)
    other = await db.fetchval("INSERT INTO audit_log (action, detail) VALUES ('source.updated', '{}') RETURNING id")
    await refused(client, db, old, other, 404, NOT_A_MOVE)
    assert (await undo(client, audit_id)).status_code == 200
    undone = await db.fetchval("SELECT id FROM audit_log WHERE action = 'source.move_undone'")
    await refused(client, db, old, undone, 404, NOT_A_MOVE)  # the Undo's own row is not a move either


async def test_ids_that_cannot_be_ids_are_a_422(client, db):
    await moved(client, db)
    for bad in (0, -1, 2**31):
        assert (await undo(client, bad)).status_code == 422, bad


async def test_a_move_older_than_24_hours_can_no_longer_be_undone(client, db):
    old, new, audit_id = await moved(client, db)
    await db.execute("UPDATE audit_log SET ts = now() - interval '25 hours' WHERE id = $1", audit_id)
    await refused(client, db, old, audit_id, 410, TOO_OLD)
    await db.execute("UPDATE audit_log SET ts = now() - interval '23 hours 59 minutes' WHERE id = $1", audit_id)
    assert (await undo(client, audit_id)).status_code == 200


async def test_a_second_undo_is_refused_and_writes_nothing(client, db):
    old, new, audit_id = await moved(client, db)
    assert (await undo(client, audit_id)).status_code == 200
    await refused(client, db, old, audit_id, 409, ALREADY)
    assert len(await audit_rows(db, "source.move_undone")) == 1


async def test_a_source_deleted_after_the_move_cannot_be_undone(client, db):
    old, new, audit_id = await moved(client, db)
    assert (await client.delete(f"/api/sources/{old}?confirm=true")).status_code == 204
    before = await state(db, old)
    response = await undo(client, audit_id)
    assert response.status_code == 409 and response.json()["detail"] == DELETED
    assert await state(db, old) == before


@pytest.mark.parametrize(
    "changed", [{"endpoint": "opc.tcp://172.20.0.77:4840/"}, {"endpoint": "opc.tcp://172.20.0.5:4841/"}, {"endpoint": "opc.tcp://other-host:4840/"}]
)
async def test_an_address_changed_since_the_move_is_not_put_back_over(client, db, changed):
    old, new, audit_id = await moved(client, db)
    await db.execute("UPDATE sources SET config = $2 WHERE id = $1", old, changed)
    await refused(client, db, old, audit_id, 409, ADDRESS)


async def test_a_name_changed_since_the_move_is_not_put_back_over(client, db):
    old, new, audit_id = await moved(client, db)
    await db.execute("UPDATE sources SET name = 'Main incomer' WHERE id = $1", old)
    await refused(client, db, old, audit_id, 409, RENAMED)


async def test_when_both_changed_the_address_is_the_first_thing_named(client, db):
    old, new, audit_id = await moved(client, db)
    await db.execute("UPDATE sources SET name = 'Main incomer', config = $2 WHERE id = $1", old, {"endpoint": "opc.tcp://172.20.0.77:4840/"})
    await refused(client, db, old, audit_id, 409, ADDRESS)


async def test_an_old_name_that_someone_took_in_the_meantime_is_a_409_naming_it(client, db):
    old, new, audit_id = await moved(client, db)
    taken = await add_source(db, OWNERS_OLD_NAME, "172.20.0.3", origin="manual")  # the old server came back and a person (or a scan) took its name
    await refused(client, db, old, audit_id, 409, f'the old name "{OWNERS_OLD_NAME}" is taken now; rename that source first')
    await db.execute("UPDATE sources SET name = 'renamed' WHERE id = $1", taken)  # that source is renamed: now it works
    response = await undo(client, audit_id)
    assert response.status_code == 200, response.text
    assert (await row_of(db, old))["name"] == OWNERS_OLD_NAME


@pytest.mark.parametrize("status", ["queued", "running"])
async def test_a_scan_in_progress_refuses_the_undo(client, db, status):
    old, new, audit_id = await moved(client, db)
    scan = await db.fetchval("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', $1) RETURNING id", status)
    await refused(client, db, old, audit_id, 409, SCAN_RUNNING)
    await db.execute("UPDATE scans SET status = 'done', finished_at = now() WHERE id = $1", scan)
    assert (await undo(client, audit_id)).status_code == 200


async def test_an_audit_row_that_does_not_say_what_an_undo_needs_is_refused(client, db):
    old, new, audit_id = await moved(client, db)
    original = (await audit_rows(db))[0]
    for broken in ({}, {**original, "host_before": None}, {**original, "port_before": "4840"}, {**original, "finding_ids": "all"},
                   {**original, "identity_before": "x"}, {key: value for key, value in original.items() if key != "name_after"}):
        await db.execute("UPDATE audit_log SET detail = $2 WHERE id = $1", audit_id, broken)
        await refused(client, db, old, audit_id, 409, NOT_UNDOABLE)


async def test_an_address_that_cannot_be_written_back_is_refused_in_words_and_never_quoted(client, db):
    old, new, audit_id = await moved(client, db)
    await db.execute("UPDATE audit_log SET detail = jsonb_set(detail, '{host_before}', '\"bad host/x\"') WHERE id = $1", audit_id)
    before = await state(db, old)
    response = await undo(client, audit_id)
    assert response.status_code == 409 and "bad host" not in response.text, response.text
    assert await state(db, old) == before


# ---- who may undo ---------------------------------------------------------------------------------------------------------------


async def test_only_a_role_with_sources_edit_may_undo_a_move(client, db):
    old, new, audit_id = await moved(client, db)
    await client.post("/api/logout")
    assert (await undo(client, audit_id)).status_code == 401
    for role in ("viewer", "operator"):
        await login_as(client, db, role)
        assert (await undo(client, audit_id)).status_code == 403, role
        await client.post("/api/logout")
    assert await audit_rows(db, "source.move_undone") == []
    await make_role(db, "source editor", ["sources.edit"])
    await login_as(client, db, "source editor", username="editor")
    assert (await undo(client, audit_id)).status_code == 200


@pytest.mark.parametrize("headers", [{"Sec-Fetch-Site": "cross-site"}, {"Origin": "http://evil.example"}])
async def test_a_page_of_another_site_cannot_undo_a_move(client, db, headers):
    old, new, audit_id = await moved(client, db)
    before = await state(db, old)
    assert (await client.post(UNDO.format(audit_id), headers=headers)).status_code == 403
    assert await state(db, old) == before


# ---- the races: no deadlock, a clean 409 or success -----------------------------------------------------------------------------


async def test_a_scan_queued_while_the_undo_waited_for_the_scan_lock_refuses_it_and_writes_nothing(client, db):
    old, new, audit_id = await moved(client, db)
    before = await state(db, old)
    async with holder(db) as (conn, tx):
        await conn.execute("SELECT pg_advisory_xact_lock($1)", SCAN_START_LOCK)  # what start_scan holds while it creates the scan
        await conn.execute("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', 'queued')")
        undoing = await pending(db, 1, undo(client, audit_id))
        await tx.commit()
        response = (await finished(undoing))[0]
    assert response.status_code == 409 and response.json()["detail"] == SCAN_RUNNING, response.text
    assert await state(db, old) == before


async def test_a_scan_started_while_an_undo_is_in_flight_waits_for_it_and_then_runs(client, db):
    old, new, audit_id = await moved(client, db)
    scope = await create_scope(client)
    point = await db.fetchval("SELECT id FROM points WHERE source_id = $1 ORDER BY id LIMIT 1", old)
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM points WHERE id = $1 FOR UPDATE", point)  # the undo has the scan lock and waits for this point
        undoing = await pending(db, 1, undo(client, audit_id))
        scanning = await pending(db, 2, start_scan(client, scope["id"]))  # waits for the scan lock the undo holds
        await tx.rollback()
        undone, started = await finished(undoing, scanning)
    assert undone.status_code == 200, undone.text
    assert started.status_code == 202, started.text
    assert (await row_of(db, old))["config"] == {"endpoint": OLD_URL}
    assert await db.fetchval("SELECT count(*) FROM scans WHERE status = 'queued'") == 1


async def test_a_patch_that_queued_behind_the_undo_reads_the_source_where_the_undo_left_it(client, db):
    old, new, audit_id = await moved(client, db)
    point = await db.fetchval("SELECT id FROM points WHERE source_id = $1 ORDER BY id LIMIT 1", old)
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM points WHERE id = $1 FOR UPDATE", point)  # the undo holds the source row and waits for this point
        undoing = await pending(db, 1, undo(client, audit_id))
        patching = await pending(db, 2, client.patch(f"/api/sources/{old}", json={"name": "Incomer"}))  # waits for the source row
        await tx.rollback()
        undone, patched = await finished(undoing, patching)
    assert undone.status_code == 200 and patched.status_code == 200, (undone.text, patched.text)
    after = await row_of(db, old)
    assert after["name"] == "Incomer" and after["config"] == {"endpoint": OLD_URL}  # the address stays where the undo put it
    [row] = await db.fetch("SELECT detail FROM audit_log WHERE action = 'source.updated'")
    assert row["detail"]["before"] == {"name": OWNERS_OLD_NAME}  # the PATCH read the row after the undo, not before it


async def test_a_patch_that_changed_the_address_while_the_undo_waited_for_the_row_is_a_clean_409(client, db):
    old, new, audit_id = await moved(client, db)
    before = await state(db, old)
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM sources WHERE id = $1 FOR UPDATE", old)  # a PATCH in flight
        undoing = await pending(db, 1, undo(client, audit_id))
        await conn.execute("UPDATE sources SET config = $2 WHERE id = $1", old, {"endpoint": "opc.tcp://172.20.0.77:4840/"})
        await tx.commit()
        response = (await finished(undoing))[0]
    assert response.status_code == 409 and response.json()["detail"] == ADDRESS, response.text
    after = await state(db, old)
    assert after[0] == before[0] and after[2:] == before[2:]  # nothing else was written
    assert (await row_of(db, old))["config"] == {"endpoint": "opc.tcp://172.20.0.77:4840/"}  # the PATCH's address, untouched


async def test_a_browse_that_holds_a_point_and_wants_the_source_row_ends_in_a_clean_409_never_a_500(client, db):
    """The collector's browse writes a source's points, then marks the source (`UPDATE sources SET status`), outside the scan lock. The
    undo holds the source row and waits for the points: a cycle. Postgres ends one of the two; the browse is given a long deadlock
    timeout, so the undo is the one, and it must answer 409 `try again` and leave everything as it was (F17)."""
    old, new, audit_id = await moved(client, db)
    point = await db.fetchval("SELECT id FROM points WHERE source_id = $1 ORDER BY id LIMIT 1", old)
    before = await state(db, old)
    async with holder(db) as (conn, tx):
        await conn.execute("SET LOCAL deadlock_timeout = '10s'")
        await conn.execute("UPDATE points SET name = name WHERE id = $1", point)  # the browse's upsert
        undoing = await pending(db, 1, undo(client, audit_id))
        marking = asyncio.create_task(conn.execute("UPDATE sources SET status = 'online' WHERE id = $1", old))  # the browse's mark_source
        try:
            response = (await finished(undoing))[0]
            await asyncio.wait_for(marking, 15)  # the undo's rollback lets the browse through
        finally:
            marking.cancel()
        await tx.commit()
    assert response.status_code == 409 and response.json()["detail"] == TRY_AGAIN, response.text
    after = await state(db, old)
    assert after[0] == before[0] and after[2:] == before[2:]
    assert (await row_of(db, old))["config"] == {"endpoint": NEW_URL}  # still moved: nothing of the undo stayed
    assert await db.fetchval("SELECT status FROM sources WHERE id = $1", old) == "online"  # and the browse's own write went through


async def test_a_name_taken_in_the_instant_before_the_write_is_a_409_never_a_500(client, db, monkeypatch):
    """The old name is checked with no lock on the other sources: someone can take it before the UPDATE. The unique name then fails the flush."""
    from dcdash.moves import service

    old, new, audit_id = await moved(client, db)
    real = service._name_taken

    async def free_then_taken(session, name, source_id):
        found = await real(session, name, source_id)
        await db.execute("INSERT INTO sources (name, connector_type, config) VALUES ($1, 'modbus', '{}')", name)  # right after the check
        return found

    monkeypatch.setattr(service, "_name_taken", free_then_taken)
    before = await state(db, old)
    response = await undo(client, audit_id)
    assert response.status_code == 409 and response.json()["detail"] == NAME_RACE, response.text
    after = await state(db, old)
    assert after[1] == before[1] and after[2:] == before[2:]  # the source, its findings, its readings and the audit rows: as they were
    assert (await row_of(db, old))["name"] == OWNERS_NEW_NAME


async def test_the_undo_and_a_second_undo_at_the_same_time_make_one_winner(client, db):
    old, new, audit_id = await moved(client, db)
    point = await db.fetchval("SELECT id FROM points WHERE source_id = $1 ORDER BY id LIMIT 1", old)
    async with holder(db) as (conn, tx):
        await conn.fetchval("SELECT id FROM points WHERE id = $1 FOR UPDATE", point)
        first = await pending(db, 1, undo(client, audit_id))
        second = await pending(db, 2, undo(client, audit_id))  # waits for the scan lock the first holds
        await tx.rollback()
        one, two = await finished(first, second)
    assert sorted((one.status_code, two.status_code)) == [200, 409], (one.text, two.text)
    loser = one if one.status_code == 409 else two
    assert loser.json()["detail"] == ALREADY
    assert len(await audit_rows(db, "source.move_undone")) == 1
