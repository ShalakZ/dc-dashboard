"""`remember`: a source learns who its server is, compares it afterwards, and never lets another server take its place."""
import asyncio
import contextlib
import json
import logging
from datetime import datetime

from dcdash.collector.identity import SOURCE_IDENTITY_CHANGED, clean_identity, remember, remember_safely
from dcdash.core.pg import CONFIG_CHANNEL
from helpers import make_source

ENDPOINT = "opc.tcp://10.0.0.5:4840/dcdash/"
CONFIG = {"endpoint": ENDPOINT}
URI_A = "urn:plant:meters:a"
URI_B = "urn:plant:meters:b"
THUMB_1 = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD"
THUMB_2 = "11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44"
SERVER_A = {"application_uri": URI_A, "application_name": "Meters A", "product_uri": "urn:vendor:product", "thumbprint": THUMB_1}


async def opc_source(db, endpoint=ENDPOINT, name="opc", secret=None) -> int:
    return await make_source(db, name, "opcua", {"endpoint": endpoint}, secret=secret, enabled=False)


async def identity_of(db, source_id):
    return await db.fetchval("SELECT identity FROM sources WHERE id = $1", source_id)


async def xmin_of(db, source_id) -> str:
    return await db.fetchval("SELECT xmin::text FROM sources WHERE id = $1", source_id)


async def events(db):
    return [dict(row) for row in await db.fetch("SELECT level, component, source_id, kind, code, message, detail FROM diag_events ORDER BY id")]


async def test_the_first_identity_is_stored(db):
    source = await opc_source(db)
    assert await remember(db, source, SERVER_A, expected_config=CONFIG) == "stored"
    assert await identity_of(db, source) == SERVER_A
    assert await events(db) == []


async def test_the_same_identity_again_changes_nothing_and_writes_nothing(db):
    source = await opc_source(db)
    await remember(db, source, SERVER_A, expected_config=CONFIG)
    before = await xmin_of(db, source)
    assert await remember(db, source, dict(SERVER_A), expected_config=CONFIG) == "same"
    assert await xmin_of(db, source) == before  # an UPDATE would have given the row a new transaction id
    assert await identity_of(db, source) == SERVER_A
    assert await events(db) == []


async def test_another_server_is_noted_once_and_never_replaces_the_stored_identity(db):
    source = await opc_source(db)
    await db.execute("UPDATE sources SET status = 'online', enabled = true WHERE id = $1", source)
    await remember(db, source, SERVER_A, expected_config=CONFIG)
    other = {"application_uri": URI_B, "thumbprint": THUMB_2, "application_name": "Meters B"}
    assert await remember(db, source, other, expected_config=CONFIG) == "different"
    stored = await identity_of(db, source)
    assert {key: stored[key] for key in SERVER_A} == SERVER_A  # the stored identity is untouched
    assert {k: v for k, v in stored["different"].items() if k != "at"} == {"application_uri": URI_B, "thumbprint": THUMB_2}
    datetime.fromisoformat(stored["different"]["at"])
    rows = await events(db)
    assert len(rows) == 1
    assert (rows[0]["level"], rows[0]["kind"], rows[0]["component"], rows[0]["source_id"]) == ("warning", SOURCE_IDENTITY_CHANGED, "collector", source)
    assert rows[0]["message"] == "The server answering at this address is not the one this source used to talk to."
    assert rows[0]["detail"]["before"] == SERVER_A
    assert rows[0]["detail"]["after"] == other
    # The same other server again, within 24 hours: no second event, and no write either.
    again = await xmin_of(db, source)
    assert await remember(db, source, other, expected_config=CONFIG) == "different"
    assert len(await events(db)) == 1 and await xmin_of(db, source) == again
    # Nothing about the source's state or polling changed.
    row = await db.fetchrow("SELECT status, enabled, last_error FROM sources WHERE id = $1", source)
    assert (row["status"], row["enabled"], row["last_error"]) == ("online", True, None)


async def test_a_third_server_is_noted_as_well(db):
    source = await opc_source(db)
    await remember(db, source, SERVER_A, expected_config=CONFIG)
    await remember(db, source, {"application_uri": URI_B}, expected_config=CONFIG)
    assert await remember(db, source, {"application_uri": "urn:plant:meters:c"}, expected_config=CONFIG) == "different"
    assert len(await events(db)) == 2
    assert (await identity_of(db, source))["different"]["application_uri"] == "urn:plant:meters:c"


async def test_the_stored_server_answering_again_clears_the_note(db):
    source = await opc_source(db)
    await remember(db, source, SERVER_A, expected_config=CONFIG)
    await remember(db, source, {"application_uri": URI_B}, expected_config=CONFIG)
    assert "different" in await identity_of(db, source)
    assert await remember(db, source, dict(SERVER_A), expected_config=CONFIG) == "same"
    assert await identity_of(db, source) == SERVER_A


