import copy
import json
import re
from dataclasses import asdict
from datetime import datetime
from typing import Any, Self

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import distinct, exists, func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import current_user, get_db, notify, require_permission
from dcdash.api.health import log_once
from dcdash.api.jobs import enqueue
from dcdash.connectors.base import connector_types
from dcdash.core.audit import (
    audit, audit_change, hidden_parts, hidden_values, reconcile_config, safe_config, scrub_url_credentials,
)
from dcdash.core.crypto import encrypt
from dcdash.core.models import Mapping, Point, Source, User
from dcdash.core.pg import CONFIG_CHANNEL
from dcdash.events import read as events_read
from dcdash.events import watchdog
from dcdash.moves.load import load_offers
from dcdash.moves.match import MOVABLE_TYPES, Offer, Two, another_server_answers
from dcdash.moves.urls import address_key, display_endpoint

router = APIRouter(prefix="/api", tags=["sources"])

CHECK_LOCK = 7_308_001  # advisory-lock namespace (first int); the source id is the second: one check start per source at a time
CHECK_COOLDOWN_SECONDS = 5
STALE_FORM = (
    "This source was changed since you opened it (for example it was moved to a new address). Close the form and open it again."
)


class SourceIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    connector_type: str
    config: dict[str, Any] = {}
    secret: str | None = None
    enabled: bool = True


class SourcePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    config: dict[str, Any] | None = None
    secret: str | None = None
    enabled: bool | None = None
    # Keys of `config` the admin wants stored without their hidden part (URL credentials) although the form sent the
    # masked value back; see reconcile_config.
    clear_config_credentials: list[str] = Field(default=[], max_length=20)
    # The masked config the edit form was opened with (what GET /api/sources showed as `config`). When both this and `config` are sent
    # and the stored config no longer shows the same, the form is stale (for example the source was moved to a new address since)
    # and saving it would write the old values back: refused with a 409, nothing changed. Absent for an older client: no check.
    expect_config: dict[str, Any] | None = None


class SourceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    connector_type: str
    config: dict[str, Any]  # as safe_config shows it: never the user name and password of a URL
    hidden_config_keys: list[str] = []  # the keys of `config` that have something hidden
    enabled: bool
    status: str
    last_seen: datetime | None
    last_error: str | None
    has_secret: bool
    origin: str

    @classmethod
    def of(cls, source: Source, **extra: Any) -> Self:
        """The API view of `source`: its config masked, and no URL credentials in its last error."""
        hidden = hidden_parts(source.config)
        last_error = source.last_error
        return cls.model_validate(source).model_copy(
            update={
                "config": safe_config(source.config),
                "hidden_config_keys": sorted(hidden),
                "last_error": None if last_error is None else scrub_url_credentials(last_error, hidden.values()),
                **extra,
            }
        )


class SourceHistoryLine(BaseModel):
    """The part of the history backfill's state that the Sources page shows under a source's name (the list's `history`)."""

    supports_history: bool
    state: str  # never_run | idle | filling | backing_off | not_supported
    answered_through: datetime | None = None
    last_success_at: datetime | None = None
    next_try_at: datetime | None = None
    last_error: str | None = None


class SourceMeters(BaseModel):
    """w35: how the data freshness rule judges the billing meters of one source. Counts only (the Sources page shows a line while
    something is wrong). `stale` is the stale level of the chip: silent meters, plus the counters of a frozen source."""

    total: int  # billing meters on this source (an energy counter, else a kW meter, per asset)
    stale: int
    not_advancing: int  # energy counters that have not risen for the set time; 0 while the source is frozen (they are in `stale`)
    frozen: bool  # the source answers but its counters (and its other points) stand still: a server serving cached values
    oldest_stale_age_seconds: float | None = None  # the longest silence or standstill among the stale ones; None = none, or unknown


