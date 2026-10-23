"""stable_address, address_key_for, AddressIndex and read_plan (w34, R2 and D1): the one place an OPC UA tag's position number
is removed, and the lookups every matcher shares."""

import json
import random
import re
from collections import defaultdict
from pathlib import Path

import pytest

from dcdash.connectors.base import create_connector
from dcdash.connectors.opcua_ids import AddressIndex, address_key_for, identity_key, read_plan, stable_address
from tests.helpers import opcua_server

SAMPLES = json.loads((Path(__file__).resolve().parent / "fixtures" / "opcua_id_samples.json").read_text(encoding="ascii"))
_PREFIX = re.compile(r"(?:ns=[0-9]+;)?s=")


def test_the_samples_file_holds_both_kinds_and_the_brief_examples():
    changed = [s for s in SAMPLES if s["in"] != s["out"]]
    assert len(changed) >= 8 and len(SAMPLES) - len(changed) >= 25
    pairs = {s["in"]: s["out"] for s in SAMPLES}
    assert pairs["ns=3;s=20403:Site.PDUA01_PM0_P"] == "ns=3;s=Site.PDUA01_PM0_P"
    assert pairs["ns=3;s=20403:"] == "ns=3;s=20403:"


@pytest.mark.parametrize("sample", SAMPLES, ids=[repr(s["in"]) for s in SAMPLES])
def test_samples(sample):
    assert stable_address(sample["in"]) == sample["out"]


def _tail(address):
    """(prefix, what follows it), or None when the string has no `[ns=N;]s=` prefix."""
    found = _PREFIX.match(address)
    return None if found is None else (found[0], address[found.end():])


def _tags(address):
    """The tags an id can be read as, written without using stable_address: (prefix, rest) with the rest as it is, and with one
    leading `<digits>:` taken off it. Two ids can only be one tag when these sets meet."""
    parts = _tail(address)
    if parts is None:
        return {(None, address)}
    prefix, tail = parts
    tags = {(prefix, tail)}
    if (number := re.match(r"[0-9]+:", tail)) is not None:
        tags.add((prefix, tail[number.end():]))
    return tags


