"""The source matcher (W33), pure: when does a source that stopped answering (O) get OFFERED a newly found source (C)?

A wrong match sends a meter's readings (and bills) to the wrong asset, so these tests are adversarial: every way two different
servers could look alike is pinned as "never". No database; the loaders (moves/load.py) build the inputs."""
import ast
import copy
import inspect
import random
from datetime import datetime, timedelta, timezone
from types import MappingProxyType

import pytest

from dcdash.connectors.identity import DEFAULT_URIS, usable_key
from dcdash.moves import match as match_module
from dcdash.moves.match import Decision, Holder, Match, NewSource, Offer, OldSource, Two, decide

T0 = datetime(2026, 10, 20, 8, 0, tzinfo=timezone.utc)   # O last answered
LATER = T0 + timedelta(days=1)                            # the scan that found C
URI_A = "urn:vendor:plant:server-a"
URI_B = "urn:vendor:plant:server-b"
THUMB_1 = "3A:5F:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:91"
THUMB_2 = "7B:6E:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:12"


def ident_opcua(uri=URI_A, thumbprint=None):
    out = {"application_uri": uri}
    if thumbprint is not None:
        out["thumbprint"] = thumbprint
    return out


def ident_sim(instance="dev"):
    return {"instance": instance}


def old(**kw):
    base = dict(id=1, name="OPC UA server at 172.20.0.3:4840", connector_type="opcua", host="172.20.0.3", port=4840, path="/dcdash/",
                identity=None, mappings=4, mapped_pairs=3, assets=2, last_seen=T0, unreachable=True)
    base.update(kw)
    return OldSource(**base)


def new(o=None, **kw):
    """A candidate for `o` (default: the plain old source): found later, nothing mapped, every mapped pair of `o` present."""
    o = o or old()
    base = dict(id=2, name="OPC UA server at 172.20.0.5:4840", connector_type=o.connector_type, host="172.20.0.5", port=o.port,
                path=o.path, identity=None, points=12, found_at=LATER, mapped=0, overlap={o.id: o.mapped_pairs})
    base.update(kw)
    return NewSource(**base)


def sim_old(**kw):
    base = dict(connector_type="simulator", name="DCDash simulator at 172.20.0.3:8080", port=8080, path="")
    base.update(kw)
    return old(**base)


def holder(identity_key_holder_id, host, port):
    return Holder(id=identity_key_holder_id, host=host, port=port)


def key_of(connector_type, identity):
    key = usable_key(connector_type, identity)
    assert key is not None
    return key


def only_offer(decision, old_id=1, new_id=2):
    offer = decision.by_old[old_id]
    assert isinstance(offer, Offer)
    assert (offer.old_id, offer.new_id) == (old_id, new_id)
    assert decision.by_new[new_id] is offer or decision.by_new[new_id] == offer
    return offer


def nothing(decision):
    assert decision.by_old == {}
    assert decision.by_new == {}


# --------------------------------------------------------------------------------------------------------- same server

def test_same_opcua_uri_is_same_server():
    o = old(identity=ident_opcua())
    decision = decide([o], [new(o, identity=ident_opcua())], {})
    offer = only_offer(decision)
    assert offer.match.kind == "same_server"
    assert offer.match.evidence == "uri"
    assert offer.match.value == URI_A


def test_same_simulator_instance_is_same_server():
    o = sim_old(identity=ident_sim("dev"))
    decision = decide([o], [new(o, identity=ident_sim("dev"))], {})
    offer = only_offer(decision)
    assert (offer.match.kind, offer.match.evidence, offer.match.value) == ("same_server", "instance", "dev")


def test_two_simulators_with_different_instance_ids_never_match_even_with_identical_address_sets():
    o = sim_old(identity=ident_sim("lab-1"))
    c = new(o, identity=ident_sim("lab-2"), overlap={1: o.mapped_pairs})
    nothing(decide([o], [c], {}))


def test_different_opcua_uris_never_match_even_with_identical_address_sets():
    o = old(identity=ident_opcua(URI_A))
    nothing(decide([o], [new(o, identity=ident_opcua(URI_B))], {}))


def test_equal_uris_with_different_thumbprints_never_match():
    o = old(identity=ident_opcua(URI_A, THUMB_1))
    nothing(decide([o], [new(o, identity=ident_opcua(URI_A, THUMB_2))], {}))


def test_different_uris_with_different_thumbprints_never_match():
    o = old(identity=ident_opcua(URI_A, THUMB_1))
    nothing(decide([o], [new(o, identity=ident_opcua(URI_B, THUMB_2))], {}))


def test_different_thumbprints_never_match_when_the_old_source_has_no_usable_key():
    # A thumbprint without a URI is still evidence AGAINST: two certificates are two servers, even when every address is present.
    o = old(identity={"thumbprint": THUMB_1})
    nothing(decide([o], [new(o, identity={"thumbprint": THUMB_2})], {}))


