from sqlalchemy import select

from dcdash.core.audit import audit, audit_pool
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
