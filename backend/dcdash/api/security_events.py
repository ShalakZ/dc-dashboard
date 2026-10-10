"""Sign-in security events: written with their own commit, with a bounded number of failure rows.

A failed sign-in answers 401 and the request's transaction is rolled back, so its audit row cannot join it: it goes
through a short session of its own. That write is best effort (it is logged and swallowed; the 401 still goes out).
The caller releases its request connection first (`await db.rollback()`), so a failure needs one pooled connection,
not two: otherwise a burst of failing sign-ins could hold the whole pool while each waits for a second connection.
The budgets are in memory like the LoginLimiter and assume one api worker; an api restart resets them.
"""
import logging
import time
from collections import deque
from collections.abc import Callable

from fastapi import Request

from dcdash.core.audit import audit
from dcdash.core.db import get_sessionmaker

log = logging.getLogger(__name__)

MAX_FAILURE_ROWS = 30
MAX_LOCKOUT_ROWS = 30
WINDOW_SECONDS = 300.0


class RowBudget:
    """At most `cap` rows per sliding window. Counts what it refused so the next written row can report it."""

    def __init__(self, cap: int, window_seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self._cap = cap
        self._window = window_seconds
        self._clock = clock
        self._stamps: deque[float] = deque()
        self._refused = 0

    def take(self) -> int | None:
        """None: over budget (the refusal is counted). Otherwise the number refused since the last row that was allowed."""
        now = self._clock()
        while self._stamps and self._stamps[0] <= now - self._window:
            self._stamps.popleft()
        if len(self._stamps) >= self._cap:
            self._refused += 1
            return None
        self._stamps.append(now)
        refused, self._refused = self._refused, 0
        return refused

    def clear(self) -> None:
        self._stamps.clear()
        self._refused = 0


def client_address(request: Request) -> str:
    """The address the browser connected from.

    Caddy is the only way to reach the api and sets X-Forwarded-For itself (the same trust the X-Forwarded-Proto handling
    in api/auth.py relies on), so the last entry is the real client. Without the header (tests, a direct run) the
    socket peer is used. Capped at 64 characters so a hostile header cannot bloat the row. On a run without Caddy the
    header can be forged: `client` is then a hint, not evidence.
    """
    forwarded = request.headers.get("x-forwarded-for", "").rsplit(",", 1)[-1].strip()
    peer = request.client.host if request.client else "-"
    return (forwarded or peer)[:64]


class SignInEvents:
    def __init__(self) -> None:
        self.failures = RowBudget(MAX_FAILURE_ROWS, WINDOW_SECONDS)
        self.lockouts = RowBudget(MAX_LOCKOUT_ROWS, WINDOW_SECONDS)

    def clear(self) -> None:
        self.failures.clear()
        self.lockouts.clear()

    async def audit_sign_in_failure(
        self, *, via: str, user_id: int | None, reason: str | None, client: str, locked: bool
    ) -> None:
        """Record a failed sign-in (`via` "login") or a wrong current password ("password_change").

        `locked` is True when this failure is the one that blocked the key; it is then written as `login.locked` and
        counted against the lockout budget instead. `user_id` is the account when one exists, else None: the typed
        username is never stored.
        """
        budget = self.lockouts if locked else self.failures
        refused = budget.take()
        if refused is None:
            return
        action = "login.locked" if locked else ("login.failed" if via == "login" else "password.change_failed")
        detail: dict[str, object] = {"via": via, "client": client}
        if reason:
            detail["reason"] = reason
        if refused:
            detail["suppressed_before"] = refused
        try:
            async with get_sessionmaker()() as session:
                await audit(session, user_id, action, detail)
                await session.commit()
        except Exception:
            log.exception("could not write the %s audit row", action)


sign_in_events = SignInEvents()
