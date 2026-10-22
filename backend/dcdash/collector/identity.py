"""Remembering who a source's server is (`sources.identity`), and noticing when another server answers at its address.

The scan, Test and the connection check learn a server's identity (OPC UA application URI and certificate thumbprint, the HTTP
simulator's instance id) and hand it to `remember`. The first time it is stored; afterwards it is only compared, so a repeat
scan writes nothing. A DIFFERENT server at the same address never replaces the stored identity: the source keeps polling, and
`identity["different"]` plus one journal warning say so (at most one per other server per 24 hours). A certificate that was
renewed on the same server (same URI, another thumbprint) is stored with one `info` event.

Identity is not configuration: nothing here notifies the collector's config channel, and nothing stored or journalled is a
secret (no password, no certificate, only the strings a server announces about itself, cut to a sane size).
"""
import logging
from datetime import UTC, datetime
from typing import Any

import asyncpg

from dcdash.connectors.base import connector_types
from dcdash.connectors.identity import clip, thumbprints_conflict, usable_key
from dcdash.core import journal

log = logging.getLogger(__name__)

SOURCE_IDENTITY_CHANGED = "source.identity_changed"
DIFFERENT_MESSAGE = "The server answering at this address is not the one this source used to talk to."
RENEWED_MESSAGE = "The server's certificate changed."
EVENT_GATE_SECONDS = 24 * 3600
# The strings a server says about itself; `name_hint` (the Docker name of the address, a small object) and `different` (set here)
# are kept in the same JSON object but are not part of who the server is.
IDENTITY_KEYS = ("application_uri", "application_name", "product_uri", "thumbprint", "instance")
_OTHER_KEYS = ("application_uri", "thumbprint", "instance")
_HINT_KEYS = ("name", "host")

# What `remember` answers: the identity was stored (first time, or a real key replaced a default one), it is the same server
# (nothing, or only a newly seen detail, was merged), the same server with a renewed certificate, another server, or nothing
# was done (no identity, the source is gone, or its address is not the one the identity was observed at).
STORED, SAME, RENEWED, DIFFERENT, SKIPPED = "stored", "same", "renewed", "different", "skipped"


def clean_identity(seen: object) -> dict[str, Any]:
    """The part of what a connector reported that is stored: the known text keys (stripped, cut at 256 characters, empty ones
    left out) and a `name_hint` made of two such texts. Anything else is dropped; `{}` when nothing is left."""
    if not isinstance(seen, dict):
        return {}
    found: dict[str, Any] = {key: text for key in IDENTITY_KEYS if (text := clip(seen.get(key))) is not None}
    hint = seen.get("name_hint")
    if isinstance(hint, dict):
        cleaned = {key: text for key in _HINT_KEYS if (text := clip(hint.get(key))) is not None}
        if cleaned:
            found["name_hint"] = cleaned
    return found


def _fields(identity: dict[str, Any]) -> dict[str, str]:
    return {key: identity[key] for key in IDENTITY_KEYS if isinstance(identity.get(key), str) and identity[key]}


def _canonical(connector_type: str, config: Any) -> Any:
    """`config` the way a connector reads it (defaults filled in, a URL in its normal form), so that the stored row and the
    config a job observed the server through compare equal even when the row was written by hand. Unchanged when the type is
    unknown or the config does not validate."""
    cls = connector_types().get(connector_type)
    if cls is None or not isinstance(config, dict):
        return config
    try:
        return cls.config_schema.model_validate(config).model_dump(mode="json")
    except Exception:  # noqa: BLE001 - a config that does not validate is compared as it is
        return config


def _address(connector_type: str, config: Any) -> Any:
    """Where a source's server is: the endpoint (OPC UA), the url (simulator), or (host, port) for any other type."""
    config = _canonical(connector_type, config)
    if not isinstance(config, dict):
        return None
    if connector_type == "opcua":
        return config.get("endpoint")
    if connector_type == "simulator":
        return config.get("url")
    cls = connector_types().get(connector_type)
    key = cls.endpoint_key(config) if cls is not None else None
    return None if key is None else tuple(key[:2])


_Event = tuple[str, dict[str, Any], dict[str, Any], tuple[Any, ...]]  # ("different" | "renewed", before, after, the rate-gate key)


def _note_different(stored: dict[str, Any], new: dict[str, Any], seen_id: dict[str, str]) -> dict[str, Any]:
    """`new` with `different` set to what the other server says (and when); left as it is when those fields are already recorded."""
    other = {key: seen_id[key] for key in _OTHER_KEYS if key in seen_id}
    current = stored.get("different")
    if not (isinstance(current, dict) and {k: v for k, v in current.items() if k != "at"} == other):
        new["different"] = {**other, "at": datetime.now(UTC).isoformat()}
    return new


