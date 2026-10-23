"""The two thresholds of the data freshness watchdog (w35): the stored setting.

`stale_floor_minutes` is the shortest time without a good reading that makes a billing meter stale (the rule also waits three of
the meter's own polling intervals, whichever is longer). `not_advancing_hours` is how long an energy counter may stand still
before it is reported as not rising. The setting lives under the key `watchdog` of the shared `settings` table, in the shape of
the system events setting (events/settings.py). A missing, broken or out-of-bounds stored value reads as the factory values:
the watchdog must always have a rule.
"""
import json
import logging
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


log = logging.getLogger(__name__)

KEY = "watchdog"
STALE_FLOOR_MINUTES_BOUNDS = (2, 60)
NOT_ADVANCING_HOURS_BOUNDS = (1, 72)


class WatchdogSettings(BaseModel):
    """Both values are required, whole numbers and inside their bounds; anything else is refused (a PUT) or ignored (a stored value)."""

    model_config = ConfigDict(extra="forbid")

    stale_floor_minutes: StrictInt = Field(ge=STALE_FLOOR_MINUTES_BOUNDS[0], le=STALE_FLOOR_MINUTES_BOUNDS[1])
    not_advancing_hours: StrictInt = Field(ge=NOT_ADVANCING_HOURS_BOUNDS[0], le=NOT_ADVANCING_HOURS_BOUNDS[1])

    @property
    def floor_seconds(self) -> float:
        return self.stale_floor_minutes * 60.0

    @property
    def not_advancing_seconds(self) -> float:
        return self.not_advancing_hours * 3600.0


FACTORY = WatchdogSettings(stale_floor_minutes=5, not_advancing_hours=6)

_FIELDS = tuple(WatchdogSettings.model_fields)


# The marker lets the tests that count the statements of a request leave the verdict's out (the Sources list computes it, at most every 5 s).
_READ = text("/* w35 watchdog */ SELECT value FROM settings WHERE key = :key")


def parse(stored: Any) -> WatchdogSettings:
    """The stored JSON as settings, or the factory values when it is not an object, lacks a value or has one out of bounds."""
    if not isinstance(stored, dict):
        return FACTORY
    try:
        return WatchdogSettings.model_validate({name: stored[name] for name in _FIELDS if name in stored})
    except ValidationError:
        return FACTORY


async def load(db: AsyncSession) -> WatchdogSettings:
    """The setting for the API and the verdict (SQLAlchemy session). Never fails on a stored value, whatever it holds."""
    try:
        stored = (await db.execute(_READ, {"key": KEY})).scalar_one_or_none()
        return parse(json.loads(stored) if isinstance(stored, str) else stored)
    except (TypeError, ValueError):  # a stored text that is not JSON
        return FACTORY


async def load_pool(pool: Any) -> WatchdogSettings:
    """The setting for the figures worker (asyncpg pool). Never raises: the watchdog step must not stop for a bad value."""
    try:
        stored = await pool.fetchval("SELECT value FROM settings WHERE key = $1", KEY)
        if isinstance(stored, str):  # a connection without the JSONB codec hands the text back
            stored = json.loads(stored)
        return parse(stored)
    except Exception:
        log.warning("could not read the data watchdog setting; using the factory values", exc_info=True)
        return FACTORY