class SourceListOut(SourceOut):
    last_reading_age_seconds: float | None = None  # newest stored reading of any of its points; None = none yet
    mapped_points: int = 0  # points of this source that have a mapping
    polls: bool = True  # the connector class's flag: false for a source that is filled by importing files, which is never tested or polled
    history: SourceHistoryLine | None = None  # never null in an answer: list_sources fills it for every row (the default only lets `of` validate)
    offline_since: datetime | None = None  # while offline: the earlier of the open incident's start and last_seen; else null (P7)
    failed_reads: int | None = None  # while offline: the open incident's count of failed reads; else null
    # w33 R8: while offline and a scan found its server again at another address, the new source it could move to
    # (`{kind: "offer", to_source_id, to_name, to_endpoint, match}`), or `{kind: "two", count}`; else null. No user info anywhere in it.
    move_candidate: dict[str, Any] | None = None
    # w33 whole-wave review I3: a scan, Test or check met ANOTHER server at this address than the one the source used to talk to
    # (`identity.different`; polling goes on). Only the fact: never what the other server said. False for no identity.
    identity_different: bool = False
    # w35: the freshness rule's numbers for this source; null for a source with no billing meter, and null for every source while the
    # rule cannot be evaluated (the rest of the row is answered all the same).
    meters: SourceMeters | None = None


class SourceHistoryOut(BaseModel):
    """How far the history backfill got with one source (the `history_status` row, or "never_run" when it has none yet)."""

    supports_history: bool  # the connector class's flag: false means the backfill never asks this source for history
    state: str  # never_run | idle | filling | backing_off | not_supported
    answered_through: datetime | None = None  # everything before this was asked once
    reread_through: datetime | None = None  # everything before this was asked a second time, for values stored late
    last_cycle_at: datetime | None = None
    last_success_at: datetime | None = None
    next_try_at: datetime | None = None  # while backing off: the source is not asked again before this
    short_hours: int = 0
    # Since the collector started (the totals restart with it).
    rows_new: int = 0
    rows_already: int = 0
    rows_differing: int = 0
    rows_rejected: int = 0
    requests: int = 0
    failures: int = 0
    last_error: str | None = None


def validated_config(connector_type: str, config: dict[str, Any]) -> dict[str, Any]:
    types = connector_types()
    if connector_type not in types:
        raise HTTPException(422, f"unknown connector type: {connector_type}")
    try:
        return types[connector_type].config_schema.model_validate(config).model_dump(mode="json")
    except ValidationError as exc:
        # No input: an edit puts the STORED config back into validation, so the input can be a password.
        raise HTTPException(422, json.loads(exc.json(include_url=False, include_input=False))) from exc


# What a form sends back for a user name it was not shown: `safe_config` writes "[hidden]@" where it removed them.
_HIDDEN_MARKER = re.compile(r"\[hidden\]@|%5Bhidden%5D@", re.IGNORECASE)


def reject_hidden_marker(config: dict[str, Any], stored: dict[str, Any]) -> None:
    """422 for a submitted top-level string that carries the `[hidden]@` marker unless it is the stored value.

    A masked URL comes back from the form with its host edited: without this, validation takes the marker for a user
    name and stores it (`http://%5Bhidden%5D@host/`), and the real credentials are gone. `reconcile_config` has
    already put back every masked value that came back unchanged, so what still carries the marker was edited. The
    value is not echoed.
    """
    for key, value in config.items():
        if isinstance(value, str) and _HIDDEN_MARKER.search(value) and value != stored.get(key):
            raise HTTPException(
                422, "the credentials stored in this address are hidden: retype them in the address, or remove them"
            )


async def get_source(db: AsyncSession, source_id: int) -> Source:
    source = await db.get(Source, source_id)
    if source is None:
        raise HTTPException(404, "source not found")
    return source


def _has_mapped_point():
    """True for a source with at least one mapped point: only those discovered sources appear in the sources list."""
    return exists(select(Point.id).join(Mapping, Mapping.point_id == Point.id).where(Point.source_id == Source.id))


async def _name_clash_message(db: AsyncSession, name: str | None) -> str:
    # A discovered source nobody has mapped yet is hidden from GET /api/sources, so without this the admin is told a
    # name is taken by something they cannot see.
    if name is not None:
        hidden = await db.scalar(
            select(Source.id).where(Source.name == name, Source.origin == "discovered", ~_has_mapped_point()).limit(1)
        )
        if hidden is not None:
            return (
                f'the name "{name}" is already used by a discovered source that is hidden from this list '
                "until one of its points is mapped; choose another name"
            )
    return "a source with this name already exists"