def test_different_thumbprints_never_match_for_a_default_uri_on_both_sides():
    default = sorted(DEFAULT_URIS)[0]
    o = old(identity=ident_opcua(default, THUMB_1))
    nothing(decide([o], [new(o, identity=ident_opcua(default, THUMB_2))], {}))


def test_stored_default_uri_identity_on_old_counts_as_no_usable_key_so_possibly_applies():
    default = sorted(DEFAULT_URIS)[0]
    o = old(identity=ident_opcua(default))
    offer = only_offer(decide([o], [new(o, identity=ident_opcua(default))], {}))
    assert offer.match.kind == "possibly"
    assert offer.match.evidence == "addresses"


def test_stored_default_uri_identity_on_old_still_excluded_by_a_thumbprint_conflict():
    default = sorted(DEFAULT_URIS)[0]
    o = old(identity=ident_opcua(default, THUMB_1))
    nothing(decide([o], [new(o, identity=ident_opcua(URI_A, THUMB_2))], {}))


@pytest.mark.parametrize("default", sorted(DEFAULT_URIS))
def test_default_uri_servers_with_identical_address_sets_are_at_most_possibly_never_same_server(default):
    o = old(identity=ident_opcua(default))
    decision = decide([o], [new(o, identity=ident_opcua(default))], {})
    offer = only_offer(decision)
    assert offer.match.kind == "possibly"
    assert offer.match.value is None
    assert offer.match.needs_tick is True


@pytest.mark.parametrize("default", sorted(DEFAULT_URIS))
def test_default_uri_servers_with_different_address_sets_give_nothing(default):
    o = old(identity=ident_opcua(default), mapped_pairs=3)
    nothing(decide([o], [new(o, identity=ident_opcua(default), overlap={1: 2})], {}))


def test_default_uri_on_new_only_is_never_a_key_and_gives_possibly_at_most():
    default = sorted(DEFAULT_URIS)[0]
    o = old(identity=None)
    offer = only_offer(decide([o], [new(o, identity=ident_opcua(default))], {}))
    assert offer.match.kind == "possibly"


def test_old_with_a_usable_key_and_new_with_a_default_uri_never_matches():
    default = sorted(DEFAULT_URIS)[0]
    o = old(identity=ident_opcua(URI_A))
    nothing(decide([o], [new(o, identity=ident_opcua(default))], {}))


@pytest.mark.parametrize("connector_type", ["modbus", "file", "mqtt", "anything-else"])
def test_other_connector_types_never_match_even_with_everything_equal(connector_type):
    ident = {"application_uri": URI_A, "instance": "dev", "thumbprint": THUMB_1}
    o = old(connector_type=connector_type, identity=ident, port=502, path="")
    nothing(decide([o], [new(o, identity=dict(ident))], {}))


def test_modbus_pair_with_identical_register_maps_never_matches():
    o = old(connector_type="modbus", port=502, path="", identity=None, mapped_pairs=5)
    nothing(decide([o], [new(o)], {}))


def test_equal_names_with_different_identities_never_match():
    o = old(name="Meter", identity=ident_opcua(URI_A))
    nothing(decide([o], [new(o, name="Meter", identity=ident_opcua(URI_B))], {}))


def test_equal_names_alone_never_match():
    o = old(name="Meter", identity=None)
    # C has no usable key and lacks every mapped pair: nothing but the name is shared.
    nothing(decide([o], [new(o, name="Meter", identity=None, overlap={})], {}))


def test_equal_names_with_a_usable_key_on_old_and_none_on_new_never_match():
    o = old(name="Meter", identity=ident_opcua(URI_A))
    nothing(decide([o], [new(o, name="Meter", identity=None)], {}))


def test_names_are_never_compared_a_match_survives_different_names():
    o = old(name="Boiler room", identity=ident_opcua(URI_A))
    c = new(o, name="Something else entirely", identity=ident_opcua(URI_A))
    assert only_offer(decide([o], [c], {})).match.kind == "same_server"


def test_old_with_a_usable_key_and_new_without_one_never_matches_even_with_every_pair_present():
    o = old(identity=ident_opcua(URI_A))
    nothing(decide([o], [new(o, identity=None)], {}))
    nothing(decide([o], [new(o, identity={})], {}))


# ---------------------------------------------------------------------------------------------------------- possibly

def test_possibly_when_old_has_no_identity_and_every_pair_is_present():
    o = old(identity=None, mapped_pairs=3)
    offer = only_offer(decide([o], [new(o, identity=None)], {}))
    assert offer.match == Match(kind="possibly", evidence="addresses", value=None, addresses=3, missing_addresses=0, needs_tick=True)


def test_possibly_when_old_has_an_empty_identity_object():
    o = old(identity={})
    assert only_offer(decide([o], [new(o)], {})).match.kind == "possibly"