async def test_a_renewed_certificate_is_stored_with_one_info_event(db):
    source = await opc_source(db)
    await remember(db, source, SERVER_A, expected_config=CONFIG)
    renewed = {**SERVER_A, "thumbprint": THUMB_2}
    assert await remember(db, source, renewed, expected_config=CONFIG) == "renewed"
    assert await identity_of(db, source) == renewed
    rows = await events(db)
    assert len(rows) == 1 and (rows[0]["level"], rows[0]["kind"]) == ("info", SOURCE_IDENTITY_CHANGED)
    assert rows[0]["message"] == "The server's certificate changed."
    assert await remember(db, source, renewed, expected_config=CONFIG) == "same"  # now it is the stored one
    assert len(await events(db)) == 1


async def test_a_renewal_clears_a_stale_different_note(db):
    source = await opc_source(db)
    await remember(db, source, SERVER_A, expected_config=CONFIG)
    await remember(db, source, {"application_uri": URI_B}, expected_config=CONFIG)
    assert await remember(db, source, {**SERVER_A, "thumbprint": THUMB_2}, expected_config=CONFIG) == "renewed"
    assert "different" not in await identity_of(db, source)


async def test_a_thumbprint_seen_for_the_first_time_is_merged_without_a_renewal(db):
    source = await opc_source(db)
    await remember(db, source, {"application_uri": URI_A, "name_hint": {"name": "meters", "host": "10.0.0.5"}}, expected_config=CONFIG)
    assert await remember(db, source, {"application_uri": URI_A, "thumbprint": THUMB_1}, expected_config=CONFIG) == "same"
    assert await identity_of(db, source) == {
        "application_uri": URI_A, "thumbprint": THUMB_1, "name_hint": {"name": "meters", "host": "10.0.0.5"}
    }
    assert await events(db) == []


async def test_an_answer_without_a_thumbprint_keeps_the_stored_one(db):
    source = await opc_source(db)
    await remember(db, source, SERVER_A, expected_config=CONFIG)
    before = await xmin_of(db, source)
    assert await remember(db, source, {"application_uri": URI_A}, expected_config=CONFIG) == "same"
    assert await identity_of(db, source) == SERVER_A and await xmin_of(db, source) == before


async def test_a_default_uri_identity_is_stored_and_a_real_key_replaces_it_silently(db):
    source = await opc_source(db)
    default = {"application_uri": "urn:freeopcua:python:server", "thumbprint": THUMB_1}
    assert await remember(db, source, default, expected_config=CONFIG) == "stored"
    assert await identity_of(db, source) == default  # what the server said is stored, though it names no one
    await db.execute(
        "UPDATE sources SET identity = identity || '{\"name_hint\": {\"name\": \"meters\", \"host\": \"10.0.0.5\"}}'::jsonb WHERE id = $1", source
    )
    assert await remember(db, source, SERVER_A, expected_config=CONFIG) == "stored"
    assert await identity_of(db, source) == {**SERVER_A, "name_hint": {"name": "meters", "host": "10.0.0.5"}}
    assert await events(db) == []


async def test_two_default_uri_answers_do_not_make_a_different_server(db):
    source = await opc_source(db)
    await remember(db, source, {"application_uri": "urn:freeopcua:python:server"}, expected_config=CONFIG)
    assert await remember(db, source, {"application_uri": "urn:open62541.server.application"}, expected_config=CONFIG) in ("stored", "same")
    assert "different" not in await identity_of(db, source) and await events(db) == []


DEFAULT_URI = "urn:freeopcua:python:server"


async def test_a_default_uri_where_a_keyed_server_used_to_be_is_another_server_noted_once(db):
    source = await opc_source(db)
    await remember(db, source, SERVER_A, expected_config=CONFIG)
    default = {"application_uri": DEFAULT_URI, "application_name": "FreeOpcUa Python Server"}
    assert await remember(db, source, default, expected_config=CONFIG) == "different"
    stored = await identity_of(db, source)
    assert {key: stored[key] for key in SERVER_A} == SERVER_A and set(stored) == {*SERVER_A, "different"}  # the stored identity is untouched
    assert {k: v for k, v in stored["different"].items() if k != "at"} == {"application_uri": DEFAULT_URI}
    datetime.fromisoformat(stored["different"]["at"])
    rows = await events(db)
    assert len(rows) == 1 and (rows[0]["level"], rows[0]["kind"], rows[0]["source_id"]) == ("warning", SOURCE_IDENTITY_CHANGED, source)
    assert rows[0]["detail"]["before"] == SERVER_A and rows[0]["detail"]["after"] == default
    again = await xmin_of(db, source)  # the same other server again within 24 hours: no second row, no write
    assert await remember(db, source, default, expected_config=CONFIG) == "different"
    assert len(await events(db)) == 1 and await xmin_of(db, source) == again
    assert await remember(db, source, dict(SERVER_A), expected_config=CONFIG) == "same"  # the stored server answers again: note cleared
    assert await identity_of(db, source) == SERVER_A