async def _flush(db: AsyncSession, name: str | None = None) -> None:
    """Flush; `name` is the name this request tried to set, used to explain a unique-name clash."""
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()  # the failed flush leaves the session unusable until it is rolled back
        raise HTTPException(409, await _name_clash_message(db, name)) from None


async def _publish(db: AsyncSession) -> None:
    await notify(db, CONFIG_CHANNEL)
    await db.commit()


def _values(source: Source) -> dict[str, Any]:
    """The audited fields of a source; the secret only as a marker, the config without URL credentials."""
    return {
        "name": source.name, "enabled": source.enabled, "config": safe_config(source.config),
        "secret": "set" if source.secret else "none",
    }


def _host_and_port(source: Source) -> tuple[str, int] | None:
    """Where the source's server is, as the matcher reads it (`moves.urls.address_key`: host lower-cased, the effective port, so a
    default port written out is the same port); the path and the scheme do not count. None for a type with no such address."""
    key = address_key(source.connector_type, source.config)
    return None if key is None else key[:2]


def _history_line(source: Source, row: Any, types: dict[str, Any]) -> SourceHistoryLine:
    """The list's `history` of one source: its `history_status` row, or "never_run" when it has none yet (as the `/history` route
    answers). `last_error` is scrubbed with the source's own hidden values, exactly as that route does it."""
    kind = types.get(source.connector_type)
    supports = bool(kind is not None and kind.supports_history)
    if row is None:
        return SourceHistoryLine(supports_history=supports, state="never_run")
    values = {key: value for key, value in dict(row).items() if key != "source_id"}
    if values["last_error"] is not None:
        values["last_error"] = scrub_url_credentials(values["last_error"], hidden_values(source.config))
    return SourceHistoryLine(supports_history=supports, **values)


def non_polling_types() -> list[str]:
    """The connector types whose sources are never asked for values: they are filled by importing files."""
    return [name for name, cls in connector_types().items() if not cls.polls]


@router.get("/connectors", dependencies=[Depends(require_permission("sources.edit"))])
async def list_connectors() -> list[dict[str, Any]]:
    # The types that poll come first: the source form starts on the first entry, and that must stay a type with an address to fill in.
    return [
        {"type": name, "config_schema": cls.config_schema.model_json_schema(), "polls": cls.polls, "description": cls.description}
        for name, cls in sorted(connector_types().items(), key=lambda item: (not item[1].polls, item[0]))
    ]


@router.get(
    "/sources", response_model=list[SourceListOut], dependencies=[Depends(require_permission("sources.view"))]
)
async def list_sources(db: AsyncSession = Depends(get_db)) -> list[SourceListOut]:
    # Discovered sources stay out of the list until at least one of their points is mapped.
    query = select(Source).where(or_(Source.origin == "manual", _has_mapped_point())).order_by(Source.name)
    sources = list((await db.scalars(query)).all())
    # point_latest holds one row per polled point, so this is cheap; never aggregate the readings hypertable for this.
    rows = await db.execute(
        text(
            "SELECT p.source_id, extract(epoch FROM now() - max(pl.ts)) FROM point_latest pl "
            "JOIN points p ON p.id = pl.point_id GROUP BY p.source_id"
        )
    )
    ages = {source_id: max(0.0, float(age)) for source_id, age in rows}
    counts = dict(
        (
            await db.execute(
                text(
                    "SELECT p.source_id, count(DISTINCT m.point_id) FROM mappings m "
                    "JOIN points p ON p.id = m.point_id GROUP BY p.source_id"
                )
            )
        ).all()
    )
    # One query for all the listed sources, never one per row. Plain SQL: the models live in core/ (see source_history).
    history = {
        row["source_id"]: row
        for row in (
            await db.execute(
                text(
                    "SELECT source_id, state, answered_through, last_success_at, next_try_at, last_error "
                    "FROM history_status WHERE source_id = ANY(:ids)"
                ),
                {"ids": [s.id for s in sources]},
            )
        ).mappings()
    }
    # One more query for all the OFFLINE listed sources: their open `source.offline` incident (w32). Plain SQL, as above. A source
    # that is not offline is not looked up (this list refreshes every 10 s for every user): with none offline, no query at all.
    incidents = await events_read.open_incidents(db, [s.id for s in sources if s.status == "offline"])
    # w33 R8: the sources a scan may have found again at another address, decided in ONE pass for the whole list. Only an offline source
    # with something mapped, of a type a scan can recognise, can have one: with none of those, the loader is not called at all.
    askable = [
        s.id for s in sources if s.status == "offline" and s.connector_type in MOVABLE_TYPES and int(counts.get(s.id, 0)) > 0
    ]
    candidates = await _move_candidates(db, askable)
    types = connector_types()
    try:
        by_source = (await watchdog.get_verdict()).sources  # its own session and bound, reused for 5 s: no query of this request's
    except Exception as exc:
        log_once("the data freshness verdict is not available for the sources", exc)
        by_source = {}
    return [
        SourceListOut.of(
            s, last_reading_age_seconds=ages.get(s.id), mapped_points=int(counts.get(s.id, 0)),
            polls=getattr(types.get(s.connector_type), "polls", True),  # a type this build does not know counts as polling
            history=_history_line(s, history.get(s.id), types),
            move_candidate=candidates.get(s.id),
            identity_different=another_server_answers(s.identity),  # the column is on the row already: no statement
            meters=_meters_of(by_source.get(s.id)),
            **_offline_fields(s, incidents.get(s.id)),
        )
        for s in sources
    ]


