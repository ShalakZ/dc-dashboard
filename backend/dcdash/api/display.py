"""The display credential and the three routes a connected display screen may call (w28).

A display is a browser that opened a secret link: `POST /api/display/claim` swaps the secret in a JSON body for the cookie
`dcdash_display` (HttpOnly, SameSite=Strict, Path=/api/display). `current_display` is the ONE dependency that reads that cookie.
It is not an account: it never starts a session, never looks at a sign-in cookie and grants nothing but the three routes below,
and a signed-in account's cookie means nothing on them. Only the SHA-256 hash of the secret is stored; every request looks the
row up again (no cache of any kind), so a revoked or deleted display is refused on its very next request.

  POST /api/display/claim        the secret in the body is the credential; WRONG secrets are counted per client address (ten block
                                 that address for fifteen minutes) and a right secret is never refused by that block; the claims of
                                 one display are capped, and a claim shares one cap of 12 with the data requests
  GET  /api/display/playlist     the display's own playlist, its dashboards and widgets, the site timezone, the build, the status
  POST /api/display/widget-data  the figures of one widget of that playlist, by ids; the stored config is used, never a sent one

The secret, its hash and the link never reach a log line, an audit row, an exception message or an answer (the create answer of
the admin routes is the one exception). Nothing here echoes the request body.
"""
import logging
import math
import re
import time
from collections.abc import AsyncIterator, Callable
from typing import Annotated, Any, NoReturn, TypeVar
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidationError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.auth import _is_https
from dcdash.api.deps import get_db
from dcdash.api.health import LiveStatus, read_live_status
from dcdash.api.security import LoginLimiter
from dcdash.api.security_events import RowBudget, client_address
from dcdash.api.settings import current_timezone
from dcdash.api.widget_data import WidgetDataRequest, compute_checked
from dcdash.core.audit import audit
from dcdash.core.build import build_info
from dcdash.core.db import get_sessionmaker
from dcdash.core.displays import DISPLAY_WIDGET_BUDGET_PER_MINUTE, MAX_DISPLAYS, ItemView, Skip, hash_secret, resolve_items
from dcdash.core.models import Display, Playlist

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/display", tags=["display"])

COOKIE = "dcdash_display"
COOKIE_MAX_AGE = 34_560_000  # 400 days, the longest a browser keeps a cookie; the link itself never expires
INVALID_LINK = "this display link is not valid"  # the one text for a wrong, a revoked and a deleted secret
NOT_CONNECTED = "not connected"
NOT_FOUND = "not found"  # the one text of every widget-data 404
SITE_NAME = "DC Dashboard"  # the site has no name setting (`/api/site` has a timezone and a currency only): the app title
MAX_ID = 2_147_483_647
CLAIM_BODY_LIMIT = 1024  # bytes: a claim is {"secret": "<43 characters>"}; anything bigger is refused unread
PLAYLIST_BUDGET_PER_MINUTE = 30  # a screen asks once a minute; this leaves room for reloads and a few screens behind one proxy
LAST_SEEN_EVERY_SECONDS = 50  # the playlist answer writes last_seen_at at most this often, so a 60 s poll always writes
# What a display may hold past its lookup, in ONE count: its data requests (the playlist, the figures) and its claims. The request pool
# is 5 + 10 = 15 connections and each of these holds one until its answer is out, so a hard cap of 12 leaves 3 for the people using the
# dashboard; the total never passes it. RESERVE slots INSIDE the cap are kept for displays with nothing in flight: a display that
# already holds one is let in only while fewer than 12 - 3 = 9 are held, so two abused links cannot take the last 3 and stall every
# other screen, which is let in (its first request, or its claim) while fewer than 12 are held.
PER_DISPLAY_IN_FLIGHT = 6
ALL_DISPLAYS_IN_FLIGHT = 12
RESERVE = 3
CLAIMS_IN_FLIGHT = 3  # claims of a valid link being answered at once, a part of the 12 (each holds a connection and the display's row lock)
CLAIM_BUDGET_PER_MINUTE = 30  # claims of ONE display in a minute: a kiosk claims once per start, so this is room for a restart loop
FORCED_ROWS_PER_HOUR = 20  # the "new address" display.connected rows a display may write over its ordinary budget
BUSY = "busy, try again"
# What a secret can look like (`secrets.token_urlsafe`). Anything else cannot be a secret: it is refused before it is hashed.
_SECRET_SHAPE = re.compile(r"[A-Za-z0-9_-]{1,64}")
_DEFAULT_PORT = {"http": 80, "https": 443}

