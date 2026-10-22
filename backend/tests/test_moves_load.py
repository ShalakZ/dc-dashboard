"""`moves.load.load_offers` (w33 T3b, P6, F4, F14): the database half of the move offers.

The pure matcher is tested in test_source_identity.py. These tests are about what the loader FEEDS it: which sources are old ones
(offline, OPC UA or simulator, something mapped, unreachable by an open incident or by "not seen"), which are new ones (discovered,
nothing mapped, found by a scan that finished after the old one last answered), the (address, name) overlap, the holders of every
identity key, and the number of statements (at most 9 however many sources there are; none when nothing is offline).
"""
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from dcdash.core.db import get_sessionmaker
from dcdash.core.models import Source
from dcdash.events import read as events_read
from dcdash.moves.freshness import not_seen_map
from dcdash.moves.load import load_offers, load_offers_detailed
from dcdash.moves.match import Decision, Match, Offer, Two
from test_moves_freshness import T0, finished_at, make_finding, make_scan, statements

PAIRS = [("ns=2;s=LVP01.kW", "LVP01 kW"), ("ns=2;s=LVP01.V", "LVP01 V"), ("ns=2;s=LVP02.kW", "LVP02 kW")]
METRICS = ["active_power_kw", "voltage_v", "energy_kwh", "current_a", "frequency_hz", "power_factor"]


async def add_source(
    db, name, host, *, kind="opcua", port=None, path="/", origin="discovered", status="unknown", last_seen=None,
    identity=None, config=None,
) -> int:
    port = port or {"opcua": 4840, "simulator": 8080, "modbus": 502}[kind]
    if config is None:
        config = {
            "opcua": {"endpoint": f"opc.tcp://{host}:{port}{path}"},
            "simulator": {"url": f"http://{host}:{port}"},
            "modbus": {"host": host, "port": port, "unit_id": 1},
        }[kind]
    return await db.fetchval(
        "INSERT INTO sources (name, connector_type, config, enabled, origin, status, last_seen, identity) "
        "VALUES ($1, $2, $3, false, $4, $5, $6, $7) RETURNING id",
        name, kind, config, origin, status, last_seen, identity,
    )


async def add_points(db, source_id, pairs) -> list[int]:
    return [
        await db.fetchval(
            "INSERT INTO points (source_id, address, name) VALUES ($1, $2, $3) RETURNING id", source_id, address, name
        )
        for address, name in pairs
    ]