def _generated(rng, count):
    """Ids built from parts (so the same-tag pairs exist by construction) and strings drawn from a small alphabet of the
    characters that matter (so odd shapes are reached)."""
    ids = []
    for _ in range(count // 2):
        prefix = rng.choice(["", "ns=3;", "ns=2;", "ns=12;"])
        number = rng.choice([None, "1", "7", "20403", "20410", "007"])
        rest = rng.choice(["Site.A", "Site.B", "A.B", "Site.A:B", "x", "Site", "2:Site.A", "9:8:Site.A", "Site.A.B", "Site.My Tag", ""])
        ids.append(f"{prefix}s={'' if number is None else number + ':'}{rest}")
    pieces = ["0", "1", "2", ":", ".", ";", "=", "s", "S", "n", "ns=3;", "s=", "A", "b", "_", " ", "20403"]
    for _ in range(count - count // 2):
        ids.append("".join(rng.choice(pieces) for _ in range(rng.randint(0, 9))))
    return ids


def test_idempotent():
    ids = [s["in"] for s in SAMPLES] + _generated(random.Random(34), 2000)
    for address in ids:
        once = stable_address(address)
        assert stable_address(once) == once, address


def test_the_output_is_the_input_with_at_most_one_number_taken_out():
    for address in [s["in"] for s in SAMPLES] + _generated(random.Random(35), 4000):
        out = stable_address(address)
        if out == address:
            continue
        prefix, tail = _tail(address)
        number = re.match(r"[0-9]+:", tail)
        assert number is not None and out == prefix + tail[number.end():], address


def test_two_different_tags_never_collapse():
    ids = _generated(random.Random(34), 2000)
    groups = defaultdict(set)
    for address in ids:
        groups[stable_address(address)].add(address)
    collisions = 0
    for members in groups.values():
        for a in members:
            for b in members:
                if a == b:
                    continue
                collisions += 1
                assert _tags(a) & _tags(b), f"{a!r} and {b!r} became one tag"
    assert collisions >= 100  # the run reached collapsing pairs, so the check above is not vacuous


def test_the_same_tag_with_another_number_collapses():
    for prefix in ("", "ns=3;", "ns=12;"):
        ids = [f"{prefix}s={number}:Site.PDUA01_PM0_P" for number in ("1", "20403", "20410", "007")]
        assert len({stable_address(a) for a in ids}) == 1
        assert stable_address(f"{prefix}s=Site.PDUA01_PM0_P") == stable_address(ids[0])


def test_a_different_namespace_or_tag_is_a_different_tag():
    assert stable_address("ns=3;s=1:Site.A") != stable_address("ns=4;s=1:Site.A")
    assert stable_address("ns=3;s=1:Site.A") != stable_address("ns=3;s=1:Site.B")
    assert stable_address("ns=3;s=1:Site.A") != stable_address("s=1:Site.A")


async def test_the_simulators_60_ids_are_unchanged():
    async with opcua_server() as srv:
        connector = create_connector("opcua", {"endpoint": srv.endpoint.replace("0.0.0.0", "127.0.0.1"), "timeout_seconds": 2})
        addresses = [p.address for p in await connector.browse()]
    assert len(addresses) == 60
    assert all(a.startswith("ns=2;i=") and stable_address(a) == a for a in addresses)


def test_address_key_for():
    numbered = "ns=3;s=20403:Site.X"
    on = address_key_for("opcua", {"endpoint": "opc.tcp://h", "stable_addresses": True})
    assert on is stable_address and on(numbered) == "ns=3;s=Site.X"
    for config in ({"stable_addresses": False}, {}, {"stable_addresses": "true"}, {"stable_addresses": 1}, {"stable_addresses": None},
                   None, "stable_addresses", ["stable_addresses"], 7):
        assert address_key_for("opcua", config) is identity_key, config
    for connector_type in ("modbus", "simulator", "file", "", "OPCUA"):
        assert address_key_for(connector_type, {"stable_addresses": True}) is identity_key, connector_type
    assert identity_key(numbered) == numbered


def test_address_index_get_prefers_an_exact_match_then_a_unique_key():
    numbered, stable, other = "ns=3;s=20403:Site.A", "ns=3;s=Site.A", "ns=3;s=20410:Site.B"
    index = AddressIndex([(numbered, 1), (other, 2)], stable_address)
    assert index.get(numbered) == 1 and index.get(other) == 2  # exact
    assert index.get(stable) == 1  # by key: one stored entry has it
    assert index.get("ns=3;s=99999:Site.A") == 1  # another number, the same tag
    assert index.get("ns=3;s=Site.C") is None and index.get("") is None
    assert numbered in index and stable in index and "ns=3;s=Site.C" not in index
    assert index.ambiguous_keys() == set()


def test_address_index_a_shared_key_serves_nobody_by_key_and_is_listed():
    first, second = "ns=3;s=20403:Site.A", "ns=3;s=20410:Site.A"
    index = AddressIndex([(first, 1), (second, 2), ("ns=3;s=Site.B", 3)], stable_address)
    assert index.get("ns=3;s=Site.A") is None and "ns=3;s=Site.A" not in index  # two stored entries are this tag
    assert index.get("ns=3;s=1:Site.A") is None
    assert index.get(first) == 1 and index.get(second) == 2  # an exact match still wins
    assert index.get("ns=3;s=Site.B") == 3
    assert index.ambiguous_keys() == {"ns=3;s=Site.A"}
    assert index.key("ns=3;s=7:Site.A") == "ns=3;s=Site.A"


def test_address_index_with_the_identity_key_is_a_plain_lookup():
    index = AddressIndex([("a", 1), ("b", 2)], identity_key)
    assert index.get("a") == 1 and index.get("c") is None and index.ambiguous_keys() == set()


def test_address_index_items_and_values_are_the_stored_entries():
    pairs = [("ns=3;s=20403:Site.A", "x"), ("ns=3;s=20410:Site.A", "y"), ("ns=3;s=Site.B", "z")]
    index = AddressIndex(pairs, stable_address)
    assert list(index.items()) == pairs and list(index.values()) == ["x", "y", "z"]
    assert list(AddressIndex([], stable_address).items()) == []


def test_read_plan_sends_each_distinct_stored_string_once_in_the_callers_order():
    stored = ["ns=3;s=20403:Site.B", "ns=3;s=Site.A", "ns=3;s=20403:Site.B", "ns=2;i=9"]
    plan = read_plan(stored, stable_address)
    assert plan.sent == [("ns=3;s=20403:Site.B", "ns=3;s=Site.B"), ("ns=3;s=Site.A", "ns=3;s=Site.A"), ("ns=2;i=9", "ns=2;i=9")]
    assert plan.refused == {}  # the same text twice is one address, not a collision


def test_read_plan_refuses_every_member_of_a_shared_stable_form():
    stored = ["ns=3;s=20403:Site.A", "ns=3;s=Site.C", "ns=3;s=20410:Site.A", "ns=3;s=Site.A", "ns=3;s=20403:Site.A"]
    plan = read_plan(stored, stable_address)
    text = "two points are the same tag (stable address ns=3;s=Site.A)"
    assert plan.refused == {"ns=3;s=20403:Site.A": text, "ns=3;s=20410:Site.A": text, "ns=3;s=Site.A": text}
    assert plan.sent == [("ns=3;s=Site.C", "ns=3;s=Site.C")]


def test_read_plan_with_the_identity_key_never_refuses():
    stored = ["ns=3;s=20403:Site.A", "ns=3;s=20410:Site.A"]
    plan = read_plan(stored, identity_key)
    assert plan.sent == [(a, a) for a in stored] and plan.refused == {}
    empty = read_plan([], stable_address)
    assert empty.sent == [] and empty.refused == {}
