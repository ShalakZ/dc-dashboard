"""Saved shape rules (w36 T7a): what a person decided about a tag shape of a source, remembered so a later browse can say how many
NEW tags match. A rule is a suggestion that writes nothing a figure reads, so it is a `settings` row (key `shape_rules:<source id>`,
value `{"rules": {<shape key>: <Rule>}}`), not a table, and it is not audited: the mappings it leads to are written, and audited as
`tags.mapped`, only by the tag-list route. A rule names the shape KEY, never the label, and is never applied by itself.

A deleted source leaves its settings row behind. It is never read again (source ids are not reused), so nothing removes it.

The models here are the ones T2's `Decision` is built from (api/shapes.py), so a rule and a decision are validated alike.
The reads take the caller's session and own no transaction.
"""
import json
from collections.abc import Iterable
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, field_validator
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.metrics import Metric, Scale
from dcdash.core.settings_store import get_setting
from dcdash.ingest.tag_list import MAX_INTERVAL, MAX_UNIT

KEY_PREFIX = "shape_rules:"
MAX_RULES = 300  # as many as the shapes page shows rows
MAX_SHAPE_KEY = 2_000  # a shape key is a tag text with its digits collapsed; a tag name is far shorter, a longer key is no shape

ShapeKey = Annotated[str, StringConstraints(min_length=1, max_length=MAX_SHAPE_KEY)]


class Rule(BaseModel):
    """How a person mapped a shape. `unit` is read for a custom metric only; `scale` and `interval_seconds` are left to the guess when
    absent. T2's `Decision` is a Rule that also names the shape it is about."""

    model_config = ConfigDict(extra="forbid")

    metric: Metric
    unit: Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_UNIT)] | None = None
    scale: Scale | None = None
    interval_seconds: Annotated[int, Field(ge=1, le=MAX_INTERVAL)] | None = None
    name_from: Literal["part1", "parts12", "part1_part2"]

    @field_validator("unit")
    @classmethod
    def _printable(cls, value: str | None) -> str | None:
        if value is not None and not value.isprintable():
            raise ValueError("the unit must be printable text")
        return value or None  # a unit of spaces is no unit


class RulesBody(BaseModel):
    """The whole rule set of one source: a PUT replaces what was stored."""

    model_config = ConfigDict(extra="forbid")

    rules: dict[ShapeKey, Rule] = Field(max_length=MAX_RULES)


def rules_key(source_id: int) -> str:
    return f"{KEY_PREFIX}{source_id}"


def rules_json(body: RulesBody) -> dict[str, dict[str, Any]]:
    """The rules as they are stored and served: JSON values, an absent option left out (never a null)."""
    return {key: rule.model_dump(mode="json", exclude_none=True) for key, rule in body.rules.items()}


def stored_rules(value: Any) -> dict[str, dict[str, Any]]:
    """The rules inside a stored value. A broken value (not an object, no `rules`, one rule that is not a valid Rule) reads as no rules:
    a hand-edited or older row must never fail the page or the Discovery graph."""
    try:
        return rules_json(RulesBody.model_validate(value))
    except ValidationError:
        return {}


async def load_rules(db: AsyncSession, source_id: int) -> dict[str, dict[str, Any]]:
    """The saved rules of one source ({} when it has none or the stored value is broken). One statement."""
    try:
        value = await get_setting(db, rules_key(source_id), {})
    except (TypeError, ValueError):  # a stored JSON array, string or number is not an object
        return {}
    return stored_rules(value)


async def load_rule_keys(db: AsyncSession, source_ids: Iterable[int]) -> dict[int, frozenset[str]]:
    """The shape keys that have a rule, for each of the given sources that has at least one. ONE statement however many sources."""
    ids = sorted(set(source_ids))
    if not ids:
        return {}
    wanted = {rules_key(source_id): source_id for source_id in ids}
    rows = await db.execute(text("SELECT key, value FROM settings WHERE key = ANY(:keys)"), {"keys": list(wanted)})
    found: dict[int, frozenset[str]] = {}
    for row in rows:
        value = row.value
        if isinstance(value, str):  # the production engine decodes JSONB itself; this is the defensive fallback get_setting also has
            try:
                value = json.loads(value)
            except ValueError:
                continue
        keys = frozenset(stored_rules(value))
        if keys:
            found[wanted[row.key]] = keys
    return found