def test_old_without_a_usable_key_and_new_with_a_usable_key_is_possibly_and_needs_a_tick():
    o = old(identity=None)
    offer = only_offer(decide([o], [new(o, identity=ident_opcua(URI_B, THUMB_1))], {}))
    assert offer.match.kind == "possibly"
    assert offer.match.needs_tick is True
    assert offer.match.value is None


def test_c_with_one_mapped_pair_missing_is_not_possibly():
    o = old(identity=None, mapped_pairs=3)
    nothing(decide([o], [new(o, overlap={1: 2})], {}))


def test_the_same_address_with_a_different_point_name_is_not_possibly():
    # The loader counts a pair only when address AND name agree; one renamed point leaves the overlap one short.
    o = old(identity=None, mapped_pairs=4)
    nothing(decide([o], [new(o, overlap={1: 3})], {}))


def test_possibly_compares_distinct_pairs_not_mappings():
    # Five mappings over three distinct (address, name) pairs: three present pairs are enough, five would be a mistake.
    o = old(identity=None, mappings=5, mapped_pairs=3)
    offer = only_offer(decide([o], [new(o, overlap={1: 3})], {}))
    assert offer.match.addresses == 3


def test_possibly_needs_at_least_one_mapped_pair():
    o = old(identity=None, mapped_pairs=0)
    nothing(decide([o], [new(o, overlap={1: 0})], {}))


def test_possibly_needs_a_browsed_point():
    o = old(identity=None, mapped_pairs=3)
    nothing(decide([o], [new(o, points=0, overlap={1: 3})], {}))


def test_possibly_with_no_overlap_entry_at_all_is_nothing():
    o = old(identity=None)
    nothing(decide([o], [new(o, overlap={})], {}))
    nothing(decide([o], [new(o, overlap={99: 3})], {}))


def test_overlap_is_read_per_old_source():
    o1 = old(id=1, identity=None, mapped_pairs=3)
    c = new(o1, id=3, overlap={1: 3})
    o2 = old(id=2, host="172.20.0.4", identity=None, mapped_pairs=3)
    decision = decide([o1, o2], [c], {})
    # O2 has no entry in the overlap of C, so only O1 is a candidate and C belongs to O1 alone.
    assert set(decision.by_old) == {1}
    assert isinstance(decision.by_old[1], Offer)


# ------------------------------------------------------------------------------------------------- who is a candidate

def test_a_c_found_by_a_scan_older_than_last_seen_is_not_a_candidate():
    o = old(identity=None, last_seen=T0)
    nothing(decide([o], [new(o, found_at=T0 - timedelta(seconds=1))], {}))


def test_a_c_found_at_exactly_last_seen_is_not_a_candidate():
    o = old(identity=None, last_seen=T0)
    nothing(decide([o], [new(o, found_at=T0)], {}))


def test_a_c_found_after_last_seen_is_a_candidate():
    o = old(identity=None, last_seen=T0)
    assert isinstance(decide([o], [new(o, found_at=T0 + timedelta(seconds=1))], {}).by_old[1], Offer)


def test_never_answered_old_accepts_any_found_at():
    o = old(identity=None, last_seen=None)
    c = new(o, found_at=datetime(2001, 1, 1, tzinfo=timezone.utc))
    assert isinstance(decide([o], [c], {}).by_old[1], Offer)


@pytest.mark.parametrize("last_seen", [None, T0])
def test_found_at_none_accepts_nothing(last_seen):
    o = old(identity=None, last_seen=last_seen)
    nothing(decide([o], [new(o, found_at=None)], {}))
    o2 = old(identity=ident_opcua(URI_A), last_seen=last_seen)
    nothing(decide([o2], [new(o2, identity=ident_opcua(URI_A), found_at=None)], {}))


def test_old_that_is_not_unreachable_gets_nothing():
    o = old(identity=ident_opcua(URI_A), unreachable=False)
    nothing(decide([o], [new(o, identity=ident_opcua(URI_A))], {}))
    o2 = old(identity=None, unreachable=False)
    nothing(decide([o2], [new(o2)], {}))


def test_old_without_a_mapping_gets_nothing():
    o = old(identity=ident_opcua(URI_A), mappings=0, mapped_pairs=0)
    nothing(decide([o], [new(o, identity=ident_opcua(URI_A))], {}))


def test_a_c_with_a_mapping_is_not_a_candidate():
    o = old(identity=ident_opcua(URI_A))
    nothing(decide([o], [new(o, identity=ident_opcua(URI_A), mapped=1)], {}))
    o2 = old(identity=None)
    nothing(decide([o2], [new(o2, mapped=2)], {}))


def test_a_different_port_never_matches():
    o = old(identity=ident_opcua(URI_A))
    nothing(decide([o], [new(o, identity=ident_opcua(URI_A), port=4841)], {}))
    o2 = old(identity=None)
    nothing(decide([o2], [new(o2, port=4841)], {}))


