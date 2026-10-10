from datetime import date
from decimal import Decimal
from enum import Enum

from sqlalchemy import select

from dcdash.core.audit import (
    audit, audit_change, audit_pool, changed_fields, credentials_in, hidden_parts, plain, safe_config,
    without_credentials,
)
from dcdash.core.db import get_sessionmaker
from dcdash.core.models import AuditLog


async def test_audit_adds_a_row_when_the_caller_commits(db):
    async with get_sessionmaker()() as session:
        await audit(session, None, "scan.started", {"scan_id": 3})
        await session.commit()
    row = await db.fetchrow("SELECT user_id, action, detail FROM audit_log")
    assert row["user_id"] is None and row["action"] == "scan.started" and row["detail"] == {"scan_id": 3}


async def test_audit_is_rolled_back_with_the_transaction(db):
    async with get_sessionmaker()() as session:
        await audit(session, None, "x")
        await session.rollback()
    assert await db.fetchval("SELECT count(*) FROM audit_log") == 0


async def test_audit_pool_commits_immediately(db):
    await audit_pool(db, None, "scan.finished", {"status": "done"})
    assert await db.fetchval("SELECT detail FROM audit_log WHERE action = 'scan.finished'") == {"status": "done"}


async def test_audit_model_reads_the_row(db):
    await audit_pool(db, None, "a")
    async with get_sessionmaker()() as session:
        row = (await session.scalars(select(AuditLog))).one()
    assert row.action == "a" and row.detail == {} and row.ts is not None


class Color(Enum):
    RED = "red"


def test_plain_makes_values_comparable():
    assert plain({"r": Decimal("0.10"), "d": date(2026, 1, 1), "c": Color.RED, "l": (1, Decimal("2"))}) == {
        "r": 0.1, "d": "2026-01-01", "c": "red", "l": [1, 2.0],
    }


def test_changed_fields_lists_only_what_differs_and_keeps_none():
    old, new = changed_fields({"a": 1, "b": 2, "c": 3}, {"a": 1, "b": 5, "c": None})
    assert old == {"b": 2, "c": 3} and new == {"b": 5, "c": None}
    assert changed_fields({"a": Decimal("0.100000")}, {"a": 0.1}) == ({}, {})


def test_without_credentials_strips_userinfo_only():
    assert without_credentials("http://user:pw@host:9000/x?y=1") == "http://host:9000/x?y=1"
    assert without_credentials("opc.tcp://u@10.0.0.1:4840") == "opc.tcp://10.0.0.1:4840"
    assert without_credentials("http://host/x") == "http://host/x"
    assert without_credentials("not a url") == "not a url"
    assert without_credentials("me@example.com") == "me@example.com"


# Spellings urlsplit does not put the "@" in the netloc for (or cannot parse at all): everything up to the last "@" is
# masked. This over-masks an "@" in a path, which is the safe direction.
MASKED_URLS = {
    "opc.tcp://user:p#ss@10.0.0.1:4840": "opc.tcp://[hidden]@10.0.0.1:4840",
    "opc.tcp://user:p/ss@10.0.0.1:4840": "opc.tcp://[hidden]@10.0.0.1:4840",
    "opc.tcp://user:p?ss@10.0.0.1:4840": "opc.tcp://[hidden]@10.0.0.1:4840",
    "http://us/er:pw@host:9000": "http://[hidden]@host:9000",
    "opc.tcp://admin@corp.com:p#ss@10.0.0.1:4840": "opc.tcp://[hidden]@10.0.0.1:4840",  # "@" in the user name too
    "opc.tcp://user:p[ss@10.0.0.1:4840": "opc.tcp://[hidden]@10.0.0.1:4840",  # urlsplit raises ValueError
    "http://host/a@b": "http://[hidden]@b",
    "http://user:pw@host/a@b": "http://[hidden]@b",
}


def test_without_credentials_masks_userinfo_that_urlsplit_cannot_isolate():
    for url, expected in MASKED_URLS.items():
        assert without_credentials(url) == expected, url
    for url in ("opc.tcp://user:p#ss@10.0.0.1:4840", "opc.tcp://user:p/ss@10.0.0.1:4840", "http://us/er:pw@host:9000"):
        assert "ss@" not in without_credentials(url) and "pw" not in without_credentials(url)


def test_without_credentials_keeps_what_has_nothing_to_hide():
    assert without_credentials("opc.tcp://user:p%23ss@10.0.0.1:4840") == "opc.tcp://10.0.0.1:4840"  # encoded form
    assert without_credentials("//user:pw@host/x") == "//host/x"
    assert without_credentials("http://[::1]:9000/x") == "http://[::1]:9000/x"
    assert without_credentials("http://[::1") == "http://[::1"  # unparsable and no "@": returned as it is
    assert without_credentials("") == ""


