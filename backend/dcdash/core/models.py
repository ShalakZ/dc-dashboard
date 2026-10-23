from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import BigInteger, DateTime, ForeignKey, Numeric, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from dcdash.core.permissions import ALL_IDS, effective_permissions

TZ = DateTime(timezone=True)


class Base(DeclarativeBase):
    pass


class Role(Base):
    __tablename__ = "roles"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]  # unique ignoring case (a database index); the built-in ones are viewer, operator, admin
    description: Mapped[str] = mapped_column(default="", server_default="")
    builtin: Mapped[bool] = mapped_column(default=False, server_default=text("false"))
    # A custom role's ids. Whatever is stored, effective_permissions() decides what it grants; a built-in role's
    # list is only a mirror (its permissions come from dcdash.core.permissions.BUILTIN).
    permissions: Mapped[list[Any]] = mapped_column(JSONB, default=list, server_default=text("'[]'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())

    @property
    def effective_permissions(self) -> frozenset[str]:
        """What the role really grants (see dcdash.core.permissions.effective_permissions)."""
        return effective_permissions(self.name, self.builtin, self.permissions)


def _known(ids: tuple[str, ...]) -> frozenset[str]:
    if not ids:
        raise ValueError("name at least one permission")
    unknown = [i for i in ids if i not in ALL_IDS]
    if unknown:
        raise ValueError(f"unknown permission {unknown[0]!r}")
    return frozenset(ids)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str]
    password_hash: Mapped[str]
    role_id: Mapped[int] = mapped_column(ForeignKey("roles.id", ondelete="RESTRICT"))
    # Loaded with the user (one query, the role's name and permissions are never a second round trip). Build a user with
    # `role_row=<the Role>`, never with `role_id` alone: reading `.role` or `.permissions` on a user whose role is not
    # loaded would lazy-load outside the async context. `.role` and `.permissions` have no setter: to change a role, assign
    # `role_row`.
    role_row: Mapped[Role] = relationship(lazy="joined", innerjoin=True)
    active: Mapped[bool] = mapped_column(default=True)
    preferences: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))

    # In a query use `role_id` (or join Role): on the class `role` is this property, not a column, and a comparison with
    # it compiles to WHERE false (test_permissions.py greps dcdash/ for it).
    @property
    def role(self) -> str:
        """The name of the account's role (viewer, operator, admin or a custom role's name)."""
        return self.role_row.name

    @property
    def permissions(self) -> frozenset[str]:
        """What the account may do, computed from the role every time it is read (no cache: a change applies next request)."""
        return self.role_row.effective_permissions

    def can(self, *ids: str) -> bool:
        """True when the account holds ALL of these permissions. An unknown id, or none at all, is a ValueError.

        For ids written in the code. To compare with a computed set (a role's, another account's) which may be empty,
        compare the sets: `other.permissions <= user.permissions`.
        """
        return _known(ids) <= self.permissions

    def can_any(self, *ids: str) -> bool:
        """True when the account holds at least ONE of these permissions. An unknown id, or none at all, is a ValueError."""
        return not _known(ids).isdisjoint(self.permissions)


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
    # None is SQL NULL, never a JSON null: queries test IS NULL
    identity: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))

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
    icon: Mapped[str | None]  # an id from core/asset_icons.py; NULL = Automatic (the icon follows the kind)


class AssetKind(Base):
    """A kind an administrator has set up and the icon its assets show unless they have one of their own. `assets.kind` stays
    free text with no foreign key: an asset belongs to a registry row when kind_key(asset.kind) equals the row's key."""

    __tablename__ = "asset_kinds"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    key: Mapped[str]  # core.asset_kinds.kind_key(name); unique, so "Rack" and " rack " are one kind
    icon: Mapped[str] = mapped_column(default="generic", server_default="generic")  # an id from core/asset_icons.py
    created_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())


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
    # w35: the freshness of the newest GOOD reading (quality 0 and a value). NULL until a Good reading has been written since 0018.
    good_at: Mapped[datetime | None] = mapped_column(TZ)
    good_value: Mapped[float | None]
    changed_at: Mapped[datetime | None] = mapped_column(TZ)  # when good_value last changed to its present value


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


