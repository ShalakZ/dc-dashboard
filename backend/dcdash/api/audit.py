import json
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from pydantic import StringConstraints
from sqlalchemy import ColumnElement, Select, Text, cast, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from dcdash.api.deps import get_db, require_permission
from dcdash.api.settings import current_timezone
from dcdash.core.csvout import write_csv
from dcdash.core.models import Asset, AuditLog, Dashboard, Point, Source, User
from dcdash.core.timeutil import local_midnight

router = APIRouter(prefix="/api", tags=["audit"])

# An exact action, or one `*` at the start and/or end (`*.deleted`, `login.*`).
ACTION = Annotated[str, StringConstraints(pattern=r"^\*?[a-z0-9_.]+\*?$", max_length=60)]

# The export is built in memory on the one API worker: 100,000 rows measured 10 s and 446 MB.
EXPORT_LIMIT = 20_000
CSV_HEADER = ("id", "time", "user", "action", "detail")


@dataclass
class AuditFilter:
    user: str | None  # an actor id as digits, or "none" for entries without an actor
    actions: list[str]
    date_from: date | None
    date_to: date | None
    q: str | None


def _check_day(day: date) -> date:
    if not 1970 <= day.year <= 2100:  # a browser date input accepts year 275760; `day + 1` overflows at 9999-12-31
        raise HTTPException(422, "dates must be between 1970 and 2100")
    return day


def audit_filter(
    user: Annotated[str | None, Query(pattern=r"^(none|[0-9]{1,9})$")] = None,
    action: Annotated[list[ACTION], Query(max_length=20)] = [],
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
    q: Annotated[str | None, Query(max_length=200, pattern=r"^[^\x00]*$")] = None,  # Postgres text cannot hold a NUL
) -> AuditFilter:
    if date_from is not None:
        _check_day(date_from)
    if date_to is not None:
        _check_day(date_to)
    if date_from is not None and date_to is not None and date_from > date_to:
        raise HTTPException(422, "from must not be after to")
    return AuditFilter(user, list(action), date_from, date_to, (q or "").strip() or None)


def _literal(text: str) -> str:
    """`text` with LIKE's metacharacters made literal (use with escape="\\")."""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _action_clause(pattern: str) -> ColumnElement[bool]:
    if "*" not in pattern:
        return AuditLog.action == pattern
    like = ("%" if pattern.startswith("*") else "") + _literal(pattern.strip("*")) + ("%" if pattern.endswith("*") else "")
    return AuditLog.action.like(like, escape="\\")


def where_clauses(f: AuditFilter, tz: str) -> list[ColumnElement[bool]]:
    """The WHERE conditions of a filter; days are days in the site time zone `tz`, both ends inclusive."""
    clauses: list[ColumnElement[bool]] = []
    if f.user is not None:
        clauses.append(AuditLog.actor_id.is_(None) if f.user == "none" else AuditLog.actor_id == int(f.user))
    if f.actions:
        clauses.append(or_(*(_action_clause(pattern) for pattern in f.actions)))
    if f.date_from is not None:
        clauses.append(AuditLog.ts >= local_midnight(f.date_from, tz))
    if f.date_to is not None:
        clauses.append(AuditLog.ts < local_midnight(f.date_to + timedelta(days=1), tz))
    if f.q is not None:
        plain = f"%{_literal(f.q)}%"
        # jsonb::text writes `"` and `\` escaped, so the detail is searched for the escaped spelling of the text
        in_json = f"%{_literal(json.dumps(f.q, ensure_ascii=False)[1:-1])}%"
        clauses.append(
            or_(
                AuditLog.action.ilike(plain, escape="\\"),
                func.coalesce(AuditLog.actor_name, "").ilike(plain, escape="\\"),
                cast(AuditLog.detail, Text).ilike(in_json, escape="\\"),
            )
        )
    return clauses


def _entries() -> Select[Any]:
    return select(AuditLog, func.coalesce(AuditLog.actor_name, User.username)).outerjoin(
        User, User.id == AuditLog.user_id
    )