def test_credentials_in_is_the_part_without_credentials_removes():
    assert credentials_in("http://user:pw@host:9000/x?y=1") == "user:pw"
    assert credentials_in("opc.tcp://u@10.0.0.1:4840") == "u"
    assert credentials_in("opc.tcp://user:p%23ss@h:4840") == "user:p%23ss"
    assert credentials_in("opc.tcp://user:p#ss@10.0.0.1:4840") == "user:p#ss"
    assert credentials_in("opc.tcp://admin@corp.com:p#ss@10.0.0.1:4840") == "admin@corp.com:p#ss"
    assert credentials_in("opc.tcp://user:p[ss@10.0.0.1:4840") == "user:p[ss"
    assert credentials_in("http://host/a@b") == "host/a"
    for nothing in ("http://host/x", "http://host:9000", "not a url", "me@example.com", "http://[::1", ""):
        assert credentials_in(nothing) == "", nothing


def test_hidden_parts_collects_what_safe_config_hides_and_nothing_else():
    config = {"url": "http://svc:pw@a:9000", "timeout_seconds": 5.0, "api_key": "k1", "password": "", "name": "plc"}
    assert hidden_parts(config) == {"url": "svc:pw", "api_key": "k1"}
    assert hidden_parts({"token": 12, "endpoint": "opc.tcp://10.0.0.1:4840"}) == {"token": "12"}
    assert hidden_parts({}) == {}
    # a host change keeps the hidden parts equal, a password change does not
    assert hidden_parts({"url": "http://svc:pw@a:9000"}) == hidden_parts({"url": "http://svc:pw@b:9000"})
    assert hidden_parts({"url": "http://svc:pw@a:9000"}) != hidden_parts({"url": "http://svc:pw2@a:9000"})
    assert hidden_parts({"url": "http://svc:pw@a:9000"}) != hidden_parts({"url": "http://a:9000"})


def test_safe_config_masks_credentials_and_keeps_the_rest():
    config = {"url": "http://u:p@h/", "timeout_seconds": 5.0, "password": "x", "api_key": "k", "client_key": "/certs/k.pem"}
    assert safe_config(config) == {
        "url": "http://h/", "timeout_seconds": 5.0, "password": "[hidden]", "api_key": "[hidden]",
        "client_key": "/certs/k.pem",
    }


def test_no_connector_config_field_looks_like_a_credential():
    # A connector that adds a "password" config field must be a conscious decision: safe_config would mask it, and a
    # masked field can never show a change in before/after. Make the secret the source secret instead.
    import dcdash.connectors  # noqa: F401  (registers the connectors)
    from dcdash.connectors.base import connector_types
    from dcdash.core.audit import SENSITIVE_KEYS

    types = connector_types()
    assert len(types) >= 3
    for name, cls in types.items():
        for field in cls.config_schema.model_fields:
            assert not SENSITIVE_KEYS.search(field), f"connector {name}: config field {field!r} looks like a credential"


async def write_change(**kwargs) -> bool:
    async with get_sessionmaker()() as session:
        wrote = await audit_change(session, None, **kwargs)
        await session.commit()
    return wrote


async def test_audit_change_writes_only_the_changed_fields(db):
    wrote = await write_change(
        action="thing.updated", subject={"thing_id": 4}, before={"a": 1, "b": 2}, after={"a": 1, "b": 3}
    )
    assert wrote is True
    assert await db.fetchval("SELECT detail FROM audit_log") == {
        "thing_id": 4, "before": {"b": 2}, "after": {"b": 3},
    }


async def test_audit_change_skips_a_no_op_and_compares_values_by_meaning(db):
    wrote = await write_change(
        action="x.updated", subject={"x_id": 1},
        before={"rate": Decimal("0.100000"), "from": date(2026, 1, 1), "color": Color.RED},
        after={"rate": 0.1, "from": "2026-01-01", "color": "red"},
    )
    assert wrote is False
    assert await db.fetchval("SELECT count(*) FROM audit_log") == 0


async def test_audit_change_always_writes_every_field(db):
    wrote = await write_change(
        action="storage.changed", subject={}, before={"a": 1, "b": 2}, after={"a": 1, "b": 2}, always=True
    )
    assert wrote is True
    assert await db.fetchval("SELECT detail FROM audit_log") == {"before": {"a": 1, "b": 2}, "after": {"a": 1, "b": 2}}