async def map_points(db, point_ids, assets=1) -> list[int]:
    """Map the points onto `assets` assets (round robin), each with its own metric on its asset. Returns the asset ids."""
    made = [await db.fetchval("INSERT INTO assets (name) VALUES ($1) RETURNING id", f"asset {point_ids[0]}.{n}") for n in range(assets)]
    for index, point_id in enumerate(point_ids):
        await db.execute(
            "INSERT INTO mappings (point_id, asset_id, metric, interval_seconds) VALUES ($1, $2, $3, 5)",
            point_id, made[index % assets], METRICS[index // assets],
        )
    return made


async def open_incident(db, source_id, code="unreachable", state="open") -> None:
    await db.execute(
        "INSERT INTO diag_events (level, component, source_id, kind, code, message, detail) "
        "VALUES ('warning', 'collector', $1, 'source.offline', $2, 'down', $3)",
        source_id, code, {"state": state, "count": 5, "last_at": datetime.now(UTC).isoformat()},
    )


async def old_source(db, name, host, *, pairs=PAIRS, kind="opcua", origin="discovered", incident="unreachable", identity=None,
                     status="offline", last_seen=None, assets=1, path="/") -> int:
    """An offline source with `pairs` mapped, last answering at `last_seen` (default: when the day-0 scan finished)."""
    source = await add_source(
        db, name, host, kind=kind, origin=origin, status=status, last_seen=last_seen or finished_at(0), identity=identity, path=path,
    )
    await map_points(db, await add_points(db, source, pairs), assets)
    if incident:
        await open_incident(db, source, incident)
    return source


async def new_source(db, name, host, scan_id, *, pairs=PAIRS, kind="opcua", identity=None, path="/", port=None) -> int:
    """A discovered source with nothing mapped, found at `host` by scan `scan_id`."""
    source = await add_source(db, name, host, kind=kind, identity=identity, path=path, port=port)
    await add_points(db, source, pairs)
    await make_finding(db, scan_id, host, port or {"opcua": 4840, "simulator": 8080, "modbus": 502}[kind], source)
    return source


async def offers(old_ids=None) -> Decision:
    async with get_sessionmaker()() as session:
        return await load_offers(session, old_ids=old_ids)


async def counted(old_ids=None) -> tuple[Decision, list[str]]:
    async with get_sessionmaker()() as session:
        with statements() as sql:
            decision = await load_offers(session, old_ids=old_ids)
    return decision, sql


POSSIBLY = Match(kind="possibly", evidence="addresses", value=None, addresses=3, missing_addresses=0, needs_tick=True)


async def owners_case(db) -> tuple[int, int]:
    """The owner's screenshot: a discovered source with three mapped points at a dead address, and the same three points found
    at a new address by a scan that finished after the old one last answered. Returns (old id, new id)."""
    first = await make_scan(db, day=0)
    old = await old_source(db, "OPC UA server at 172.20.0.3:4840", "172.20.0.3")
    await make_finding(db, first, "172.20.0.3", 4840, old)
    second = await make_scan(db, day=3)
    new = await new_source(db, "OPC UA server at 172.20.0.5:4840", "172.20.0.5", second, pairs=PAIRS + [("ns=2;s=LVP03.kW", "LVP03 kW")])
    return old, new


# ---- the owner's case, end to end -------------------------------------------------------------------------------------------

async def test_the_owners_case_gives_a_possibly_offer_that_needs_a_tick(db):
    old, new = await owners_case(db)
    decision = await offers()
    offer = decision.by_old[old]
    assert offer == Offer(old_id=old, new_id=new, match=POSSIBLY)
    assert decision.by_new == {new: offer}


async def test_the_same_case_without_any_incident_row_is_decided_by_not_seen(db):
    """No `source.offline` row (the collector was restarted, the row retention ran): the newer scan of the same range that did not
    find the discovered source is enough, and nothing in the answer depends on the incident."""
    old, new = await owners_case(db)
    await db.execute("DELETE FROM diag_events")
    assert (await offers()).by_old[old] == Offer(old_id=old, new_id=new, match=POSSIBLY)


async def test_a_hand_added_source_without_an_incident_is_never_unreachable_by_not_seen(db):
    old, _ = await owners_case(db)
    await db.execute("DELETE FROM diag_events")
    await db.execute("UPDATE sources SET origin = 'manual' WHERE id = $1", old)
    assert await offers() == Decision(by_old={}, by_new={})


async def test_a_timeout_incident_counts_like_unreachable(db):
    old, new = await owners_case(db)
    await db.execute("UPDATE diag_events SET code = 'timeout' WHERE source_id = $1", old)
    assert (await offers()).by_old[old].new_id == new


async def test_an_old_source_that_never_answered_accepts_any_new_one(db):
    old, new = await owners_case(db)
    await db.execute("UPDATE sources SET last_seen = NULL WHERE id = $1", old)
    assert (await offers()).by_old[old].new_id == new


# ---- who is an old source, who is a new one ---------------------------------------------------------------------------------

@pytest.mark.parametrize("code", ["protocol_error", "auth_failed", "exception", "config_invalid", None])
async def test_incident_codes_other_than_unreachable_and_timeout_offer_nothing_and_stop_after_two_statements(db, code):
    await make_scan(db, day=0)
    second = await make_scan(db, day=3)
    old = await old_source(db, "O", "172.20.0.3", origin="manual", incident=None)
    await db.execute(
        "INSERT INTO diag_events (level, component, source_id, kind, code, message, detail) "
        "VALUES ('warning', 'collector', $1, 'source.offline', $2, 'down', $3)", old, code, {"state": "open", "count": 1},
    )
    await new_source(db, "C", "172.20.0.5", second)
    decision, sql = await counted()
    assert decision == Decision(by_old={}, by_new={})
    assert len(sql) == 2, sql  # the old sources and their incidents: nothing is unreachable, so nothing more is read


async def test_a_discovered_source_that_the_newer_scan_did_find_is_not_unreachable_whatever_its_incident(db):
    first = await make_scan(db, day=0)
    old = await old_source(db, "O", "172.20.0.3", incident="auth_failed")
    await make_finding(db, first, "172.20.0.3", 4840, old)
    second = await make_scan(db, day=3)
    await make_finding(db, second, "172.20.0.3", 4840, old)  # a server that refuses the login is still there
    await new_source(db, "C", "172.20.0.5", second)
    assert await offers() == Decision(by_old={}, by_new={})


async def test_a_closed_incident_is_not_an_open_one(db):
    old, _ = await owners_case(db)
    await db.execute("DELETE FROM diag_events")
    await db.execute("UPDATE sources SET origin = 'manual' WHERE id = $1", old)
    await open_incident(db, old, "unreachable", state="closed")
    assert await offers() == Decision(by_old={}, by_new={})


async def test_an_online_source_is_never_an_old_source(db):
    old, _ = await owners_case(db)
    await db.execute("UPDATE sources SET status = 'online' WHERE id = $1", old)
    decision, sql = await counted()
    assert decision == Decision(by_old={}, by_new={}) and len(sql) == 1


async def test_an_offline_source_with_nothing_mapped_is_never_an_old_source(db):
    old, _ = await owners_case(db)
    await db.execute("DELETE FROM mappings WHERE point_id IN (SELECT id FROM points WHERE source_id = $1)", old)
    assert await offers() == Decision(by_old={}, by_new={})


async def test_modbus_is_never_offered(db):
    await make_scan(db, day=0)
    await old_source(db, "meter", "172.20.0.3", kind="modbus")
    second = await make_scan(db, day=3)
    await new_source(db, "twin", "172.20.0.5", second, kind="modbus")
    assert await offers() == Decision(by_old={}, by_new={})


async def test_a_new_source_with_a_mapping_is_not_a_candidate(db):
    _, new = await owners_case(db)
    point = await db.fetchval("SELECT id FROM points WHERE source_id = $1 ORDER BY id LIMIT 1", new)
    await map_points(db, [point])
    assert await offers() == Decision(by_old={}, by_new={})


async def test_a_hand_added_new_source_is_not_a_candidate(db):
    _, new = await owners_case(db)
    await db.execute("UPDATE sources SET origin = 'manual' WHERE id = $1", new)
    assert await offers() == Decision(by_old={}, by_new={})


async def test_a_new_source_found_only_by_a_running_scan_is_not_a_candidate(db):
    _, new = await owners_case(db)
    running = await make_scan(db, day=4, status="running")
    await db.execute("UPDATE scan_findings SET scan_id = $2 WHERE source_id = $1", new, running)
    assert await offers() == Decision(by_old={}, by_new={})


async def test_a_new_source_found_before_the_old_one_last_answered_is_not_a_candidate(db):
    old, _ = await owners_case(db)
    await db.execute("UPDATE sources SET last_seen = $2 WHERE id = $1", old, finished_at(5))
    assert await offers() == Decision(by_old={}, by_new={})


async def test_found_at_is_the_start_of_the_first_finished_scan_that_found_the_source(db):
    """A candidate must have APPEARED after O went quiet, so its EARLIEST sighting counts, not the newest: a later scan that finds
    it again proves it is still there, not that it is new."""
    old, new = await owners_case(db)
    third = await make_scan(db, day=6)
    await make_finding(db, third, "172.20.0.5", 4840, new)
    assert (await offers()).by_old[old].new_id == new  # found on day 3 and again on day 6: the first sighting is after O's last poll
    early = await make_scan(db, day=-5)
    await make_finding(db, early, "172.20.0.5", 4840, new)
    assert await offers() == Decision(by_old={}, by_new={})  # it was there before O went quiet: a neighbour, not a replacement


async def test_a_new_source_seen_in_the_same_scan_as_the_old_one_is_not_a_candidate_even_when_later_scans_find_it_again(db):
    """Two units of one make, one of them mapped: both answered on day 0, so the unmapped one did not replace the mapped one."""
    first = await make_scan(db, day=0)
    old = await old_source(db, "O", "172.20.0.3")
    await make_finding(db, first, "172.20.0.3", 4840, old)
    new = await new_source(db, "C", "172.20.0.5", first)
    second = await make_scan(db, day=3)
    await make_finding(db, second, "172.20.0.5", 4840, new)
    assert await offers() == Decision(by_old={}, by_new={})


async def test_a_scan_that_started_before_the_old_source_last_answered_does_not_make_a_candidate_of_what_it_found(db):
    """The scan ran 08:00 to 09:00 and O last answered at 08:30: C may have been answering at the same time, so C is no replacement."""
    scan = await make_scan(db, day=0)
    old = await old_source(db, "O", "172.20.0.3", last_seen=T0 + timedelta(minutes=30))
    await make_finding(db, scan, "172.20.0.3", 4840, old)
    await new_source(db, "C", "172.20.0.5", scan)
    assert await db.fetchval("SELECT finished_at FROM scans WHERE id = $1", scan) > T0 + timedelta(minutes=30)
    assert await offers() == Decision(by_old={}, by_new={})


async def test_a_scan_that_started_after_the_old_source_last_answered_does_make_one(db):
    scan = await make_scan(db, day=0)
    old = await old_source(db, "O", "172.20.0.3", last_seen=T0 - timedelta(minutes=30))
    await make_finding(db, scan, "172.20.0.3", 4840, old)
    new = await new_source(db, "C", "172.20.0.5", scan)
    assert (await offers()).by_old[old].new_id == new


async def test_only_a_finished_scan_counts_for_found_at_so_a_failed_one_that_found_it_early_changes_nothing(db):
    old, new = await owners_case(db)
    failed = await make_scan(db, day=-5, status="failed")
    await make_finding(db, failed, "172.20.0.5", 4840, new)
    assert (await offers()).by_old[old].new_id == new


async def test_another_port_or_another_path_is_not_a_candidate(db):
    first = await make_scan(db, day=0)
    old = await old_source(db, "O", "172.20.0.3")
    await make_finding(db, first, "172.20.0.3", 4840, old)
    second = await make_scan(db, day=3)
    await new_source(db, "other port", "172.20.0.5", second, port=4841)
    await new_source(db, "other path", "172.20.0.6", second, path="/other/")
    assert await offers() == Decision(by_old={}, by_new={})


async def test_an_empty_endpoint_path_and_a_slash_are_the_same_place(db):
    """A hand-typed `opc.tcp://host:4840` (the config is not normalised) must pair with what a scan stores, `opc.tcp://host:4840/`."""
    await make_scan(db, day=0)
    old = await old_source(db, "O", "172.20.0.3", path="")
    second = await make_scan(db, day=3)
    new = await new_source(db, "C", "172.20.0.5", second, path="/")
    assert await db.fetchval("SELECT config->>'endpoint' FROM sources WHERE id = $1", old) == "opc.tcp://172.20.0.3:4840"
    assert (await offers()).by_old[old] == Offer(old_id=old, new_id=new, match=POSSIBLY)


async def test_any_other_difference_in_the_endpoint_path_is_a_different_place(db):
    await make_scan(db, day=0)
    await old_source(db, "O", "172.20.0.3", path="/dcdash")
    second = await make_scan(db, day=3)
    await new_source(db, "C", "172.20.0.5", second, path="/dcdash/")
    assert await offers() == Decision(by_old={}, by_new={})


async def test_the_same_addresses_under_other_names_do_not_overlap(db):
    first = await make_scan(db, day=0)
    old = await old_source(db, "O", "172.20.0.3")
    await make_finding(db, first, "172.20.0.3", 4840, old)
    second = await make_scan(db, day=3)
    await new_source(db, "C", "172.20.0.5", second, pairs=[(address, name + " (renamed)") for address, name in PAIRS])
    assert await offers() == Decision(by_old={}, by_new={})


async def test_one_pair_missing_on_the_new_source_is_not_possibly(db):
    first = await make_scan(db, day=0)
    old = await old_source(db, "O", "172.20.0.3")
    await make_finding(db, first, "172.20.0.3", 4840, old)
    second = await make_scan(db, day=3)
    await new_source(db, "C", "172.20.0.5", second, pairs=PAIRS[:2])
    assert await offers() == Decision(by_old={}, by_new={})


async def test_a_stored_default_uri_is_no_key_so_the_addresses_decide(db):
    first = await make_scan(db, day=0)
    default = {"application_uri": "urn:freeopcua:python:server"}
    old = await old_source(db, "O", "172.20.0.3", identity=default)
    await make_finding(db, first, "172.20.0.3", 4840, old)
    second = await make_scan(db, day=3)
    new = await new_source(db, "C", "172.20.0.5", second, identity=default)
    assert (await offers()).by_old[old] == Offer(old_id=old, new_id=new, match=POSSIBLY)


# ---- same_server: identities and the holders of a key -----------------------------------------------------------------------

URI = "urn:vendor:meter-7"
THUMBPRINT = "AA:BB:CC:DD"
SAME_SERVER = Match(kind="same_server", evidence="uri", value=URI, addresses=3, missing_addresses=0, needs_tick=False)


async def same_server_case(db, *, old_identity=None, new_identity=None, pairs=PAIRS, old_pairs=PAIRS) -> tuple[int, int]:
    await make_scan(db, day=0)
    identity = {"application_uri": URI, "thumbprint": THUMBPRINT}
    old = await old_source(db, "O", "172.20.0.3", origin="manual", identity=old_identity or identity, pairs=old_pairs)
    second = await make_scan(db, day=3)
    new = await new_source(db, "C", "172.20.0.5", second, identity=new_identity or identity, pairs=pairs)
    return old, new


async def test_equal_uri_and_certificate_is_the_same_server_and_needs_no_tick(db):
    old, new = await same_server_case(db)
    assert (await offers()).by_old[old] == Offer(old_id=old, new_id=new, match=SAME_SERVER)


async def test_equal_uri_without_a_certificate_on_one_side_needs_a_tick(db):
    old, new = await same_server_case(db, new_identity={"application_uri": URI})
    assert (await offers()).by_old[old].match == replace(SAME_SERVER, needs_tick=True)


async def test_equal_uri_with_different_certificates_is_not_offered(db):
    await same_server_case(db, new_identity={"application_uri": URI, "thumbprint": "11:22:33:44"})
    assert await offers() == Decision(by_old={}, by_new={})


async def test_different_uris_are_not_offered_even_with_identical_addresses(db):
    await same_server_case(db, new_identity={"application_uri": "urn:vendor:meter-8", "thumbprint": THUMBPRINT})
    assert await offers() == Decision(by_old={}, by_new={})


async def test_the_old_source_knowing_its_server_and_the_new_one_not_is_not_offered(db):
    await same_server_case(db, new_identity={"application_name": "Meter"})
    assert await offers() == Decision(by_old={}, by_new={})


async def test_missing_addresses_counts_the_old_pairs_the_new_source_lacks(db):
    old, _ = await same_server_case(db, pairs=PAIRS[:2])
    match = (await offers()).by_old[old].match
    assert (match.kind, match.addresses, match.missing_addresses) == ("same_server", 2, 1)


async def test_a_new_source_that_was_never_browsed_is_still_offered_when_the_server_is_the_same(db):
    old, _ = await same_server_case(db, pairs=[])
    match = (await offers()).by_old[old].match
    assert (match.kind, match.addresses, match.missing_addresses) == ("same_server", 0, None)


async def test_the_same_name_on_two_points_of_different_addresses_counts_two_pairs(db):
    pairs = [("ns=2;s=A", "Power"), ("ns=2;s=B", "Power")]
    old, _ = await same_server_case(db, pairs=pairs, old_pairs=pairs)
    match = (await offers()).by_old[old].match
    assert (match.addresses, match.missing_addresses) == (2, 0)


async def test_a_third_source_at_another_endpoint_with_the_same_uri_makes_the_uri_no_identity(db):
    await same_server_case(db)
    await add_source(db, "elsewhere", "172.20.0.9", status="online", identity={"application_uri": URI})
    assert await offers() == Decision(by_old={}, by_new={})


async def test_a_holder_whatever_its_status_or_origin_counts(db):
    old, new = await same_server_case(db)
    other = await add_source(db, "elsewhere", "172.20.0.9", origin="manual", status="offline", identity={"application_uri": URI})
    assert await offers() == Decision(by_old={}, by_new={})
    await db.execute("DELETE FROM sources WHERE id = $1", other)
    assert (await offers()).by_old[old].new_id == new


async def test_a_holder_with_an_unreadable_address_counts_as_another_endpoint(db):
    await same_server_case(db)
    await add_source(db, "broken", "x", origin="manual", config={}, identity={"application_uri": URI})
    assert await offers() == Decision(by_old={}, by_new={})


async def test_a_holder_at_the_old_or_the_new_endpoint_does_not_count(db):
    old, new = await same_server_case(db)
    await add_source(db, "hand-added copy of C", "172.20.0.5", origin="manual", identity={"application_uri": URI})
    await add_source(db, "copy of O", "172.20.0.3", origin="manual", identity={"application_uri": URI})
    assert (await offers()).by_old[old] == Offer(old_id=old, new_id=new, match=SAME_SERVER)


async def test_the_host_of_a_holder_is_compared_in_lower_case(db):
    old, new = await same_server_case(db)
    await db.execute("UPDATE sources SET config = $2 WHERE id = $1", new, {"endpoint": "opc.tcp://Host.Lab:4840/"})
    await add_source(db, "copy of C", "host.lab", origin="manual", identity={"application_uri": URI})
    assert (await offers()).by_old[old].new_id == new


async def test_two_simulators_with_one_instance_id_are_the_same_server_by_instance(db):
    await make_scan(db, day=0)
    old = await old_source(db, "sim O", "172.20.0.3", kind="simulator", identity={"instance": "dev"}, origin="manual")
    second = await make_scan(db, day=3)
    new = await new_source(db, "sim C", "172.20.0.5", second, kind="simulator", identity={"instance": "dev"})
    offer = (await offers()).by_old[old]
    assert offer == Offer(
        old_id=old, new_id=new,
        match=Match(kind="same_server", evidence="instance", value="dev", addresses=3, missing_addresses=0, needs_tick=True),
    )


async def test_two_simulators_with_different_instance_ids_are_never_matched(db):
    await make_scan(db, day=0)
    await old_source(db, "sim O", "172.20.0.3", kind="simulator", identity={"instance": "dev"}, origin="manual")
    second = await make_scan(db, day=3)
    await new_source(db, "sim C", "172.20.0.5", second, kind="simulator", identity={"instance": "lab-2"})
    assert await offers() == Decision(by_old={}, by_new={})


# ---- pairing across several sources, and the old_ids narrowing ---------------------------------------------------------------

async def two_olds_one_new(db) -> tuple[int, int, int]:
    first = await make_scan(db, day=0)
    one = await old_source(db, "O1", "172.20.0.3")
    two = await old_source(db, "O2", "172.20.0.4")
    for source, host in ((one, "172.20.0.3"), (two, "172.20.0.4")):
        await make_finding(db, first, host, 4840, source)
    second = await make_scan(db, day=3)
    new = await new_source(db, "C", "172.20.0.5", second)
    return one, two, new


async def test_two_old_sources_that_one_new_source_could_replace_give_two_on_every_card(db):
    one, two, new = await two_olds_one_new(db)
    decision = await offers()
    assert decision.by_old == {one: Two(count=2), two: Two(count=2)}
    assert decision.by_new == {new: Two(count=2)}


async def test_old_ids_narrow_the_answer_but_the_other_old_sources_still_compete(db):
    """Asking about O1 alone must not turn an ambiguous pairing into an offer: O2 wants the same new source."""
    one, two, new = await two_olds_one_new(db)
    decision = await offers(old_ids=[one])
    assert decision.by_old == {one: Two(count=2)}


async def test_old_ids_narrow_an_unambiguous_answer_to_the_asked_sources(db):
    old, new = await owners_case(db)
    other_first = await make_scan(db, day=1)
    other = await old_source(db, "O2", "172.20.0.9", pairs=[("ns=2;s=Z", "Z")])
    await make_finding(db, other_first, "172.20.0.9", 4840, other)
    third = await make_scan(db, day=4)
    other_new = await new_source(db, "C2", "172.20.0.10", third, pairs=[("ns=2;s=Z", "Z")])
    assert sorted((await offers()).by_old) == sorted([old, other])
    only = await offers(old_ids=[other])
    assert list(only.by_old) == [other] and only.by_old[other].new_id == other_new
    assert (await offers(old_ids={old})).by_old[old].new_id == new


async def test_old_ids_that_are_not_offline_or_unknown_give_an_empty_answer(db):
    old, _ = await owners_case(db)
    assert await offers(old_ids=[old + 1000]) == Decision(by_old={}, by_new={})


# ---- statements --------------------------------------------------------------------------------------------------------------

async def test_no_offline_source_costs_no_statement_when_the_caller_names_the_offline_ones(db):
    await owners_case(db)
    decision, sql = await counted(old_ids=[])
    assert decision == Decision(by_old={}, by_new={}) and sql == []


async def test_nothing_offline_costs_one_statement_when_the_loader_has_to_look(db):
    old, _ = await owners_case(db)
    await db.execute("UPDATE sources SET status = 'online'")
    decision, sql = await counted()
    assert decision == Decision(by_old={}, by_new={}) and len(sql) == 1


async def populate(db, olds: int) -> list[int]:
    """`olds` offline mapped sources (half with an incident, half left to "not seen"), each with its own twin."""
    first = await make_scan(db, day=0)
    second = await make_scan(db, day=3)
    made = []
    for number in range(olds):
        pairs = [(f"ns=2;s=M{number}.{n}", f"M{number} {n}") for n in range(3)]
        host = f"10.1.{number // 200}.{number % 200 + 1}"
        old = await old_source(db, f"old {number}", host, pairs=pairs, incident="unreachable" if number % 2 else None)
        await make_finding(db, first, host, 4840, old)
        await new_source(db, f"new {number}", f"10.2.{number // 200}.{number % 200 + 1}", second, pairs=pairs,
                         identity={"application_uri": f"urn:vendor:{number}"})
        made.append(old)
    return made


async def test_a_normal_pass_runs_at_most_eight_statements_whatever_the_number_of_sources(db):
    made = await populate(db, 4)
    small, small_sql = await counted()
    assert sorted(small.by_old) == sorted(made) and all(isinstance(v, Offer) for v in small.by_old.values())
    await populate_more(db, 4, 30)
    big, big_sql = await counted()
    assert len(big.by_old) == 30
    assert len(small_sql) <= 9 and len(big_sql) <= 9, (small_sql, big_sql)
    assert len(big_sql) == len(small_sql)


async def test_found_at_is_read_once_for_all_the_candidates_not_once_per_source(db):
    """`scan_findings` has no index on `source_id` and scans are never pruned, so a read per candidate would grow with sources x
    findings: one grouped statement reads it for every candidate, and the pass costs the same for 1 and for 60 unmapped sources."""
    old, new = await owners_case(db)
    one, one_sql = await counted()
    assert one.by_old[old].new_id == new
    second = await db.fetchval("SELECT max(id) FROM scans")
    for number in range(59):
        # the same shape as the real candidate (type, port, path), so every one of them is read for its first sighting
        await new_source(db, f"extra {number}", f"10.3.0.{number + 1}", second)
    many, many_sql = await counted()
    assert many.by_old[old] == Two(count=60) and many.by_new[new] == Two(count=60)
    assert len(many_sql) == len(one_sql), (one_sql, many_sql)
    reads = [statement for statement in many_sql if "scan_findings" in statement.lower()]
    assert len(reads) == 1 and "group by" in reads[0].lower(), reads


async def populate_more(db, start: int, end: int) -> None:
    second = await db.fetchval("SELECT max(id) FROM scans")
    first = await db.fetchval("SELECT min(id) FROM scans")
    for number in range(start, end):
        pairs = [(f"ns=2;s=M{number}.{n}", f"M{number} {n}") for n in range(3)]
        host = f"10.1.{number // 200}.{number % 200 + 1}"
        old = await old_source(db, f"old {number}", host, pairs=pairs, incident="unreachable" if number % 2 else None)
        await make_finding(db, first, host, 4840, old)
        await new_source(db, f"new {number}", f"10.2.{number // 200}.{number % 200 + 1}", second, pairs=pairs,
                         identity={"application_uri": f"urn:vendor:{number}"})


async def test_the_loader_never_reads_a_password_or_the_certificate_of_anything(db):
    """The statements select columns by name: the encrypted `secret` of a source is never part of a statement's result."""
    await owners_case(db)
    _, sql = await counted()
    assert sql and all("secret" not in statement.lower() for statement in sql), sql


# ---- the incident code (events/read.py) --------------------------------------------------------------------------------------

async def test_open_incidents_carry_the_code_of_the_row_and_stay_otherwise_the_same(db):
    timed_out = await add_source(db, "a", "10.0.0.1", status="offline")
    no_code = await add_source(db, "b", "10.0.0.2", status="offline")
    closed = await add_source(db, "c", "10.0.0.3", status="offline")
    await open_incident(db, timed_out, "timeout")
    await db.execute(
        "INSERT INTO diag_events (level, component, source_id, kind, message, detail) "
        "VALUES ('warning', 'collector', $1, 'source.offline', 'down', '{\"state\": \"open\", \"count\": 2}')", no_code,
    )
    await open_incident(db, closed, "unreachable", state="closed")
    async with get_sessionmaker()() as session:
        found = await events_read.open_incidents(session, [timed_out, no_code, closed])
    assert sorted(found) == sorted([timed_out, no_code])
    assert set(found[timed_out]) == {"first_at", "count", "code"} and found[timed_out]["count"] == 5
    assert (found[timed_out]["code"], found[no_code]["code"], found[no_code]["count"]) == ("timeout", None, 2)


# ---- the detailed answer (w33 T4a: the Discovery graph names the old source on the new one's card) --------------------------

async def detailed(*, old_ids=None, not_seen=None, count=False):
    async with get_sessionmaker()() as session:
        with statements() as sql:
            loaded = await load_offers_detailed(session, old_ids=old_ids, not_seen=not_seen)
    return (loaded, sql) if count else loaded


async def test_the_detailed_answer_has_the_same_decision_and_names_the_old_sources_and_their_incidents(db):
    old, new = await owners_case(db)
    loaded = await detailed()
    assert loaded.decision == await offers() and loaded.decision.by_new[new].old_id == old
    assert list(loaded.olds) == [old]
    taken = loaded.olds[old]
    assert (taken.name, taken.mappings, taken.assets, taken.last_seen) == ("OPC UA server at 172.20.0.3:4840", 3, 1, finished_at(0))
    assert list(loaded.incidents) == [old] and loaded.incidents[old]["code"] == "unreachable"
    assert loaded.incidents[old]["first_at"] is not None


async def test_the_detailed_answer_of_nothing_is_empty_all_round_and_costs_what_the_plain_one_does(db):
    await owners_case(db)
    await db.execute("UPDATE sources SET status = 'online'")
    loaded, sql = await detailed(count=True)
    assert (loaded.decision, dict(loaded.olds), dict(loaded.incidents)) == (Decision(by_old={}, by_new={}), {}, {}) and len(sql) == 1
    loaded, sql = await detailed(old_ids=[], count=True)
    assert loaded.decision == Decision(by_old={}, by_new={}) and sql == []


async def test_the_plain_answer_is_the_detailed_ones_decision(db):
    await owners_case(db)
    assert await offers(old_ids=[]) == (await detailed(old_ids=[])).decision
    assert await offers() == (await detailed()).decision


async def test_a_not_seen_map_handed_in_is_used_instead_of_the_loaders_own_work(db):
    """Without any incident row, a discovered source is unreachable only by "not seen": the map decides, and with the map given the
    loader skips the statements that compute it."""
    old, new = await owners_case(db)
    await db.execute("DELETE FROM diag_events")
    async with get_sessionmaker()() as session:
        rows = (await session.execute(select(Source.id, Source.origin, Source.connector_type, Source.config))).all()
        full = await not_seen_map(session, rows)
    assert old in full
    on_its_own, own_sql = await detailed(count=True)
    given, given_sql = await detailed(not_seen=full, count=True)
    assert given.decision == on_its_own.decision and given.decision.by_old[old].new_id == new
    assert len(given_sql) < len(own_sql)
    nothing = await detailed(not_seen={})  # an empty map says no source is not seen: nothing is unreachable
    assert nothing.decision == Decision(by_old={}, by_new={})