async def test_a_default_uri_with_its_own_thumbprint_records_both_in_the_note(db):
    source = await opc_source(db)
    await remember(db, source, SERVER_A, expected_config=CONFIG)
    assert await remember(db, source, {"application_uri": DEFAULT_URI, "thumbprint": THUMB_2}, expected_config=CONFIG) == "different"
    note = (await identity_of(db, source))["different"]
    assert {k: v for k, v in note.items() if k != "at"} == {"application_uri": DEFAULT_URI, "thumbprint": THUMB_2}
    assert len(await events(db)) == 1


async def test_an_answer_that_names_no_server_leaves_a_keyed_source_alone(db):
    source = await opc_source(db)
    await remember(db, source, SERVER_A, expected_config=CONFIG)
    before = await xmin_of(db, source)
    for nameless in ({"application_name": "Some Server"}, {"product_uri": "urn:vendor:product"}, {"application_name": "Some Server", "product_uri": "urn:v"}):
        assert await remember(db, source, nameless, expected_config=CONFIG) == "same"
    assert await identity_of(db, source) == SERVER_A and await xmin_of(db, source) == before and await events(db) == []


async def test_a_name_hint_alone_leaves_a_keyed_source_alone(db):
    source = await opc_source(db)
    await remember(db, source, SERVER_A, expected_config=CONFIG)
    hint = {"name": "meters", "host": "10.0.0.5"}
    assert await remember(db, source, {"name_hint": hint}, expected_config=CONFIG) == "same"
    assert await identity_of(db, source) == {**SERVER_A, "name_hint": hint} and await events(db) == []
    assert await remember(db, source, {}, expected_config=CONFIG) == "skipped"  # nothing at all: not even looked at
    assert await events(db) == []


def test_deciding_on_an_empty_answer_is_the_same_server():
    from dcdash.collector.identity import _decide

    outcome, new, event = _decide("opcua", dict(SERVER_A), {})
    assert (outcome, new, event) == ("same", SERVER_A, None)


async def test_a_name_hint_replaces_the_stored_one_and_is_never_dropped(db):
    source = await opc_source(db)
    await remember(db, source, {**SERVER_A, "name_hint": {"name": "old", "host": "10.0.0.5"}}, expected_config=CONFIG)
    assert await remember(db, source, {**SERVER_A, "name_hint": {"name": "new", "host": "10.0.0.5"}}, expected_config=CONFIG) == "same"
    assert (await identity_of(db, source))["name_hint"] == {"name": "new", "host": "10.0.0.5"}
    assert await remember(db, source, dict(SERVER_A), expected_config=CONFIG) == "same"
    assert (await identity_of(db, source))["name_hint"] == {"name": "new", "host": "10.0.0.5"}  # not received: kept


async def test_the_simulator_is_compared_by_its_instance(db):
    config = {"url": "http://10.0.0.7:9000/"}
    source = await make_source(db, "sim", "simulator", config, enabled=False)
    assert await remember(db, source, {"instance": "dev"}, expected_config=config) == "stored"
    assert await remember(db, source, {"instance": "dev"}, expected_config=config) == "same"
    assert await remember(db, source, {"instance": "other"}, expected_config=config) == "different"
    assert (await identity_of(db, source))["instance"] == "dev"
    assert [row["kind"] for row in await events(db)] == [SOURCE_IDENTITY_CHANGED]


async def test_nothing_is_written_when_the_address_changed_since_the_server_was_asked(db):
    source = await opc_source(db)
    moved = "opc.tcp://10.0.0.9:4840/dcdash/"
    await db.execute("UPDATE sources SET config = $2 WHERE id = $1", source, {"endpoint": moved})  # moved meanwhile
    before = await xmin_of(db, source)
    assert await remember(db, source, SERVER_A, expected_config=CONFIG) == "skipped"
    assert await identity_of(db, source) is None and await xmin_of(db, source) == before
    assert await remember(db, source, SERVER_A, expected_config={"endpoint": moved}) == "stored"  # the new address learns it


async def test_a_source_configured_by_name_still_learns_its_identity(db):
    named = {"endpoint": "opc.tcp://simulator:4840/dcdash/"}
    source = await opc_source(db, named["endpoint"])
    # The scan found the server at its resolved address and read the row's config, not the finding's address.
    assert await remember(db, source, SERVER_A, expected_config=named) == "stored"
    assert await identity_of(db, source) == SERVER_A


