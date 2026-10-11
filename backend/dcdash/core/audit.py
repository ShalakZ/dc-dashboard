import re
from collections.abc import Iterable, Mapping
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import asyncpg
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.models import AuditLog

# Config keys that look like credentials. No connector has one today (a test checks that); the mask is a safety net.
SENSITIVE_KEYS = re.compile(r"password|passwd|secret|token|api[_-]?key|credential", re.IGNORECASE)


async def audit(db: AsyncSession, user_id: int | None, action: str, detail: dict[str, Any] | None = None) -> None:
    """Add an audit row to the session's transaction; the caller commits."""
    db.add(AuditLog(user_id=user_id, action=action, detail=detail or {}))


async def audit_pool(
    pool: asyncpg.Pool, user_id: int | None, action: str, detail: dict[str, Any] | None = None
) -> None:
    """Insert an audit row immediately (used by the collector, which has no SQLAlchemy session).

    The collector reads a scan's starter once and finishes minutes later; the account may have been deleted by then,
    which would be a foreign-key error. A user that no longer exists is recorded as no user.
    """
    await pool.execute(
        "INSERT INTO audit_log (user_id, action, detail) VALUES ((SELECT id FROM users WHERE id = $1), $2, $3)",
        user_id, action, detail or {},
    )


def plain(value: Any) -> Any:
    """`value` as plain JSON data, so two spellings of one value compare equal.

    Decimal('0.10') and 0.1, a date and its ISO string, an Enum member and its value all become the same thing.
    """
    if isinstance(value, Enum):
        return plain(value.value)
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    return value


