"""Does a source that stopped answering (O) have a newly found twin (C)? A pure decision: no I/O, no database, no logging.

A wrong match sends a meter's readings (and the bills built on them) to the wrong asset, so the rules lean towards "no":

* only OPC UA and the HTTP simulator can ever match (a Modbus device has no identity, and identical devices share register maps);
* a name is never evidence: nothing here reads `name`;
* two different identities, or two different certificates, never match; a default application URI is no identity at all;
* a URI that sources at OTHER endpoints also report is no identity either;
* a candidate must have appeared after O went silent (its earliest sighting, `found_at`), and a same-server claim without a
  certificate on both sides needs every pair O has mapped on a candidate that was browsed;
* a pairing must be unique in both directions, otherwise the person is told that several servers could be it.

The loaders (`moves/load.py`) build the inputs from the database; the offer's wording lives in the front end."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from dcdash.connectors.identity import thumbprints_conflict, usable_key

# The only connector types whose servers can say who they are. Everything else is never offered.
MOVABLE_TYPES = frozenset({"opcua", "simulator"})

_HEX = "0123456789abcdefABCDEF"


@dataclass(frozen=True)
class OldSource:
    """A mapped source that stopped answering."""
    id: int
    name: str
    connector_type: str
    host: str                       # lower-cased
    port: int
    path: str                       # "" for the simulator
    identity: Mapping[str, Any] | None
    mappings: int
    mapped_pairs: int               # distinct (address, point name) pairs mapped on it
    assets: int
    last_seen: datetime | None
    unreachable: bool               # the loader decided: offline AND (an open unreachable|timeout incident OR not seen)


@dataclass(frozen=True)
class NewSource:
    """A discovered source with nothing mapped."""
    id: int
    name: str
    connector_type: str
    host: str
    port: int
    path: str
    identity: Mapping[str, Any] | None
    points: int
    # When it APPEARED: its earliest sighting, the start (`scans.created_at`) of the first finished scan that found it; None = no
    # finished scan found it. A candidate must have turned up after O went silent, not merely been seen again after that.
    found_at: datetime | None
    mapped: int                     # mappings on it; a candidate has 0
    overlap: Mapping[int, int]      # old source id -> how many of that old source's mapped (address, name) pairs this one has


@dataclass(frozen=True)
class Match:
    kind: Literal["same_server", "possibly"]
    evidence: Literal["uri", "instance", "addresses"]
    value: str | None               # the URI or instance id for same_server, None for possibly
    addresses: int                  # how many of O's mapped pairs C has
    missing_addresses: int | None   # mapped pairs C lacks; None when C has no points (never browsed)
    needs_tick: bool                # the person must confirm before moving


@dataclass(frozen=True)
class Offer:
    old_id: int
    new_id: int
    match: Match


@dataclass(frozen=True)
class Two:
    count: int                      # how many servers could be this one (>= 2)


@dataclass(frozen=True)
class Decision:
    by_old: Mapping[int, Offer | Two]   # only the old sources that have something to say
    by_new: Mapping[int, Offer | Two]


@dataclass(frozen=True)
class Holder:
    """A source (whatever its status) whose stored identity has a given usable key."""
    id: int
    host: str                       # lower-cased
    port: int


def _plain(identity: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """A plain dict copy of a stored identity (`usable_key` only reads dicts); anything that is not a mapping is no identity."""
    return dict(identity) if isinstance(identity, Mapping) else None


def _thumbprint(identity: Mapping[str, Any] | None) -> str | None:
    """The stored certificate thumbprint, or None when there is none to compare: a value with no hex digit in it ("::", spaces,
    "unknown") is no certificate, so it can neither prove a server nor spare the tick (two equal junk values must not look like two
    equal certificates). A value with at least one hex digit stays a thumbprint and is compared as `thumbprints_conflict` does."""
    value = identity.get("thumbprint") if isinstance(identity, Mapping) else None
    return value if isinstance(value, str) and any(char in _HEX for char in value) else None


def _endpoint(host: str, port: int) -> tuple[str, int]:
    return (host.lower(), port)


def _eligible(old: OldSource) -> bool:
    return old.connector_type in MOVABLE_TYPES and old.unreachable and old.mappings >= 1


def _fits(old: OldSource, new: NewSource) -> bool:
    """The shape of a candidate, before any identity evidence."""
    return (
        new.connector_type == old.connector_type
        and new.port == old.port
        and new.path == old.path
        and new.id != old.id
        and new.mapped == 0
        and new.found_at is not None
        and (old.last_seen is None or new.found_at > old.last_seen)
    )


def _ambiguous(key: tuple[str, str], old: OldSource, new: NewSource, holders: Mapping[tuple[str, str], Sequence[Holder]]) -> bool:
    """Some third source, at an endpoint that is neither O's nor C's, reports the same server key: then the key is no identity."""
    ours = {_endpoint(old.host, old.port), _endpoint(new.host, new.port)}
    for holder in holders.get(key, ()):
        if holder.id in (old.id, new.id):
            continue
        if _endpoint(holder.host, holder.port) not in ours:
            return True
    return False


def _evaluate(old: OldSource, new: NewSource, holders: Mapping[tuple[str, str], Sequence[Holder]]) -> Match | None:
    """The evidence rule for one candidate pair, or None when the pair is not a match."""
    old_key = usable_key(old.connector_type, _plain(old.identity))
    new_key = usable_key(new.connector_type, _plain(new.identity))
    # (a) two usable identities that differ: two servers.
    if old_key is not None and new_key is not None and old_key != new_key:
        return None
    # (b) two certificates that differ: two servers, whatever else is equal.
    old_thumbprint, new_thumbprint = _thumbprint(old.identity), _thumbprint(new.identity)
    if thumbprints_conflict(old_thumbprint, new_thumbprint):
        return None
    addresses = new.overlap.get(old.id, 0)
    if old_key is not None:
        # (e) O knows its server and C does not say who it is: never.
        if new_key is None:
            return None
        # (c) equal usable keys: the same server, unless the key is not unique to this pair.
        if _ambiguous(old_key, old, new, holders):
            return None
        kind, value = old_key
        evidence: Literal["uri", "instance"] = "uri" if kind == "uri" else "instance"
        missing = None if new.points == 0 else max(0, old.mapped_pairs - addresses)
        needs_tick = not (old_thumbprint and new_thumbprint)
        # Without a certificate on both sides an equal URI or instance id is only a claim (a product line shares one URI, a
        # simulator left at its default shares its id). A C that was browsed and lacks any pair O has mapped is then another
        # server, and moving would leave those mappings dead: no offer. Equal certificates prove the server, so a few missing
        # pairs stay a warning; a C never browsed (`missing is None`) cannot be judged and stays allowed.
        if needs_tick and missing:
            return None
        return Match(
            kind="same_server", evidence=evidence, value=value, addresses=addresses, missing_addresses=missing, needs_tick=needs_tick,
        )
    # (d) O has no usable key: only "possibly", and only when C has every (address, name) pair O has mapped.
    if new.points >= 1 and old.mapped_pairs >= 1 and addresses == old.mapped_pairs:
        return Match(kind="possibly", evidence="addresses", value=None, addresses=addresses, missing_addresses=0, needs_tick=True)
    return None


def decide(olds: Sequence[OldSource], news: Sequence[NewSource], holders: Mapping[tuple[str, str], Sequence[Holder]]) -> Decision:
    """Pair old sources with new ones. An Offer exists only when the pairing is unique in both directions."""
    cands_of_old: dict[int, list[tuple[int, Match]]] = {}
    olds_of_new: dict[int, list[int]] = {}
    for old in sorted(olds, key=lambda o: o.id):
        if not _eligible(old):
            continue
        found: list[tuple[int, Match]] = []
        for new in sorted(news, key=lambda n: n.id):
            if not _fits(old, new):
                continue
            match = _evaluate(old, new, holders)
            if match is not None:
                found.append((new.id, match))
        if found:
            cands_of_old[old.id] = found
            for new_id, _ in found:
                olds_of_new.setdefault(new_id, []).append(old.id)

    by_old: dict[int, Offer | Two] = {}
    by_new: dict[int, Offer | Two] = {}
    for old_id, found in cands_of_old.items():
        if len(found) == 1 and len(olds_of_new[found[0][0]]) == 1:
            new_id, match = found[0]
            offer = Offer(old_id=old_id, new_id=new_id, match=match)
            by_old[old_id] = offer
            by_new[new_id] = offer
        else:
            # several candidates, or one that other old sources want too: how many servers could be this one
            by_old[old_id] = Two(count=max(len(found), max(len(olds_of_new[new_id]) for new_id, _ in found)))
    for new_id, old_ids in olds_of_new.items():
        if new_id in by_new:
            continue
        if len(old_ids) >= 2:
            by_new[new_id] = Two(count=len(old_ids))
        else:
            by_new[new_id] = Two(count=len(cands_of_old[old_ids[0]]))       # its only old source has several candidates
    return Decision(by_old=by_old, by_new=by_new)