def test_a_different_path_never_matches():
    o = old(identity=ident_opcua(URI_A), path="/dcdash/")
    nothing(decide([o], [new(o, identity=ident_opcua(URI_A), path="/other/")], {}))
    o2 = old(identity=None, path="/dcdash/")
    nothing(decide([o2], [new(o2, path="")], {}))


def test_a_different_connector_type_never_matches():
    o = old(identity=None, connector_type="opcua", port=8080, path="")
    c = new(o, connector_type="simulator")
    nothing(decide([o], [c], {}))
    o2 = sim_old(identity=ident_sim("dev"))
    nothing(decide([o2], [new(o2, connector_type="opcua", identity={"application_uri": "dev"})], {}))


def test_a_source_is_never_its_own_candidate():
    o = old(identity=ident_opcua(URI_A))
    c = new(o, id=1, identity=ident_opcua(URI_A))
    nothing(decide([o], [c], {}))


def test_the_old_source_at_the_same_address_is_not_special_the_loader_decides_who_is_new():
    # The matcher trusts `mapped == 0` and the id; it never compares addresses of O and C (the loader did).
    o = old(identity=ident_opcua(URI_A), host="172.20.0.3")
    c = new(o, host="172.20.0.3", identity=ident_opcua(URI_A))
    assert isinstance(decide([o], [c], {}).by_old[1], Offer)


# ------------------------------------------------------------------------------------------------------ needs_tick etc

def test_same_server_with_equal_thumbprints_on_both_sides_needs_no_tick():
    o = old(identity=ident_opcua(URI_A, THUMB_1))
    offer = only_offer(decide([o], [new(o, identity=ident_opcua(URI_A, THUMB_1))], {}))
    assert offer.match.kind == "same_server"
    assert offer.match.needs_tick is False


def test_same_server_with_a_thumbprint_on_one_side_only_needs_a_tick():
    o = old(identity=ident_opcua(URI_A, THUMB_1))
    assert only_offer(decide([o], [new(o, identity=ident_opcua(URI_A))], {})).match.needs_tick is True
    o2 = old(identity=ident_opcua(URI_A))
    assert only_offer(decide([o2], [new(o2, identity=ident_opcua(URI_A, THUMB_1))], {})).match.needs_tick is True


def test_same_server_with_no_thumbprint_on_either_side_needs_a_tick():
    o = old(identity=ident_opcua(URI_A))
    assert only_offer(decide([o], [new(o, identity=ident_opcua(URI_A))], {})).match.needs_tick is True


def test_same_simulator_server_needs_a_tick_it_has_no_certificate():
    o = sim_old(identity=ident_sim("dev"))
    assert only_offer(decide([o], [new(o, identity=ident_sim("dev"))], {})).match.needs_tick is True


def test_same_server_with_no_points_is_allowed_and_missing_addresses_is_none():
    o = old(identity=ident_opcua(URI_A), mapped_pairs=3)
    offer = only_offer(decide([o], [new(o, identity=ident_opcua(URI_A), points=0, overlap={})], {}))
    assert offer.match.kind == "same_server"
    assert offer.match.missing_addresses is None
    assert offer.match.addresses == 0


@pytest.mark.parametrize("overlap, expected_missing", [(3, 0), (2, 1), (0, 3), (1, 2)])
def test_missing_addresses_is_mapped_pairs_minus_addresses(overlap, expected_missing):
    # equal certificates on both sides: the server is proven, so missing pairs are a warning and not a refusal
    o = old(identity=ident_opcua(URI_A, THUMB_1), mapped_pairs=3)
    offer = only_offer(decide([o], [new(o, identity=ident_opcua(URI_A, THUMB_1), overlap={1: overlap})], {}))
    assert offer.match.addresses == overlap
    assert offer.match.missing_addresses == expected_missing


def test_missing_addresses_is_never_negative():
    o = old(identity=ident_opcua(URI_A), mapped_pairs=3)
    offer = only_offer(decide([o], [new(o, identity=ident_opcua(URI_A), overlap={1: 7})], {}))
    assert offer.match.missing_addresses == 0


def test_same_server_with_a_missing_overlap_entry_has_zero_addresses():
    o = old(identity=ident_opcua(URI_A, THUMB_1), mapped_pairs=3)
    offer = only_offer(decide([o], [new(o, identity=ident_opcua(URI_A, THUMB_1), overlap={})], {}))
    assert (offer.match.addresses, offer.match.missing_addresses) == (0, 3)


# A match that needs the tick (no certificate on both sides) and whose C was browsed must hold every mapped pair of O: a URI shared by
# a product line, or a simulator id left at its default, would otherwise offer a meter's mappings to a server that has none of them.
def test_same_server_by_uri_with_points_and_no_overlap_at_all_is_not_offered():
    o = old(identity=ident_opcua(URI_A), mapped_pairs=3)
    nothing(decide([o], [new(o, identity=ident_opcua(URI_A), points=10, overlap={1: 0})], {}))
    nothing(decide([o], [new(o, identity=ident_opcua(URI_A), points=10, overlap={})], {}))