async def test_a_name_configured_source_that_was_edited_before_the_write_is_left_alone(db):
    named = {"endpoint": "opc.tcp://simulator:4840/dcdash/"}
    source = await opc_source(db, named["endpoint"])
    await db.execute("UPDATE sources SET config = $2 WHERE id = $1", source, {"endpoint": "opc.tcp://172.20.0.5:4840/dcdash/"})
    assert await remember(db, source, SERVER_A, expected_config=named) == "skipped"
    assert await identity_of(db, source) is None


async def test_a_stored_config_written_by_hand_still_matches_the_config_a_job_read(db):
    from dcdash.connectors.opcua import OpcUaConfig

    source = await opc_source(db)  # {"endpoint": ...} only: the connector's own dump has every default filled in
    full = OpcUaConfig(endpoint=ENDPOINT).model_dump(mode="json")
    assert full != CONFIG
    assert await remember(db, source, SERVER_A, expected_config=full) == "stored"


async def test_no_answer_or_a_missing_source_is_skipped(db):
    source = await opc_source(db)
    assert await remember(db, source, None, expected_config=CONFIG) == "skipped"
    assert await remember(db, source, {}, expected_config=CONFIG) == "skipped"
    assert await remember(db, source, {"application_uri": "   ", "extra": 1}, expected_config=CONFIG) == "skipped"
    assert await remember(db, 9999, SERVER_A, expected_config=CONFIG) == "skipped"
    assert await identity_of(db, source) is None


@contextlib.asynccontextmanager
async def listening(pool, channel):
    """Yields the list of notifications a second connection hears on `channel`."""
    heard = []

    def hear(*args):
        heard.append(args)

    listener = await pool.acquire()
    try:
        await listener.add_listener(channel, hear)
        yield heard
        await asyncio.sleep(0.3)
        await listener.remove_listener(channel, hear)
    finally:
        await pool.release(listener)


async def test_the_listener_of_the_next_test_does_hear_a_notification(db):
    async with listening(db, CONFIG_CHANNEL) as heard:
        await db.execute("SELECT pg_notify($1, '')", CONFIG_CHANNEL)
    assert len(heard) == 1


async def test_nothing_is_announced_on_the_config_channel(db):
    source = await opc_source(db)
    async with listening(db, CONFIG_CHANNEL) as heard:
        await remember(db, source, SERVER_A, expected_config=CONFIG)  # stored
        await remember(db, source, {"application_uri": URI_B}, expected_config=CONFIG)  # different
        await remember(db, source, dict(SERVER_A), expected_config=CONFIG)  # cleared
        await remember(db, source, {**SERVER_A, "thumbprint": THUMB_2}, expected_config=CONFIG)  # renewed
    assert heard == []


async def test_what_a_server_says_is_cut_and_only_known_text_is_stored(db):
    source = await opc_source(db)
    long = "urn:" + "x" * 500
    await remember(db, source, {"application_uri": long, "application_name": "a\x00b", "evil": "x", "thumbprint": 5}, expected_config=CONFIG)
    stored = await identity_of(db, source)
    assert set(stored) == {"application_uri", "application_name"}
    assert len(stored["application_uri"]) == 256 and stored["application_name"] == "ab"
    assert clean_identity("not a dict") == {} and clean_identity({"name_hint": {"name": "a", "host": 1}}) == {"name_hint": {"name": "a"}}


async def test_no_user_name_or_password_reaches_the_journal_or_the_log(db, caplog):
    secret_endpoint = "opc.tcp://operator:hunter2-pass@10.0.0.5:4840/dcdash/"
    config = {"endpoint": secret_endpoint, "username": "operator"}
    source = await make_source(db, "creds", "opcua", config, secret="hunter2-secret", enabled=False)
    with caplog.at_level(logging.DEBUG):
        await remember(db, source, SERVER_A, expected_config=config)
        await remember(db, source, {"application_uri": URI_B, "application_name": "operator hunter2-pass"}, expected_config=config)
        await remember(db, source, {**SERVER_A, "thumbprint": THUMB_2}, expected_config=config)
    text = json.dumps(await events(db), default=str) + json.dumps(await identity_of(db, source)) + caplog.text
    for word in ("hunter2-pass", "hunter2-secret"):
        assert word not in text
    assert "operator" not in json.dumps([row["message"] for row in await events(db)])


class BrokenPool:
    def acquire(self):
        raise ConnectionError("the database is down")


async def test_remember_safely_never_raises(db, caplog):
    with caplog.at_level(logging.WARNING):
        assert await remember_safely(BrokenPool(), 1, SERVER_A, expected_config=CONFIG) == "skipped"
    assert "could not remember the identity of source 1" in caplog.text
    source = await opc_source(db)
    assert await remember_safely(db, source, SERVER_A, expected_config=CONFIG) == "stored"
