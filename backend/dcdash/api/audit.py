import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from pydantic import StringConstraints
from sqlalchemy import ColumnElement, Select, Text, cast, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from dcdash.api.deps import get_db, require_role
from dcdash.api.settings import current_timezone
from dcdash.core.csvout import write_csv
from dcdash.core.models import AuditLog, User
from dcdash.core.timeutil import local_midnight

router = APIRouter(prefix="/api", tags=["audit"], dependencies=[Depends(require_role("admin"))])

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
    q: Annotated[str | None, Query(max_length=200)] = None,
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


def _item(entry: AuditLog, username: str | None) -> dict[str, Any]:
    return {
        "id": entry.id, "user_id": entry.user_id, "actor_id": entry.actor_id, "username": username,
        "action": entry.action, "detail": entry.detail, "ts": entry.ts,
    }


@router.get("/audit")
async def list_audit(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    f: AuditFilter = Depends(audit_filter),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    clauses = where_clauses(f, await current_timezone(db))
    total = await db.scalar(select(func.count()).select_from(AuditLog).where(*clauses))
    rows = await db.execute(_entries().where(*clauses).order_by(AuditLog.id.desc()).limit(limit).offset(offset))
    return {"total": total, "offset": offset, "limit": limit, "items": [_item(e, username) for e, username in rows]}


@router.get("/audit.csv")
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


@router.get("/audit/options")
async def audit_options(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    actions = (await db.scalars(select(AuditLog.action).distinct().order_by(AuditLog.action))).all()
    newest = (
        select(func.max(AuditLog.id)).where(AuditLog.actor_id.is_not(None)).group_by(AuditLog.actor_id)
    )  # the newest entry of each actor carries the name to show
    actors = await db.execute(select(AuditLog.actor_id, AuditLog.actor_name).where(AuditLog.id.in_(newest)))
    users = sorted(
        ({"id": actor_id, "name": name or f"#{actor_id}"} for actor_id, name in actors),
        key=lambda u: (u["name"].casefold(), u["id"]),
    )
    unattributed = await db.scalar(select(exists().where(AuditLog.actor_id.is_(None))))
    return {"actions": list(actions), "users": users, "unattributed": bool(unattributed)}


@router.get("/audit/position")
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


@router.get("/audit/{entry_id:int}")
async def get_audit_entry(
    entry_id: Annotated[int, Path(ge=1, le=2_147_483_647)], db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    row = (await db.execute(_entries().where(AuditLog.id == entry_id))).first()
    if row is None:
        raise HTTPException(404, "audit entry not found")
    return _item(*row)
