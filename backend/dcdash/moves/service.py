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
   whether to go on (`expect`); what is written is always the server's own computation.
4. Findings re-pointed, graph positions removed, C deleted and the delete flushed, THEN O's name is computed and O is changed (the
   unit of work would otherwise write O's new name before C's row is gone and hit the unique name).
The preview takes no lock at all (a big server has thousands of points) and, while a scan is queued or running, says so instead of
refusing. It never changes an attribute of a loaded row, so nothing is flushed.

Nothing here writes an endpoint with its user info: answers and the audit detail carry host, port and `display_endpoint` only.
"""
import copy
import re
from collections.abc import Mapping
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
from dcdash.moves.match import MOVABLE_TYPES, Offer, Two
from dcdash.moves.urls import (
    URL_KEYS, CannotRewrite, address_key, display_endpoint, is_default_name, label_for, swap_host_port, unique_name,
)

INT32_MAX = 2_147_483_647  # ids are 32-bit integers: a larger one in a query would come back from the driver as a 500, not a 422
UNDO_HOURS = 24
MAX_FINDING_IDS = 200  # how many re-pointed findings the audit row remembers (the newest), for the Undo

SCAN_RUNNING = "A scan is running. Move the source when it has finished."
ALREADY_MOVED = "this source was already moved"
NOT_OFFLINE = "This source is not offline any more, so there is nothing to move. Nothing was changed."
NO_LONGER_UNIQUE = "The new source is no longer the one match for this source. Nothing was changed; look at Sources again."
TWO_SERVERS = "Two servers could be this one; edit the address by hand"
GOT_A_MAPPING = "The new source got a mapping since you looked. Nothing was moved."
HOLDS_READINGS = "The new source holds readings, so it is not the scan's copy that nothing uses. Nothing was moved."
NO_NAME = "no name is known for that address"
NOT_MOVABLE = (
    "Only OPC UA servers and DCDash simulators can be moved. A Modbus device has nothing a scan can check, "
    "so edit its address by hand."
)
CANNOT_WRITE = "the new address could not be written into this source; edit its address by hand"

_HOST_NAME = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?")


class MoveExpect(BaseModel):
    """What the person was shown by the preview. `name_after` is required but may be null (the name stays)."""
    mappings: int = Field(ge=0, le=INT32_MAX)
    address_before: str = Field(max_length=300)  # "host:port", unbracketed, as the preview showed it
    address_after: str = Field(max_length=300)
    name_after: str | None = Field(max_length=300)


class SourceMoveIn(BaseModel):
    to: int = Field(ge=1, le=INT32_MAX)
    address: Literal["as_found", "name"]
    expect: MoveExpect | None = None


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
    """The identity O takes: a copy of C's, with its `name_hint` kept only while the hint is for the host O will point at."""
    if not isinstance(identity, Mapping):
        return None
    kept = copy.deepcopy(dict(identity))
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
    for template, shown, now in (
        ("it has {now} mappings now, not {shown}", expect.mappings, mappings),
        ("it points at {now} now, not {shown}", expect.address_before, address_before),
        ("the new server is at {now} now, not {shown}", expect.address_after, address_after),
        ("its new name would be {now} now, not {shown}", expect.name_after, name_after),
    ):
        if shown != now:
            raise HTTPException(409, f"changed since the preview: {template.format(now=_said(now), shown=_said(shown))}; look at it again")

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
    old.config = new_config
    old.identity = new_identity
    if final is not None:
        old.name = final["to"]
    await db.flush()  # a name someone else took in the meantime is an IntegrityError here, inside the caller's try-again block
    await notify(db, CONFIG_CHANNEL)  # the collector polls the new address at once
    # now() is the start of this transaction, which is the audit row's `ts`: the same 24 hours the Undo checks.
    undo_until = (await db.scalar(text(f"SELECT now() + interval '{UNDO_HOURS} hours'"))).isoformat()

    detail = {
        "source_id": old.id, "name_before": name_before, "name_after": old.name,
        "host_before": old_where[0], "port_before": old_where[1], "host_after": to_host, "port_after": port,
        "address": body.address, "identity_before": identity_before, "identity_after": copy.deepcopy(new_identity),
        "match": _match_for_audit(match), "mappings": mappings, "removed": removed,
        "finding_ids": finding_ids[-MAX_FINDING_IDS:],
    }
    response = {
        "dry_run": False, "audit_id": None, "source": {"id": old.id, "name": old.name}, "from": from_, "to": to,
        "rename": rename, "undo_until": undo_until,
    }
    return response, detail


def _said(value: Any) -> str:
    """A value of `expect` or of the server, in words for the refusal: numbers and addresses as they are, no new name as "the same"."""
    return "the same name" if value is None else str(value)