@pytest.mark.parametrize("overlap", [0, 1, 2])
def test_same_server_by_uri_without_certificates_and_two_of_three_pairs_is_not_offered(overlap):
    o = old(identity=ident_opcua(URI_A), mapped_pairs=3)
    nothing(decide([o], [new(o, identity=ident_opcua(URI_A), overlap={1: overlap})], {}))


def test_same_server_by_uri_with_a_certificate_on_one_side_only_still_needs_every_pair():
    o = old(identity=ident_opcua(URI_A, THUMB_1), mapped_pairs=3)
    nothing(decide([o], [new(o, identity=ident_opcua(URI_A), overlap={1: 2})], {}))
    o2 = old(identity=ident_opcua(URI_A), mapped_pairs=3)
    nothing(decide([o2], [new(o2, identity=ident_opcua(URI_A, THUMB_1), overlap={1: 2})], {}))
    assert only_offer(decide([o2], [new(o2, identity=ident_opcua(URI_A, THUMB_1), overlap={1: 3})], {})).match.missing_addresses == 0


def test_same_server_by_simulator_instance_with_a_missing_pair_is_not_offered():
    o = sim_old(identity=ident_sim("dev"), mapped_pairs=3)
    nothing(decide([o], [new(o, identity=ident_sim("dev"), overlap={1: 2})], {}))
    assert only_offer(decide([o], [new(o, identity=ident_sim("dev"), overlap={1: 3})], {})).match.missing_addresses == 0


def test_same_server_by_uri_with_equal_certificates_and_two_of_three_pairs_is_offered_with_the_warning():
    o = old(identity=ident_opcua(URI_A, THUMB_1), mapped_pairs=3)
    offer = only_offer(decide([o], [new(o, identity=ident_opcua(URI_A, THUMB_1), overlap={1: 2})], {}))
    assert offer.match == Match(kind="same_server", evidence="uri", value=URI_A, addresses=2, missing_addresses=1, needs_tick=False)


def test_same_server_by_uri_without_certificates_and_a_c_that_was_never_browsed_is_still_offered():
    o = old(identity=ident_opcua(URI_A), mapped_pairs=3)
    offer = only_offer(decide([o], [new(o, identity=ident_opcua(URI_A), points=0, overlap={})], {}))
    assert (offer.match.needs_tick, offer.match.missing_addresses) == (True, None)


def test_a_thumbprint_with_something_left_after_the_colons_and_spaces_still_conflicts_with_a_real_one():
    o = old(identity=ident_opcua(URI_A, "zz:zz"))
    nothing(decide([o], [new(o, identity=ident_opcua(URI_A, THUMB_1))], {}))


# A thumbprint with no hex digit in it ("::", spaces) is no certificate: the tick stays and it cannot conflict.
@pytest.mark.parametrize("junk", ["::", " ", ":: ::", "\t:\n"])
def test_a_junk_thumbprint_is_no_thumbprint_so_the_tick_is_needed(junk):
    o = old(identity=ident_opcua(URI_A, junk))
    offer = only_offer(decide([o], [new(o, identity=ident_opcua(URI_A, THUMB_1))], {}))
    assert (offer.match.kind, offer.match.needs_tick) == ("same_server", True)
    o2 = old(identity=ident_opcua(URI_A, THUMB_1))
    assert only_offer(decide([o2], [new(o2, identity=ident_opcua(URI_A, junk))], {})).match.needs_tick is True
    o3 = old(identity=ident_opcua(URI_A, junk))
    assert only_offer(decide([o3], [new(o3, identity=ident_opcua(URI_A, junk))], {})).match.needs_tick is True


# -------------------------------------------------------------------------------------------------------------- holders

def test_a_third_source_holding_the_same_uri_at_a_different_endpoint_makes_the_uri_no_identity():
    o = old(identity=ident_opcua(URI_A))
    c = new(o, identity=ident_opcua(URI_A))
    key = key_of("opcua", ident_opcua(URI_A))
    other = Holder(id=77, host="172.20.0.9", port=4840)
    nothing(decide([o], [c], {key: [Holder(1, o.host, o.port), Holder(2, c.host, c.port), other]}))


def test_the_ambiguity_ignores_the_status_of_the_third_source():
    # The holder carries no status at all: whatever its status, a URI that two endpoints report is no identity.
    o = old(identity=ident_opcua(URI_A))
    c = new(o, identity=ident_opcua(URI_A))
    key = key_of("opcua", ident_opcua(URI_A))
    assert not hasattr(Holder(1, "h", 1), "status")
    nothing(decide([o], [c], {key: [Holder(9, "172.20.0.9", 4840)]}))


def test_a_third_source_at_the_same_host_but_another_port_is_a_different_endpoint():
    o = old(identity=ident_opcua(URI_A))
    c = new(o, identity=ident_opcua(URI_A))
    key = key_of("opcua", ident_opcua(URI_A))
    nothing(decide([o], [c], {key: [Holder(9, o.host, 4841)]}))


