"""The settings of the history backfill (w30 D12, D18): five `DCDASH_HISTORY_*` variables read once, with their defaults.

Compose passes every one of them, empty when the operator set nothing, so an empty or unset variable means the default. A value
that is not a number, or is outside its range, is refused with a sentence that names the variable: a typo must not quietly run
the backfill with another pace than the one that was meant."""
import math
from collections.abc import Mapping
from dataclasses import dataclass

EVERY = "DCDASH_HISTORY_EVERY"
MAX_ROWS = "DCDASH_HISTORY_MAX_ROWS"
RATE = "DCDASH_HISTORY_RATE"
LOOKBACK_DAYS = "DCDASH_HISTORY_LOOKBACK_DAYS"
REREAD_HOURS = "DCDASH_HISTORY_REREAD_HOURS"
NAMES = (EVERY, MAX_ROWS, RATE, LOOKBACK_DAYS, REREAD_HOURS)


def _number(environ: Mapping[str, str], name: str, default: float, *, minimum: float | None, whole: bool) -> float:
    text = (environ.get(name) or "").strip()
    if not text:
        return default
    kind = "a whole number" if whole else "a number"
    try:
        number = float(text)
    except ValueError:
        raise ValueError(f"{name} must be {kind}, not '{text}'.") from None
    if not math.isfinite(number) or (whole and number != int(number)):
        raise ValueError(f"{name} must be {kind}, not '{text}'.")
    if minimum is not None and number < minimum:
        raise ValueError(f"{name} must be at least {minimum:g}, not '{text}'.")
    return int(number) if whole else number


@dataclass(frozen=True)
class HistorySettings:
    every_seconds: float = 600.0  # between two cycles; zero or less switches the loop off
    max_rows: int = 20_000  # expected rows in one request
    rate_per_minute: int = 30  # requests a minute to one source
    lookback_days: int = 7  # how far back an automatic fill goes (further capped by the raw retention at run time)
    reread_hours: int = 3  # the late pass asks an hour again once it is this old

    @property
    def enabled(self) -> bool:
        return self.every_seconds > 0

    @classmethod
    def from_env(cls, environ: Mapping[str, str]) -> "HistorySettings":
        return cls(
            every_seconds=float(_number(environ, EVERY, cls.every_seconds, minimum=None, whole=False)),
            max_rows=int(_number(environ, MAX_ROWS, cls.max_rows, minimum=100, whole=True)),
            rate_per_minute=int(_number(environ, RATE, cls.rate_per_minute, minimum=1, whole=True)),
            lookback_days=int(_number(environ, LOOKBACK_DAYS, cls.lookback_days, minimum=1, whole=True)),
            reread_hours=int(_number(environ, REREAD_HOURS, cls.reread_hours, minimum=0, whole=True)),
        )