class BillingClose(Base):
    """A closed billing month: the exact output of month_costs() at close time, kept in `figures`. A reopened row is kept (the
    reopened_* columns are set together); a re-close inserts a new row. At most one row per month is open (a partial unique
    index on `month` where `reopened_at IS NULL`)."""

    __tablename__ = "billing_closes"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    month: Mapped[str]  # 'YYYY-MM', the API's own month format (a CHECK in migration 0012)
    closed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    closed_name: Mapped[str]  # the name shown when the month was closed; it outlives the account
    closed_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())
    note: Mapped[str] = mapped_column(default="", server_default="")
    timezone: Mapped[str]
    currency: Mapped[str | None]
    total_kwh: Mapped[float]
    total_cost: Mapped[float | None]
    figures: Mapped[dict[str, Any]] = mapped_column(JSONB)
    reopened_at: Mapped[datetime | None] = mapped_column(TZ)
    reopened_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    reopened_name: Mapped[str | None]
    reopen_note: Mapped[str | None]


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


class Playlist(Base):
    """An ordered list of dashboards (its `PlaylistItem` rows) that a display shows. The name is unique (migration 0015)."""

    __tablename__ = "playlists"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())


class PlaylistItem(Base):
    """One dashboard of a playlist, shown for `seconds` (10 to 3600, a CHECK). Order is (position, id). `dashboard_id` becomes NULL
    when the dashboard is deleted and `dashboard_name` keeps the name from the last save; `focus_asset_id` has NO foreign key (a
    deleted asset leaves the item, which is then skipped) and `focus_name` keeps its name from the last save."""

    __tablename__ = "playlist_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    playlist_id: Mapped[int] = mapped_column(ForeignKey("playlists.id", ondelete="CASCADE"))
    position: Mapped[int]
    dashboard_id: Mapped[int | None] = mapped_column(ForeignKey("dashboards.id", ondelete="SET NULL"))
    dashboard_name: Mapped[str | None]
    focus_asset_id: Mapped[int | None]  # no foreign key, on purpose
    focus_name: Mapped[str | None]
    seconds: Mapped[int] = mapped_column(default=60, server_default=text("60"))


class Display(Base):
    """A screen with a secret link. Only the SHA-256 hash of the secret is stored (`secret_hash`, unique); a revoked link keeps
    its row (`revoked_at`). Its playlist cannot be deleted while the row exists (ON DELETE RESTRICT)."""

    __tablename__ = "displays"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    playlist_id: Mapped[int] = mapped_column(ForeignKey("playlists.id", ondelete="RESTRICT"))
    secret_hash: Mapped[str]
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())
    last_seen_at: Mapped[datetime | None] = mapped_column(TZ)
    last_client: Mapped[str | None]
    revoked_at: Mapped[datetime | None] = mapped_column(TZ)
    revoked_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    action: Mapped[str]
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    actor_id: Mapped[int | None]  # the user's id when the row was written; no foreign key, so it outlives the user
    actor_name: Mapped[str | None]  # filled by the audit_log_snapshot_actor trigger (migration 0005)
    ts: Mapped[datetime] = mapped_column(TZ, server_default=func.now())


class DiagEvent(Base):
    __tablename__ = "diag_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    ts: Mapped[datetime] = mapped_column(TZ, server_default=func.now())
    level: Mapped[str]  # info | warning | error (a CHECK in migration 0006)
    component: Mapped[str]  # collector | api | scan | job
    source_id: Mapped[int | None]  # no foreign key: the journal outlives the source
    kind: Mapped[str]
    code: Mapped[str | None]
    message: Mapped[str]
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