def _decide(connector_type: str, stored: dict[str, Any], seen: dict[str, Any]) -> tuple[str, dict[str, Any], _Event | None]:
    """(outcome, the identity to store, the journal event to write after the commit or None). Pure."""
    stored_id, seen_id = _fields(stored), _fields(seen)
    stored_key, seen_key = usable_key(connector_type, stored_id), usable_key(connector_type, seen_id)
    new = dict(stored)
    if "name_hint" in seen:
        new["name_hint"] = seen["name_hint"]  # a name hint replaces the stored one; keys that were not received are kept

    if not stored_id:  # nothing remembered yet (a name hint alone is no identity)
        if not seen_id:
            return SAME, new, None
        new.pop("different", None)
        new.update(seen_id)
        return STORED, new, None
    if stored_key is None:
        if seen_key is not None:  # the stored identity named no one (a default URI): a real key replaces it, silently
            replaced = dict(seen_id)
            if "name_hint" in new:
                replaced["name_hint"] = new["name_hint"]
            return STORED, replaced, None
        new.update(seen_id)  # neither names anyone: keep what the server says now
        return (STORED if _fields(new) != stored_id else SAME), new, None
    if seen_key is None:  # a stored key and an answer without one: the stored key is never overwritten
        if not any(key in seen_id for key in _OTHER_KEYS):  # the answer names no server at all (only an application name, ...)
            return SAME, new, None
        # It names one, but a default one (or a bare thumbprint): where a keyed server used to be, that is another server.
        gate = ("unkeyed", seen_id.get("application_uri"), seen_id.get("thumbprint"))
        return DIFFERENT, _note_different(stored, new, seen_id), ("different", stored_id, seen_id, gate)

    if seen_key != stored_key:
        event = ("different", stored_id, seen_id, (seen_key, seen_id.get("thumbprint")))
        return DIFFERENT, _note_different(stored, new, seen_id), event

    new.pop("different", None)  # the stored server answers again
    renewed = thumbprints_conflict(stored_id.get("thumbprint"), seen_id.get("thumbprint"))
    new.update(seen_id)
    if renewed:
        return RENEWED, new, ("renewed", stored_id, seen_id, (seen_id["thumbprint"],))
    return SAME, new, None


async def remember(pool: asyncpg.Pool, source_id: int, seen: dict[str, Any] | None, *, expected_config: dict[str, Any]) -> str:
    """Store or compare the identity `seen` for `source_id`; returns "stored", "same", "renewed", "different" or "skipped".

    `expected_config` is the config the caller observed the server through (the one the connector was built from, or the row the
    scan matched). Under the row lock the identity is written only when the source's address is still that one: a Test that
    finished after the source was moved (or the move undone) must not write the old address's identity. A source configured by
    name is compared by its config, never by a finding's resolved address, so it learns its identity too.
    """
    fresh = clean_identity(seen)
    if not fresh:
        return SKIPPED
    event = None
    known: list[str] = []
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT connector_type, config, identity FROM sources WHERE id = $1 FOR NO KEY UPDATE", source_id
            )
            if row is None:
                return SKIPPED
            connector_type = row["connector_type"]
            if _address(connector_type, row["config"]) != _address(connector_type, expected_config):
                return SKIPPED
            stored = row["identity"] if isinstance(row["identity"], dict) else {}
            outcome, new, event = _decide(connector_type, stored, fresh)
            if new != stored:
                await conn.execute("UPDATE sources SET identity = $2 WHERE id = $1", source_id, new)
            known = journal.known_for(row["config"], None) if isinstance(row["config"], dict) else []
    if event is not None:  # after the commit: a rolled-back write is not news, and the row lock is not held while the journal writes
        await _journal(pool, source_id, event, known)
    return outcome


async def _journal(pool: asyncpg.Pool, source_id: int, event: _Event, known: list[str]) -> None:
    what, before, after, gate = event
    key = ("identity-changed" if what == "different" else "identity-renewed", source_id, gate)
    if not journal.allow(key, EVENT_GATE_SECONDS):
        return
    await journal.record(
        pool, "collector", SOURCE_IDENTITY_CHANGED,
        DIFFERENT_MESSAGE if what == "different" else RENEWED_MESSAGE,
        level="warning" if what == "different" else "info",
        source_id=source_id,
        detail={"before": before, "after": after},
        known=known,
    )


async def remember_safely(pool: asyncpg.Pool, source_id: int, seen: dict[str, Any] | None, *, expected_config: dict[str, Any]) -> str:
    """`remember`, but never raises: a failure is logged and the answer is "skipped". What the scan, Test and the connection check
    call, because learning who a server is must never fail a scan or a job."""
    try:
        return await remember(pool, source_id, seen, expected_config=expected_config)
    except Exception:  # noqa: BLE001 - see the docstring
        log.warning("could not remember the identity of source %s", source_id, exc_info=True)
        return SKIPPED
