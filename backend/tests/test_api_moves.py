"""POST /api/sources/{id}/move (w33 R5, R6, P7-P9, F1, F8, F10, F-M4..M6): move a source that stopped answering to the address where
its server turned up.

A wrong move sends a meter's readings (and the bills built on them) to the wrong asset and deletes a source, so most of these tests
are about what it must NOT do: change anything on a dry run, move without the person's numbers, touch a point, a mapping or a reading
of the old source, write more than the host and port of its address, or leak a credential. The races are in test_moves_service.py.

The world is the owner's screenshot (`test_moves_load.owners_case`): `OPC UA server at 172.20.0.3:4840` has three mapped points and
stopped answering; a scan that began after that found the same three points (and one more) at `OPC UA server at 172.20.0.5:4840`.
"""
import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta

import pytest

from dcdash.core.crypto import encrypt
from dcdash.core.pg import CONFIG_CHANNEL
from helpers import listening, login_as, make_role
from test_moves_freshness import finished_at, make_finding, make_scan, marks
from test_moves_load import PAIRS, add_points, add_source, map_points, new_source, old_source, open_incident, owners_case

MOVE = "/api/sources/{}/move"
EXTRA_PAIR = ("ns=2;s=LVP03.kW", "LVP03 kW")
URI = "urn:vendor:meter-7"
THUMBPRINT = "AA:BB:CC:DD"
OWNERS_OLD_NAME = "OPC UA server at 172.20.0.3:4840"
OWNERS_NEW_NAME = "OPC UA server at 172.20.0.5:4840"
TABLES = ("sources", "points", "mappings", "scan_findings", "audit_log", "diag_events", "graph_layout", "readings", "point_latest")


# ---- helpers -------------------------------------------------------------------------------------------------------------------


async def counts(db) -> dict[str, int]:
    return {table: await db.fetchval(f"SELECT count(*) FROM {table}") for table in TABLES}


async def row_of(db, source_id: int):
    return await db.fetchrow("SELECT name, connector_type, config, secret, identity, status, enabled, origin FROM sources WHERE id = $1", source_id)


async def preview(client, old: int, new: int, address: str = "as_found"):
    return await client.post(MOVE.format(old) + "?dry_run=1", json={"to": new, "address": address})


REQUIRED_EXPECT = ("mappings", "address_before", "address_after", "name_after")


def expect_of(shown: dict) -> dict:
    """What a front end sends back: the numbers and addresses the preview showed (as `host:port` strings) and why it was offered."""
    return {
        "mappings": shown["mappings"],
        "address_before": f"{shown['from']['host']}:{shown['from']['port']}",
        "address_after": f"{shown['to']['host']}:{shown['to']['port']}",
        "name_after": shown["rename"]["to"] if shown["rename"] else None,
        "match_kind": shown["match"]["kind"],
        "needs_tick": shown["needs_tick"],
    }


async def move(client, old: int, new: int, address: str = "as_found", *, ticked: bool = True, **changes):
    """Preview, then move with what the preview showed (`changes` replaces keys of `expect`) and the box ticked (`ticked`)."""
    shown = await preview(client, old, new, address)
    assert shown.status_code == 200, shown.text
    return await client.post(
        MOVE.format(old), json={"to": new, "address": address, "expect": {**expect_of(shown.json()), **changes}, "ticked": ticked},
    )


async def audit_rows(db, action: str = "source.moved") -> list[dict]:
    return [r["detail"] for r in await db.fetch("SELECT detail FROM audit_log WHERE action = $1 ORDER BY id", action)]


async def everything_said(db) -> str:
    """Every audit row and every journal row as text, to search for a secret."""
    rows = await db.fetch("SELECT action, detail::text AS detail FROM audit_log")
    events = await db.fetch("SELECT message, detail::text AS detail, code FROM diag_events")
    return json.dumps([[dict(r) for r in rows], [dict(r) for r in events]], default=str)


async def with_hint(db, source: int, name: str = "simulator", host: str = "172.20.0.5") -> None:
    await db.execute("UPDATE sources SET identity = $2 WHERE id = $1", source, {"name_hint": {"name": name, "host": host}})


async def same_server_case(db) -> tuple[int, int]:
    """A hand-added source that knows its server (URI and certificate) and a scan's copy that reports the same ones."""
    await make_scan(db, day=0)
    identity = {"application_uri": URI, "thumbprint": THUMBPRINT}
    old = await old_source(db, OWNERS_OLD_NAME, "172.20.0.3", origin="manual", identity=identity)
    second = await make_scan(db, day=3)
    new = await new_source(db, OWNERS_NEW_NAME, "172.20.0.5", second, identity={**identity, "application_name": "Meter 7"})
    return old, new


async def credentialed_case(db) -> tuple[int, int]:
    """The owner's case, but the old source has a user name and password in its address, a stored secret and its own settings."""
    first = await make_scan(db, day=0)
    config = {
        "endpoint": "opc.tcp://user:pass@172.20.0.3:4840/dcdash/", "security_policy": "basic256sha256", "username": "user",
        "root_node": "ns=2;s=Plant", "timeout_seconds": 9.0, "client_cert": "/certs/a.pem", "client_key": "/certs/a-key.pem",
    }
    old = await add_source(
        db, OWNERS_OLD_NAME, "172.20.0.3", path="/dcdash/", origin="discovered", status="offline", last_seen=finished_at(0), config=config,
    )
    await db.execute("UPDATE sources SET secret = $2 WHERE id = $1", old, encrypt("s3cret-value"))
    await map_points(db, await add_points(db, old, PAIRS))
    await open_incident(db, old, "unreachable")
    await make_finding(db, first, "172.20.0.3", 4840, old)
    second = await make_scan(db, day=3)
    new = await new_source(db, OWNERS_NEW_NAME, "172.20.0.5", second, pairs=PAIRS + [EXTRA_PAIR], path="/dcdash/")
    return old, new