def _meters_of(verdict: watchdog.SourceVerdict | None) -> SourceMeters | None:
    return None if verdict is None else SourceMeters(
        total=verdict.meters, stale=verdict.stale, not_advancing=verdict.not_advancing, frozen=verdict.frozen,
        oldest_stale_age_seconds=verdict.oldest_stale_age_seconds,
    )


async def _move_candidates(db: AsyncSession, old_ids: list[int]) -> dict[int, dict[str, Any]]:
    """`move_candidate` of each listed source in `old_ids` that has one: the new source it could move to (named without user info:
    scheme, host, port and path only), or that several servers could be it. At most the offer loader's constant number of statements
    plus one that names the offered sources; none when `old_ids` is empty."""
    if not old_ids:
        return {}
    said = (await load_offers(db, old_ids=old_ids)).by_old
    targets = {}
    wanted = sorted({answer.new_id for answer in said.values() if isinstance(answer, Offer)})
    if wanted:  # columns named: a source's encrypted secret is not read
        rows = await db.execute(select(Source.id, Source.name, Source.connector_type, Source.config).where(Source.id.in_(wanted)))
        targets = {row.id: row for row in rows}
    found: dict[int, dict[str, Any]] = {}
    for old_id, answer in said.items():
        if isinstance(answer, Two):
            found[old_id] = {"kind": "two", "count": answer.count}
        elif isinstance(answer, Offer) and answer.new_id in targets:  # a source a removal took away in between has no offer
            target = targets[answer.new_id]
            value = answer.match.value
            found[old_id] = {
                "kind": "offer", "to_source_id": target.id, "to_name": target.name,
                "to_endpoint": display_endpoint(target.connector_type, target.config),
                # the application URI or instance id came off the network: as the Discovery graph shows it, any user info scrubbed
                "match": {**asdict(answer.match), "value": scrub_url_credentials(value) if isinstance(value, str) and value else None},
            }
    return found


def _offline_fields(source: Source, incident: dict[str, Any] | None) -> dict[str, Any]:
    """`offline_since` and `failed_reads` of a listed source. `offline_since` is the earlier of the open incident's start and
    `last_seen` (a null is ignored) and only while the source is offline; null when there is neither. `failed_reads` is the open
    incident's count, and only an offline source has its incident looked up: any other source answers null."""
    since = None
    if source.status == "offline":
        starts = [moment for moment in (incident["first_at"] if incident else None, source.last_seen) if moment is not None]
        since = min(starts) if starts else None
    return {"offline_since": since, "failed_reads": incident["count"] if incident else None}


@router.post(
    "/sources", response_model=SourceOut, status_code=201, dependencies=[Depends(require_permission("sources.edit"))]
)
async def create_source(body: SourceIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)) -> SourceOut:
    reject_hidden_marker(body.config, {})
    source = Source(
        name=body.name,
        connector_type=body.connector_type,
        config=validated_config(body.connector_type, body.config),
        secret=encrypt(body.secret) if body.secret else None,
        enabled=body.enabled,
    )
    db.add(source)
    await _flush(db, body.name)
    await audit(
        db, user.id, "source.created",
        {"source_id": source.id, "connector_type": source.connector_type, **_values(source)},
    )
    await _publish(db)
    return SourceOut.of(source)


