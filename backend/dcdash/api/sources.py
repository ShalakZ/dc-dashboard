import copy
import json
import re
from datetime import datetime
from typing import Any, Self

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import distinct, exists, func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import current_user, get_db, notify, require_permission
from dcdash.api.jobs import enqueue
from dcdash.connectors.base import connector_types
from dcdash.core.audit import (
    audit, audit_change, hidden_parts, reconcile_config, safe_config, scrub_url_credentials,
)
from dcdash.core.crypto import encrypt
from dcdash.core.models import Mapping, Point, Source, User
from dcdash.core.pg import CONFIG_CHANNEL

router = APIRouter(prefix="/api", tags=["sources"])

CHECK_LOCK = 7_308_001  # advisory-lock namespace (first int); the source id is the second: one check start per source at a time
CHECK_COOLDOWN_SECONDS = 5


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


class SourceListOut(SourceOut):
    last_reading_age_seconds: float | None = None  # newest stored reading of any of its points; None = none yet
    mapped_points: int = 0  # points of this source that have a mapping


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


@router.get("/connectors", dependencies=[Depends(require_permission("sources.edit"))])
async def list_connectors() -> list[dict[str, Any]]:
    return [
        {"type": name, "config_schema": cls.config_schema.model_json_schema()}
        for name, cls in sorted(connector_types().items())
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
    return [
        SourceListOut.of(s, last_reading_age_seconds=ages.get(s.id), mapped_points=int(counts.get(s.id, 0)))
        for s in sources
    ]


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
    source = await get_source(db, source_id)
    before = _values(source)
    raw_config = copy.deepcopy(source.config)
    if body.name is not None:
        source.name = body.name
    if body.config is not None:
        # The form can only send back the masked config: put back what it did not see (before validation, which
        # normalises URLs and would make the comparison fail).
        submitted = reconcile_config(source.config, body.config, body.clear_config_credentials)
        reject_hidden_marker(submitted, source.config)
        source.config = validated_config(source.connector_type, submitted)
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
                "depend on them disappear from billing and dashboards. "
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
    ids = (await db.scalars(select(Source.id).where(Source.enabled).order_by(Source.id))).all()
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