def test_a_hand_added_duplicate_at_the_old_endpoint_does_not_make_the_uri_ambiguous():
    o = old(identity=ident_opcua(URI_A))
    c = new(o, identity=ident_opcua(URI_A))
    key = key_of("opcua", ident_opcua(URI_A))
    holders = {key: [Holder(1, o.host, o.port), Holder(2, c.host, c.port), Holder(30, o.host, o.port)]}
    assert only_offer(decide([o], [c], holders)).match.kind == "same_server"


def test_a_discovered_duplicate_at_the_new_endpoint_does_not_make_the_uri_ambiguous():
    o = old(identity=ident_opcua(URI_A))
    c = new(o, identity=ident_opcua(URI_A))
    key = key_of("opcua", ident_opcua(URI_A))
    holders = {key: [Holder(1, o.host, o.port), Holder(2, c.host, c.port), Holder(31, c.host, c.port)]}
    assert only_offer(decide([o], [c], holders)).match.kind == "same_server"


def test_holder_hosts_are_compared_case_insensitively():
    o = old(identity=ident_opcua(URI_A), host="meter-1.plant")
    c = new(o, host="meter-2.plant", identity=ident_opcua(URI_A))
    key = key_of("opcua", ident_opcua(URI_A))
    holders = {key: [Holder(30, "METER-1.PLANT", o.port)]}
    assert only_offer(decide([o], [c], holders)).match.kind == "same_server"


def test_the_two_sources_themselves_as_holders_never_count():
    o = old(identity=ident_opcua(URI_A))
    c = new(o, identity=ident_opcua(URI_A))
    key = key_of("opcua", ident_opcua(URI_A))
    # Even with odd hosts recorded for them, a holder that IS O or C is never a third source.
    holders = {key: [Holder(1, "somewhere.else", 9999), Holder(2, "elsewhere.too", 9998)]}
    assert only_offer(decide([o], [c], holders)).match.kind == "same_server"


def test_holders_of_other_keys_do_not_matter():
    o = old(identity=ident_opcua(URI_A))
    c = new(o, identity=ident_opcua(URI_A))
    other_key = key_of("opcua", ident_opcua(URI_B))
    assert only_offer(decide([o], [c], {other_key: [Holder(9, "172.20.0.9", 4840)]})).match.kind == "same_server"


def test_an_ambiguous_key_does_not_fall_back_to_possibly_when_old_has_a_usable_key():
    o = old(identity=ident_opcua(URI_A), mapped_pairs=3)
    c = new(o, identity=ident_opcua(URI_A), overlap={1: 3})
    key = key_of("opcua", ident_opcua(URI_A))
    nothing(decide([o], [c], {key: [Holder(9, "172.20.0.9", 4840)]}))


def test_ambiguity_does_not_stop_possibly_when_old_has_no_usable_key():
    o = old(identity=None, mapped_pairs=3)
    c = new(o, identity=ident_opcua(URI_A), overlap={1: 3})
    key = key_of("opcua", ident_opcua(URI_A))
    offer = only_offer(decide([o], [c], {key: [Holder(9, "172.20.0.9", 4840)]}))
    assert offer.match.kind == "possibly"


def test_an_ambiguous_simulator_instance_is_no_identity_either():
    o = sim_old(identity=ident_sim("dev"))
    c = new(o, identity=ident_sim("dev"))
    key = key_of("simulator", ident_sim("dev"))
    nothing(decide([o], [c], {key: [Holder(9, "172.20.0.9", 8080)]}))


# ------------------------------------------------------------------------------------------------------------ pairing

def test_two_candidates_for_one_old_give_two_on_the_old_and_on_both_news():
    o = old(identity=None, mapped_pairs=3)
    c1 = new(o, id=2, host="172.20.0.5")
    c2 = new(o, id=3, host="172.20.0.6")
    decision = decide([o], [c1, c2], {})
    assert decision.by_old == {1: Two(count=2)}
    assert decision.by_new == {2: Two(count=2), 3: Two(count=2)}


def test_three_candidates_count_three():
    o = old(identity=None)
    cs = [new(o, id=10 + i, host=f"172.20.0.{20 + i}") for i in range(3)]
    decision = decide([o], cs, {})
    assert decision.by_old == {1: Two(count=3)}
    assert decision.by_new == {10: Two(count=3), 11: Two(count=3), 12: Two(count=3)}


def test_two_same_server_candidates_with_one_uri_also_give_two():
    o = old(identity=ident_opcua(URI_A))
    c1 = new(o, id=2, identity=ident_opcua(URI_A))
    c2 = new(o, id=3, host="172.20.0.6", identity=ident_opcua(URI_A))
    decision = decide([o], [c1, c2], {})
    assert decision.by_old == {1: Two(count=2)}
    assert decision.by_new == {2: Two(count=2), 3: Two(count=2)}


