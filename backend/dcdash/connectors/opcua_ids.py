"""OPC UA tag addresses that survive a SCADA project change (w34).

AVEVA Plant SCADA shows each tag to a Browse as `ns=3;s=20403:Cluster.Tag`: the number in front of the tag is a position that can
change when the SCADA project changes, while `ns=3;s=Cluster.Tag` is said (a community answer, not tested against any real SCADA)
to keep working. `stable_address` is the ONE place that number is removed. The read, the browse and every place that compares
point addresses take their key from `address_key_for`, so they always agree on which stored point a value belongs to. All of it
applies only to a source whose JSON config says `stable_addresses: true`; for every other source the key is the identity.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Callable, ItemsView, Iterable, Sequence, ValuesView
from dataclasses import dataclass
from urllib.parse import urlsplit

# `[ns=<digits>;]s=<digits>:<rest>`: <rest> has a dot, no whitespace at all, and does not itself start with `<digits>:`.
# Digits are ASCII only (`\d` would match other scripts' digits). Whole string (fullmatch): a leading or trailing space, a
# newline, upper case `NS=`/`S=`, `nsu=`, numeric/GUID/opaque ids and a string without the number or without a dot never match,
# and what does not match is returned unchanged. The `(?!...)` makes the function idempotent: its output never starts its
# `<rest>` with a digit-colon run, so it never matches again; it also leaves `s=1:2:A.B` alone (which number is "the" number?).
_NUMBERED = re.compile(r"((?:ns=[0-9]+;)?s=)[0-9]+:((?![0-9]+:)(?=\S*\.)\S+)")


def stable_address(address: str) -> str:
    """`address` without the position number in front of its tag; every other string comes back as it is."""
    found = _NUMBERED.fullmatch(address)
    return address if found is None else found[1] + found[2]


def has_number_prefix(address: str) -> bool:
    """True when `address` has the numbered form `stable_address` strips (the same regex, so `s=1:foo`, a digits-only id, a numeric
    or GUID id and anything else `stable_address` leaves alone are not numbered)."""
    return _NUMBERED.fullmatch(address) is not None


def tag_name(address: str) -> str:
    """The tag in a numbered address, without the number and the cluster: `ns=3;s=20403:Site.PDUA01_PM0_P` gives `PDUA01_PM0_P`.
    An address that is not numbered comes back whole."""
    found = _NUMBERED.fullmatch(address)
    if found is None:
        return address
    return found[2].partition(".")[2] or found[2]


# GUESSES, not facts (question 26 of the w34 brief asks the SCADA owners what their server announces): what AVEVA Plant SCADA's OPC
# UA server calls itself is unknown. The endpoint path `/plantscada` is what the owner's briefing showed; the words are what a
# product or application name would plausibly contain (Citect is the product's former name). A wrong guess costs one sentence in
# the Test result, nothing else: the suggestion never switches the option on.
_PLANT_SCADA_PATH = "plantscada"
_PLANT_SCADA_WORDS = ("plant scada", "plantscada", "citect")
_IDENTITY_KEYS = ("application_uri", "product_uri", "application_name")
_SAMPLE_LIMIT = 200
_NUMBERED_SHARE = (4, 5)  # at least 4 of every 5 sampled ids carry the number


def looks_like_plant_scada(identity: dict[str, object] | None, endpoint: str, sample_addresses: Sequence[str]) -> bool:
    """Whether a source looks like AVEVA Plant SCADA, so that Test may SUGGEST the option "Stable tag addresses".

    Both must hold. (a) The endpoint path contains `plantscada`, or the identity's application URI, product URI or application name
    contains `plant scada`, `plantscada` or `citect` (all case-insensitive; guesses, see above). (b) At least 80 percent of the first
    200 `sample_addresses` have the numbered form. The caller passes the source's stored STRING ids only, so that the ids of another
    kind (`i=`) on a mixed source do not dilute the share; the digits alone never count (`s=1:foo` is a normal id elsewhere).
    """
    try:
        path = urlsplit(endpoint).path.lower() if isinstance(endpoint, str) else ""
    except ValueError:
        path = ""
    named = _PLANT_SCADA_PATH in path
    if not named and isinstance(identity, dict):
        for key in _IDENTITY_KEYS:
            text = identity.get(key)
            if isinstance(text, str) and any(word in text.lower() for word in _PLANT_SCADA_WORDS):
                named = True
                break
    if not named:
        return False
    sample = list(sample_addresses)[:_SAMPLE_LIMIT]
    if not sample:
        return False
    numbered = sum(1 for address in sample if has_number_prefix(address))
    return numbered * _NUMBERED_SHARE[1] >= len(sample) * _NUMBERED_SHARE[0]


def identity_key(address: str) -> str:
    """The key function of a source that compares addresses as they are."""
    return address


def address_key_for(connector_type: str, config: object) -> Callable[[str], str]:
    """The function every matcher compares addresses through: `stable_address` for an OPC UA source whose config holds the real
    boolean True under `stable_addresses`, else `identity_key` (a string "true", 1, a missing key, a config that is not a dict)."""
    if connector_type == "opcua" and isinstance(config, dict) and config.get("stable_addresses") is True:
        return stable_address
    return identity_key


class AddressIndex[T]:
    """The stored addresses of a source (each with a value of the caller's choosing) looked up by the source's key function.

    `get(address)`: an EXACT stored match first (what a lookup did before keys existed), else the entry whose key is the key of
    `address`, but only when exactly one stored entry has that key. A key two or more stored entries share serves nobody by key
    and is listed by `ambiguous_keys()`: the caller decides what to do (a refused line, a skipped tag).
    """

    def __init__(self, pairs: Iterable[tuple[str, T]], key: Callable[[str], str]) -> None:
        self.key = key
        self._stored: dict[str, T] = dict(pairs)
        owners: dict[str, list[str]] = {}
        for stored in self._stored:
            owners.setdefault(key(stored), []).append(stored)
        self._owners = owners

    def get(self, address: str) -> T | None:
        if address in self._stored:
            return self._stored[address]
        owners = self._owners.get(self.key(address))
        return self._stored[owners[0]] if owners is not None and len(owners) == 1 else None

    def ambiguous_keys(self) -> set[str]:
        return {key for key, owners in self._owners.items() if len(owners) > 1}

    def items(self) -> ItemsView[str, T]:
        return self._stored.items()

    def values(self) -> ValuesView[T]:
        return self._stored.values()

    def __contains__(self, address: object) -> bool:
        return isinstance(address, str) and self.get(address) is not None


@dataclass(frozen=True)
class ReadPlan:
    sent: list[tuple[str, str]]  # (stored, stable) of what goes on the wire: the caller's order, identical stored strings once
    refused: dict[str, str]  # stored string -> why it is not read (its stable form belongs to another stored string too)


def read_plan(stored: Sequence[str], key: Callable[[str], str]) -> ReadPlan:
    """What one read request sends. Distinct stored strings that share a key are one tag under two names: none of them is read
    (never one value written to two points). The same stored string twice is one address, not a collision."""
    distinct = list(dict.fromkeys(stored))
    shared = Counter(key(address) for address in distinct)
    sent: list[tuple[str, str]] = []
    refused: dict[str, str] = {}
    for address in distinct:
        stable = key(address)
        if shared[stable] == 1:
            sent.append((address, stable))
        else:
            refused[address] = f"two points are the same tag (stable address {stable})"
    return ReadPlan(sent, refused)


def slice_size(server_limit: int | None, cap: int) -> int:
    """Nodes per Read request, the ONE rule the poll and the connection check share (w34 R9): the server's `MaxNodesPerRead` when
    it is a positive whole number, but never more than `cap`; a missing, zero (= no limit), negative or non-numeric limit gives `cap`."""
    if isinstance(server_limit, int) and not isinstance(server_limit, bool) and server_limit > 0:
        return min(server_limit, cap)
    return cap
