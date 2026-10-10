import copy
import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import distinct, exists, func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, notify, require_role
from dcdash.api.jobs import enqueue
from dcdash.connectors.base import connector_types
from dcdash.core.audit import audit, audit_change, hidden_parts, safe_config
from dcdash.core.crypto import encrypt
from dcdash.core.models import Mapping, Point, Source, User
from dcdash.core.pg import CONFIG_CHANNEL

router = APIRouter(prefix="/api", tags=["sources"])
Admin = Depends(require_role("admin"))
Operator = Depends(require_role("operator"))


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


class SourceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    connector_type: str
    config: dict[str, Any]
    enabled: bool
    status: str
    last_seen: datetime | None
    last_error: str | None
    has_secret: bool
    origin: str


class SourceListOut(SourceOut):
    last_reading_age_seconds: float | None = None  # newest stored reading of any of its points; None = none yet


def validated_config(connector_type: str, config: dict[str, Any]) -> dict[str, Any]:
    types = connector_types()
    if connector_type not in types:
        raise HTTPException(422, f"unknown connector type: {connector_type}")
    try:
        return types[connector_type].config_schema.model_validate(config).model_dump(mode="json")
    except ValidationError as exc:
        raise HTTPException(422, json.loads(exc.json(include_url=False))) from exc


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


@router.get("/connectors", dependencies=[Admin])
async def list_connectors() -> list[dict[str, Any]]:
    return [
        {"type": name, "config_schema": cls.config_schema.model_json_schema()}
        for name, cls in sorted(connector_types().items())
    ]


@router.get("/sources", response_model=list[SourceListOut], dependencies=[Operator])
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
    return [
        SourceListOut.model_validate(s).model_copy(update={"last_reading_age_seconds": ages.get(s.id)}) for s in sources
    ]


@router.post("/sources", response_model=SourceOut, status_code=201, dependencies=[Admin])
async def create_source(body: SourceIn, db: AsyncSession = Depends(get_db), admin: User = Admin) -> Source:
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
        db, admin.id, "source.created",
        {"source_id": source.id, "connector_type": source.connector_type, **_values(source)},
    )
    await _publish(db)
    return source


@router.patch("/sources/{source_id}", response_model=SourceOut, dependencies=[Admin])
async def update_source(
    source_id: int, body: SourcePatch, db: AsyncSession = Depends(get_db), admin: User = Admin
) -> Source:
    source = await get_source(db, source_id)
    before = _values(source)
    raw_config = copy.deepcopy(source.config)
    if body.name is not None:
        source.name = body.name
    if body.config is not None:
        source.config = validated_config(source.connector_type, body.config)
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
    await audit_change(db, admin.id, "source.updated", {"source_id": source.id, "name": source.name}, before, after)
    await _publish(db)
    return source


@router.delete("/sources/{source_id}", status_code=204, response_model=None)
async def delete_source(
    source_id: int,
    confirm: bool = False,
    db: AsyncSession = Depends(get_db),
    admin: User = Admin,
) -> JSONResponse | None:
    source = await get_source(db, source_id)
    mapped_points, mappings = (
        await db.execute(
            select(func.count(distinct(Mapping.point_id)), func.count(Mapping.id))
            .join(Point, Point.id == Mapping.point_id)
            .where(Point.source_id == source_id)
        )
    ).one()
    if not confirm and mapped_points:
        # Past energy and cost are recomputed from today's mappings (spec 6), so this changes billing history.
        return JSONResponse(
            status_code=409,
            content={
                "detail": (
                    f'Source "{source.name}" has {mapped_points} mapped point{"" if mapped_points == 1 else "s"}; '
                    "deleting it deletes them and their mappings, and the past energy and cost figures that "
                    "depend on them disappear from billing and dashboards. "
                    "Repeat the request with confirm=true to go ahead."
                ),
                "points": mapped_points,
                "mappings": mappings,
            },
        )
    await db.delete(source)
    await audit(
        db, admin.id, "source.deleted",
        {"source_id": source_id, "name": source.name, "points": mapped_points, "mappings": mappings},
    )
    await notify(db, CONFIG_CHANNEL)
    await db.commit()


@router.post("/sources/test-all", status_code=202)
async def test_all_sources(
    user: User = Operator, db: AsyncSession = Depends(get_db)
) -> dict[str, list[int]]:
    ids = (await db.scalars(select(Source.id).where(Source.enabled).order_by(Source.id))).all()
    job_ids = [await enqueue(db, "test_source", {"source_id": i}, user) for i in ids]
    await audit(db, user.id, "source.test_all", {"sources": len(ids), "job_ids": job_ids})
    await db.commit()
    return {"job_ids": job_ids}


@router.post("/sources/{source_id}/test", status_code=202)
async def test_source(
    source_id: int, user: User = Operator, db: AsyncSession = Depends(get_db)
) -> dict[str, int]:
    source = await get_source(db, source_id)
    job_id = await enqueue(db, "test_source", {"source_id": source_id}, user)
    await audit(db, user.id, "source.tested", {"source_id": source.id, "name": source.name, "job_id": job_id})
    await db.commit()
    return {"job_id": job_id}


@router.post("/sources/{source_id}/browse", status_code=202)
async def browse_source(
    source_id: int, user: User = Admin, db: AsyncSession = Depends(get_db)
) -> dict[str, int]:
    source = await get_source(db, source_id)
    job_id = await enqueue(db, "browse_source", {"source_id": source_id}, user)
    await audit(db, user.id, "source.browsed", {"source_id": source.id, "name": source.name, "job_id": job_id})
    await db.commit()
    return {"job_id": job_id}


@router.get("/sources/{source_id}/points", dependencies=[Operator])
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
