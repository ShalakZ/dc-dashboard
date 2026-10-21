"""Import profiles (w31): how one kind of CSV export is laid out, saved by name so that an import of it is one choice.

A profile names the columns that hold the tag, the time and the value (and, when the file has them, the unit and the quality),
the delimiter and the decimal mark, how a time is written and, for a time without an offset, the zone it was written in. It also
says what a value means (`reading`: a running counter, an instantaneous power, or a total for one period of `period_seconds`
stamped at the `start` or the `end` of that period).

Profiles are kept in one `settings` row (key `import_profiles`, value `{"profiles": {name: {...}}}`): at most MAX_PROFILES of
them, so no table and no migration. A profile holds layout only, never a reading or a secret. This module is the model, its
validation sentences and the load/save over that row; the routes (api/imports.py) own the lock, the audit row and the commit.
"""
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, ValidationError, ValidationInfo, field_validator, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.settings_store import get_setting, set_setting

log = logging.getLogger(__name__)

IMPORT_PROFILES_KEY = "import_profiles"
MAX_PROFILES = 20
# One advisory lock for every change to the row: the row may not exist yet, so a row lock cannot serialise two first saves, and the
# cap of MAX_PROFILES must not be passed by two saves that both counted 19 (the pattern of the sign-in policy's lock).
PROFILE_LOCK = 7_312_003

MAX_NAME = 60
MAX_COLUMN = 100  # characters of a column name
MAX_GOOD_CODES = 20
MAX_CODE = 40
MAX_FORMAT = 40
MAX_ECHO = 40  # characters of the request's own text (a zone, a field name) a refusal sentence repeats
MAX_PERIOD_SECONDS = 31 * 86_400
DELIMITERS = (",", ";", "\t")
# The only strptime directives a time format may use: enough for every export seen so far, and none that depends on the locale of the
# machine (%b, %a, %p) or leaves a part of the instant open (%y has two century readings).
TIME_DIRECTIVES = "YmdHMSfz"
_FIXED_FORMATS = ("iso", "epoch_s", "epoch_ms")
_ZONE_KEY = re.compile(r"[A-Za-z0-9_+\-]+(/[A-Za-z0-9_+\-]+)*")
# A moment with every part set to a different, unambiguous number: a format that cannot read what it writes is a typo.
_SAMPLE = datetime(2026, 3, 29, 13, 45, 6, 123456, tzinfo=timezone(timedelta(hours=2)))

ColumnName = Annotated[str, Field(max_length=MAX_COLUMN)]


def _unprintable(text: str) -> bool:
    """True when `text` holds a control, format, separator (other than a plain space) or unassigned character."""
    return not text.isprintable()


def clip_text(text: str, limit: int) -> str:
    """Text that came from a request, as a sentence may echo it: at most `limit` characters, each control, format or separator
    character (a line break, a right-to-left override) replaced by `?`. The importer's `clip_cell` is this function."""
    return "".join(ch if ch.isprintable() else "?" for ch in text[:limit])


def _column(value: str, label: str) -> str:
    text = value.strip()
    if not text:
        raise ValueError(f"{label} must name a column of the file, or be left out")
    if _unprintable(text):
        raise ValueError(f"{label} must not contain control characters")
    return text


