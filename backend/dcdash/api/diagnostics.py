"""Field diagnostics: which build is running here, and the report an admin pastes to get a failure diagnosed.

`GET /api/diagnostics/report` wires the pieces of `dcdash.diagnostics`: `load_known` (what must be hidden, read first and fail
closed), `gather` (the facts), `render` (the text, every free-text value scrubbed and, for `mask=1`, masked before it is clipped),
a second masking pass over the finished body, and `finalize` (parts, footers and the checksum, computed on the masked text).
The audit row is written after the report exists and records only how it was asked for, never what it said.
"""
import re
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import COOKIE, account_vanished_is_401, current_user, get_db, require_permission
from dcdash.core.audit import audit
from dcdash.core.build import build_info, uptime_seconds
from dcdash.core.models import User
from dcdash.diagnostics.redact import FORMAT, Masker, clip, finalize, scrub
from dcdash.diagnostics.report import LINE_LIMIT, gather, load_known, load_source_hosts, mask_names, render

router = APIRouter(prefix="/api", tags=["diagnostics"])

_ALIAS = re.compile(r"\b(?:HOST|URN)-\d+\b")
NO_STORE = {"Cache-Control": "no-store"}  # a report is not something a browser or a proxy should keep


class VersionOut(BaseModel):
    build_id: str
    build_time: str
    uptime_seconds: float


@router.get("/version", response_model=VersionOut, dependencies=[Depends(current_user)])
async def get_version() -> VersionOut:
    """The build this api process runs (the commit it was built from) and how long it has been up."""
    info = build_info()
    return VersionOut(build_id=info.build_id, build_time=info.build_time, uptime_seconds=round(uptime_seconds(), 1))


def _second_net(body: str, known: list[str], masker: Masker | None) -> str:
    """The finished body once more through `scrub` and, for a masked report, the masker that handled every value: whatever `render`
    wrote without the transform is covered too. Section titles are left alone (a host called `storage` must not rename
    `== STORAGE AND RETENTION ==`), and a line an alias made longer is cut again."""

    def net(line: str) -> str:
        if line.startswith("== "):
            return line
        line = scrub(line, known)
        return clip(masker.mask(line) if masker else line, LINE_LIMIT)

    return "\n".join(map(net, body.split("\n")))


@router.get(
    "/diagnostics/report", response_model=None, dependencies=[Depends(require_permission("diagnostics.view"))]
)
async def get_report(
    request: Request,
    detail: Literal["summary", "full"] = "summary",
    mask: Annotated[int, Query(ge=0, le=1)] = 0,
    source: Annotated[int | None, Query(ge=1, le=2_147_483_647)] = None,
    fmt: Annotated[Literal["text", "json"], Query(alias="format")] = "text",
    client_time: datetime | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
) -> Response:
    """The diagnostics report, as the text to paste (`format=text`, parts joined by a blank line) or as JSON with the parts, the
    checksum and, for `mask=1`, the legend that says which alias stands for which host (for the page only, never in the text).

    `client_time` is the browser's clock; the report compares it with the container's (the container and the database share one
    VM clock, so only the browser can witness that drifting). Needs diagnostics.view: it holds settings, retention, the audit tail and the
    sources' security settings.
    """
    user_id = user.id
    # The session's token is a secret the database never holds (only its hash); this request's own cookie is one more value to hide.
    own_token = request.cookies.get(COOKIE)
    known = await load_known(db, extra=[own_token] if own_token else ())
    source_hosts = await load_source_hosts(db) if mask else None  # all sources, not only the filtered one; fails closed
    data = await gather(db, detail=detail, source_id=source, client_time=client_time)
    masker = Masker(*mask_names(data, source_hosts)) if mask else None
    transform = (lambda value: masker.mask(scrub(value, known))) if masker else (lambda value: scrub(value, known))
    body = _second_net(render(data, detail, transform, masked=bool(mask)), known, masker)
    parts = finalize(body, build_info().build_id, data.generated_at)
    text = parts.text()
    async with account_vanished_is_401(db):  # the audit row needs the acting admin
        await audit(
            db, user_id, "diagnostics.report",
            {"detail": detail, "mask": bool(mask), "source_id": source, "parts": len(parts.parts), "chars": len(text)},
        )
        await db.commit()
    if fmt == "text":
        return PlainTextResponse(text, headers=NO_STORE)
    shown = set(_ALIAS.findall(text))  # aliases of lines `render` trimmed away stay in the masker's legend
    legend = [entry for entry in masker.legend() if entry["alias"] in shown] if masker else []
    return JSONResponse(
        {
            "format": FORMAT,
            "build_id": parts.build_id,
            "detail": detail,
            "mask": bool(mask),
            "checksum": parts.checksum,
            "parts": [{"index": p.index, "of": p.of, "text": p.text, "chars": p.chars, "lines": p.lines} for p in parts.parts],
            "legend": legend,
        },
        headers=NO_STORE,
    )
