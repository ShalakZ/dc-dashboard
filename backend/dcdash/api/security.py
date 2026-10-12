import hashlib
import secrets
import time
from collections.abc import Callable, Hashable

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

ROLE_LEVEL = {"viewer": 0, "operator": 1, "admin": 2}

_hasher = PasswordHasher()

# Verified against when the username does not exist, so a login attempt costs the same
# time whether or not the account is real.
DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_session_token() -> tuple[str, str]:
    """Return (token for the cookie, hash to store)."""
    token = secrets.token_urlsafe(32)
    return token, hash_token(token)


class LoginLimiter:
    """Blocks a key for `window_seconds` once it has `max_failures` failures inside that window.

    The two numbers can change at run time (`configure`); a block lasts `blocked_since + window` with the CURRENT window.
    `configure(..., enabled=False)` switches the blocking off: nothing is counted or blocked, and what was held is dropped.
    Memory is bounded: expired entries are swept and, past `max_keys`, plain counters are evicted before blocks.

    The state is per process, and a process learns of a change (the on/off switch, the numbers) from the next request that
    runs `apply_sign_in_policy`. With more than one api worker a worker that missed an OFF could keep a block alive, and
    show it again after OFF then ON. Compose runs one worker; run another and the switch needs a shared store first.
    """

    def __init__(
        self,
        max_failures: int = 5,
        window_seconds: float = 300,
        clock: Callable[[], float] = time.monotonic,
        max_keys: int = 50_000,
    ) -> None:
        self._max = max_failures
        self._window = window_seconds
        self._enabled = True
        self._initial = (max_failures, window_seconds, True)
        self._clock = clock
        self._max_keys = max_keys
        self._failures: dict[Hashable, list[float]] = {}
        self._blocked_since: dict[Hashable, float] = {}

    def configure(self, max_failures: int, window_seconds: float, enabled: bool = True) -> None:
        self._max, self._window, self._enabled = max_failures, window_seconds, enabled
        if not enabled:
            self._failures.clear()  # so that switching it on again counts from zero, with no block coming back
            self._blocked_since.clear()

    def retry_after(self, key: Hashable) -> float:
        if not self._enabled:
            return 0.0
        since = self._blocked_since.get(key)
        if since is None:
            return 0.0
        left = since + self._window - self._clock()
        if left <= 0:
            del self._blocked_since[key]
            return 0.0
        return left

    def blocked(self, key: Hashable) -> bool:
        return self.retry_after(key) > 0

    def record_failure(self, key: Hashable) -> None:
        if not self._enabled or self.blocked(key):
            return  # a failure during a block neither counts nor extends it
        now = self._clock()
        recent = [t for t in self._failures.get(key, []) if t > now - self._window]
        recent.append(now)
        if len(recent) >= self._max:
            self._blocked_since[key] = now
            self._failures.pop(key, None)
        else:
            self._failures[key] = recent
        self._bound()

    def blocked_keys(self) -> list[Hashable]:
        if not self._enabled:
            return []
        return [key for key in list(self._blocked_since) if self.blocked(key)]

    def drop(self, match: Callable[[Hashable], bool]) -> int:
        """Forget every matching key, plain failure counters too. Returns how many of them were BLOCKED at this moment:
        a stale counter or a block that has already run out is forgotten but not counted."""
        gone = {k for k in (*self._failures, *self._blocked_since) if match(k)}
        blocked = sum(1 for key in gone if self.blocked(key))
        for key in gone:
            self._failures.pop(key, None)
            self._blocked_since.pop(key, None)
        return blocked

    def reset(self, key: Hashable) -> None:
        self._failures.pop(key, None)
        self._blocked_since.pop(key, None)

    def clear(self) -> None:
        self._failures.clear()
        self._blocked_since.clear()
        self._max, self._window, self._enabled = self._initial  # a configure() from an earlier test or request is forgotten too

    def _bound(self) -> None:
        # Only non-empty lists are ever stored in _failures, so times[-1] below is safe. The sweep is O(n) per failure
        # once over the cap (about 0.8 ms at 50,000 keys), noise next to the argon2 verify every attempt pays. Past the
        # cap blocks can be evicted too, but that takes max_keys x max_failures attempts, far longer than a block lasts.
        if len(self._failures) + len(self._blocked_since) <= self._max_keys:
            return
        cutoff = self._clock() - self._window
        for key in [k for k, times in self._failures.items() if times[-1] <= cutoff]:
            del self._failures[key]
        for key in [k for k, since in self._blocked_since.items() if since <= cutoff]:
            del self._blocked_since[key]
        while len(self._failures) + len(self._blocked_since) > self._max_keys:
            if self._failures:
                del self._failures[next(iter(self._failures))]  # counters go first, blocks are worth keeping
            else:
                del self._blocked_since[next(iter(self._blocked_since))]
