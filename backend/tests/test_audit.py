from datetime import date
from decimal import Decimal
from enum import Enum

from sqlalchemy import select

from dcdash.core.audit import audit, audit_change, audit_pool, changed_fields, plain, safe_config, without_credentials
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