Budget = TypeVar("Budget", bound=RowBudget)


class ConnectedBudget(RowBudget):
    """The `display.connected` rows of ONE display (10 in 5 minutes). A claim from an address the display was not last seen at is
    written over that budget too, because that row is what an administrator needs to see - but at most `forced_cap` such rows in
    `forced_window` seconds (20 an hour), since two addresses taking turns are each "new" every time."""

    def __init__(
        self, cap: int, window_seconds: float, clock: Callable[[], float] = time.monotonic,
        forced_cap: int = FORCED_ROWS_PER_HOUR, forced_window: float = 3600.0,
    ) -> None:
        super().__init__(cap, window_seconds, clock)
        self._forced = RowBudget(forced_cap, forced_window, clock)

    def take_row(self, must_write: bool) -> int | None:
        """Like `take()`: None when the row is left out, else how many were left out since the last row. With `must_write` the row
        is left out only when the forced budget is spent too; the refused count it carries is then the count of the claims before it,
        and a row that is left out stays counted for the next one."""
        refused = self.take()
        if refused is None and must_write and self._forced.take() is not None:
            self._refused -= 1  # take() counted this claim among the left-out ones, but it is written
            refused, self._refused = self._refused, 0
        return refused

    def clear(self) -> None:
        super().clear()
        self._forced.clear()


class InFlight:
    """Everything that holds a database connection past its lookup, in ONE count: the data requests (the playlist, the figures) being
    answered right now and the claims of a valid link, in total and per display (`claims` is the part of `total` that are claims).
    Plain integers changed only between two awaits, so there is no lock to forget or to deadlock on."""

    def __init__(self) -> None:
        self.total = 0
        self.by_display: dict[int, int] = {}
        self.claims = 0

    def _take(self, display_id: int) -> bool:
        """The one rule for a slot of the hard cap: a display with nothing in flight is let in while `total` is under
        ALL_DISPLAYS_IN_FLIGHT; one that already holds a slot only while it is under ALL_DISPLAYS_IN_FLIGHT - RESERVE and the display
        is under PER_DISPLAY_IN_FLIGHT. False (and nothing changes) otherwise, so `total` never passes the cap."""
        mine = self.by_display.get(display_id, 0)
        if mine == 0:
            allowed = self.total < ALL_DISPLAYS_IN_FLIGHT
        else:
            allowed = self.total < ALL_DISPLAYS_IN_FLIGHT - RESERVE and mine < PER_DISPLAY_IN_FLIGHT
        if allowed:
            self.total += 1
            self.by_display[display_id] = mine + 1
        return allowed

    def enter(self, display_id: int) -> bool:
        """Take a slot for a data request; False when the display or all displays together are at their cap."""
        return self._take(display_id)

    def claims_full(self) -> bool:
        return self.claims >= CLAIMS_IN_FLIGHT

    def enter_claim(self, display_id: int) -> bool:
        """Take a slot for a claim of that display: the same rule as a data request, and no more than CLAIMS_IN_FLIGHT claims at once
        (so claims cannot fill the cap). False (and nothing changes) over either."""
        if self.claims_full() or not self._take(display_id):
            return False
        self.claims += 1
        return True

    def leave_claim(self, display_id: int) -> None:
        self.claims = max(0, self.claims - 1)
        self.leave(display_id)

    def leave(self, display_id: int) -> None:
        self.total = max(0, self.total - 1)
        left = self.by_display.get(display_id, 0) - 1
        if left > 0:
            self.by_display[display_id] = left
        else:
            self.by_display.pop(display_id, None)

    def clear(self) -> None:
        self.total = 0
        self.by_display.clear()
        self.claims = 0


# Module state, in one place; `reset_display_state` empties it (the test fixture calls it). One api worker, like the sign-in limiter:
# with more workers each would count on its own.
claim_limiter = LoginLimiter(10, 900)  # 10 wrong secrets from one address in 15 minutes block that address for 15 minutes
blocked_budget = RowBudget(10, 300)  # display.claim_blocked rows
connected_budgets: dict[int, ConnectedBudget] = {}  # display.connected rows, per display id: one noisy screen cannot silence the rest
widget_budgets: dict[int, RowBudget] = {}  # per display id; all four dicts are bounded by `_budget`
playlist_budgets: dict[int, RowBudget] = {}
claim_budgets: dict[int, RowBudget] = {}  # the claims of a valid link, per display id
in_flight = InFlight()


