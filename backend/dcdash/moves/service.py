"""Move a source that stopped answering to the address where its server turned up (w33 R5, R6, P7-P9, F-rulings).

One function, `move_source(db, source_id, body, real=...)`, serves the preview (`real=False`) and the action (`real=True`), so the
preview cannot drift from what the action does. Everything up to the first write is the same code; only the real run takes locks and
writes.

The old source O keeps its id, points, mappings and readings. The new source C (the scan's duplicate: a discovered source at the new
address that nothing is mapped to) is deleted, and O's address is rewritten: ONLY the host and port inside `config["endpoint"]` (OPC UA)
or `config["url"]` (simulator); every other key of the config, the secret, the user info, the path and the security settings stay as
they are. O also takes C's identity, the scan findings that pointed at C now point at O, and a default name follows the address.

The real run, in this order, and why:
1. `pg_advisory_xact_lock(SCAN_START_LOCK)` and the scan refusal, as the remove route does it: no scan starts or finishes under us.
2. `_lock_source` of the lower id, then of the higher id (the same order as every other route that locks two sources).
3. Both rows are read AFTER the locks, and the offer is decided again on what the server holds now. The client's numbers only decide
   whether to go on (`expect`: the numbers and addresses, and why it was offered, `match_kind` and `needs_tick`); what is written is
   always the server's own computation. A match that asks for a tick is moved only when the body says `ticked`, whatever the client
   believed it showed; a new source where ANOTHER server answers now (`identity.different`) is refused, for the preview and the click.
4. Findings re-pointed, graph positions removed, C deleted and the delete flushed, THEN O's name is computed and O is changed (the
   unit of work would otherwise write O's new name before C's row is gone and hit the unique name).
The preview takes no lock at all (a big server has thousands of points) and, while a scan is queued or running, says so instead of
refusing. It never changes an attribute of a loaded row, so nothing is flushed.

Nothing here writes an endpoint with its user info: answers and the audit detail carry host, port and `display_endpoint` only.

`undo_move` (further down) takes a move back from the audit row that recorded it; it is the move's mirror and takes the same locks in the
same order (the scan lock, then the source and its points).
"""
import copy
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import Text, cast, delete, func, literal, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import notify
from dcdash.api.scans import SCAN_START_LOCK
from dcdash.api.sources import _lock_source, _mapped_counts, validated_config
from dcdash.core.models import GraphLayout, Point, Scan, ScanFinding, Source
from dcdash.core.pg import CONFIG_CHANNEL
from dcdash.moves.load import load_offers_detailed
from dcdash.moves.match import MOVABLE_TYPES, Offer, Two, another_server_answers
from dcdash.moves.urls import (
    URL_KEYS, CannotRewrite, address_key, authority_of, display_endpoint, is_default_name, label_for, put_authority, swap_host_port,
    unique_name,
)

INT32_MAX = 2_147_483_647  # ids are 32-bit integers: a larger one in a query would come back from the driver as a 500, not a 422
UNDO_HOURS = 24
MAX_FINDING_IDS = 200  # how many re-pointed findings the audit row remembers (the newest), for the Undo

SCAN_RUNNING = "A scan is running. Move the source when it has finished."
ALREADY_MOVED = "this source was already moved"
NOT_OFFLINE = "This source is not offline any more, so there is nothing to move. Nothing was changed."
NO_LONGER_UNIQUE = "The new source is no longer the one match for this source. Nothing was changed; look at Sources again."
DIFFERENT_SERVER = "A different server answers at the new address now; scan again before moving"
NEEDS_TICK = "The match needs your confirmation: tick the box that says you checked this is the same device or server."
TWO_SERVERS = "Two servers could be this one; edit the address by hand"
GOT_A_MAPPING = "The new source got a mapping since you looked. Nothing was moved."
HOLDS_READINGS = "The new source holds readings, so it is not the scan's copy that nothing uses. Nothing was moved."
NO_NAME = "no name is known for that address"
NOT_MOVABLE = (
    "Only OPC UA servers and DCDash simulators can be moved. A Modbus device has nothing a scan can check, "
    "so edit its address by hand."
)
CANNOT_WRITE = "the new address could not be written into this source; edit its address by hand"