# The detail keys that hold the id of something with a name, and which kind of thing each one points at.
REF_KEYS = {
    "asset_id": "asset", "parent_id": "asset", "user_id": "user",
    "source_id": "source", "dashboard_id": "dashboard", "point_id": "point",
}
# For each kind, the id and the ONE column that names it: nothing else of these rows (config, secret, hash) is read.
REF_COLUMNS = {
    "asset": (Asset.id, Asset.name), "user": (User.id, User.username), "source": (Source.id, Source.name),
    "dashboard": (Dashboard.id, Dashboard.name), "point": (Point.id, Point.name),
}
MAX_ID = 2_147_483_647  # the database's integer; a stored detail is arbitrary JSON and must never push a bigger one into an IN


def _ref_ids(detail: Any) -> dict[str, set[int]]:
    """The ids an entry's detail points at, by kind: read from the detail itself and from its `before` and `after`
    objects (one level, no deeper). Only a real positive integer in range counts (not a bool, string, float or list)."""
    ids: dict[str, set[int]] = {}
    if not isinstance(detail, dict):
        return ids
    for scope in (detail, detail.get("before"), detail.get("after")):
        if not isinstance(scope, dict):
            continue
        for key, kind in REF_KEYS.items():
            value = scope.get(key)
            if type(value) is int and 0 < value <= MAX_ID:
                ids.setdefault(kind, set()).add(value)
    return ids


async def _refs_for(db: AsyncSession, entries: Sequence[AuditLog]) -> list[dict[str, dict[str, str]]]:
    """For each entry, the current names of the things its detail points at: `{kind: {"id": name}}`. A kind or an id
    that no longer exists is left out (the caller reads that as a deleted target); an entry with none gets `{}`.
    One query per kind that has ids, for all the entries together, and none for a kind without ids."""
    wanted = [_ref_ids(entry.detail) for entry in entries]
    names: dict[str, dict[int, str]] = {}
    for kind, (id_column, name_column) in REF_COLUMNS.items():
        every_id = set().union(*(ids_by_kind.get(kind, ()) for ids_by_kind in wanted))
        if every_id:
            names[kind] = dict((await db.execute(select(id_column, name_column).where(id_column.in_(every_id)))).all())
    refs = []
    for ids_by_kind in wanted:
        found: dict[str, dict[str, str]] = {}
        for kind, ids in ids_by_kind.items():
            current = {str(i): names[kind][i] for i in sorted(ids) if i in names[kind]}
            if current:
                found[kind] = current
        refs.append(found)
    return refs


def _item(entry: AuditLog, username: str | None, refs: dict[str, dict[str, str]]) -> dict[str, Any]:
    return {
        "id": entry.id, "user_id": entry.user_id, "actor_id": entry.actor_id, "username": username,
        "action": entry.action, "detail": entry.detail, "ts": entry.ts, "refs": refs,
    }


@router.get("/audit", dependencies=[Depends(require_permission("audit.view"))])
async def list_audit(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0, le=2_147_483_647),  # the database takes a 32-bit offset
    f: AuditFilter = Depends(audit_filter),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    clauses = where_clauses(f, await current_timezone(db))
    total = await db.scalar(select(func.count()).select_from(AuditLog).where(*clauses))
    rows = (await db.execute(_entries().where(*clauses).order_by(AuditLog.id.desc()).limit(limit).offset(offset))).all()
    refs = await _refs_for(db, [entry for entry, _ in rows])
    items = [_item(entry, username, entry_refs) for (entry, username), entry_refs in zip(rows, refs, strict=True)]
    return {"total": total, "offset": offset, "limit": limit, "items": items}