def reset_display_state() -> None:
    claim_limiter.clear()
    blocked_budget.clear()
    connected_budgets.clear()
    widget_budgets.clear()
    playlist_budgets.clear()
    claim_budgets.clear()
    in_flight.clear()


# --- the credential ---------------------------------------------------------------------------------------------------------


async def current_display(request: Request, db: AsyncSession = Depends(get_db)) -> AsyncIterator[Display]:
    """The display that holds the cookie, or 401. The row is read again on every request: revoking takes effect at once.

    It also holds one of the display's in-flight slots until the answer is out (a yield dependency: FastAPI runs the `finally` after
    the response, on an error and when the request is cancelled). The slot is one of the 12 all displays share with the claims; a
    display that already holds one is turned away at 9 (the last 3 are for displays with nothing in flight) or at its own 6, and a
    display with nothing in flight at 12. It gets 429 "busy" with `Retry-After: 1`, and only a display that is connected learns
    that: a stranger gets the 401."""
    token = request.cookies.get(COOKIE)
    display = None
    if token and _SECRET_SHAPE.fullmatch(token):  # a longer or odd value cannot be a secret: 401 without hashing it
        display = await db.scalar(
            select(Display).where(Display.secret_hash == hash_secret(token), Display.revoked_at.is_(None))
        )
    if display is None:
        raise HTTPException(401, INVALID_LINK if token else NOT_CONNECTED)  # a cookie that was sent but matches no active display says so: a revoked screen can show "revoked"
    display_id = display.id  # (read before the route commits: a committed row is expired and cannot be read in an async session)
    if not in_flight.enter(display_id):
        raise HTTPException(429, BUSY, headers={"Retry-After": "1"})
    try:
        yield display
    finally:
        in_flight.leave(display_id)


# --- the claim --------------------------------------------------------------------------------------------------------------


class ClaimBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    secret: str = Field(min_length=1, max_length=64)


def _authority(scheme: str, hostname: str | None, port: int | None) -> str | None:
    """host[:port] in one spelling: lower case (urlsplit does that), IPv6 in brackets, the scheme's default port dropped."""
    if not hostname:
        return None
    host = f"[{hostname}]" if ":" in hostname else hostname
    return host if port is None or port == _DEFAULT_PORT[scheme] else f"{host}:{port}"


def _origin_parts(origin: str) -> tuple[str, str] | None:
    """The (scheme, host:port) an Origin header names, None when it is not a plain http(s) origin (`null`, no scheme, junk)."""
    try:
        parts = urlsplit(origin)
        scheme, port = parts.scheme.lower(), parts.port
    except ValueError:
        return None
    if scheme not in _DEFAULT_PORT or parts.username is not None or parts.password is not None:
        return None
    if parts.path or parts.query or parts.fragment:
        return None
    authority = _authority(scheme, parts.hostname, port)
    return None if authority is None else (scheme, authority)


def _host_authority(request: Request) -> str | None:
    host = request.headers.get("host")
    if not host:
        return None
    try:
        parts = urlsplit("//" + host)
        port = parts.port
    except ValueError:
        return None
    if parts.username is not None or parts.password is not None or parts.path or parts.query or parts.fragment:
        return None
    return _authority("https" if _is_https(request) else "http", parts.hostname, port)


def _comes_from_another_site(request: Request) -> bool:
    """The CSRF rule: a hostile page must not make a visitor's browser a display. Headers a browser sets itself are judged;
    a request without them (curl, a script, an old browser) passes, because the secret is the credential."""
    if request.headers.get("sec-fetch-site", "").strip().lower() in ("cross-site", "same-site"):
        return True
    origin = request.headers.get("origin")
    if origin is None:
        return False
    named, own = _origin_parts(origin), _host_authority(request)
    # The scheme counts: https://host is another origin than http://host. The request's scheme is the one `_is_https` says (the
    # proxy's X-Forwarded-Proto on a TLS install), the host is the Host header the proxy passes through unchanged.
    return named is None or own is None or named != ("https" if _is_https(request) else "http", own)  # `Origin: null` is different


async def _read_claim(request: Request) -> ClaimBody:
    """The body of a claim: JSON only, small, and never quoted back in an error."""
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type != "application/json":
        raise HTTPException(422, "send the claim as JSON")
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > CLAIM_BODY_LIMIT:
            raise HTTPException(422, "the claim is too large")
    try:
        return ClaimBody.model_validate_json(bytes(raw))
    except ValidationError:
        raise HTTPException(422, "the claim must be a JSON object with a secret of 1 to 64 characters") from None