# ---- the preview ---------------------------------------------------------------------------------------------------------------


async def test_the_preview_of_the_owners_case_says_what_would_happen(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    response = await preview(client, old, new)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "dry_run": True, "scan_running": False,
        "source": {"id": old, "name": OWNERS_OLD_NAME}, "target": {"id": new, "name": OWNERS_NEW_NAME, "points": 4},
        "from": {"host": "172.20.0.3", "port": 4840, "endpoint": "opc.tcp://172.20.0.3:4840/"},
        "to": {"host": "172.20.0.5", "port": 4840, "endpoint": "opc.tcp://172.20.0.5:4840/"},
        "address": "as_found", "name_hint": None, "rename": {"from": OWNERS_OLD_NAME, "to": OWNERS_NEW_NAME},
        "match": {"kind": "possibly", "evidence": "addresses", "value": None, "addresses": 3, "missing_addresses": 0, "needs_tick": True},
        "mappings": 3, "mapped_points": 3, "assets": 1, "needs_tick": True,
    }


async def test_a_same_server_preview_needs_no_tick_when_both_sides_have_a_certificate(client, db):
    await login_as(client, db)
    old, new = await same_server_case(db)
    shown = (await preview(client, old, new)).json()
    assert shown["match"] == {"kind": "same_server", "evidence": "uri", "value": URI, "addresses": 3, "missing_addresses": 0, "needs_tick": False}
    assert shown["needs_tick"] is False