@router.get("/audit.csv", dependencies=[Depends(require_permission("audit.export"))])
async def audit_csv(f: AuditFilter = Depends(audit_filter), db: AsyncSession = Depends(get_db)) -> Response:
    """The filtered log as it is stored (not the friendly text), newest first; too many rows is a 422, never a short file."""
    tz = await current_timezone(db)
    clauses = where_clauses(f, tz)
    rows = (
        await db.execute(
            select(AuditLog.id, AuditLog.ts, func.coalesce(AuditLog.actor_name, User.username), AuditLog.action, AuditLog.detail)
            .outerjoin(User, User.id == AuditLog.user_id)
            .where(*clauses)
            .order_by(AuditLog.id.desc())
            .limit(EXPORT_LIMIT + 1)
        )
    ).all()
    if len(rows) > EXPORT_LIMIT:
        matched = await db.scalar(select(func.count()).select_from(AuditLog).where(*clauses))
        raise HTTPException(
            422,
            f"{matched:,} entries match; the export holds at most {EXPORT_LIMIT:,}. Narrow the date range and try again.",
        )
    zone = ZoneInfo(tz)
    lines = (
        [entry_id, ts.astimezone(zone), username or "", action, json.dumps(detail, ensure_ascii=False)]
        for entry_id, ts, username, action, detail in rows
    )
    body = await run_in_threadpool(write_csv, CSV_HEADER, lines)
    stamp = datetime.now(zone).strftime("%Y%m%d-%H%M")
    return Response(
        body, media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="audit-{stamp}.csv"'}
    )


@router.get("/audit/options", dependencies=[Depends(require_permission("audit.view"))])
async def audit_options(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    actions = (await db.scalars(select(AuditLog.action).distinct().order_by(AuditLog.action))).all()
    newest = (
        select(func.max(AuditLog.id)).where(AuditLog.actor_id.is_not(None)).group_by(AuditLog.actor_id)
    )  # the newest entry of each actor carries the name to show
    actors = await db.execute(
        select(AuditLog.actor_id, AuditLog.actor_name, User.id.is_(None))
        .outerjoin(User, User.id == AuditLog.actor_id)
        .where(AuditLog.id.in_(newest))
    )
    named = sorted(
        ((actor_id, name or f"#{actor_id}", gone) for actor_id, name, gone in actors),
        key=lambda a: (a[1].casefold(), a[0]),
    )
    labels = [(actor_id, name, f"{name}{' (deleted)' if gone else ''}") for actor_id, name, gone in named]
    # A deleted `bob` and a new `bob` would otherwise read alike, and a deleted `bob` and a live account that is
    # literally called `bob (deleted)` end in the same label; both cases get the id.
    same_name = Counter(name for _, name, _ in labels)
    same_label = Counter(label for _, _, label in labels)
    users = [
        {"id": actor_id, "name": f"{label} #{actor_id}" if same_name[name] > 1 or same_label[label] > 1 else label}
        for actor_id, name, label in labels
    ]
    unattributed = await db.scalar(select(exists().where(AuditLog.actor_id.is_(None))))
    return {"actions": list(actions), "users": users, "unattributed": bool(unattributed)}


@router.get("/audit/position", dependencies=[Depends(require_permission("audit.view"))])
async def audit_position(
    day: Annotated[date, Query(alias="date")],
    f: AuditFilter = Depends(audit_filter),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Where the list (newest id first) should start to show `day`: the newest matching entry written before the day
    ended, so newer entries stay reachable with Previous."""
    _check_day(day)
    tz = await current_timezone(db)
    clauses = where_clauses(f, tz)
    total = await db.scalar(select(func.count()).select_from(AuditLog).where(*clauses)) or 0
    end = local_midnight(day + timedelta(days=1), tz)
    anchor = (
        await db.execute(
            select(AuditLog.id, AuditLog.ts).where(*clauses, AuditLog.ts < end).order_by(AuditLog.id.desc()).limit(1)
        )
    ).first()
    if anchor is None:
        return {"offset": max(total - 1, 0), "total": total, "on_day": False}
    newer = await db.scalar(select(func.count()).select_from(AuditLog).where(*clauses, AuditLog.id > anchor.id))
    return {"offset": newer, "total": total, "on_day": anchor.ts >= local_midnight(day, tz)}


@router.get("/audit/{entry_id:int}", dependencies=[Depends(require_permission("audit.view"))])
async def get_audit_entry(
    entry_id: Annotated[int, Path(ge=1, le=2_147_483_647)], db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    row = (await db.execute(_entries().where(AuditLog.id == entry_id))).first()
    if row is None:
        raise HTTPException(404, "audit entry not found")
    entry, username = row
    return _item(entry, username, (await _refs_for(db, [entry]))[0])