def _retry_after(seconds: float) -> dict[str, str]:
    return {"Retry-After": str(max(1, math.ceil(seconds)))}


@router.post(
    "/claim", status_code=204, response_class=Response,
    openapi_extra={"requestBody": {"required": True, "content": {"application/json": {"schema": ClaimBody.model_json_schema()}}}},
)
async def claim(request: Request, db: AsyncSession = Depends(get_db)) -> Response:
    """Swap the secret of a display link for the display cookie. A RIGHT secret is never refused because of an address: on an
    install that loses client addresses (Docker Desktop) every client is one address, and a block that refused right secrets would
    let anyone keep every wall screen from reconnecting. The order is fixed, and only a wrong secret counts toward the block:
    another site (403), not JSON or a malformed body (422; 429 for a blocked address), claims in flight at the cap (503), then the
    lookup (401 for a wrong, a revoked and a deleted secret alike - 429 for a blocked address, uncounted and unwritten; a wrong or
    deleted one counts, a revoked one does not). A secret that is found is let in whatever the block says, within the claim budget
    of its display (429) and a slot of the one cap of 12 that data requests share, at most 3 of them for claims (503)."""
    client = client_address(request)
    if _comes_from_another_site(request):
        raise HTTPException(403, "a display link can only be opened from its own address")
    try:
        body = await _read_claim(request)
    except HTTPException:
        _refuse_a_blocked_address(client)  # a blocked address is told 429 whatever its claim lacks: it is no right secret
        raise
    if in_flight.claims_full():  # shed before any lookup: a claim that is turned away here holds no connection
        raise _claims_busy()

    row = None
    if _SECRET_SHAPE.fullmatch(body.secret):  # the revoked ones are found too: the work is the same for every kind of secret
        row = await db.scalar(select(Display).where(Display.secret_hash == hash_secret(body.secret)))
    if row is None or row.revoked_at is not None:
        await _refuse_a_claim(client, counted=row is None, db=db)
    display_id, display_name = row.id, row.name  # (read before anything commits: a committed row is expired)

    # Only a claim that FOUND a display takes a slot, so a flood of wrong secrets (which the block limits) can never use the slots up
    # and keep the real screens out. The check above is the same test made early; this one is the one that counts: the slot is one of
    # the 12 that data requests share (a claim of a display with nothing in flight needs fewer than 12 held, any other fewer than 9).
    if not in_flight.enter_claim(display_id):
        raise _claims_busy()
    try:
        budget = await _budget(claim_budgets, display_id, lambda: RowBudget(CLAIM_BUDGET_PER_MINUTE, 60), db)
        if budget.take() is None:  # a valid link claimed 30 times in a minute: not counted toward the block, no row
            raise HTTPException(429, BUSY, headers={"Retry-After": "60"})
        answer = Response(status_code=204)
        answer.set_cookie(
            COOKIE, body.secret, max_age=COOKIE_MAX_AGE, httponly=True, samesite="strict", path="/api/display",
            secure=_is_https(request),
        )
        answer.headers["Cache-Control"] = "no-store"
        # Where the display connected from is noted on its row (the playlist poll does the same, at most once in 50 s). A claim from an
        # address it was not last seen at is written over the ordinary row budget, but two addresses taking turns are each "new" every
        # time, so those forced rows have a budget of their own (20 an hour) and the rest are only counted.
        new_address = await _note_where_seen(db, display_id, client)
        connected = await _budget(connected_budgets, display_id, lambda: ConnectedBudget(10, 300), db)
        refused = connected.take_row(must_write=new_address)  # 10 rows in 5 minutes for a display, and 20 an hour for new addresses
        if refused is not None:
            detail: dict[str, object] = {"display_id": display_id, "name": display_name, "client": client}
            if refused:
                detail["suppressed_before"] = refused  # as the sign-in rows do: how many were left out since the last one
            await audit(db, None, "display.connected", detail)
        if new_address or refused is not None:
            await db.commit()
        return answer
    finally:
        in_flight.leave_claim(display_id)


def _claims_busy() -> HTTPException:
    """503 (not 429: a 429 on a claim reads as a blocked address), so the screen tries again a second later."""
    return HTTPException(503, BUSY, headers={"Retry-After": "1"})


def _refuse_a_blocked_address(client: str) -> None:
    """429 for an address that is blocked right now. The same text and the same header at every place that checks."""
    waiting = claim_limiter.retry_after(client)
    if waiting > 0:
        raise HTTPException(429, "too many wrong links from this address", headers=_retry_after(waiting))