# The Undo's refusals (each is a rolled-back 409 and says the first thing that is in the way).
UNDO_SCAN_RUNNING = "A scan is running. Undo the move when it has finished."
ALREADY_UNDONE = "this move was already undone"
DELETED_SINCE = "the source was deleted after the move"
ADDRESS_CHANGED = "the source's address was changed after the move; edit it by hand"
NAME_CHANGED = "the source's name was changed after the move; edit it by hand"
NOT_UNDOABLE = "this audit row does not hold what an undo needs"
CANNOT_PUT_BACK = "the old address could not be written back into this source; edit its address by hand"

_KIND_WORDS = {"same_server": "the same server", "possibly": "possibly the same device"}
_HOST_NAME = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?")


class MoveExpect(BaseModel):
    """What the person was shown by the preview. `name_after` is required but may be null (the name stays). `match_kind` and
    `needs_tick` (why the move was offered, and whether it asked for a tick) are optional so that an older client still works; when
    they are sent they are compared like the rest."""
    mappings: int = Field(ge=0, le=INT32_MAX)
    address_before: str = Field(max_length=300)  # "host:port", unbracketed, as the preview showed it
    address_after: str = Field(max_length=300)
    name_after: str | None = Field(max_length=300)
    match_kind: Literal["same_server", "possibly"] | None = None
    needs_tick: bool | None = None


class SourceMoveIn(BaseModel):
    to: int = Field(ge=1, le=INT32_MAX)
    address: Literal["as_found", "name"]
    expect: MoveExpect | None = None
    ticked: bool = False  # the person ticked "I checked it is the same device"; the real run needs it whenever the match asks for it


# ---- small pure helpers ----------------------------------------------------------------------------------------------------------


def hint_name(identity: Any, host: str) -> str | None:
    """The Docker name a scan stored for `host` (`identity.name_hint` = `{"name", "host"}`), only while the hint is for this very host
    and the name is a plain host name; lower-cased. None otherwise."""
    hint = identity.get("name_hint") if isinstance(identity, Mapping) else None
    if not isinstance(hint, Mapping):
        return None
    name, where = hint.get("name"), hint.get("host")
    if not isinstance(name, str) or not isinstance(where, str) or where.strip().lower() != host.lower():
        return None
    name = name.strip()
    return name.lower() if _HOST_NAME.fullmatch(name) else None


def moved_identity(identity: Any, host: str) -> dict[str, Any] | None:
    """The identity O takes: a copy of C's without its `different` note, with its `name_hint` kept only while the hint is for the host
    O will point at."""
    if not isinstance(identity, Mapping):
        return None
    kept = copy.deepcopy(dict(identity))
    kept.pop("different", None)  # who answered at C's address is no part of what O is; O has no stranger to carry
    hint = kept.get("name_hint")
    if hint is not None and not (isinstance(hint, Mapping) and str(hint.get("host", "")).strip().lower() == host.lower()):
        kept.pop("name_hint")
    return kept or None


def _match_for_audit(match: Any) -> dict[str, Any]:
    return {
        "kind": match.kind, "evidence": match.evidence, "value": match.value,
        "addresses": match.addresses, "missing_addresses": match.missing_addresses,
    }


def _plain_address(host: str, port: int) -> str:
    """`host:port` as the front end builds it: the host unbracketed, also for IPv6."""
    return f"{host}:{port}"


# ---- reads -----------------------------------------------------------------------------------------------------------------------


async def _fresh(db: AsyncSession, source_id: int) -> Source | None:
    """The row as the database holds it now (never the session's older copy)."""
    return await db.scalar(select(Source).where(Source.id == source_id).execution_options(populate_existing=True))