@router.patch(
    "/sources/{source_id}", response_model=SourceOut, dependencies=[Depends(require_permission("sources.edit"))]
)
async def update_source(
    source_id: int, body: SourcePatch, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)
) -> SourceOut:
    # Locked from this read to the commit (w33 F-M7): a move of this source that is in flight (api/moves.py) finishes first, and this
    # request then reads where the move left it, so a PATCH that read the old address before the move cannot write it back.
    source = await db.scalar(select(Source).where(Source.id == source_id).with_for_update())
    if source is None:
        raise HTTPException(404, "source not found")
    if body.config is not None and body.expect_config is not None and safe_config(source.config) != body.expect_config:
        raise HTTPException(409, STALE_FORM)  # read under the row lock above, so a move that was in flight is already in it (w33 T5b-I1)
    before = _values(source)
    raw_config = copy.deepcopy(source.config)
    place_before = _host_and_port(source)
    if body.name is not None:
        source.name = body.name
    if body.config is not None:
        # The form can only send back the masked config: put back what it did not see (before validation, which
        # normalises URLs and would make the comparison fail).
        submitted = reconcile_config(source.config, body.config, body.clear_config_credentials)
        reject_hidden_marker(submitted, source.config)
        source.config = validated_config(source.connector_type, submitted)
    # A source that now points at another host or port is not talking to the server it remembers (w33 whole-wave review I1): forget it,
    # so a stale identity cannot read "a different server answers here" for good or carry a move offer. A Test learns it again.
    identity_cleared = source.identity is not None and body.config is not None and _host_and_port(source) != place_before
    if identity_cleared:
        source.identity = None
    if "secret" in body.model_fields_set:
        source.secret = encrypt(body.secret) if body.secret else None
    if body.enabled is not None:
        source.enabled = body.enabled
    await _flush(db, body.name)
    after = _values(source)
    if "secret" in body.model_fields_set and body.secret:
        after["secret"] = "changed"  # a supplied value always counts: the stored token cannot be compared
    if hidden_parts(raw_config) != hidden_parts(source.config):
        # What safe_config hides (URL credentials, a masked key) changed, whatever else changed with it: record that,
        # never the values (hidden_parts is only compared here).
        before["config_credentials"], after["config_credentials"] = "unchanged", "changed"
    if identity_cleared:
        before["identity_cleared"], after["identity_cleared"] = False, True  # only the fact, never the identity that was dropped
    await audit_change(db, user.id, "source.updated", {"source_id": source.id, "name": source.name}, before, after)
    await _publish(db)
    return SourceOut.of(source)


async def _mapped_counts(db: AsyncSession, source_id: int) -> tuple[int, int]:
    """(mapped points, mappings) of the source: what a delete takes with it that anything depends on. Unmapped points go
    too, but no figure on billing or a dashboard depends on them, so they are not counted."""
    mapped_points, mappings = (
        await db.execute(
            select(func.count(distinct(Mapping.point_id)), func.count(Mapping.id))
            .join(Point, Point.id == Mapping.point_id)
            .where(Point.source_id == source_id)
        )
    ).one()
    return mapped_points, mappings


async def _lock_source(db: AsyncSession, source_id: int) -> bool:
    """Lock the source and its points until this transaction ends; False if the source is gone.

    A point being added holds FOR KEY SHARE on the source's row and a mapping being added holds it on its point's row, so
    either waits for this lock, or this waits for it and the count that follows sees the new row (see _lock_subtree in
    assets.py). ORDER BY id keeps two deletes that meet in the same order.
    """
    if await db.scalar(select(Source.id).where(Source.id == source_id).with_for_update()) is None:
        return False  # a delete that finished while this one waited leaves no row to lock
    await db.execute(select(Point.id).where(Point.source_id == source_id).order_by(Point.id).with_for_update())
    return True


