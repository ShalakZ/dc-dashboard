from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TZ = DateTime(timezone=True)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str]
    password_hash: Mapped[str]
    role: Mapped[str]
    active: Mapped[bool] = mapped_column(default=True)


class UserSession(Base):
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    expires_at: Mapped[datetime] = mapped_column(TZ)


class Source(Base):
    __tablename__ = "sources"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    connector_type: Mapped[str]
    config: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    secret: Mapped[str | None]
    enabled: Mapped[bool] = mapped_column(default=True)
    status: Mapped[str] = mapped_column(default="unknown")
    last_seen: Mapped[datetime | None] = mapped_column(TZ)
    last_error: Mapped[str | None]

    @property
    def has_secret(self) -> bool:
        return self.secret is not None


class Point(Base):
    __tablename__ = "points"
    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id"))
    address: Mapped[str]
    name: Mapped[str]
    data_type: Mapped[str] = mapped_column(default="float")
    unit_hint: Mapped[str | None]


class Asset(Base):
    __tablename__ = "assets"
    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id"))
    name: Mapped[str]
    kind: Mapped[str] = mapped_column(default="generic")
    sort_order: Mapped[int] = mapped_column(default=0)


class Mapping(Base):
    __tablename__ = "mappings"
    id: Mapped[int] = mapped_column(primary_key=True)
    point_id: Mapped[int] = mapped_column(ForeignKey("points.id"))
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id"))
    metric: Mapped[str]
    scale: Mapped[float] = mapped_column(default=1.0)
    interval_seconds: Mapped[int]
    custom_unit: Mapped[str | None]


class PointLatest(Base):
    __tablename__ = "point_latest"
    point_id: Mapped[int] = mapped_column(ForeignKey("points.id"), primary_key=True)
    ts: Mapped[datetime] = mapped_column(TZ)
    value: Mapped[float | None]
    quality: Mapped[int]


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str]
    params: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(default="pending")
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    requested_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(TZ)