async def _was_already_moved(db: AsyncSession, old: Source, new_id: int) -> bool:
    """A source.moved row says `old` was moved onto the (now deleted) source `new_id`, and `old` still sits at the address it moved to."""
    row = (
        await db.execute(
            text(
                "SELECT detail->>'host_after' AS host, detail->>'port_after' AS port FROM audit_log "
                "WHERE action = 'source.moved' AND detail->>'source_id' = CAST(:old AS text) "
                "AND detail->'removed'->>'source_id' = CAST(:new AS text) ORDER BY id DESC LIMIT 1"
            ),
            {"old": str(old.id), "new": str(new_id)},
        )
    ).first()
    where = address_key(old.connector_type, old.config)
    return row is not None and where is not None and (str(row.host).lower(), str(row.port)) == (where[0], str(where[1]))


async def _holds_readings(db: AsyncSession, source_id: int) -> bool:
    """True when any point of the source has a latest value or a stored reading: a discovered unmapped source is never polled, so this
    says something else has been writing to it."""
    return bool(
        await db.scalar(
            text(
                "SELECT EXISTS (SELECT 1 FROM point_latest pl JOIN points p ON p.id = pl.point_id WHERE p.source_id = :id) "
                "OR EXISTS (SELECT 1 FROM readings r WHERE r.point_id IN (SELECT id FROM points WHERE source_id = :id))"
            ),
            {"id": source_id},
        )
    )


async def _rename(
    db: AsyncSession, old: Source, old_where: tuple[str, int, str], host: str, port: int, new_id: int
) -> dict[str, str] | None:
    """`{from, to}` when O's name is the scan's default name for its old address (with or without " (n)"): the default name for the
    new address, the first free one, counted without O itself and without C (which is gone by the time this is written). Any other
    name was typed by a person and stays."""
    if not is_default_name(old.name, old.connector_type, old_where[0], old_where[1]):
        return None
    label = label_for(old.connector_type, host, port)
    assert label is not None  # a default name exists only for a type that has a label
    taken = set(
        await db.scalars(
            select(Source.name).where(Source.id.notin_((old.id, new_id)), Source.name.startswith(label, autoescape=True))
        )
    )
    wanted = unique_name(label, taken)
    return None if wanted == old.name else {"from": old.name, "to": wanted}


# ---- the move --------------------------------------------------------------------------------------------------------------------