@router.get("/sources/{source_id}/impact", dependencies=[Depends(require_permission("sources.edit"))])
async def source_impact(source_id: int, db: AsyncSession = Depends(get_db)) -> dict[str, int]:
    """What deleting the source would take with it that anything depends on: mapped points and their mappings, counts
    only, for the confirmation dialog. Changes nothing (no lock: it is a read) and writes no audit row."""
    await get_source(db, source_id)  # 404
    points, mappings = await _mapped_counts(db, source_id)
    return {"points": points, "mappings": mappings}


@router.delete(
    "/sources/{source_id}", status_code=204, response_model=None, dependencies=[Depends(require_permission("sources.edit"))]
)
async def delete_source(
    source_id: int,
    confirm: bool = False,
    # What the caller was shown (GET .../impact). A real count above its expectation means the source grew since: refuse.
    expect_points: int | None = Query(None, ge=0),
    expect_mappings: int | None = Query(None, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
) -> JSONResponse | None:
    # Lock first, then decide whether the source exists and what it takes with it (see _lock_source).
    if not await _lock_source(db, source_id):
        raise HTTPException(404, "source not found")
    source = await get_source(db, source_id)
    mapped_points, mappings = await _mapped_counts(db, source_id)  # its own statement: it sees what committed while waiting
    grown = any(
        expected is not None and count > expected
        for count, expected in ((mapped_points, expect_points), (mappings, expect_mappings))
    )
    if grown or (not confirm and mapped_points):
        # Past energy and cost are recomputed from today's mappings (spec 6), so this changes billing history.
        if grown:  # also when confirmed: the confirmation was for the smaller numbers
            detail = (
                f"More than you were shown would be deleted now: {mapped_points} mapped point"
                f'{"" if mapped_points == 1 else "s"} and {mappings} mapping{"" if mappings == 1 else "s"}. '
                "Check the new numbers and repeat the request."
            )
        else:
            detail = (
                f'Source "{source.name}" has {mapped_points} mapped point{"" if mapped_points == 1 else "s"}; '
                "deleting it deletes them and their mappings, and the past energy and cost figures that "
                "depend on them disappear from billing and dashboards, except in closed months, which keep their billed figures. "
                "Repeat the request with confirm=true to go ahead."
            )
        return JSONResponse(status_code=409, content={"detail": detail, "points": mapped_points, "mappings": mappings})
    await db.delete(source)
    await audit(
        db, user.id, "source.deleted",
        {"source_id": source_id, "name": source.name, "points": mapped_points, "mappings": mappings},
    )
    await notify(db, CONFIG_CHANNEL)
    await db.commit()


@router.post("/sources/test-all", status_code=202, dependencies=[Depends(require_permission("sources.test"))])
async def test_all_sources(
    user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
) -> dict[str, list[int]]:
    # A source that is filled by importing files has no connection to test: it is left out, not counted.
    ids = (
        await db.scalars(
            select(Source.id).where(Source.enabled, Source.connector_type.notin_(non_polling_types())).order_by(Source.id)
        )
    ).all()
    job_ids = [await enqueue(db, "test_source", {"source_id": i}, user) for i in ids]
    await audit(db, user.id, "source.test_all", {"sources": len(ids), "job_ids": job_ids})
    await db.commit()
    return {"job_ids": job_ids}


@router.post(
    "/sources/{source_id}/test", status_code=202, dependencies=[Depends(require_permission("sources.test"))]
)
async def test_source(
    source_id: int, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
) -> dict[str, int]:
    source = await get_source(db, source_id)
    job_id = await enqueue(db, "test_source", {"source_id": source_id}, user)
    await audit(db, user.id, "source.tested", {"source_id": source.id, "name": source.name, "job_id": job_id})
    await db.commit()
    return {"job_id": job_id}


@router.post(
    "/sources/{source_id}/check", status_code=202, response_model=None,
    dependencies=[Depends(require_permission("diagnostics.run"))],
)
async def check_source(
    source_id: int, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
) -> dict[str, int] | JSONResponse:
    """Queue a step-by-step connection check. One per source at a time (409 while one is queued or running) and not again
    within CHECK_COOLDOWN_SECONDS of the last one (429): the device it probes may be fragile. The guards and the insert run
    under one advisory lock, so two requests cannot both pass them."""
    source = await get_source(db, source_id)
    await db.execute(text("SELECT pg_advisory_xact_lock(:space, :source)"), {"space": CHECK_LOCK, "source": source_id})
    sid = str(source_id)
    active = await db.scalar(
        text(
            "SELECT id FROM jobs WHERE kind = 'check_connection' AND params->>'source_id' = :sid "
            "AND status IN ('pending', 'running') ORDER BY id DESC LIMIT 1"
        ),
        {"sid": sid},
    )
    if active is not None:
        return JSONResponse(
            status_code=409,
            content={"detail": "a connection check is already running for this source", "job_id": active},
        )
    recent = await db.scalar(
        text(
            "SELECT id FROM jobs WHERE kind = 'check_connection' AND params->>'source_id' = :sid "
            "AND finished_at > clock_timestamp() - CAST(:cooldown AS integer) * interval '1 second' ORDER BY id DESC LIMIT 1"
        ),
        {"sid": sid, "cooldown": CHECK_COOLDOWN_SECONDS},
    )
    if recent is not None:
        return JSONResponse(
            status_code=429,
            content={"detail": "a connection check for this source finished a moment ago; try again in a few seconds"},
            headers={"Retry-After": str(CHECK_COOLDOWN_SECONDS)},
        )
    job_id = await enqueue(db, "check_connection", {"source_id": source_id}, user)
    await audit(db, user.id, "source.checked", {"source_id": source.id, "name": source.name, "job_id": job_id})
    await db.commit()
    return {"job_id": job_id}


@router.post(
    "/sources/{source_id}/browse", status_code=202, dependencies=[Depends(require_permission("sources.edit"))]
)
async def browse_source(
    source_id: int, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)
) -> dict[str, int]:
    source = await get_source(db, source_id)
    job_id = await enqueue(db, "browse_source", {"source_id": source_id}, user)
    await audit(db, user.id, "source.browsed", {"source_id": source.id, "name": source.name, "job_id": job_id})
    await db.commit()
    return {"job_id": job_id}


