from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Numeric, func
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
    origin: Mapped[str] = mapped_column(default="manual", server_default="manual")

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


class ScanScope(Base):
    __tablename__ = "scan_scopes"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    targets: Mapped[list[str]] = mapped_column(JSONB)
    ports: Mapped[list[int]] = mapped_column(JSONB)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())


class Scan(Base):
    __tablename__ = "scans"
    id: Mapped[int] = mapped_column(primary_key=True)
    scope_id: Mapped[int | None] = mapped_column(ForeignKey("scan_scopes.id", ondelete="SET NULL"))
    scope_snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(default="queued", server_default="queued")
    stage: Mapped[str | None]
    progress: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    started_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(TZ)
    error: Mapped[str | None]


class ScanFinding(Base):
    __tablename__ = "scan_findings"
    id: Mapped[int] = mapped_column(primary_key=True)
    scan_id: Mapped[int] = mapped_column(ForeignKey("scans.id", ondelete="CASCADE"))
    host: Mapped[str]
    port: Mapped[int]
    source_id: Mapped[int | None] = mapped_column(ForeignKey("sources.id", ondelete="SET NULL"))
    connector_type: Mapped[str | None]
    outcome: Mapped[str]
    detail: Mapped[str] = mapped_column(default="", server_default="")


class GraphLayout(Base):
    __tablename__ = "graph_layout"
    node_id: Mapped[str] = mapped_column(primary_key=True)
    x: Mapped[float]
    y: Mapped[float]


class Tariff(Base):
    __tablename__ = "tariffs"
    id: Mapped[int] = mapped_column(primary_key=True)
    asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id", ondelete="CASCADE"))  # None = the site default
    rate_per_kwh: Mapped[Decimal] = mapped_column(Numeric(13, 6))
    effective_from: Mapped[date]
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())


class Dashboard(Base):
    __tablename__ = "dashboards"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    range: Mapped[str] = mapped_column(default="24h", server_default="24h")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())


class Widget(Base):
    __tablename__ = "widgets"
    id: Mapped[int] = mapped_column(primary_key=True)
    dashboard_id: Mapped[int] = mapped_column(ForeignKey("dashboards.id", ondelete="CASCADE"))
    type: Mapped[str]
    title: Mapped[str] = mapped_column(default="", server_default="")
    config: Mapped[dict[str, Any]] = mapped_column(JSONB)
    x: Mapped[int]
    y: Mapped[int]
    w: Mapped[int]
    h: Mapped[int]


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    action: Mapped[str]
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    actor_id: Mapped[int | None]  # the user's id when the row was written; no foreign key, so it outlives the user
    actor_name: Mapped[str | None]  # filled by the audit_log_snapshot_actor trigger (migration 0005)
    ts: Mapped[datetime] = mapped_column(TZ, server_default=func.now())