async def move_source(
    db: AsyncSession, source_id: int, body: SourceMoveIn, *, real: bool
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """The preview (`real=False`: `(answer, None)`) or the move (`real=True`: `(answer, audit detail)`; the caller audits and commits).

    A refusal is an `HTTPException`; the real run's caller rolls back (`api/moves.py`). `audit_id` of the answer is the caller's to fill.
    """
    if body.to == source_id:
        raise HTTPException(422, "a source cannot be moved onto itself")
    expect = body.expect
    if real and expect is None:
        raise HTTPException(422, "expect is required: send the numbers and addresses the preview showed")

    # 1. a scan
    if real:
        await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": SCAN_START_LOCK})
    scan_running = bool(await db.scalar(select(func.count()).select_from(Scan).where(Scan.status.in_(("queued", "running")))))
    if real and scan_running:
        raise HTTPException(409, SCAN_RUNNING)

    # 2. locks, lower id first (a source that is gone locks nothing; the reads below find that out)
    if real:
        for locked in sorted((source_id, body.to)):
            await _lock_source(db, locked)

    # 3. both rows, as they are now
    old = await _fresh(db, source_id)
    if old is None:
        raise HTTPException(404, "source not found")
    new = await _fresh(db, body.to)
    if new is None:
        if await _was_already_moved(db, old, body.to):
            raise HTTPException(409, ALREADY_MOVED)
        raise HTTPException(404, "the new source was not found; a scan or a removal may have taken it away")

    # 4. what it is
    if old.connector_type not in MOVABLE_TYPES or old.connector_type not in URL_KEYS:
        raise HTTPException(422, NOT_MOVABLE)
    if new.connector_type != old.connector_type or new.origin != "discovered":
        raise HTTPException(422, "the new source must be a source a scan found, of the same kind as this one")
    old_where = address_key(old.connector_type, old.config)
    new_where = address_key(new.connector_type, new.config)
    if old_where is None or new_where is None:
        raise HTTPException(422, "the address of one of the two sources cannot be read; edit it by hand")

    # 5. the new source must be the scan's untouched copy
    new_points_mapped, new_mappings = await _mapped_counts(db, new.id)
    if new_points_mapped or new_mappings:
        raise HTTPException(409, GOT_A_MAPPING)
    if await _holds_readings(db, new.id):
        raise HTTPException(409, HOLDS_READINGS)
    if old.status != "offline":
        raise HTTPException(409, NOT_OFFLINE)
    if another_server_answers(new.identity):  # the matcher skips it too; said in words here, for the preview and the click alike
        raise HTTPException(409, DIFFERENT_SERVER)

    # 6. the offer, decided again on what the server holds now
    loaded = await load_offers_detailed(db, old_ids=[old.id])
    said = loaded.decision.by_old.get(old.id)
    if isinstance(said, Two):
        raise HTTPException(409, TWO_SERVERS)
    if not isinstance(said, Offer) or said.new_id != new.id:
        raise HTTPException(409, NO_LONGER_UNIQUE)
    match = said.match
    assets = loaded.olds[old.id].assets

    # 7. where it goes
    found_host, port = new_where[0], new_where[1]
    name_hint = hint_name(new.identity, found_host)
    if body.address == "name":
        if name_hint is None:
            raise HTTPException(422, NO_NAME)
        to_host = name_hint
    else:
        to_host = found_host
    if (old_where[0], old_where[1]) == (to_host, port):
        raise HTTPException(409, "This source already points at that address. Nothing was changed.")
    key = URL_KEYS[old.connector_type]
    authority_before = authority_of(old.config.get(key))  # host[:port] exactly as stored, for the Undo (no user info in it)
    try:
        swapped = swap_host_port(old.config[key], to_host, port)
    except CannotRewrite as error:
        raise HTTPException(422, str(error)) from None
    except (KeyError, TypeError):
        raise HTTPException(422, CANNOT_WRITE) from None
    candidate = copy.deepcopy(old.config)
    candidate[key] = swapped
    checked = validated_config(old.connector_type, candidate)  # 422 when the connector will not take it; it echoes no input
    new_config = copy.deepcopy(old.config)  # every other key stays exactly as it is: only the address text is taken from `checked`
    new_config[key] = checked[key]
    written = address_key(old.connector_type, new_config)
    if written is None or written != (to_host, port, old_where[2]):
        raise HTTPException(422, CANNOT_WRITE)  # F-M4: what is stored must read back as the address that was asked for

    # 8. what the person sees, and what they are told it will be
    mapped_points, mappings = await _mapped_counts(db, old.id)
    points = await db.scalar(select(func.count()).select_from(Point).where(Point.source_id == new.id)) or 0
    rename = await _rename(db, old, old_where, to_host, port, new.id)
    address_before, address_after = _plain_address(old_where[0], old_where[1]), _plain_address(to_host, port)
    name_after = None if rename is None else rename["to"]
    from_ = {"host": old_where[0], "port": old_where[1], "endpoint": display_endpoint(old.connector_type, old.config)}
    to = {"host": to_host, "port": port, "endpoint": display_endpoint(old.connector_type, new_config)}
    shown_match = {**_match_for_audit(match), "needs_tick": match.needs_tick}

    if not real:
        return {
            "dry_run": True, "scan_running": scan_running,
            "source": {"id": old.id, "name": old.name}, "target": {"id": new.id, "name": new.name, "points": points},
            "from": from_, "to": to, "address": body.address, "name_hint": name_hint, "rename": rename,
            "match": shown_match, "mappings": mappings, "mapped_points": mapped_points, "assets": assets,
            "needs_tick": match.needs_tick,
        }, None

    # 9. the person's numbers against ours (the first difference is named)
    assert expect is not None  # checked at the top
    differences = [
        (expect.mappings, mappings, f"it has {mappings} mappings now, not {expect.mappings}"),
        (expect.address_before, address_before, f"it points at {address_before} now, not {expect.address_before}"),
        (expect.address_after, address_after, f"the new server is at {address_after} now, not {expect.address_after}"),
        (expect.name_after, name_after, f"its new name would be {_said(name_after)} now, not {_said(expect.name_after)}"),
    ]
    if expect.match_kind is not None:  # why it was offered: a change here is a different move from the one the person looked at
        differences.append((
            expect.match_kind, match.kind, f"it is offered as {_KIND_WORDS[match.kind]} now, not {_KIND_WORDS[expect.match_kind]}",
        ))
    if expect.needs_tick is not None:
        differences.append((
            expect.needs_tick, match.needs_tick,
            "it needs your confirmation now" if match.needs_tick else "it no longer needs your confirmation",
        ))
    for shown, now, sentence in differences:
        if shown != now:
            raise HTTPException(409, f"changed since the preview: {sentence}; look at it again")
    # The tick is enforced here, on the server's own decision, whatever the client believed it showed (and for a client that sent no
    # `needs_tick` at all): an uncertain match is moved only for a person who said they checked it.
    if match.needs_tick and not body.ticked:
        raise HTTPException(409, NEEDS_TICK)

    # 10. writes. Findings first (they would be set to nothing by the delete), then the graph positions, then C, flushed.
    finding_ids = sorted(
        await db.scalars(
            update(ScanFinding)
            .where(ScanFinding.source_id == new.id)
            .values(source_id=old.id)
            .returning(ScanFinding.id)
            .execution_options(synchronize_session=False)
        )
    )
    point_keys = select(literal("point:") + cast(Point.id, Text)).where(Point.source_id == new.id)
    await db.execute(
        delete(GraphLayout).where(
            or_(
                GraphLayout.node_id == f"src:{new.id}",
                GraphLayout.node_id.in_(point_keys),
                GraphLayout.node_id.startswith(f"cluster:{new.id}:", autoescape=True),
            )
        )
    )
    removed = {"source_id": new.id, "name": new.name, "points": points}
    new_id, new_identity = new.id, moved_identity(new.identity, to_host)
    await db.delete(new)
    await db.flush()

    # 11. O. Computed again now that C is gone; it cannot differ from what the person was shown, and if it does they look again.
    final = await _rename(db, old, old_where, to_host, port, new_id)
    if (None if final is None else final["to"]) != name_after:
        raise HTTPException(409, "changed since the preview: the name it would get is not free any more; look at it again")
    name_before, identity_before = old.name, copy.deepcopy(old.identity)
    last_seen_before = None if old.last_seen is None else old.last_seen.isoformat()
    old.config = new_config
    old.identity = new_identity
    old.last_error = None  # an error from the old address must not sit beside the new name until the first poll; `status` is left as it is
    if final is not None:
        old.name = final["to"]
    await db.flush()  # a name someone else took in the meantime is an IntegrityError here, inside the caller's try-again block
    await notify(db, CONFIG_CHANNEL)  # the collector polls the new address at once
    # now() is the start of this transaction, which is the audit row's `ts`: the same 24 hours the Undo checks.
    undo_until = (await db.scalar(text(f"SELECT now() + interval '{UNDO_HOURS} hours'"))).isoformat()

    detail = {
        "source_id": old.id, "name_before": name_before, "name_after": old.name,
        "host_before": old_where[0], "port_before": old_where[1], "host_after": to_host, "port_after": port,
        # the host[:port] text exactly as stored (no user info in it): the Undo writes `authority_before` back byte for byte
        "authority_before": authority_before, "authority_after": authority_of(new_config[key]),
        "address": body.address, "identity_before": identity_before, "identity_after": copy.deepcopy(new_identity),
        "match": _match_for_audit(match), "mappings": mappings, "removed": removed,
        "finding_ids": finding_ids[-MAX_FINDING_IDS:],
        # O's last answer from the old address, as read under the lock (null: it never answered). Nothing of O can be newer than this
        # from there, so the Undo counts the readings after it as the ones taken at the new address (T5b-M1).
        "last_seen_before": last_seen_before,
    }
    response = {
        "dry_run": False, "audit_id": None, "source": {"id": old.id, "name": old.name}, "from": from_, "to": to,
        "rename": rename, "undo_until": undo_until,
    }
    return response, detail


def _said(value: Any) -> str:
    """A value of `expect` or of the server, in words for the refusal: numbers and addresses as they are, no new name as "the same"."""
    return "the same name" if value is None else str(value)


# ---- the Undo (w33 R5, P9, F8, F9, F10, F13, F-M4) ---------------------------------------------------------------------------------
#
# Takes back what ONE `source.moved` audit row says the move changed, inside the current state of the source: the host and port in
# its CURRENT config (every other key, the user info, the path and the secret stay as they are now), its identity, its name, and the
# scan findings the move re-pointed. It does not recreate the removed duplicate (the next scan finds it again) and it does not undo
# readings: it counts the ones taken since the old address last answered (the move's time when that is not recorded) and says they stay.
# It refuses, saying the first thing that is in the way, when the source is not as the move left it (or another source holds the old
# address now). The order of the locks is the move's: the scan lock, then the source (its row, then its points).

_ALREADY_UNDONE = text(
    "SELECT 1 FROM audit_log WHERE action = 'source.move_undone' AND id > :id AND detail->>'audit_id' = CAST(:id AS text) LIMIT 1"
)
_MAPPED_POINTS = text(
    "SELECT DISTINCT m.point_id FROM mappings m JOIN points p ON p.id = m.point_id WHERE p.source_id = :id"
)
# The readings of those points taken at the new address. With the old source's last answer on record (T5b-M1): everything newer than it,
# which includes what the history backfill wrote for the outage window after the move (its times lie before the move). Without it (a
# move recorded before it was kept, or a source that never answered): everything from the moment of the move on.
_READINGS_AFTER_LAST_ANSWER = text("SELECT count(*) FROM readings WHERE point_id = ANY(CAST(:ids AS int[])) AND ts > :since")
_READINGS_SINCE_MOVE = text("SELECT count(*) FROM readings WHERE point_id = ANY(CAST(:ids AS int[])) AND ts >= :since")


@dataclass(frozen=True)
class Recorded:
    """What a `source.moved` audit row says: where the source was and is, and what the move re-pointed."""

    source_id: int
    name_before: str
    name_after: str
    host_before: str
    port_before: int
    host_after: str
    port_after: int
    identity_before: dict[str, Any] | None
    finding_ids: tuple[int, ...]
    authority_before: str | None = None  # the host[:port] text as it was stored; a row written before the move recorded it has none
    last_seen_before: datetime | None = None  # the old source's last answer; None for a row that predates it or a source that never answered


def _whole(value: Any) -> bool:
    return type(value) is int and 0 < value <= INT32_MAX


def recorded_move(detail: Any) -> Recorded:
    """The audit row's detail as plain values, or a 409 `this audit row does not hold what an undo needs` for a row that lacks a key
    or holds one of the wrong kind (the move writes every one of them; this is a row nobody should have edited)."""
    try:
        last_seen_before = detail.get("last_seen_before")
        if isinstance(last_seen_before, str):
            last_seen_before = datetime.fromisoformat(last_seen_before)
        found = Recorded(
            source_id=detail["source_id"], name_before=detail["name_before"], name_after=detail["name_after"],
            host_before=detail["host_before"], port_before=detail["port_before"], host_after=detail["host_after"],
            port_after=detail["port_after"], identity_before=detail["identity_before"], finding_ids=tuple(detail["finding_ids"]),
            authority_before=detail.get("authority_before"), last_seen_before=last_seen_before,
        )
    except (AttributeError, KeyError, TypeError, ValueError):
        raise HTTPException(409, NOT_UNDOABLE) from None
    valid = (
        _whole(found.source_id) and _whole(found.port_before) and found.port_before <= 65535
        and _whole(found.port_after) and found.port_after <= 65535
        and all(isinstance(value, str) and value for value in (found.name_before, found.name_after, found.host_before, found.host_after))
        and (found.identity_before is None or isinstance(found.identity_before, dict))
        and (found.authority_before is None or (isinstance(found.authority_before, str) and found.authority_before != ""))
        and (found.last_seen_before is None or (isinstance(found.last_seen_before, datetime) and found.last_seen_before.tzinfo is not None))
        and isinstance(detail["finding_ids"], list) and all(_whole(i) for i in found.finding_ids)
    )
    if not valid:
        raise HTTPException(409, NOT_UNDOABLE)
    return found


def host_of_authority(authority: str) -> str:
    """The host of a stored `host[:port]` (`authority_of`) as it is written: its letter case kept, the port and the brackets of an IPv6
    host left out."""
    if authority.startswith("["):
        end = authority.find("]")
        return authority[1:end] if end > 0 else authority
    host, colon, port = authority.rpartition(":")
    return host if colon and port.isdigit() else authority


def _host_port(host: str, port: int) -> str:
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


def undo_sentence(host: str, port: int, readings: int) -> str:
    """`Moved back to 172.20.0.3:4840.` and, when readings were taken since the old address last answered, that they stay."""
    stay = ""
    if readings == 1:
        stay = " 1 reading taken since the last answer from the old address stays."
    elif readings:
        stay = f" {readings:,} readings taken since the last answer from the old address stay."
    return f"Moved back to {_host_port(host, port)}.{stay}"


def _quoted(name: str) -> str:
    return '"' + "".join(char if char.isprintable() else "?" for char in name)[:80] + '"'


async def _name_taken(db: AsyncSession, name: str, source_id: int) -> bool:
    """Another source (discovered ones nobody mapped included: the name is unique across all) already has this name."""
    return await db.scalar(select(Source.id).where(Source.name == name, Source.id != source_id).limit(1)) is not None


async def undo_move(db: AsyncSession, audit_id: int, detail: Any, moved_at: datetime) -> tuple[dict[str, Any], dict[str, Any]]:
    """Take back the move of the `source.moved` audit row `audit_id` (its `detail` and time `moved_at`). Returns `(answer, audit detail
    of the Undo)`; the caller audits and commits, inside a rolled-back-409 block (api/moves.py). A refusal is an `HTTPException`."""
    rec = recorded_move(detail)

    # 1. a scan (the move's own first step: no scan starts or finishes under us)
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": SCAN_START_LOCK})
    if await db.scalar(select(func.count()).select_from(Scan).where(Scan.status.in_(("queued", "running")))):
        raise HTTPException(409, UNDO_SCAN_RUNNING)

    # 2. the source and its points, then the row as the database holds it now (a PATCH that committed while this waited counts)
    if not await _lock_source(db, rec.source_id):
        raise HTTPException(409, DELETED_SINCE)
    if (await db.execute(_ALREADY_UNDONE, {"id": audit_id})).first() is not None:
        raise HTTPException(409, ALREADY_UNDONE)
    old = await _fresh(db, rec.source_id)
    if old is None:  # cannot happen under the lock
        raise HTTPException(409, DELETED_SINCE)

    # 3. is it as the move left it? The address first, then the name; the host compared without regard to case (F-M4).
    where = address_key(old.connector_type, old.config)
    if where is None or (where[0], where[1]) != (rec.host_after.lower(), rec.port_after):
        raise HTTPException(409, ADDRESS_CHANGED)
    restored_host = rec.host_before if rec.authority_before is None else host_of_authority(rec.authority_before)  # the text it had (T5b-M6)
    # Another source at the address being restored (a scan after the move can have found another server there): the Undo would leave
    # two sources on one address, the old one reading a stranger. Said before the name checks, which a default name would trip first (T5b-M2).
    for other in await db.execute(
        select(Source.name, Source.config).where(Source.connector_type == old.connector_type, Source.id != old.id).order_by(Source.id)
    ):
        if address_key(old.connector_type, other.config) == (rec.host_before.lower(), rec.port_before, where[2]):
            raise HTTPException(
                409,
                f"Another source ({_quoted(other.name)}) is at {_host_port(restored_host, rec.port_before)} now; "
                "look at Discovery first and decide which one keeps it.",
            )
    if old.name != rec.name_after:
        raise HTTPException(409, NAME_CHANGED)
    if rec.name_before != old.name and await _name_taken(db, rec.name_before, old.id):
        raise HTTPException(409, f"the old name {_quoted(rec.name_before)} is taken now; rename that source first")

    # 4. the address back, inside the current config: only the host and port change, as in the move (F10, F-M4)
    key = URL_KEYS.get(old.connector_type)
    if key is None:
        raise HTTPException(409, ADDRESS_CHANGED)
    try:
        if rec.authority_before is not None:  # the text exactly as it was stored (case, a missing port): byte for byte
            swapped = put_authority(old.config[key], rec.authority_before)
        else:
            swapped = swap_host_port(old.config[key], rec.host_before, rec.port_before)
    except (CannotRewrite, KeyError, TypeError):
        raise HTTPException(409, CANNOT_PUT_BACK) from None
    candidate = copy.deepcopy(old.config)
    candidate[key] = swapped
    checked = validated_config(old.connector_type, candidate)  # 422 when the connector will not take it; it echoes no input
    new_config = copy.deepcopy(old.config)
    new_config[key] = checked[key]
    written = address_key(old.connector_type, new_config)
    if written is None or written != (rec.host_before.lower(), rec.port_before, where[2]):
        raise HTTPException(409, CANNOT_PUT_BACK)

    # 5. the readings taken at the new address since the move: they stay (F13)
    point_ids = list(await db.scalars(_MAPPED_POINTS, {"id": old.id}))
    readings = 0
    if point_ids and rec.last_seen_before is not None:
        readings = int(await db.scalar(_READINGS_AFTER_LAST_ANSWER, {"ids": point_ids, "since": rec.last_seen_before}) or 0)
    elif point_ids:
        readings = int(await db.scalar(_READINGS_SINCE_MOVE, {"ids": point_ids, "since": moved_at}) or 0)

    # 6. writes
    if rec.finding_ids:
        await db.execute(
            update(ScanFinding)
            .where(ScanFinding.id.in_(rec.finding_ids), ScanFinding.source_id == old.id)
            .values(source_id=None)
            .execution_options(synchronize_session=False)
        )
    name_moved = old.name
    old.config = new_config
    old.identity = rec.identity_before
    old.name = rec.name_before
    await db.flush()  # a name someone took in the meantime is an IntegrityError here, inside the caller's try-again block
    await notify(db, CONFIG_CHANNEL)  # the collector polls the old address at once

    # The `_before` side is the source as this Undo found it (the moved state), the `_after` side what it put back.
    undone = {
        "audit_id": audit_id, "source_id": old.id, "name_before": name_moved, "name_after": old.name,
        "host_before": rec.host_after, "port_before": rec.port_after, "host_after": rec.host_before, "port_after": rec.port_before,
        "readings_since_move": readings,
    }
    response = {
        "source": {"id": old.id, "name": old.name},
        "restored": {"host": restored_host, "port": rec.port_before, "name": old.name},
        "readings_since_move": readings,
        "text": undo_sentence(restored_host, rec.port_before, readings),
    }
    return response, undone