@router.get(
    "/sources/{source_id}/history", response_model=SourceHistoryOut, dependencies=[Depends(require_permission("sources.view"))]
)
async def source_history(source_id: int, db: AsyncSession = Depends(get_db)) -> SourceHistoryOut:
    """The state of the history backfill for one source. A read: no audit row, and nothing is changed. The table is read with
    plain SQL: the models live in core/, whose files are hashed into the figure engine's id, so the table has none."""
    source = await get_source(db, source_id)  # 404
    kind = connector_types().get(source.connector_type)
    supports = bool(kind is not None and kind.supports_history)
    row = (
        await db.execute(
            text(
                "SELECT state, answered_through, reread_through, last_cycle_at, last_success_at, next_try_at, short_hours, "
                "rows_new, rows_already, rows_differing, rows_rejected, requests, failures, last_error "
                "FROM history_status WHERE source_id = :sid"
            ),
            {"sid": source_id},
        )
    ).mappings().first()
    if row is None:
        return SourceHistoryOut(supports_history=supports, state="never_run")
    values = dict(row)
    if values["last_error"] is not None:  # the engine scrubbed it when it stored it; scrub once more, as SourceOut does
        values["last_error"] = scrub_url_credentials(values["last_error"], hidden_values(source.config))
    return SourceHistoryOut(supports_history=supports, **values)


@router.get("/sources/{source_id}/points", dependencies=[Depends(require_permission("sources.view"))])
async def list_points(source_id: int, db: AsyncSession = Depends(get_db)) -> list[dict[str, Any]]:
    await get_source(db, source_id)
    rows = await db.execute(
        select(Point, Mapping)
        .outerjoin(Mapping, Mapping.point_id == Point.id)
        .where(Point.source_id == source_id)
        .order_by(Point.address)
    )
    return [
        {
            "id": point.id,
            "address": point.address,
            "name": point.name,
            "data_type": point.data_type,
            "unit_hint": point.unit_hint,
            "mapping": None
            if mapping is None
            else {
                "id": mapping.id,
                "asset_id": mapping.asset_id,
                "metric": mapping.metric,
                "scale": mapping.scale,
                "interval_seconds": mapping.interval_seconds,
                "custom_unit": mapping.custom_unit,
            },
        }
        for point, mapping in rows
    ]