async def test_the_preview_names_the_container_name_hint_only_while_it_is_for_the_found_address(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    await with_hint(db, new)
    assert (await preview(client, old, new)).json()["name_hint"] == "simulator"
    await with_hint(db, new, host="172.20.0.9")  # a hint for another address says nothing about this one
    assert (await preview(client, old, new)).json()["name_hint"] is None


async def test_a_preview_while_a_scan_runs_says_so_and_still_answers(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    for status in ("queued", "running"):
        scan = await db.fetchval("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', $1) RETURNING id", status)
        response = await preview(client, old, new)
        assert response.status_code == 200 and response.json()["scan_running"] is True, status
        await db.execute("DELETE FROM scans WHERE id = $1", scan)
    assert (await preview(client, old, new)).json()["scan_running"] is False


async def test_the_dry_run_changes_nothing(client, db, database_url):
    await login_as(client, db)
    old, new = await owners_case(db)
    await db.execute("INSERT INTO graph_layout (node_id, x, y) VALUES ($1, 1, 2), ($2, 3, 4)", f"src:{new}", f"src:{old}")
    async with listening(database_url, CONFIG_CHANNEL) as received:
        for address in ("as_found", "name"):
            await with_hint(db, new)
            before = (await counts(db), await row_of(db, old), await row_of(db, new))
            assert (await preview(client, old, new, address)).status_code == 200
            assert (await counts(db), await row_of(db, old), await row_of(db, new)) == before
        await db.execute("SELECT pg_notify($1, 'sentinel')", CONFIG_CHANNEL)
        assert await asyncio.wait_for(received.get(), timeout=5) == "sentinel"  # nothing was announced to the collector before it


# ---- the move: the owner's case ------------------------------------------------------------------------------------------------


async def test_the_move_of_the_owners_case_changes_the_address_and_the_name_and_nothing_else(client, db, database_url):
    await login_as(client, db)
    admin = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    old, new = await owners_case(db)
    points_before = await db.fetch("SELECT * FROM points WHERE source_id = $1 ORDER BY id", old)
    mappings_before = await db.fetch("SELECT * FROM mappings ORDER BY id")
    for n, point in enumerate(points_before):
        await db.execute("INSERT INTO readings (point_id, ts, value) VALUES ($1, now() - $2 * interval '1 minute', $3)", point["id"], n + 1, 10.0 * n)
    readings_before = await db.fetch("SELECT point_id, ts, value, quality FROM readings ORDER BY point_id, ts")
    others_before = await row_of(db, old)
    new_points = [r["id"] for r in await db.fetch("SELECT id FROM points WHERE source_id = $1", new)]
    new_finding = await db.fetchval("SELECT id FROM scan_findings WHERE source_id = $1", new)
    first_finding = await db.fetchval("SELECT id FROM scan_findings WHERE source_id = $1", old)
    await db.executemany(
        "INSERT INTO graph_layout (node_id, x, y) VALUES ($1, 1, 2)",
        [(f"src:{new}",), (f"cluster:{new}:Panel",), (f"point:{new_points[0]}",), (f"src:{old}",), (f"point:{points_before[0]['id']}",), ("asset:1",)],
    )

    async with listening(database_url, CONFIG_CHANNEL) as received:
        response = await move(client, old, new)
        assert response.status_code == 200, response.text
        await db.execute("SELECT pg_notify($1, 'sentinel')", CONFIG_CHANNEL)
        announced = []
        while (payload := await asyncio.wait_for(received.get(), timeout=5)) != "sentinel":
            announced.append(payload)
    assert len(announced) == 1  # the collector is told once, at the commit

    done = response.json()
    audit_id = await db.fetchval("SELECT id FROM audit_log WHERE action = 'source.moved'")
    assert done["audit_id"] == audit_id
    undo_until = datetime.fromisoformat(done["undo_until"])
    assert abs(undo_until - (datetime.now(UTC) + timedelta(hours=24))) < timedelta(minutes=5)
    assert {key: done[key] for key in done if key not in ("audit_id", "undo_until")} == {
        "dry_run": False, "source": {"id": old, "name": OWNERS_NEW_NAME},
        "from": {"host": "172.20.0.3", "port": 4840, "endpoint": "opc.tcp://172.20.0.3:4840/"},
        "to": {"host": "172.20.0.5", "port": 4840, "endpoint": "opc.tcp://172.20.0.5:4840/"},
        "rename": {"from": OWNERS_OLD_NAME, "to": OWNERS_NEW_NAME},
    }

    # the old source: same id, new address and name; everything else as it was
    after = await row_of(db, old)
    assert after["config"] == {"endpoint": "opc.tcp://172.20.0.5:4840/"}
    assert after["name"] == OWNERS_NEW_NAME  # the new label, with no " (2)": the scan's copy is gone
    assert (after["connector_type"], after["secret"], after["status"], after["enabled"], after["origin"]) == (
        others_before["connector_type"], others_before["secret"], others_before["status"], others_before["enabled"], others_before["origin"],
    )
    # its points, mappings and readings are the very same rows
    assert await db.fetch("SELECT * FROM points WHERE source_id = $1 ORDER BY id", old) == points_before
    assert await db.fetch("SELECT * FROM mappings ORDER BY id") == mappings_before
    assert await db.fetch("SELECT point_id, ts, value, quality FROM readings ORDER BY point_id, ts") == readings_before
    # the scan's copy and everything of it is gone
    assert await db.fetchval("SELECT count(*) FROM sources WHERE id = $1", new) == 0
    assert await db.fetchval("SELECT count(*) FROM points WHERE source_id = $1", new) == 0
    assert sorted(r["node_id"] for r in await db.fetch("SELECT node_id FROM graph_layout")) == sorted(
        [f"src:{old}", f"point:{points_before[0]['id']}", "asset:1"]
    )
    # its findings: the copy's now belong to it, so the latest scan found it (F1)
    assert [r["id"] for r in await db.fetch("SELECT id FROM scan_findings WHERE source_id = $1 ORDER BY id", old)] == [first_finding, new_finding]
    assert await marks(old) == {}
    # the audit row
    [detail] = await audit_rows(db)
    assert detail == {
        "source_id": old, "name_before": OWNERS_OLD_NAME, "name_after": OWNERS_NEW_NAME,
        "host_before": "172.20.0.3", "port_before": 4840, "host_after": "172.20.0.5", "port_after": 4840, "address": "as_found",
        "authority_before": "172.20.0.3:4840", "authority_after": "172.20.0.5:4840",
        "identity_before": None, "identity_after": None,
        "match": {"kind": "possibly", "evidence": "addresses", "value": None, "addresses": 3, "missing_addresses": 0},
        "mappings": 3, "removed": {"source_id": new, "name": OWNERS_NEW_NAME, "points": 4}, "finding_ids": [new_finding],
        "last_seen_before": finished_at(0).isoformat(),  # the old source's last answer, as read under the lock (T5b-M1)
    }
    assert await db.fetchval("SELECT user_id FROM audit_log WHERE id = $1", audit_id) == admin


async def test_a_move_clears_the_stale_error_of_the_old_address_and_leaves_the_status_to_the_first_poll(client, db):
    # Whole-wave review, minor 3: for some seconds the renamed row showed "Connect call failed ('172.20.0.3', 4840)" beside the new name.
    await login_as(client, db)
    old, new = await owners_case(db)
    error = "Connect call failed ('172.20.0.3', 4840)"
    await db.execute("UPDATE sources SET last_error = $2 WHERE id = $1", old, error)
    assert await db.fetchval("SELECT last_error FROM sources WHERE id = $1", old) == error
    assert (await move(client, old, new)).status_code == 200
    stored = await db.fetchrow("SELECT status, last_error, last_seen FROM sources WHERE id = $1", old)
    assert stored["last_error"] is None
    assert stored["status"] == "offline"  # the first poll at the new address decides this, as before
    assert stored["last_seen"] is not None  # (and what the source last answered is not erased)
    row = next(r for r in (await client.get("/api/sources")).json() if r["id"] == old)
    assert row["last_error"] is None and "172.20.0.3" not in json.dumps(row)


async def test_a_refused_move_keeps_the_error(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    error = "Connect call failed ('172.20.0.3', 4840)"
    await db.execute("UPDATE sources SET last_error = $2 WHERE id = $1", old, error)
    shown = (await preview(client, old, new)).json()
    refused = await client.post(MOVE.format(old), json={"to": new, "address": "as_found", "expect": expect_of(shown), "ticked": False})
    assert refused.status_code == 409
    assert await db.fetchval("SELECT last_error FROM sources WHERE id = $1", old) == error


async def test_the_audit_list_shows_one_source_moved_row(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    assert (await move(client, old, new)).status_code == 200
    rows = [r for r in (await client.get("/api/audit?limit=200")).json()["items"] if r["action"] == "source.moved"]
    assert len(rows) == 1 and rows[0]["detail"]["source_id"] == old and rows[0]["refs"]["source"][str(old)] == OWNERS_NEW_NAME


async def test_the_old_source_takes_the_identity_of_the_copy(client, db):
    await login_as(client, db)
    old, new = await same_server_case(db)
    copy = (await row_of(db, new))["identity"]
    assert (await move(client, old, new)).status_code == 200
    assert (await row_of(db, old))["identity"] == copy == {"application_uri": URI, "thumbprint": THUMBPRINT, "application_name": "Meter 7"}
    [detail] = await audit_rows(db)
    assert detail["match"]["kind"] == "same_server" and detail["identity_before"] == {"application_uri": URI, "thumbprint": THUMBPRINT}
    assert detail["identity_after"] == copy


async def test_a_name_hint_stays_with_the_identity_only_while_it_is_for_the_address_the_source_points_at(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    await with_hint(db, new)
    assert (await move(client, old, new)).status_code == 200
    assert (await row_of(db, old))["identity"] == {"name_hint": {"name": "simulator", "host": "172.20.0.5"}}


async def test_moving_by_name_writes_the_name_as_the_host_and_renames_to_the_name_label(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    await with_hint(db, new)
    shown = (await preview(client, old, new, "name")).json()
    assert shown["to"] == {"host": "simulator", "port": 4840, "endpoint": "opc.tcp://simulator:4840/"} and shown["address"] == "name"
    assert shown["rename"] == {"from": OWNERS_OLD_NAME, "to": "OPC UA server at simulator:4840"}
    response = await move(client, old, new, "name")
    assert response.status_code == 200, response.text
    after = await row_of(db, old)
    assert after["config"] == {"endpoint": "opc.tcp://simulator:4840/"} and after["name"] == "OPC UA server at simulator:4840"
    assert after["identity"] is None  # the hint was for the numeric address; the source now uses the name itself
    [detail] = await audit_rows(db)
    assert (detail["host_after"], detail["address"]) == ("simulator", "name")


async def test_moving_by_name_without_a_hint_for_that_address_is_refused_in_words(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    before = await counts(db)
    for hint in (None, {"name": "simulator", "host": "172.20.0.9"}, {"name": "bad name!", "host": "172.20.0.5"}):
        await db.execute("UPDATE sources SET identity = $2 WHERE id = $1", new, None if hint is None else {"name_hint": hint})
        for url in (MOVE.format(old) + "?dry_run=1", MOVE.format(old)):
            response = await client.post(url, json={"to": new, "address": "name", "expect": {"mappings": 3, "address_before": "172.20.0.3:4840", "address_after": "simulator:4840", "name_after": None}})
            assert response.status_code == 422 and response.json()["detail"] == "no name is known for that address", (hint, url)
    assert await counts(db) == before


# ---- names (R6, P8, F8) ---------------------------------------------------------------------------------------------------------


async def rename_case(db, old_name: str, *, new_name: str = OWNERS_NEW_NAME, extra: list[str] = ()) -> tuple[int, int]:
    old, new = await owners_case(db)
    await db.execute("UPDATE sources SET name = $2 WHERE id = $1", old, old_name)
    await db.execute("UPDATE sources SET name = $2 WHERE id = $1", new, new_name)
    for name in extra:
        await add_source(db, name, "172.20.0.99", origin="manual")
    return old, new


async def test_a_name_a_person_typed_is_kept(client, db):
    await login_as(client, db)
    old, new = await rename_case(db, "Main incomer meter")
    assert (await preview(client, old, new)).json()["rename"] is None
    response = await move(client, old, new)
    assert response.status_code == 200 and response.json()["rename"] is None
    assert (await row_of(db, old))["name"] == "Main incomer meter"
    [detail] = await audit_rows(db)
    assert detail["name_before"] == detail["name_after"] == "Main incomer meter"


@pytest.mark.parametrize("old_name", [OWNERS_OLD_NAME, OWNERS_OLD_NAME + " (2)", OWNERS_OLD_NAME + " (7)"])
async def test_a_default_name_follows_the_address_and_loses_its_number_when_the_new_label_is_free(client, db, old_name):
    await login_as(client, db)
    old, new = await rename_case(db, old_name)
    assert (await move(client, old, new)).status_code == 200
    assert (await row_of(db, old))["name"] == OWNERS_NEW_NAME  # the copy that held it is gone by the time the name is chosen


async def test_the_first_free_number_is_counted_after_the_copy_is_gone(client, db):
    await login_as(client, db)
    # A third source holds the bare label, the copy holds " (2)": once the copy is gone " (2)" is free again.
    old, new = await rename_case(db, OWNERS_OLD_NAME, new_name=OWNERS_NEW_NAME + " (2)", extra=[OWNERS_NEW_NAME, OWNERS_NEW_NAME + " (3)"])
    shown = (await preview(client, old, new)).json()
    assert shown["rename"] == {"from": OWNERS_OLD_NAME, "to": OWNERS_NEW_NAME + " (2)"}
    assert (await move(client, old, new)).status_code == 200
    assert (await row_of(db, old))["name"] == OWNERS_NEW_NAME + " (2)"


async def test_a_number_is_never_carried_over_and_the_old_source_never_counts_against_itself(client, db):
    await login_as(client, db)
    old, new = await rename_case(db, OWNERS_OLD_NAME + " (2)", extra=[OWNERS_NEW_NAME + " (2)"])
    assert (await preview(client, old, new)).json()["rename"]["to"] == OWNERS_NEW_NAME


async def test_a_name_taken_after_the_preview_is_a_change_since_the_preview(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    shown = (await preview(client, old, new)).json()
    assert shown["rename"]["to"] == OWNERS_NEW_NAME
    await db.execute("UPDATE sources SET name = 'renamed copy' WHERE id = $1", new)
    await add_source(db, OWNERS_NEW_NAME, "172.20.0.98", origin="manual")  # someone took the label the preview promised
    before = await counts(db)
    response = await client.post(MOVE.format(old), json={"to": new, "address": "as_found", "expect": expect_of(shown), "ticked": True})
    assert response.status_code == 409 and response.json()["detail"].startswith("changed since the preview: ")
    assert OWNERS_NEW_NAME + " (2)" in response.json()["detail"]
    assert await counts(db) == before and (await row_of(db, old))["name"] == OWNERS_OLD_NAME


# ---- the address: only the host and port change ----------------------------------------------------------------------------------


async def test_a_credentialed_address_keeps_its_credentials_its_secret_and_its_settings(client, db, caplog):
    caplog.set_level(logging.DEBUG)
    await login_as(client, db)
    old, new = await credentialed_case(db)
    before = await row_of(db, old)
    shown = await preview(client, old, new)
    assert shown.status_code == 200, shown.text
    assert shown.json()["from"]["endpoint"] == "opc.tcp://172.20.0.3:4840/dcdash/"  # no user info in what is shown (F10)
    response = await move(client, old, new)
    assert response.status_code == 200, response.text
    after = await row_of(db, old)
    assert after["config"] == {**before["config"], "endpoint": "opc.tcp://user:pass@172.20.0.5:4840/dcdash/"}  # one key changed, one text
    assert after["secret"] == before["secret"] and after["secret"] is not None  # untouched, byte for byte
    # nowhere a person or a log can read it
    for text in (shown.text, response.text, await everything_said(db)):
        assert "pass" not in text and "user:" not in text and "s3cret" not in text
    assert "user:" not in caplog.text and ":pass@" not in caplog.text and "s3cret" not in caplog.text
    [detail] = await audit_rows(db)
    assert "pass" not in json.dumps(detail) and "user" not in json.dumps(detail)


async def test_the_simulator_address_keeps_its_trailing_slash_and_its_other_settings(client, db):
    await login_as(client, db)
    first = await make_scan(db, day=0)
    config = {"url": "http://172.20.0.3:9000/", "timeout_seconds": 7.5}
    old = await add_source(db, "DCDash simulator at 172.20.0.3:9000", "172.20.0.3", kind="simulator", port=9000, origin="discovered",
                           status="offline", last_seen=finished_at(0), config=config)
    await map_points(db, await add_points(db, old, PAIRS))
    await open_incident(db, old, "unreachable")
    await make_finding(db, first, "172.20.0.3", 9000, old)
    second = await make_scan(db, day=3)
    new = await new_source(db, "DCDash simulator at 172.20.0.5:9000", "172.20.0.5", second, kind="simulator", port=9000)
    await db.execute("UPDATE sources SET config = $2 WHERE id = $1", new, {"url": "http://172.20.0.5:9000/", "timeout_seconds": 5.0})
    shown = (await preview(client, old, new)).json()
    assert shown["to"] == {"host": "172.20.0.5", "port": 9000, "endpoint": "http://172.20.0.5:9000"} and shown["rename"]["to"] == "DCDash simulator at 172.20.0.5:9000"
    assert (await move(client, old, new)).status_code == 200
    after = await row_of(db, old)
    assert after["config"] == {"url": "http://172.20.0.5:9000/", "timeout_seconds": 7.5}  # not the scan's 5.0
    assert after["name"] == "DCDash simulator at 172.20.0.5:9000"


async def test_a_source_whose_stored_config_has_only_its_address_gets_no_other_key(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)  # the helper stores {"endpoint": ...} alone: no defaults were ever filled in
    assert (await row_of(db, old))["config"] == {"endpoint": "opc.tcp://172.20.0.3:4840/"}
    assert (await move(client, old, new)).status_code == 200
    assert (await row_of(db, old))["config"] == {"endpoint": "opc.tcp://172.20.0.5:4840/"}


async def test_an_address_that_cannot_be_rewritten_safely_is_refused_in_words_and_never_quoted(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    await db.execute("UPDATE sources SET config = $2 WHERE id = $1", old, {"endpoint": "opc.tcp://user:pa/ss@172.20.0.3:4840/"})
    before = await counts(db)
    response = await preview(client, old, new)
    assert response.status_code in (409, 422) and "pa/ss" not in response.text and "user" not in response.text
    assert await counts(db) == before


# ---- refusals ------------------------------------------------------------------------------------------------------------------


async def test_a_real_move_needs_the_numbers_the_preview_showed(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    before = await counts(db)
    missing = await client.post(MOVE.format(old), json={"to": new, "address": "as_found"})
    assert missing.status_code == 422 and "expect" in missing.json()["detail"]
    shown = expect_of((await preview(client, old, new)).json())
    for key in REQUIRED_EXPECT:
        partial = {k: v for k, v in shown.items() if k != key}
        assert (await client.post(MOVE.format(old), json={"to": new, "address": "as_found", "expect": partial, "ticked": True})).status_code == 422, key
    assert await counts(db) == before


@pytest.mark.parametrize(
    "change, mentions",
    [
        ({"mappings": 2}, "3 mappings"),
        ({"address_before": "172.20.0.4:4840"}, "172.20.0.3:4840"),
        ({"address_after": "172.20.0.6:4840"}, "172.20.0.5:4840"),
        ({"name_after": "Something else"}, OWNERS_NEW_NAME),
        ({"name_after": None}, OWNERS_NEW_NAME),
    ],
)
async def test_anything_that_differs_from_the_preview_is_a_409_naming_the_difference_and_nothing_is_written(client, db, change, mentions):
    await login_as(client, db)
    old, new = await owners_case(db)
    before = (await counts(db), await row_of(db, old))
    response = await move(client, old, new, **change)
    assert response.status_code == 409 and response.json()["detail"].startswith("changed since the preview: "), response.text
    assert mentions in response.json()["detail"]
    assert (await counts(db), await row_of(db, old)) == before


async def test_the_first_difference_is_the_one_named(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    response = await move(client, old, new, mappings=99, address_before="x:1")
    assert "mappings" in response.json()["detail"] and "x:1" not in response.json()["detail"]


async def test_a_mapping_added_since_the_preview_is_a_change(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    shown = (await preview(client, old, new)).json()
    extra = await add_points(db, old, [EXTRA_PAIR])  # one more mapped pair, which the new source has too: still a match, one more mapping
    await map_points(db, extra)
    response = await client.post(MOVE.format(old), json={"to": new, "address": "as_found", "expect": expect_of(shown), "ticked": True})
    assert response.status_code == 409 and "4 mappings" in response.json()["detail"]
    assert await db.fetchval("SELECT count(*) FROM sources WHERE id = $1", new) == 1


@pytest.mark.parametrize("status", ["queued", "running"])
async def test_a_scan_in_progress_refuses_the_real_run_and_nothing_is_written(client, db, status):
    await login_as(client, db)
    old, new = await owners_case(db)
    shown = (await preview(client, old, new)).json()
    await db.execute("INSERT INTO scans (scope_snapshot, status) VALUES ('{}', $1)", status)
    before = (await counts(db), await row_of(db, old))
    response = await client.post(MOVE.format(old), json={"to": new, "address": "as_found", "expect": expect_of(shown), "ticked": True})
    assert response.status_code == 409 and response.json()["detail"] == "A scan is running. Move the source when it has finished."
    assert (await counts(db), await row_of(db, old)) == before


async def test_a_finished_scan_does_not_refuse(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    for status in ("done", "failed"):
        await db.execute("INSERT INTO scans (scope_snapshot, status, finished_at) VALUES ('{}', $1, now())", status)
    assert (await move(client, old, new)).status_code == 200


async def test_the_old_source_that_answers_again_is_not_moved(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    shown = (await preview(client, old, new)).json()
    await db.execute("UPDATE sources SET status = 'online' WHERE id = $1", old)
    before = await counts(db)
    for url in (MOVE.format(old), MOVE.format(old) + "?dry_run=1"):
        response = await client.post(url, json={"to": new, "address": "as_found", "expect": expect_of(shown), "ticked": True})
        assert response.status_code == 409 and "not offline any more" in response.json()["detail"], url
    assert await counts(db) == before


async def test_a_new_source_that_got_a_mapping_since_is_not_deleted(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    shown = (await preview(client, old, new)).json()
    await map_points(db, [await db.fetchval("SELECT id FROM points WHERE source_id = $1 ORDER BY id LIMIT 1", new)])
    before = await counts(db)
    response = await client.post(MOVE.format(old), json={"to": new, "address": "as_found", "expect": expect_of(shown), "ticked": True})
    assert response.status_code == 409 and "got a mapping" in response.json()["detail"]
    assert await counts(db) == before and (await row_of(db, old))["name"] == OWNERS_OLD_NAME


@pytest.mark.parametrize("where", ["point_latest", "readings"])
async def test_a_new_source_that_holds_a_reading_is_not_deleted(client, db, where):
    await login_as(client, db)
    old, new = await owners_case(db)
    shown = (await preview(client, old, new)).json()
    point = await db.fetchval("SELECT id FROM points WHERE source_id = $1 ORDER BY id LIMIT 1", new)
    if where == "readings":
        await db.execute("INSERT INTO readings (point_id, ts, value) VALUES ($1, now(), 1)", point)
    else:
        await db.execute("INSERT INTO point_latest (point_id, ts, value) VALUES ($1, now(), 1)", point)
    before = await counts(db)
    for url in (MOVE.format(old), MOVE.format(old) + "?dry_run=1"):
        response = await client.post(url, json={"to": new, "address": "as_found", "expect": expect_of(shown), "ticked": True})
        assert response.status_code == 409 and "holds readings" in response.json()["detail"], url
    assert await counts(db) == before and await db.fetchval("SELECT count(*) FROM sources WHERE id = $1", new) == 1


async def test_two_servers_that_could_be_the_old_one_are_never_moved_onto(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    third = await new_source(db, "twin", "172.20.0.6", await db.fetchval("SELECT max(id) FROM scans"), pairs=PAIRS + [EXTRA_PAIR])
    before = await counts(db)
    for target in (new, third):
        response = await preview(client, old, target)
        assert response.status_code == 409 and response.json()["detail"] == "Two servers could be this one; edit the address by hand"
    assert await counts(db) == before


async def test_a_new_source_that_is_no_longer_the_match_is_refused(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    shown = (await preview(client, old, new)).json()
    await db.execute("DELETE FROM points WHERE source_id = $1 AND name = 'LVP01 kW'", new)  # it lost a mapped pair: no longer a match
    before = await counts(db)
    response = await client.post(MOVE.format(old), json={"to": new, "address": "as_found", "expect": expect_of(shown), "ticked": True})
    assert response.status_code == 409 and "no longer the one match" in response.json()["detail"]
    assert await counts(db) == before


async def test_modbus_is_refused_in_words(client, db):
    await login_as(client, db)
    await make_scan(db, day=0)
    old = await old_source(db, "meter", "172.20.0.3", kind="modbus")
    new = await new_source(db, "twin", "172.20.0.5", await make_scan(db, day=3), kind="modbus")
    before = await counts(db)
    for url in (MOVE.format(old) + "?dry_run=1", MOVE.format(old)):
        response = await client.post(url, json={"to": new, "address": "as_found", "expect": {"mappings": 3, "address_before": "a:1", "address_after": "b:1", "name_after": None}})
        assert response.status_code == 422 and "Modbus" in response.json()["detail"], url
    assert await counts(db) == before


async def test_the_new_source_must_be_a_scan_find_of_the_same_kind(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    before = await counts(db)
    await db.execute("UPDATE sources SET origin = 'manual' WHERE id = $1", new)
    assert (await preview(client, old, new)).status_code == 422
    await db.execute("UPDATE sources SET origin = 'discovered', connector_type = 'simulator' WHERE id = $1", new)
    assert (await preview(client, old, new)).status_code == 422
    assert await counts(db) == before


async def test_unknown_and_identical_ids(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    assert (await preview(client, 99999, new)).status_code == 404
    unknown = await preview(client, old, 99999)
    assert unknown.status_code == 404 and "new source was not found" in unknown.json()["detail"]
    assert (await preview(client, old, old)).status_code == 422
    for bad in (0, -1, 2**31):
        assert (await client.post(MOVE.format(bad) + "?dry_run=1", json={"to": new, "address": "as_found"})).status_code == 422
        assert (await client.post(MOVE.format(old) + "?dry_run=1", json={"to": bad, "address": "as_found"})).status_code == 422
    assert (await client.post(MOVE.format(old) + "?dry_run=1", json={"to": new, "address": "elsewhere"})).status_code == 422
    assert (await client.post(MOVE.format(old) + "?dry_run=1", json={})).status_code == 422


async def test_a_second_send_for_a_pair_that_already_moved_says_so(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    shown = (await preview(client, old, new)).json()
    body = {"to": new, "address": "as_found", "expect": expect_of(shown), "ticked": True}
    assert (await client.post(MOVE.format(old), json=body)).status_code == 200
    after = (await counts(db), await row_of(db, old))
    for url in (MOVE.format(old), MOVE.format(old) + "?dry_run=1"):
        again = await client.post(url, json=body)
        assert again.status_code == 409 and again.json()["detail"] == "this source was already moved", url
    assert (await counts(db), await row_of(db, old)) == after
    assert len(await audit_rows(db)) == 1


async def test_a_source_that_is_gone_is_not_called_already_moved(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    shown = (await preview(client, old, new)).json()
    assert (await client.post(MOVE.format(old), json={"to": new, "address": "as_found", "expect": expect_of(shown), "ticked": True})).status_code == 200
    await db.execute("UPDATE sources SET config = $2 WHERE id = $1", old, {"endpoint": "opc.tcp://172.20.0.77:4840/"})  # edited since
    assert (await preview(client, old, new)).status_code == 404
    await db.execute("DELETE FROM sources WHERE id = $1", old)
    assert (await preview(client, old, new)).status_code == 404


# ---- another server answers at the new address now (fix 5a C1) ---------------------------------------------------------------------

DIFFERENT_SERVER = "A different server answers at the new address now; scan again before moving"
OTHER_SERVER = {"application_uri": "urn:other:T", "thumbprint": "CC:DD", "at": "2026-10-21T00:00:00+00:00"}


async def another_server_now_answers(db, source: int) -> None:
    """What the collector's `remember()` leaves on a source when ANOTHER server answers at its address: the first server's identity
    stays (and so do its points), the other one is noted in `different`."""
    await db.execute("UPDATE sources SET identity = COALESCE(identity, '{}'::jsonb) || $2 WHERE id = $1", source, {"different": OTHER_SERVER})


async def test_a_new_source_where_another_server_answers_now_is_not_moved_onto_though_everything_else_matches(client, db):
    await login_as(client, db)
    old, new = await same_server_case(db)
    shown = (await preview(client, old, new)).json()
    assert shown["match"]["kind"] == "same_server" and shown["needs_tick"] is False  # the best evidence there is, and no tick asked
    await another_server_now_answers(db, new)  # a scan ran between the preview and the click
    before = (await counts(db), await row_of(db, old), await row_of(db, new))
    for url in (MOVE.format(old) + "?dry_run=1", MOVE.format(old)):
        response = await client.post(url, json={"to": new, "address": "as_found", "expect": expect_of(shown), "ticked": True})
        assert response.status_code == 409 and response.json()["detail"] == DIFFERENT_SERVER, (url, response.text)
    assert (await counts(db), await row_of(db, old), await row_of(db, new)) == before  # nothing written, nothing deleted
    assert await audit_rows(db) == []


async def test_a_new_source_that_already_had_another_server_when_the_page_was_opened_is_refused_in_the_same_words(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    await another_server_now_answers(db, new)
    rows = {row["name"]: row for row in (await client.get("/api/sources")).json()}
    assert rows[OWNERS_OLD_NAME]["move_candidate"] is None  # no offer is made for it
    for address in ("as_found", "name"):  # also when somebody asks anyway
        response = await preview(client, old, new, address)
        assert response.status_code == 409 and response.json()["detail"] == DIFFERENT_SERVER, address


async def test_the_server_that_answered_first_is_back_and_the_move_is_offered_again(client, db):
    await login_as(client, db)
    old, new = await same_server_case(db)
    await another_server_now_answers(db, new)
    assert (await preview(client, old, new)).status_code == 409
    await db.execute("UPDATE sources SET identity = identity - 'different' WHERE id = $1", new)  # remember() drops it when S answers again
    assert (await preview(client, old, new)).status_code == 200


async def test_the_identity_the_old_source_takes_never_carries_a_different_note(client, db):
    from dcdash.moves.service import moved_identity

    identity = {"application_uri": URI, "thumbprint": THUMBPRINT, "different": OTHER_SERVER}
    assert moved_identity(identity, "172.20.0.5") == {"application_uri": URI, "thumbprint": THUMBPRINT}
    assert moved_identity({"different": OTHER_SERVER}, "172.20.0.5") is None
    assert "different" in identity  # the argument was not changed


# ---- the tick and the match are part of what the person confirmed (fix 5a M1) ---------------------------------------------------

NEEDS_TICK = "The match needs your confirmation: tick the box that says you checked this is the same device or server."


async def test_a_match_that_asks_for_a_tick_is_not_moved_without_one_and_nothing_is_written(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    shown = (await preview(client, old, new)).json()
    assert shown["needs_tick"] is True and shown["match"]["kind"] == "possibly"
    before = (await counts(db), await row_of(db, old), await row_of(db, new))
    bodies = {
        "ticked absent": {"to": new, "address": "as_found", "expect": expect_of(shown)},
        "ticked false": {"to": new, "address": "as_found", "expect": expect_of(shown), "ticked": False},
        "an old client that sends no needs_tick": {
            "to": new, "address": "as_found", "expect": {key: expect_of(shown)[key] for key in REQUIRED_EXPECT},
        },
    }
    for label, body in bodies.items():
        response = await client.post(MOVE.format(old), json=body)
        assert response.status_code == 409 and response.json()["detail"] == NEEDS_TICK, (label, response.text)
    assert (await counts(db), await row_of(db, old), await row_of(db, new)) == before
    assert await audit_rows(db) == []


async def test_a_ticked_box_moves_it_and_the_dry_run_never_asks_for_one(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    assert (await preview(client, old, new)).status_code == 200  # no `ticked` at all
    response = await move(client, old, new, ticked=True)
    assert response.status_code == 200, response.text
    assert (await row_of(db, old))["config"] == {"endpoint": "opc.tcp://172.20.0.5:4840/"}


async def test_an_old_client_without_the_new_expect_fields_still_moves_when_it_ticked(client, db):
    await login_as(client, db)
    old, new = await owners_case(db)
    shown = (await preview(client, old, new)).json()
    required = {key: expect_of(shown)[key] for key in REQUIRED_EXPECT}
    response = await client.post(MOVE.format(old), json={"to": new, "address": "as_found", "expect": required, "ticked": True})
    assert response.status_code == 200, response.text


async def test_a_match_that_needs_no_tick_moves_without_one(client, db):
    await login_as(client, db)
    old, new = await same_server_case(db)
    shown = (await preview(client, old, new)).json()
    assert shown["needs_tick"] is False
    response = await client.post(MOVE.format(old), json={"to": new, "address": "as_found", "expect": expect_of(shown)})
    assert response.status_code == 200, response.text


@pytest.mark.parametrize(
    "change, mentions",
    [
        ({"match_kind": "same_server"}, "offered as possibly the same device now, not the same server"),
        ({"needs_tick": False}, "it needs your confirmation now"),
    ],
)
async def test_a_different_match_than_the_one_shown_is_a_409_naming_it(client, db, change, mentions):
    await login_as(client, db)
    old, new = await owners_case(db)  # offered as "possibly", and it asks for a tick
    before = (await counts(db), await row_of(db, old))
    response = await move(client, old, new, **change)
    assert response.status_code == 409 and response.json()["detail"].startswith("changed since the preview: "), response.text
    assert mentions in response.json()["detail"]
    assert (await counts(db), await row_of(db, old)) == before


async def test_a_certificate_that_went_missing_since_the_preview_turns_a_no_tick_move_into_a_changed_one(client, db):
    await login_as(client, db)
    old, new = await same_server_case(db)
    shown = (await preview(client, old, new)).json()
    assert shown["needs_tick"] is False
    await db.execute("UPDATE sources SET identity = identity - 'thumbprint' WHERE id = $1", new)  # C no longer reports a certificate
    before = (await counts(db), await row_of(db, old))
    response = await client.post(MOVE.format(old), json={"to": new, "address": "as_found", "expect": expect_of(shown), "ticked": True})
    assert response.status_code == 409 and "it needs your confirmation now" in response.json()["detail"], response.text
    assert (await counts(db), await row_of(db, old)) == before


async def test_a_tick_that_was_not_needed_at_the_preview_is_still_enforced_when_it_is_needed_at_the_click(client, db):
    await login_as(client, db)
    old, new = await same_server_case(db)
    shown = (await preview(client, old, new)).json()
    await db.execute("UPDATE sources SET identity = identity - 'thumbprint' WHERE id = $1", new)
    required = {key: expect_of(shown)[key] for key in REQUIRED_EXPECT}  # a client that does not say what it showed
    response = await client.post(MOVE.format(old), json={"to": new, "address": "as_found", "expect": required})
    assert response.status_code == 409 and response.json()["detail"] == NEEDS_TICK, response.text


@pytest.mark.parametrize("change", [{"match_kind": "certainly"}, {"needs_tick": "maybe"}])
async def test_a_match_the_server_cannot_have_said_is_a_422(client, db, change):
    await login_as(client, db)
    old, new = await owners_case(db)
    shown = (await preview(client, old, new)).json()
    response = await client.post(MOVE.format(old), json={"to": new, "address": "as_found", "expect": {**expect_of(shown), **change}, "ticked": True})
    assert response.status_code == 422


# ---- who may ask ---------------------------------------------------------------------------------------------------------------


async def test_only_a_role_with_sources_edit_may_move_a_source(client, db):
    old, new = await owners_case(db)
    body = {"to": new, "address": "as_found"}
    assert (await client.post(MOVE.format(old) + "?dry_run=1", json=body)).status_code == 401
    for role in ("viewer", "operator"):
        await login_as(client, db, role)
        for url in (MOVE.format(old) + "?dry_run=1", MOVE.format(old)):
            assert (await client.post(url, json=body)).status_code == 403, (role, url)
        await client.post("/api/logout")
    await make_role(db, "source editor", ["sources.edit"])
    await login_as(client, db, "source editor", username="editor")
    assert (await client.post(MOVE.format(old) + "?dry_run=1", json=body)).status_code == 200


@pytest.mark.parametrize("headers", [{"Sec-Fetch-Site": "cross-site"}, {"Origin": "http://evil.example"}])
async def test_a_page_of_another_site_cannot_move_a_source(client, db, headers):
    await login_as(client, db)
    old, new = await owners_case(db)
    shown = (await preview(client, old, new)).json()
    before = await counts(db)
    for url in (MOVE.format(old) + "?dry_run=1", MOVE.format(old)):
        response = await client.post(url, json={"to": new, "address": "as_found", "expect": expect_of(shown), "ticked": True}, headers=headers)
        assert response.status_code == 403, url
    assert await counts(db) == before