def test_two_olds_sharing_one_new_give_two_on_both_olds_and_on_the_new():
    o1 = old(id=1, host="172.20.0.3", identity=None, mapped_pairs=3)
    o2 = old(id=2, host="172.20.0.4", identity=None, mapped_pairs=3)
    c = new(o1, id=3, overlap={1: 3, 2: 3})
    decision = decide([o1, o2], [c], {})
    assert decision.by_old == {1: Two(count=2), 2: Two(count=2)}
    assert decision.by_new == {3: Two(count=2)}


def test_two_olds_with_distinct_news_give_two_offers():
    o1 = old(id=1, host="172.20.0.3", identity=ident_opcua(URI_A))
    o2 = old(id=2, host="172.20.0.4", identity=ident_opcua(URI_B))
    c1 = new(o1, id=3, host="172.20.0.5", identity=ident_opcua(URI_A), overlap={1: 3, 2: 3})
    c2 = new(o2, id=4, host="172.20.0.6", identity=ident_opcua(URI_B), overlap={1: 3, 2: 3})
    decision = decide([o1, o2], [c1, c2], {})
    assert (decision.by_old[1].old_id, decision.by_old[1].new_id) == (1, 3)
    assert (decision.by_old[2].old_id, decision.by_old[2].new_id) == (2, 4)
    assert decision.by_new[3] is decision.by_old[1]
    assert decision.by_new[4] is decision.by_old[2]


def test_a_shared_new_does_not_spoil_an_unrelated_offer():
    o1 = old(id=1, host="172.20.0.3", identity=None)
    o2 = old(id=2, host="172.20.0.4", identity=None)
    o3 = old(id=3, host="172.20.0.7", connector_type="simulator", port=8080, path="", identity=ident_sim("dev"))
    shared = new(o1, id=10, overlap={1: 3, 2: 3})
    unrelated = new(o3, id=11, host="172.20.0.9", identity=ident_sim("dev"))
    decision = decide([o1, o2, o3], [shared, unrelated], {})
    assert decision.by_old[1] == Two(count=2)
    assert decision.by_old[2] == Two(count=2)
    assert isinstance(decision.by_old[3], Offer)
    assert decision.by_new[10] == Two(count=2)
    assert decision.by_new[11] is decision.by_old[3]


def test_the_count_on_an_old_is_the_larger_of_its_candidates_and_the_olds_of_its_candidate():
    # O1 has two candidates (C10, C11); C10 is also the candidate of O2 and O3: three servers or sources are in play around C10.
    o1 = old(id=1, host="172.20.0.3", identity=None)
    o2 = old(id=2, host="172.20.0.4", identity=None)
    o3 = old(id=3, host="172.20.0.7", identity=None)
    c10 = new(o1, id=10, host="172.20.0.15", overlap={1: 3, 2: 3, 3: 3})
    c11 = new(o1, id=11, host="172.20.0.16", overlap={1: 3})
    decision = decide([o1, o2, o3], [c10, c11], {})
    assert decision.by_old == {1: Two(count=3), 2: Two(count=3), 3: Two(count=3)}
    assert decision.by_new == {10: Two(count=3), 11: Two(count=2)}


def test_old_with_two_candidates_where_only_one_is_valid_is_an_offer():
    o = old(identity=ident_opcua(URI_A))
    good = new(o, id=2, identity=ident_opcua(URI_A))
    bad = new(o, id=3, host="172.20.0.6", identity=ident_opcua(URI_B))
    decision = decide([o], [good, bad], {})
    assert only_offer(decision, 1, 2).match.kind == "same_server"
    assert 3 not in decision.by_new


def test_an_old_with_nothing_to_say_is_absent_from_the_decision():
    o1 = old(id=1, identity=ident_opcua(URI_A))
    o2 = old(id=2, host="172.20.0.4", identity=ident_opcua(URI_B))
    c = new(o1, id=3, identity=ident_opcua(URI_A), overlap={1: 3, 2: 3})
    decision = decide([o1, o2], [c], {})
    assert set(decision.by_old) == {1}
    assert set(decision.by_new) == {3}


def test_empty_inputs_give_an_empty_decision():
    assert decide([], [], {}) == Decision(by_old={}, by_new={})
    assert decide([old()], [], {}) == Decision(by_old={}, by_new={})
    assert decide([], [new()], {}) == Decision(by_old={}, by_new={})


def test_the_offer_carries_the_match_that_decided():
    o = old(identity=ident_opcua(URI_A, THUMB_1), mapped_pairs=4)
    c = new(o, identity=ident_opcua(URI_A, THUMB_1), overlap={1: 3})
    offer = only_offer(decide([o], [c], {}))
    assert offer.match == Match(kind="same_server", evidence="uri", value=URI_A, addresses=3, missing_addresses=1, needs_tick=False)


# --------------------------------------------------------------------------------------------------------- properties