async def _refuse_a_claim(client: str, counted: bool, db: AsyncSession) -> NoReturn:
    """The 401 of a claim that found no usable link. `counted` is False for a REVOKED link: a kiosk started on one claims again at
    every reload, and ten reloads must not block the address that other screens share. The answer and the work are the same.

    The address is checked once more right before the failure is written, with nothing awaited between the check and the write (the
    rule of the sign-in path): the claims already in flight when the block starts are then refused with 429 instead of each adding
    a 401, so ten wrong secrets are all a burst can get from one address."""
    _refuse_a_blocked_address(client)
    written = None
    if counted:
        claim_limiter.record_failure(client)
        if claim_limiter.blocked(client):  # this failure was the one that blocked the address: it is written once
            written = blocked_budget.take()
    if written is not None:
        await db.rollback()  # release the request's connection first: a burst of failures needs one connection each, not two
        detail: dict[str, object] = {"client": client}
        if written:
            detail["suppressed_before"] = written  # how many blocks were left out since the last row
        try:  # best effort, like a failed sign-in: the 401 goes out whatever happens here
            async with get_sessionmaker()() as session:
                await audit(session, None, "display.claim_blocked", detail)
                await session.commit()
        except Exception:
            log.exception("could not write the display.claim_blocked audit row")
    raise HTTPException(401, INVALID_LINK)


async def _note_where_seen(db: AsyncSession, display_id: int, client: str) -> bool:
    """Write the address (and the time) a display connected from; True when it is not the address it was last seen at (or it was
    never seen). One statement decides, so two claims at once from a new address make one 'new' between them."""
    changed = await db.execute(
        text(
            "UPDATE displays SET last_client = :client, last_seen_at = now() WHERE id = :id AND revoked_at IS NULL "
            "AND last_client IS DISTINCT FROM CAST(:client AS text)"
        ),
        {"client": client, "id": display_id},
    )
    return bool(changed.rowcount)


# --- the playlist -----------------------------------------------------------------------------------------------------------


class DisplayName(BaseModel):
    name: str


class WidgetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    type: str
    title: str
    config: dict[str, Any]
    x: int
    y: int
    w: int
    h: int


class DashboardOut(BaseModel):
    id: int
    name: str
    range: str
    widgets: list[WidgetOut]


class FocusOut(BaseModel):
    id: int
    name: str
    trail: list[str]


class ItemOut(BaseModel):
    id: int
    seconds: int
    dashboard: DashboardOut | None
    focus: FocusOut | None
    skipped: Skip | None


class PlaylistOut(BaseModel):
    name: str
    items: list[ItemOut]


class SiteOut(BaseModel):
    name: str
    timezone: str


class PlaylistAnswer(BaseModel):
    display: DisplayName
    playlist: PlaylistOut
    site: SiteOut
    build: str
    status: LiveStatus


def _too_many_requests() -> HTTPException:
    return HTTPException(429, "too many requests", headers={"Retry-After": "60"})


async def _budget(budgets: dict[int, Budget], display_id: int, make: Callable[[], Budget], db: AsyncSession) -> Budget:
    """The budget of one display in `budgets`, made by `make` the first time. Only a display that exists (it passed
    `current_display`, or a claim found its link) ever gets an entry, and when the dict outgrows twice the display limit the entries
    of displays that no longer exist are dropped."""
    budget = budgets.get(display_id)
    if budget is None:
        if len(budgets) >= 2 * MAX_DISPLAYS:
            live = set(await db.scalars(select(Display.id)))
            for gone in [key for key in budgets if key not in live]:
                del budgets[gone]
        budget = budgets.setdefault(display_id, make())
    return budget


async def _take(budgets: dict[int, RowBudget], display: Display, cap: int, db: AsyncSession) -> bool:
    """One request of `display` against its own budget (cap requests a minute); False when it is over."""
    return (await _budget(budgets, display.id, lambda: RowBudget(cap, 60), db)).take() is not None


def _item_out(view: ItemView) -> ItemOut:
    dashboard = None
    if view.dashboard is not None:
        dashboard = DashboardOut(
            id=view.dashboard.id, name=view.dashboard.name, range=view.dashboard.range,
            widgets=[WidgetOut.model_validate(widget) for widget in view.widgets],
        )
    focus = None
    if view.trail is not None and view.focus_asset_id is not None and view.focus_name is not None:  # a live focus only
        focus = FocusOut(id=view.focus_asset_id, name=view.focus_name, trail=view.trail)
    return ItemOut(id=view.id, seconds=view.seconds, dashboard=dashboard, focus=focus, skipped=view.skipped)