class ImportProfile(BaseModel):
    """One saved layout of a CSV export. `extra="forbid"` and `strict`: a misspelt or mistyped field is an error, never a default."""

    model_config = ConfigDict(extra="forbid", strict=True)

    name: str
    tag: ColumnName
    time: ColumnName
    value: ColumnName
    unit: ColumnName | None = None
    quality: ColumnName | None = None
    delimiter: str | None = None  # None: found from the header line
    decimal: Literal[".", ","] = "."
    time_format: str = "iso"
    zone: str | None = None  # only a time without an offset needs it
    reading: Literal["counter", "power", "interval"] = "counter"
    period_seconds: int | None = None  # interval only
    stamp: Literal["start", "end"] | None = None  # interval only
    good_codes: list[str] = Field(default_factory=lambda: ["good"], max_length=MAX_GOOD_CODES)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        text = value.strip()
        if not 1 <= len(text) <= MAX_NAME:
            raise ValueError(f"the name must be 1 to {MAX_NAME} characters")
        if _unprintable(text):
            raise ValueError("the name must not contain control characters")
        # The name is a segment of the URL (/api/import-profiles/{name}): a slash would split it, and a dot segment would be
        # resolved away by the browser before the request leaves.
        if "/" in text or "\\" in text or text in (".", ".."):
            raise ValueError('the name must not contain "/" or "\\" and must not be "." or ".."')
        return text

    @field_validator("tag", "time", "value", "unit", "quality")
    @classmethod
    def _columns(cls, value: str | None, info: ValidationInfo) -> str | None:
        return None if value is None else _column(value, f"the {info.field_name} column")

    @field_validator("delimiter")
    @classmethod
    def _delimiter(cls, value: str | None) -> str | None:
        if value is not None and value not in DELIMITERS:
            raise ValueError("the delimiter must be a comma, a semicolon or a tab, or left out to find it from the header line")
        return value

    @field_validator("time_format")
    @classmethod
    def _time_format(cls, value: str) -> str:
        if value in _FIXED_FORMATS:
            return value
        sentence = (
            f'the time format must be "iso", "epoch_s", "epoch_ms" or a pattern made of {" ".join("%" + d for d in TIME_DIRECTIVES)} '
            "and plain characters, such as %d.%m.%Y %H:%M"
        )
        if not value or len(value) > MAX_FORMAT or _unprintable(value) or "%" not in value:
            raise ValueError(sentence)
        index = 0
        seen: set[str] = set()
        while (index := value.find("%", index)) != -1:
            letter = value[index + 1:index + 2]
            if not letter or letter not in TIME_DIRECTIVES:  # a "%" at the end, and "%%": a literal percent sign is not allowed
                raise ValueError(sentence)
            seen.add(letter)
            index += 2
        if not {"Y", "m", "d"} <= seen:
            raise ValueError("a time pattern must have at least the year (%Y), the month (%m) and the day (%d)")
        try:
            datetime.strptime(_SAMPLE.strftime(value), value)
        except (ValueError, re.error):  # a part used twice ("%S ... %S") is a re.error, not a ValueError
            raise ValueError("this time pattern cannot read the times it writes; check the order of its parts") from None
        return value

    @field_validator("zone")
    @classmethod
    def _zone(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip()
        problem = f'"{clip_text(text, MAX_ECHO)}" is not a time zone name; use a name such as Africa/Cairo or UTC'
        if not text or len(text) > 64 or _ZONE_KEY.fullmatch(text) is None:
            raise ValueError(problem)
        try:
            ZoneInfo(text)
        except (KeyError, ValueError, OSError):  # not found, a malformed key, a directory instead of a file
            raise ValueError(problem) from None
        return text

    @field_validator("period_seconds")
    @classmethod
    def _period(cls, value: int | None) -> int | None:
        if value is not None and not 1 <= value <= MAX_PERIOD_SECONDS:
            raise ValueError("the period must be between 1 second and 31 days")
        return value

    @field_validator("good_codes")
    @classmethod
    def _good_codes(cls, value: list[str]) -> list[str]:
        codes: list[str] = []
        for code in value:
            text = code.strip().lower()  # the importer compares a quality cell stripped and in lower case
            if not text or len(text) > MAX_CODE or _unprintable(text):
                raise ValueError(f"a good quality code must be 1 to {MAX_CODE} printable characters")
            if text not in codes:
                codes.append(text)
        return codes

    @model_validator(mode="after")
    def _whole(self) -> "ImportProfile":
        named = [(label, getattr(self, label)) for label in ("tag", "time", "value", "unit", "quality") if getattr(self, label)]
        folded = [column.casefold() for _, column in named]
        if len(set(folded)) != len(folded):
            raise ValueError("each of the tag, time, value, unit and quality columns must be a different column")
        if self.decimal == "," and self.delimiter == ",":
            raise ValueError("a decimal comma needs another delimiter: a semicolon or a tab")
        if self.reading == "interval":
            if self.period_seconds is None or self.stamp is None:
                raise ValueError('an interval reading needs period_seconds and a stamp ("start" or "end" of the period)')
        elif self.period_seconds is not None or self.stamp is not None:
            raise ValueError("period_seconds and stamp belong to an interval reading only")
        return self


def describe_problem(error: ValidationError) -> str:
    """The first problems of a refused profile as one sentence (no value is echoed except through a validator's own text)."""
    parts: list[str] = []
    for item in error.errors(include_url=False, include_input=False)[:3]:
        where = clip_text(".".join(str(step) for step in item["loc"]), MAX_ECHO)  # an extra field's name is the request's own text
        kind = item["type"]
        if kind == "value_error":  # one of the validators above: its sentence already says what it is about
            parts.append(str(item["ctx"]["error"]))
        elif kind == "missing":
            parts.append(f"{where} is required")
        elif kind == "extra_forbidden":
            parts.append(f"{where} is not a field of an import profile")
        else:
            parts.append(f"{where}: {item['msg'][:1].lower()}{item['msg'][1:]}")
    return "; ".join(parts) or "the profile is not valid"


def parse_profile(raw: Any, name: str) -> ImportProfile:
    """The profile in `raw` saved under `name`. The name of the URL or the key wins over any `name` inside `raw`.
    Raises ValidationError (a non-dict `raw` counts as one with no fields)."""
    body = dict(raw) if isinstance(raw, dict) else {}
    body["name"] = name
    return ImportProfile.model_validate(body)


async def stored_profiles(db: AsyncSession) -> dict[str, dict[str, Any]]:
    """The stored profiles as plain dicts by name, exactly as the row holds them (a damaged row reads as no profiles)."""
    value = (await get_setting(db, IMPORT_PROFILES_KEY, {})).get("profiles")
    if not isinstance(value, dict):
        return {}
    return {key: item for key, item in value.items() if isinstance(key, str) and isinstance(item, dict)}


async def store_profiles(db: AsyncSession, profiles: dict[str, dict[str, Any]]) -> None:
    """Replace the row. The caller holds PROFILE_LOCK and commits."""
    await set_setting(db, IMPORT_PROFILES_KEY, {"profiles": profiles})


async def load_profiles(db: AsyncSession) -> list[ImportProfile]:
    """The stored profiles that are still valid, sorted by name. One that no longer validates (a hand-edited row, a rule that
    tightened) is left out and logged, not raised: it must not take the list down."""
    found: list[ImportProfile] = []
    for name, raw in (await stored_profiles(db)).items():
        try:
            found.append(parse_profile(raw, name))
        except ValidationError:
            log.warning("the stored import profile %r does not validate and is left out", name[:MAX_NAME])
    return sorted(found, key=lambda profile: (profile.name.casefold(), profile.name))


async def get_profile(db: AsyncSession, name: str) -> ImportProfile | None:
    """One stored profile by name, or None when there is none or it no longer validates."""
    raw = (await stored_profiles(db)).get(name)
    if raw is None:
        return None
    try:
        return parse_profile(raw, name)
    except ValidationError:
        return None
