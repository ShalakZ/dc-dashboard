import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import exists, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, notify, require_role
from dcdash.api.jobs import enqueue
from dcdash.connectors.base import connector_types
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


async def _save(db: AsyncSession) -> None:
    try:
        await db.flush()
    except IntegrityError:
        raise HTTPException(409, "a source with this name already exists") from None
    await notify(db, CONFIG_CHANNEL)
    await db.commit()


@router.get("/connectors", dependencies=[Admin])
async def list_connectors() -> list[dict[str, Any]]:
    return [
        {"type": name, "config_schema": cls.config_schema.model_json_schema()}
        for name, cls in sorted(connector_types().items())
    ]


@router.get("/sources", response_model=list[SourceOut], dependencies=[Operator])
async def list_sources(db: AsyncSession = Depends(get_db)) -> list[Source]:
    # Discovered sources stay out of the list until at least one of their points is mapped.
    mapped = exists(
        select(Point.id).join(Mapping, Mapping.point_id == Point.id).where(Point.source_id == Source.id)
    )
    query = select(Source).where(or_(Source.origin == "manual", mapped)).order_by(Source.name)
    return list((await db.scalars(query)).all())


@router.post("/sources", response_model=SourceOut, status_code=201, dependencies=[Admin])
async def create_source(body: SourceIn, db: AsyncSession = Depends(get_db)) -> Source:
    source = Source(
        name=body.name,
        connector_type=body.connector_type,
        config=validated_config(body.connector_type, body.config),
        secret=encrypt(body.secret) if body.secret else None,
        enabled=body.enabled,
    )
    db.add(source)
    await _save(db)
    return source


@router.patch("/sources/{source_id}", response_model=SourceOut, dependencies=[Admin])
async def update_source(source_id: int, body: SourcePatch, db: AsyncSession = Depends(get_db)) -> Source:
    source = await get_source(db, source_id)
    if body.name is not None:
        source.name = body.name
    if body.config is not None:
        source.config = validated_config(source.connector_type, body.config)
    if "secret" in body.model_fields_set:
        source.secret = encrypt(body.secret) if body.secret else None
    if body.enabled is not None:
        source.enabled = body.enabled
    await _save(db)
    return source


@router.delete("/sources/{source_id}", status_code=204, dependencies=[Admin])
async def delete_source(source_id: int, db: AsyncSession = Depends(get_db)) -> None:
    await db.delete(await get_source(db, source_id))
    await notify(db, CONFIG_CHANNEL)
    await db.commit()


@router.post("/sources/test-all", status_code=202)
async def test_all_sources(
    user: User = Operator, db: AsyncSession = Depends(get_db)
) -> dict[str, list[int]]:
    ids = (await db.scalars(select(Source.id).where(Source.enabled).order_by(Source.id))).all()
    job_ids = [await enqueue(db, "test_source", {"source_id": i}, user) for i in ids]
    await db.commit()
    return {"job_ids": job_ids}


@router.post("/sources/{source_id}/test", status_code=202)
async def test_source(
    source_id: int, user: User = Operator, db: AsyncSession = Depends(get_db)
) -> dict[str, int]:
    await get_source(db, source_id)
    job_id = await enqueue(db, "test_source", {"source_id": source_id}, user)
    await db.commit()
    return {"job_id": job_id}


@router.post("/sources/{source_id}/browse", status_code=202)
async def browse_source(
    source_id: int, user: User = Admin, db: AsyncSession = Depends(get_db)
) -> dict[str, int]:
    await get_source(db, source_id)
    job_id = await enqueue(db, "browse_source", {"source_id": source_id}, user)
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