def scenario():
    """A mixed bag: offers, a shared C, a two-candidate O, a modbus pair, an ambiguous key."""
    olds = [
        old(id=1, host="172.20.0.3", identity=ident_opcua(URI_A, THUMB_1)),
        old(id=2, host="172.20.0.4", identity=None, mapped_pairs=3),
        old(id=3, host="172.20.0.7", identity=None, mapped_pairs=3),
        old(id=4, host="172.20.1.1", connector_type="modbus", port=502, path="", identity=None),
        sim_old(id=5, host="172.20.2.1", identity=ident_sim("lab-1")),
        old(id=6, host="172.20.3.1", port=4850, identity=ident_opcua("urn:vendor:plant:server-z")),
    ]
    news = [
        new(olds[0], id=11, host="172.20.0.15", identity=ident_opcua(URI_A, THUMB_1), overlap={1: 3}),
        new(olds[1], id=12, host="172.20.0.16", identity=None, overlap={2: 3, 3: 3}),
        new(olds[2], id=13, host="172.20.0.17", identity=ident_opcua("urn:x"), overlap={2: 3, 3: 3}),
        new(olds[3], id=14, host="172.20.1.2", overlap={4: 3}),
        new(olds[4], id=15, host="172.20.2.2", identity=ident_sim("lab-1"), overlap={5: 3}),
        new(olds[4], id=16, host="172.20.2.3", identity=ident_sim("lab-2"), overlap={5: 3}),
        new(olds[5], id=17, host="172.20.3.2", port=4850, identity=ident_opcua("urn:vendor:plant:server-z"), overlap={6: 3}),
    ]
    holders = {key_of("opcua", ident_opcua("urn:vendor:plant:server-z")): [Holder(99, "172.20.9.9", 4850)]}
    return olds, news, holders


def test_scenario_decision_is_what_we_expect():
    olds, news, holders = scenario()
    decision = decide(olds, news, holders)
    assert isinstance(decision.by_old[1], Offer) and decision.by_old[1].new_id == 11
    assert decision.by_old[2] == Two(count=2) and decision.by_old[3] == Two(count=2)
    assert decision.by_new[12] == Two(count=2) and decision.by_new[13] == Two(count=2)
    assert 4 not in decision.by_old and 14 not in decision.by_new            # modbus
    assert isinstance(decision.by_old[5], Offer) and decision.by_old[5].new_id == 15   # the other instance is not a candidate
    assert 16 not in decision.by_new
    assert 6 not in decision.by_old and 17 not in decision.by_new            # ambiguous key


def test_order_of_the_input_lists_never_changes_the_decision():
    olds, news, holders = scenario()
    expected = decide(olds, news, holders)
    rng = random.Random(33)
    for _ in range(40):
        o2, n2 = olds[:], news[:]
        rng.shuffle(o2)
        rng.shuffle(n2)
        shuffled_holders = {k: rng.sample(list(v), len(v)) for k, v in holders.items()}
        got = decide(o2, n2, shuffled_holders)
        assert got == expected


def test_decide_accepts_any_sequence_and_never_mutates_its_inputs():
    olds, news, holders = scenario()
    frozen = (copy.deepcopy(olds), copy.deepcopy(news), copy.deepcopy(holders))
    olds_t, news_t = tuple(olds), tuple(news)
    decide(olds_t, news_t, holders)
    assert (list(olds_t), list(news_t), holders) == frozen
    assert (olds, news) == (frozen[0], frozen[1])


def test_decide_reads_read_only_mappings():
    o = old(identity=MappingProxyType(ident_opcua(URI_A, THUMB_1)))
    c = new(o, identity=MappingProxyType(ident_opcua(URI_A, THUMB_1)), overlap=MappingProxyType({1: 3}))
    key = key_of("opcua", ident_opcua(URI_A))
    assert only_offer(decide([o], [c], MappingProxyType({key: (Holder(1, o.host, o.port),)}))).match.kind == "same_server"


def test_the_dataclasses_are_frozen():
    o = old()
    with pytest.raises(Exception):
        o.id = 5
    with pytest.raises(Exception):
        Match(kind="possibly", evidence="addresses", value=None, addresses=1, missing_addresses=0, needs_tick=True).kind = "same_server"
    with pytest.raises(Exception):
        Offer(1, 2, only_offer(decide([old(identity=None)], [new()], {})).match).old_id = 3


def test_decide_is_deterministic_for_repeated_calls():
    olds, news, holders = scenario()
    assert decide(olds, news, holders) == decide(olds, news, holders)


def test_the_module_is_pure_no_io_no_logging():
    tree = ast.parse(inspect.getsource(match_module))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported |= {a.name for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module)
    assert imported <= {"__future__", "collections.abc", "dataclasses", "datetime", "typing", "dcdash.connectors.identity"}, imported
    called = {n.func.id for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
    assert not called & {"open", "print", "input", "exec", "eval"}