def changed_fields(before: Mapping[str, Any], after: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """The fields whose plain values differ, as (old values, new values). A key missing on one side counts as None."""
    old, new = plain(before), plain(after)
    keys = [key for key in {**old, **new} if old.get(key) != new.get(key)]
    return {key: old.get(key) for key in keys}, {key: new.get(key) for key in keys}


async def audit_change(
    db: AsyncSession,
    user_id: int | None,
    action: str,
    subject: Mapping[str, Any],
    before: Mapping[str, Any],
    after: Mapping[str, Any],
    *,
    always: bool = False,
) -> bool:
    """Audit an update as `{**subject, "before": {...}, "after": {...}}` with only the changed fields.

    Returns False and writes nothing when nothing changed (a no-op update is not an event). `always=True` writes the
    row anyway, with every field on both sides: for a save that has a side effect even when the values are equal.
    The caller commits.
    """
    if always:
        old, new = plain(before), plain(after)
    else:
        old, new = changed_fields(before, after)
        if not new:
            return False
    await audit(db, user_id, action, {**plain(subject), "before": old, "after": new})
    return True


def _split(url: str) -> tuple[str, str, str]:
    """(the credentials in `url`, `url` truly without them, `url` masked); ("", url, url) with nothing to remove.

    Two rules. When every "@" sits inside the netloc that urlsplit finds, the text before the last "@" of the netloc
    goes. Otherwise (an unencoded "/", "?" or "#" in the password ended the netloc early, a "[" made urlsplit raise, or
    an "@" in the user name) the text between "://" and the last "@" goes. The truly clean URL is then
    `<scheme>://<what follows the last "@">`; the masked one keeps a marker, `<scheme>://[hidden]@<...>`, so that a
    reader can tell something was removed. The second rule over-masks: an "@" in a path hides the host too
    (`http://host/a@b` becomes `http://[hidden]@b`), which is the safe direction for an audit log.
    """
    scheme, separator, rest = url.partition("://")
    try:
        parts = urlsplit(url)
    except ValueError:
        parts = None
    if separator and "@" in rest and (parts is None or rest.count("@") > parts.netloc.count("@")):
        credentials, _, tail = rest.rpartition("@")
        return credentials, f"{scheme}://{tail}", f"{scheme}://[hidden]@{tail}"
    if parts is not None and "@" in parts.netloc:
        credentials, _, host = parts.netloc.rpartition("@")
        clean = urlunsplit(parts._replace(netloc=host))
        return credentials, clean, clean
    return "", url, url


def without_credentials(url: str) -> str:
    """`url` without the user name and password in front of its host; anything else comes back unchanged.

    A URL whose credentials urlsplit cannot isolate (see `_split`) is masked up to its last "@".
    """
    return _split(url)[2]


def credentials_in(url: str) -> str:
    """The part of `url` that `without_credentials` removes, "" when it removes nothing.

    Only for comparing two configs in memory: the value must never be written anywhere.
    """
    return _split(url)[0]


def strip_credentials(url: str) -> str:
    """`url` truly without the user name and password: what `without_credentials` shows, minus its `[hidden]` marker.

    For storing a URL the admin asked to keep without credentials, never for display.
    """
    return _split(url)[1]


_WHITESPACE_RUNS = re.compile(r"(\s+)")
_MIN_KNOWN = 4  # a shorter known value ("f") would mangle ordinary words around it


def _known_values(known: Iterable[str]) -> list[str]:
    """The values to hide, longest first: each known value, and the password part (after the first ":") of each."""
    values: set[str] = set()
    for value in known:
        for candidate in (value, value.partition(":")[2]):
            if len(candidate) >= _MIN_KNOWN:
                values.add(candidate)
    return sorted(values, key=len, reverse=True)


def _scrub_run(run: str) -> str:
    """One run of non-space text: from its first "://" to its last "@" becomes "://[hidden]@" (if an "@" follows)."""
    start = run.find("://")
    end = run.rfind("@")
    if start < 0 or end < start + len("://"):
        return run
    return f"{run[:start]}://[hidden]@{run[end + 1:]}"


def scrub_url_credentials(text: str, known: Iterable[str] = ()) -> str:
    """`text` with every "://user:password@" turned into "://[hidden]@", and every value in `known` into "[hidden]".

    For error text that quotes a URL (an exception message, a log line). `known` catches what the position cannot: a
    password with a space inside, or a credential that is quoted on its own. It holds the values `hidden_parts` returns
    (the user name and password joined by ":"); each value of 4 or more characters is hidden, and so is the password
    part of each when that is 4 or more characters. Text with neither comes back unchanged, and scrubbing scrubbed text
    changes nothing. Over-masks an "@" later in the same run of non-space text (a query string with an e-mail address),
    the safe direction.

    The result is what `re.sub(r"://\\S*@", "://[hidden]@", text)` gives, in linear time: that pattern rescans the rest
    of the run at every "://", so a hostile string of 100,000 of them took 20 seconds.
    """
    for value in _known_values(known):
        text = text.replace(value, "[hidden]")
    if "://" not in text or "@" not in text:
        return text
    return "".join(_scrub_run(part) for part in _WHITESPACE_RUNS.split(text))


def clip_error(text: str, limit: int = 1000) -> str:
    """`text` scrubbed (`scrub_url_credentials`) and then cut to at most `limit` characters, the cut marked with "…".

    For error text that is stored: a device can send a megabyte. Scrubbing comes first, so a password that straddles the
    cut cannot survive as half a password.
    """
    text = scrub_url_credentials(text)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def scrub_strings(value: Any, known: Iterable[str] = ()) -> Any:
    """A JSON value with `scrub_url_credentials(..., known)` applied to every string in it, however deep (keys are left alone).

    For a stored result (a job's) or a journal detail that may quote a URL, or a source's password, anywhere in it. Other
    values come back as they are.
    """
    return _scrub_strings(value, tuple(known))


def _scrub_strings(value: Any, known: tuple[str, ...]) -> Any:
    if isinstance(value, str):
        return scrub_url_credentials(value, known)
    if isinstance(value, dict):
        return {key: _scrub_strings(item, known) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_scrub_strings(item, known) for item in value]
    return value


def hidden_parts(config: Mapping[str, Any]) -> dict[str, str]:
    """What `safe_config` hides from `config`, by key: the value of a credential-named key, the credentials in a URL.

    Only for comparing two configs in memory (did a hidden part change?): the values must never be written anywhere.
    """
    hidden: dict[str, str] = {}
    for key, value in config.items():
        if SENSITIVE_KEYS.search(key):
            text = str(value)
        elif isinstance(value, str):
            text = credentials_in(value)
        else:
            continue
        if text:
            hidden[key] = text
    return hidden


def safe_config(config: Mapping[str, Any]) -> dict[str, Any]:
    """A connector's config as it may be written to the audit log: URLs lose credentials, credential keys are masked.

    Top-level values only: query strings and nested values are not inspected (no connector has either today, and the
    schema guard in test_audit.py fails if one adds a credential-named field).
    """
    safe: dict[str, Any] = {}
    for key, value in config.items():
        if SENSITIVE_KEYS.search(key):
            safe[key] = "[hidden]"
        elif isinstance(value, str):
            safe[key] = without_credentials(value)
        else:
            safe[key] = value
    return safe


def reconcile_config(stored: Mapping[str, Any], submitted: Mapping[str, Any], clear: Iterable[str]) -> dict[str, Any]:
    """`submitted` (an edited config) with the hidden parts of `stored` put back where the form sent them back masked.

    The API shows a config through `safe_config`, so an edit form can only send the masked value. A top-level value
    equal to the masked stored value means "unchanged" and keeps the stored one; any other value replaces it. A key in
    `clear` that is sent back masked says "keep it, without the credentials": a URL is stored truly without them
    (`strip_credentials`, never the `[hidden]` marker) and a credential-named key becomes empty. A key in `clear` with
    nothing hidden is ignored; a key absent from `submitted` stays absent. Compare on the RAW request body, before
    validation normalises the URLs.
    """
    clear = set(clear)
    masked = safe_config(stored)
    result = dict(submitted)
    for key, value in stored.items():
        if key not in submitted or masked[key] == value or submitted[key] != masked[key]:
            continue
        if key not in clear:
            result[key] = value
        elif SENSITIVE_KEYS.search(key):
            result[key] = ""
        else:
            result[key] = strip_credentials(value)
    return result