@router.get("/playlist", response_model=PlaylistAnswer)
async def get_playlist(
    request: Request, response: Response, db: AsyncSession = Depends(get_db), display: Display = Depends(current_display)
) -> PlaylistAnswer:
    """Everything a screen needs in one answer, so that it never calls /api/site, /api/status, /api/assets or /api/dashboards."""
    if not await _take(playlist_budgets, display, PLAYLIST_BUDGET_PER_MINUTE, db):
        raise _too_many_requests()
    display_id, display_name, playlist_id = display.id, display.name, display.playlist_id
    # One statement says "seen": it writes only when the stored time is older than 50 seconds (or there is none), so a screen
    # polling every 60 s always writes and a reload loop writes once. It commits only when it changed a row.
    seen = await db.execute(
        text(
            "UPDATE displays SET last_seen_at = now(), last_client = :client WHERE id = :id AND revoked_at IS NULL "
            "AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => :every))"
        ),
        {"client": client_address(request), "id": display_id, "every": LAST_SEEN_EVERY_SECONDS},
    )
    # Either way the transaction ends here. A statement that waited for the row and then found nothing to do keeps the row locked
    # until its transaction ends, which would hold up every other poll of this display (each with its pooled connection) for the
    # whole of this request.
    if seen.rowcount:
        await db.commit()
    else:
        await db.rollback()
    playlist_name = await db.scalar(select(Playlist.name).where(Playlist.id == playlist_id))
    items = [_item_out(view) for view in await resolve_items(db, playlist_id)]
    response.headers["Cache-Control"] = "no-store"
    return PlaylistAnswer(
        display=DisplayName(name=display_name),
        playlist=PlaylistOut(name=playlist_name or "", items=items),
        site=SiteOut(name=SITE_NAME, timezone=await current_timezone(db)),
        build=build_info().build_id,
        status=await read_live_status(db),
    )


# --- the figures ------------------------------------------------------------------------------------------------------------


class DisplayWidgetRequest(BaseModel):
    """Ids only. A display never sends a config, a range or a focus: all three come from what an administrator saved."""

    model_config = ConfigDict(extra="forbid")
    item: Annotated[StrictInt, Field(ge=1, le=MAX_ID)]
    widget: Annotated[StrictInt, Field(ge=1, le=MAX_ID)]


@router.post("/widget-data")
async def post_widget_data(
    body: DisplayWidgetRequest, response: Response, db: AsyncSession = Depends(get_db),
    display: Display = Depends(current_display),
) -> dict[str, Any]:
    """The answer `/api/widget-data` gives for the widget as it is stored: its config, its own range (else the dashboard's) and,
    for a widget that follows the focus, the focus of the item. The item must be one of THIS display's playlist and the widget
    one of that item's dashboard; whatever else is asked, 404 with one text. No account is involved, so no permission is asked."""
    if not await _take(widget_budgets, display, DISPLAY_WIDGET_BUDGET_PER_MINUTE, db):
        raise _too_many_requests()
    # The item is looked up among the items of THIS display's playlist, resolved the way the playlist answer resolves them, so that
    # an item a screen is told to skip (its dashboard deleted, its focus asset gone, no widgets) answers no figures either. In
    # particular a following widget of an item whose focus is gone must never fall back to the whole site.
    view = next((candidate for candidate in await resolve_items(db, display.playlist_id) if candidate.id == body.item), None)
    if view is None or view.skipped is not None or view.dashboard is None:
        raise HTTPException(404, NOT_FOUND)
    widget = next((candidate for candidate in view.widgets if candidate.id == body.widget), None)
    if widget is None:  # not a widget of that item's dashboard
        raise HTTPException(404, NOT_FOUND)
    dashboard = view.dashboard
    config = widget.config if isinstance(widget.config, dict) else {}
    try:
        # The focus is the one the item stores, as stored: never derived from the trail and never None for a focus that exists.
        request = WidgetDataRequest(
            type=widget.type, config=config, range=config.get("range") or dashboard.range, focus=view.focus_asset_id
        )
    except ValidationError:  # something stored no longer fits (a type or a range that was removed): never a 500, never the text
        raise HTTPException(422, "this widget cannot be shown") from None
    result = await compute_checked(request, db)
    response.headers["Cache-Control"] = "no-store"
    return result.as_json()
