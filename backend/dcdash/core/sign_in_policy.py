"""The sign-in protection setting: how many failed sign-ins block an account, and for how many minutes."""
import logging
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.settings_store import SIGN_IN_KEY

log = logging.getLogger(__name__)

MIN_FAILURES, MAX_FAILURES = 3, 20
MIN_BLOCK_MINUTES, MAX_BLOCK_MINUTES = 1, 60


@dataclass(frozen=True)
class SignInPolicy:
    max_failures: int
    block_minutes: int


DEFAULT_POLICY = SignInPolicy(max_failures=5, block_minutes=5)  # what the limiter did before it was configurable


def _int_in(value: Any, low: int, high: int) -> bool:
    return type(value) is int and low <= value <= high  # a bool or a float is not an int here


_warned: set[str] = set()  # one warning per distinct bad value, not one per sign-in attempt


def policy_from(stored: Any) -> SignInPolicy:
    """The stored value as a policy; anything out of bounds or of the wrong shape means the defaults, as a whole."""
    if isinstance(stored, dict) and _int_in(stored.get("max_failures"), MIN_FAILURES, MAX_FAILURES) \
            and _int_in(stored.get("block_minutes"), MIN_BLOCK_MINUTES, MAX_BLOCK_MINUTES):
        return SignInPolicy(stored["max_failures"], stored["block_minutes"])
    if stored is not None and (shown := repr(stored)[:200]) not in _warned:
        _warned.add(shown)
        log.warning("stored sign-in policy %s is not valid; using the defaults", shown)
    return DEFAULT_POLICY


async def get_sign_in_policy(db: AsyncSession) -> SignInPolicy:
    """MUST read the raw value: `get_setting` wraps it in dict(...), which raises on `5` and `"abc"` (a sign-in 500)
    and turns a list of pairs into a valid policy. The engine's asyncpg dialect has already decoded the JSONB, so it is
    not decoded again: a JSON string that merely contains a policy is a wrong type, not a policy."""
    row = await db.execute(text("SELECT value FROM settings WHERE key = :key"), {"key": SIGN_IN_KEY})
    return policy_from(row.scalar_one_or_none())
