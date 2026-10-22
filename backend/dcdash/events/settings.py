"""How long system events are kept (w32): the stored setting, the forecast of a shortening, and the figures the Storage card shows.

System events are the rows of `diag_events`. They are kept for `retention_days` days or the newest `max_rows` rows, whichever is
fewer, by the hourly housekeeping (collector/housekeeping.py). The setting lives under the key `events` of the shared `settings`
table. A missing, broken or out-of-bounds stored value reads as the factory values: housekeeping must always have a rule.

Open incidents are never deleted by either rule; a closed incident counts from the day it closed (`detail.closed_at`), so a long
outage that has just ended is not deleted at the next run. `will_delete` below and the DELETE in housekeeping spell the same
rule: the first counts, the second deletes, and a test holds them equal.
"""
import json
import logging
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.settings_store import get_setting

log = logging.getLogger(__name__)

KEY = "events"
RETENTION_DAYS_BOUNDS = (7, 400)
MAX_ROWS_BOUNDS = (10_000, 1_000_000)


class EventsSettings(BaseModel):
    """Both values are required, whole numbers and inside their bounds; anything else is refused (a PUT) or ignored (a stored value)."""

    model_config = ConfigDict(extra="forbid")

    retention_days: StrictInt = Field(ge=RETENTION_DAYS_BOUNDS[0], le=RETENTION_DAYS_BOUNDS[1])
    max_rows: StrictInt = Field(ge=MAX_ROWS_BOUNDS[0], le=MAX_ROWS_BOUNDS[1])


FACTORY = EventsSettings(retention_days=90, max_rows=100_000)

_FIELDS = tuple(EventsSettings.model_fields)


def parse(stored: Any) -> EventsSettings:
    """The stored JSON as settings, or the factory values when it is not an object, lacks a value or has one out of bounds."""
    if not isinstance(stored, dict):
        return FACTORY
    try:
        return EventsSettings.model_validate({name: stored[name] for name in _FIELDS if name in stored})
    except ValidationError:
        return FACTORY


async def load(db: AsyncSession) -> EventsSettings:
    """The setting for the API (SQLAlchemy session). Never fails on a stored value, whatever it holds."""
    try:
        return parse(await get_setting(db, KEY, {}))
    except (TypeError, ValueError):  # get_setting turns the stored JSON into a dict: a stored list or string cannot be
        return FACTORY


async def load_pool(pool: Any) -> EventsSettings:
    """The setting for the collector's housekeeping (asyncpg pool). Never raises: the hourly run must not stop for a bad value."""
    try:
        stored = await pool.fetchval("SELECT value FROM settings WHERE key = $1", KEY)
        if isinstance(stored, str):  # a connection without the JSONB codec hands the text back
            stored = json.loads(stored)
        return parse(stored)
    except Exception:
        log.warning("could not read the system events retention setting; using the factory values", exc_info=True)
        return FACTORY


# The moment a row `e` counts from for the age rule: the day a closed incident closed (`detail.closed_at`), else the row's own
# time. A `closed_at` that is missing or is not a time (a damaged or hand-edited row) reads as the row's own time: it must never
# raise, or one bad row would stop the journal from ever being pruned (and turn the forecast into an error). `CASE` evaluates the
# cast only for the rows whose value passed `pg_input_is_valid` (PostgreSQL 16). Housekeeping uses this same text.
AGE_FROM = (
    "CASE WHEN pg_input_is_valid(e.detail->>'closed_at', 'timestamptz') "
    "THEN CAST(e.detail->>'closed_at' AS timestamptz) ELSE e.ts END"
)

# The one rule, as a condition on a row `e` and the cut ids: a row goes when it is not an open incident and it is older than
# the days (a closed incident counts from its closing) or it is beyond the newest `rows` ids of ALL rows. housekeeping.py
# spells the DELETE with the same `AGE_FROM` (asyncpg numbers its parameters); a test holds the two equal.
_WILL_DELETE = text(
    f"""
    WITH cuts AS (
        SELECT (SELECT id FROM diag_events ORDER BY id DESC OFFSET :old_rows LIMIT 1) AS old_id,
               (SELECT id FROM diag_events ORDER BY id DESC OFFSET :new_rows LIMIT 1) AS new_id
    )
    SELECT count(*) FROM diag_events e, cuts
    WHERE e.detail->>'state' IS DISTINCT FROM 'open'
      AND ({AGE_FROM} < now() - make_interval(days => :new_days)
           OR COALESCE(e.id <= cuts.new_id, false))
      AND NOT ({AGE_FROM} < now() - make_interval(days => :old_days)
               OR COALESCE(e.id <= cuts.old_id, false))
    """
)


async def will_delete(db: AsyncSession, old: EventsSettings, new: EventsSettings) -> int:
    """How many rows the `new` setting would delete that the `old` one would not: the union of the age rule and the count rule,
    each row counted once, open incidents left out. After the change this is what the next hourly run deletes (rows the old
    setting was already about to delete go anyway and are not this change's doing)."""
    row = await db.execute(
        _WILL_DELETE,
        {
            "old_days": old.retention_days, "old_rows": old.max_rows,
            "new_days": new.retention_days, "new_rows": new.max_rows,
        },
    )
    return int(row.scalar_one())


async def stats(db: AsyncSession) -> tuple[int, datetime | None]:
    """(how many events are kept, the time of the oldest; None when there are none)."""
    count, oldest = (await db.execute(text("SELECT count(*), min(ts) FROM diag_events"))).one()
    return int(count), oldest
