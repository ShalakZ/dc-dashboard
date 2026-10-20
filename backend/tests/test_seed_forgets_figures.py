"""The history seeder clears the stored figures once it has moved the rollups (w26b).

A figure of an OPEN month is trusted for up to a minute without a data check (core/ledger.py, `decide`), so a page opened right
after a seed, or after its undo, would show the figures of before it. `seed.history.refresh_rollups` is the one place where
seeded hours become visible to readers, and it ends by clearing `figure_ledger` (derived data: the `figures` service rebuilds it).
These tests are small on purpose: they do not seed anything (`test_seed_history.py` does, slowly).
"""
from datetime import datetime, timezone
from types import SimpleNamespace

import asyncpg

from dcdash.seed import history

NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)

ROW = (
    "INSERT INTO figure_ledger (kind, start_ts, end_ts, params, engine, config_fp, data_fp, snapshot_at, checked_at, size_bytes, payload) "
    "VALUES ('month-days', $1, $2, '[\"UTC\"]', 'e', 'c', 'd', $3, $3, 3, '\\x010203')"
)


async def count(db) -> int:
    return await db.fetchval("SELECT count(*) FROM figure_ledger")


async def test_forget_figures_clears_the_stored_figures(db):
    await db.execute(ROW, datetime(2026, 10, 1, tzinfo=timezone.utc), datetime(2026, 11, 1, tzinfo=timezone.utc), NOW)
    await db.execute(ROW, datetime(2026, 9, 1, tzinfo=timezone.utc), datetime(2026, 10, 1, tzinfo=timezone.utc), NOW)
    assert await count(db) == 2
    await history.forget_figures(db)
    assert await count(db) == 0


async def test_the_rollup_refresh_of_a_seed_ends_by_forgetting_the_figures(db, monkeypatch):
    """`refresh_rollups` is what `_seed` and `_undo` both call after they changed readings: it refreshes both rollups, THEN clears."""
    order: list[str] = []

    async def refreshed(pool, view, lo, hi):
        order.append(f"refresh {view}")

    async def forgot(pool):
        order.append("forget")

    monkeypatch.setattr(history, "_refresh", refreshed)
    monkeypatch.setattr(history, "forget_figures", forgot)
    await history.refresh_rollups(db, SimpleNamespace(start=NOW, now=NOW))
    assert order == ["refresh readings_1m", "refresh readings_1h", "forget"]


async def test_a_seed_is_never_failed_by_the_figures_table(db, monkeypatch, capsys):
    """An older schema has no table (left alone, silently); any other failure is one line on stderr, never an exception."""

    class Broken:
        def __init__(self, error: Exception):
            self.error = error

        async def execute(self, *args):
            raise self.error

    await history.forget_figures(Broken(asyncpg.UndefinedTableError("relation does not exist")))
    assert capsys.readouterr().err == ""
    await history.forget_figures(Broken(RuntimeError("the connection dropped")))
    assert "could not clear the stored figures (RuntimeError)" in capsys.readouterr().err
