"""The figure ledger's store (core/ledger.py): the rules of when a row may be used (`decide`, pure, every branch), the engine id,
and the writer side and the header read against a real database.

The consultation of the ledger from inside the figure cache (the hook in `_run`) is tested in test_figure_cache_ledger.py.
"""
import importlib.metadata
import logging
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError

from dcdash.core import ledger, ledger_codec
from dcdash.core.db import get_sessionmaker

UTC = timezone.utc
NOW = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)
SECOND = timedelta(seconds=1)
OPEN_END = NOW + timedelta(hours=1)  # a window that is still open
SETTLED_END = NOW - timedelta(days=9)  # one that ended more than 7 days and an hour ago


@pytest.fixture(autouse=True)
def _ledger_state():
    ledger.reset_stats()
    yield
    ledger.reset_stats()


def header(**changes) -> ledger.Header:
    """A good row: this engine, configuration "c", made 20 s ago and checked 10 s ago."""
    fields = dict(
        now=NOW, engine=ledger.engine_id(), config_fp="c", data_fp="d", snapshot_at=NOW - 20 * SECOND, checked_at=NOW - 10 * SECOND
    )
    fields.update(changes)
    return ledger.Header(**fields)


def decide(head, *, window_end=OPEN_END, fresh=False, replaced_data_at=None, config_fp="c"):
    return ledger.decide(head, config_fp=config_fp, window_end=window_end, fresh=fresh, replaced_data_at=replaced_data_at)


# ---- decide: the rules of plan D3, every branch -------------------------------------------------------------------------------


def test_a_good_young_row_of_an_open_window_is_used_without_a_data_check():
    assert decide(header()) == "open"


def test_no_row_is_a_miss():
    assert decide(ledger.Header(now=NOW)) == "miss"


def test_another_engine_is_a_miss_whatever_else_is_true():
    assert decide(header(engine="somebody-else")) == "miss"
    assert decide(header(engine="somebody-else"), window_end=SETTLED_END) == "miss"


def test_another_configuration_is_a_miss():
    assert decide(header(config_fp="other")) == "miss"
    assert decide(header(), config_fp="other") == "miss"


def test_a_row_dated_in_the_future_is_a_miss():
    future = NOW + timedelta(hours=1)
    assert decide(header(snapshot_at=future, checked_at=future)) == "miss"
    assert decide(header(snapshot_at=NOW + SECOND, checked_at=NOW + 2 * SECOND)) == "miss"


def test_a_check_after_the_database_now_is_a_negative_age_and_a_miss():
    assert decide(header(snapshot_at=NOW - 10 * SECOND, checked_at=NOW + SECOND)) == "miss"


def test_a_snapshot_after_its_own_check_is_a_miss():
    assert decide(header(snapshot_at=NOW - 5 * SECOND, checked_at=NOW - 10 * SECOND)) == "miss"


def test_a_row_made_and_checked_this_very_instant_is_good():
    assert decide(header(snapshot_at=NOW, checked_at=NOW)) == "open"


def test_a_row_with_a_missing_header_member_is_a_miss():
    assert decide(header(snapshot_at=None)) == "miss"
    assert decide(header(checked_at=None)) == "miss"
    assert decide(header(data_fp=None)) == "miss"


@pytest.mark.parametrize(
    ("age", "expected"),
    [(0, "open"), (59, "open"), (60, "open"), (61, "check"), (3600, "check")],
)
def test_an_open_window_uses_a_row_checked_at_most_sixty_seconds_ago(age, expected):
    head = header(snapshot_at=NOW - timedelta(seconds=age + 5), checked_at=NOW - timedelta(seconds=age))
    assert decide(head) == expected


def test_a_settled_window_always_checks_the_data_even_for_a_young_row():
    assert decide(header(), window_end=SETTLED_END) == "check"
    boundary = NOW - ledger.OPEN_DAYS_PLUS
    assert decide(header(), window_end=boundary) == "check"  # ended exactly 7 days and an hour ago: settled
    assert decide(header(), window_end=boundary + timedelta(microseconds=1)) == "open"


def test_a_request_under_require_fresh_always_checks_the_data():
    assert decide(header(), fresh=True) == "check"


def test_a_row_older_than_the_entry_it_would_replace_is_checked_not_used_on_trust():
    head = header()
    assert decide(head, replaced_data_at=head.checked_at + timedelta(microseconds=1)) == "check"
    assert decide(head, replaced_data_at=head.checked_at) == "open"  # equal is not older
    assert decide(head, replaced_data_at=head.checked_at - SECOND) == "open"


def test_the_constants_are_the_ones_of_the_plan():
    assert ledger.OPEN_DAYS_PLUS == timedelta(days=7, hours=1) and ledger.OPEN_MAX_AGE == timedelta(seconds=60)


# ---- the switch, the counters -------------------------------------------------------------------------------------------------


def test_the_ledger_is_on_unless_the_variable_is_zero_and_it_is_read_at_call_time(monkeypatch):
    monkeypatch.delenv("DCDASH_FIGURE_LEDGER", raising=False)
    assert ledger.enabled()
    monkeypatch.setenv("DCDASH_FIGURE_LEDGER", "0")
    assert not ledger.enabled()
    monkeypatch.setenv("DCDASH_FIGURE_LEDGER", "1")
    assert ledger.enabled()


def test_the_counters_are_their_own_and_are_not_the_figure_caches():
    from dcdash.core import figure_cache

    assert ledger.stats() == {"hits_exact": 0, "hits_open": 0, "misses": 0, "errors": 0}
    assert {"hits_exact", "hits_open", "errors"}.isdisjoint(figure_cache.stats())  # (both count "misses", each its own)
    ledger.record_error("testing", ValueError("secret payload text"))
    assert ledger.stats()["errors"] == 1
    ledger.reset_stats()
    assert ledger.stats()["errors"] == 0


def test_an_error_is_logged_once_per_exception_type_and_never_with_its_message(caplog):
    with caplog.at_level(logging.WARNING, logger="dcdash.core.ledger"):
        ledger.record_error("reading the payload", ValueError("secret payload text"))
        ledger.record_error("reading the payload", ValueError("secret payload text"))
        ledger.record_error("reading the header", KeyError("other"))
    assert len(caplog.records) == 2 and ledger.stats()["errors"] == 3
    assert "secret" not in caplog.text and "ValueError" in caplog.text and "KeyError" in caplog.text


# ---- the engine id ------------------------------------------------------------------------------------------------------------


def make_tree(root):
    for name, body in (
        ("core/a.py", "A = 1\n"), ("core/sub/b.py", "B = 2\n"), ("figures/w.py", "W = 3\n"), ("api/billing_check.py", "C = 4\n"),
        ("api/other.py", "O = 5\n"), ("core/notes.txt", "not python\n"),
    ):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    return root


def test_the_engine_id_is_sixteen_hex_digits_and_stable_across_calls():
    first = ledger.engine_id()
    assert len(first) == 16 and int(first, 16) >= 0
    assert ledger.engine_id() == first == ledger.engine_id()
    assert ledger._engine_id_for(ledger._PACKAGE) == first


def test_the_engine_id_changes_when_the_bytes_of_an_engine_file_change(tmp_path):
    root = make_tree(tmp_path)
    base = ledger._engine_id_for(root)
    assert ledger._engine_id_for(root) == base
    for name in ("core/a.py", "core/sub/b.py", "figures/w.py", "api/billing_check.py"):
        path = root / name
        original = path.read_bytes()
        path.write_bytes(original + b"#")
        assert ledger._engine_id_for(root) != base, name
        path.write_bytes(original)
        assert ledger._engine_id_for(root) == base, name


def test_the_engine_id_ignores_files_that_are_not_the_engine(tmp_path):
    root = make_tree(tmp_path)
    base = ledger._engine_id_for(root)
    (root / "api/other.py").write_text("changed = True\n")
    (root / "core/notes.txt").write_text("changed\n")
    (root / "core/__pycache__").mkdir()
    (root / "core/__pycache__/a.cpython-312.pyc").write_bytes(b"\0\1")
    assert ledger._engine_id_for(root) == base


def test_the_engine_id_sees_a_new_file_a_removed_file_and_a_rename(tmp_path):
    root = make_tree(tmp_path)
    base = ledger._engine_id_for(root)
    (root / "figures/new.py").write_text("N = 6\n")
    with_new = ledger._engine_id_for(root)
    assert with_new != base
    (root / "figures/new.py").unlink()
    assert ledger._engine_id_for(root) == base
    (root / "core/a.py").rename(root / "core/z.py")  # the same bytes under another name
    assert ledger._engine_id_for(root) != base


def test_the_engine_id_does_not_need_the_figures_package_or_the_billing_check_file(tmp_path):
    root = make_tree(tmp_path)
    full = ledger._engine_id_for(root)
    (root / "figures/w.py").unlink()
    (root / "figures").rmdir()
    without_figures = ledger._engine_id_for(root)
    assert without_figures != full
    (root / "api/billing_check.py").unlink()
    assert ledger._engine_id_for(root) not in (full, without_figures)


def test_the_engine_id_includes_the_python_version_the_tzdata_version_and_the_codec_format(tmp_path, monkeypatch):
    root = make_tree(tmp_path)
    base = ledger._engine_id_for(root)
    monkeypatch.setattr(sys, "version", sys.version + " (another build)")
    assert ledger._engine_id_for(root) != base
    monkeypatch.undo()
    assert ledger._engine_id_for(root) == base

    versions = {"tzdata": "2025.1"}

    def fake_version(name):
        if name not in versions:
            raise importlib.metadata.PackageNotFoundError(name)
        return versions[name]

    monkeypatch.setattr(importlib.metadata, "version", fake_version)
    old_rules = ledger._engine_id_for(root)
    versions["tzdata"] = "2025.2"
    assert ledger._engine_id_for(root) != old_rules
    del versions["tzdata"]  # not installed: the text "none"
    not_installed = ledger._engine_id_for(root)
    assert not_installed != old_rules
    monkeypatch.undo()

    monkeypatch.setattr(ledger_codec, "LEDGER_FORMAT", ledger_codec.LEDGER_FORMAT + 1)
    assert ledger._engine_id_for(root) != base


def test_the_engine_id_of_the_real_package_covers_the_core_files_and_the_billing_check():
    listed = [name for name, _ in ledger._engine_sources(ledger._PACKAGE)]
    assert {"core/ledger.py", "core/figure_cache.py", "core/figures.py", "core/ledger_codec.py", "api/billing_check.py"} <= set(listed)
    assert not any(name.startswith("api/") and name != "api/billing_check.py" for name in listed)
    assert listed == sorted(listed)  # sorted by relative path: the id does not depend on the order the disk lists them


# ---- the writer side and the header read, against a database ------------------------------------------------------------------

START = datetime(2026, 9, 1, tzinfo=UTC)
END = datetime(2026, 10, 1, tzinfo=UTC)
KEY = ("month-days", START, END, '["UTC"]')


@pytest.fixture
async def session(db):
    async with get_sessionmaker()() as s:
        yield s


async def put(session, *, key=KEY, payload=b"payload", engine=None, config_fp="c", data_fp="d", snapshot_at=None,
              checked_at=None) -> bool:
    now = datetime.now(UTC)
    written = await ledger.write(
        session, *key, payload, engine=engine or ledger.engine_id(), config_fp=config_fp, data_fp=data_fp,
        snapshot_at=snapshot_at or now - 20 * SECOND, checked_at=checked_at or now - 10 * SECOND,
    )
    await session.commit()
    return written


async def stored(db, key=KEY):
    return await db.fetchrow(
        "SELECT engine, config_fp, data_fp, snapshot_at, checked_at, size_bytes, payload FROM figure_ledger "
        "WHERE kind = $1 AND start_ts = $2 AND end_ts = $3 AND params = $4", *key,
    )


async def test_write_inserts_a_row_with_every_column(db, session):
    snapshot, checked = datetime.now(UTC) - 60 * SECOND, datetime.now(UTC) - 30 * SECOND
    assert await put(session, payload=b"abcdef", engine="e1", config_fp="c1", data_fp="d1", snapshot_at=snapshot, checked_at=checked)
    row = await stored(db)
    assert (row["engine"], row["config_fp"], row["data_fp"]) == ("e1", "c1", "d1")
    assert (row["snapshot_at"], row["checked_at"], row["size_bytes"], bytes(row["payload"])) == (snapshot, checked, 6, b"abcdef")
    assert await db.fetchval("SELECT count(*) FROM figure_ledger") == 1


async def test_write_replaces_a_row_only_for_a_newer_snapshot(db, session):
    base = datetime.now(UTC) - timedelta(minutes=10)
    assert await put(session, payload=b"v2", data_fp="d2", snapshot_at=base, checked_at=base)
    assert await put(session, payload=b"v3", data_fp="d3", snapshot_at=base + 60 * SECOND, checked_at=base + 60 * SECOND)
    assert bytes((await stored(db))["payload"]) == b"v3"
    # an older snapshot never rolls the row back, and an equal one does not either
    assert not await put(session, payload=b"v1", data_fp="d1", snapshot_at=base - 60 * SECOND, checked_at=base - 60 * SECOND)
    assert not await put(session, payload=b"vE", data_fp="dE", snapshot_at=base + 60 * SECOND, checked_at=base + 90 * SECOND)
    row = await stored(db)
    assert bytes(row["payload"]) == b"v3" and row["data_fp"] == "d3" and row["size_bytes"] == 2
    assert row["checked_at"] == base + 60 * SECOND


async def test_write_replaces_a_row_dated_in_the_future_even_by_an_older_snapshot(db, session):
    future = datetime.now(UTC) + timedelta(hours=2)
    assert await put(session, payload=b"future", snapshot_at=future, checked_at=future)
    past = datetime.now(UTC) - timedelta(minutes=5)
    assert await put(session, payload=b"honest", snapshot_at=past, checked_at=past)
    row = await stored(db)
    assert bytes(row["payload"]) == b"honest" and row["snapshot_at"] == past


async def test_keys_differ_by_kind_window_and_params(db, session):
    await put(session, payload=b"1")
    await put(session, key=("window-values", START, END, '["UTC"]'), payload=b"2")
    await put(session, key=("month-days", START, END + timedelta(hours=1), '["UTC"]'), payload=b"3")
    await put(session, key=("month-days", START, END, '["Europe/Berlin"]'), payload=b"4")
    assert await db.fetchval("SELECT count(*) FROM figure_ledger") == 4
    assert bytes((await stored(db))["payload"]) == b"1"


async def test_touch_raises_checked_at_only_when_engine_config_and_data_match(db, session):
    old = datetime.now(UTC) - timedelta(minutes=10)
    await put(session, snapshot_at=old - 60 * SECOND, checked_at=old)
    engine = ledger.engine_id()
    for wrong in (
        dict(engine="other", config_fp="c", data_fp="d"),
        dict(engine=engine, config_fp="other", data_fp="d"),
        dict(engine=engine, config_fp="c", data_fp="other"),
    ):
        assert not await ledger.touch(session, *KEY, **wrong)
        await session.commit()
        assert (await stored(db))["checked_at"] == old
    assert not await ledger.touch(session, "month-days", START, END, '["Elsewhere"]', engine=engine, config_fp="c", data_fp="d")
    assert await ledger.touch(session, *KEY, engine=engine, config_fp="c", data_fp="d")
    await session.commit()
    row = await stored(db)
    assert row["checked_at"] > old and row["snapshot_at"] == old - 60 * SECOND and bytes(row["payload"]) == b"payload"


async def test_touch_never_moves_checked_at_backwards(db, session):
    future = datetime.now(UTC) + timedelta(hours=1)
    await put(session, snapshot_at=datetime.now(UTC) - 60 * SECOND, checked_at=future)
    assert await ledger.touch(session, *KEY, engine=ledger.engine_id(), config_fp="c", data_fp="d")
    await session.commit()
    assert (await stored(db))["checked_at"] == future


async def test_delete_removes_one_key(db, session):
    await put(session)
    await put(session, key=("window-values", START, END, '["UTC"]'))
    assert await ledger.delete(session, *KEY)
    assert not await ledger.delete(session, *KEY)
    await session.commit()
    assert await db.fetchval("SELECT kind FROM figure_ledger") == "window-values"


async def test_delete_future_removes_the_rows_dated_in_the_future_and_counts_them(db, session):
    now = datetime.now(UTC)
    await put(session, key=("a", START, END, "[]"), snapshot_at=now - 60 * SECOND, checked_at=now - 30 * SECOND)  # honest
    await put(session, key=("b", START, END, "[]"), snapshot_at=now + timedelta(hours=1), checked_at=now + timedelta(hours=1))
    await put(session, key=("c", START, END, "[]"), snapshot_at=now - 60 * SECOND, checked_at=now + timedelta(hours=1))
    assert await ledger.delete_future(session) == 2
    await session.commit()
    assert await db.fetchval("SELECT kind FROM figure_ledger") == "a"
    assert await ledger.delete_future(session) == 0


async def test_list_rows_has_the_key_and_the_headers_and_never_the_payload(db, session):
    await put(session, payload=b"x" * 40, engine="e1", config_fp="c1", data_fp="d1")
    await put(session, key=("window-values", START, END, "[1]"), payload=b"yy")
    rows = await ledger.list_rows(session)
    assert [row.kind for row in rows] == ["month-days", "window-values"]
    first = rows[0]
    assert (first.start_ts, first.end_ts, first.params, first.engine, first.config_fp, first.data_fp) == (
        START, END, '["UTC"]', "e1", "c1", "d1",
    )
    assert first.size_bytes == 40 and rows[1].size_bytes == 2
    assert not hasattr(first, "payload") and "payload" not in {name for name in vars(first)}


async def test_read_header_always_returns_the_database_now_and_the_header_of_a_row(db, session):
    empty = await ledger.read_header(session, *KEY)
    assert empty.engine is None and empty.config_fp is None and empty.data_fp is None
    assert empty.snapshot_at is None and empty.checked_at is None
    assert empty.now.tzinfo is not None and abs((empty.now - datetime.now(UTC)).total_seconds()) < 60
    snapshot, checked = datetime.now(UTC) - 60 * SECOND, datetime.now(UTC) - 30 * SECOND
    await put(session, snapshot_at=snapshot, checked_at=checked, engine="e1", config_fp="c1", data_fp="d1")
    found = await ledger.read_header(session, *KEY)
    assert (found.engine, found.config_fp, found.data_fp, found.snapshot_at, found.checked_at) == ("e1", "c1", "d1", snapshot, checked)
    other = await ledger.read_header(session, "month-days", START, END, '["Elsewhere"]')
    assert other.engine is None


async def test_read_payload_gives_the_bytes_of_the_row_or_none(db, session):
    assert await ledger.read_payload(session, *KEY) is None
    await put(session, payload=bytes(range(256)))
    raw = await ledger.read_payload(session, *KEY)
    assert type(raw) is bytes and raw == bytes(range(256))
    assert await ledger.read_payload(session, "month-days", START, END, '["Elsewhere"]') is None


async def test_a_failing_header_read_raises_and_leaves_the_session_and_its_snapshot_usable(db, session, monkeypatch):
    await put(session)
    await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
    assert await session.scalar(text("SELECT count(*) FROM figure_ledger")) == 1  # the snapshot is taken here
    await db.execute("DELETE FROM figure_ledger")  # another connection, after the snapshot

    monkeypatch.setattr(ledger, "_HEADER", text("SELECT 1 FROM a_table_that_does_not_exist WHERE :k = :s AND :e = :p"))
    with pytest.raises(ProgrammingError):
        await ledger.read_header(session, *KEY)
    monkeypatch.undo()

    assert await session.scalar(text("SELECT 1")) == 1  # the transaction is not aborted
    assert await session.scalar(text("SELECT count(*) FROM figure_ledger")) == 1  # and it is still the same snapshot
    found = await ledger.read_header(session, *KEY)  # a read that works after the failed one
    assert found.engine == ledger.engine_id()
    await session.rollback()
    assert await session.scalar(text("SELECT count(*) FROM figure_ledger")) == 0


async def test_a_failing_payload_read_also_leaves_the_session_usable(db, session, monkeypatch):
    await put(session)
    monkeypatch.setattr(ledger, "_PAYLOAD", text("SELECT payload FROM a_table_that_does_not_exist WHERE :k = :s AND :e = :p"))
    with pytest.raises(ProgrammingError):
        await ledger.read_payload(session, *KEY)
    monkeypatch.undo()
    assert await ledger.read_payload(session, *KEY) == b"payload"


# ---- consult, with a stand-in decoder ------------------------------------------------------------------------------------------


def decoder(config_fp="c"):
    return lambda raw: SimpleNamespace(config_fp=config_fp, raw=raw)


def spec(window_end, decode=None) -> ledger.LedgerSpec:
    return ledger.LedgerSpec(KEY[0], KEY[3], window_end, decode or decoder())


class DataFp:
    """The data fingerprint reader a caller passes to `consult`: counts its calls."""

    def __init__(self, value="d"):
        self.value, self.calls = value, 0

    async def __call__(self):
        self.calls += 1
        return self.value


async def consult(session, window_end, read, *, decode=None, fresh=False, replaced=None, config_fp="c"):
    return await ledger.consult(
        session, spec(window_end, decode), START, END, config_fp=config_fp, fresh=fresh, replaced_data_at=replaced, read_data_fp=read
    )


async def test_consult_uses_a_young_row_of_an_open_window_without_reading_the_data(db, session):
    await put(session, payload=b"the bytes", checked_at=datetime.now(UTC) - 10 * SECOND)
    read = DataFp()
    hit, data_fp, db_now = await consult(session, datetime.now(UTC) + timedelta(hours=1), read)
    assert read.calls == 0 and data_fp is None and db_now is not None
    assert hit is not None and not hit.exact and hit.value.raw == b"the bytes" and hit.data_fp == "d"
    assert 5 < hit.age_seconds < 60 and hit.data_at < db_now
    assert ledger.stats() == {"hits_exact": 0, "hits_open": 1, "misses": 0, "errors": 0}


async def test_consult_takes_a_settled_row_only_on_an_exact_data_match_and_returns_the_fingerprint_it_read(db, session):
    await put(session, payload=b"settled")
    settled = datetime.now(UTC) - timedelta(days=30)
    read = DataFp("d")
    hit, data_fp, db_now = await consult(session, settled, read)
    assert read.calls == 1 and data_fp == "d" and hit.exact and hit.age_seconds == 0.0 and hit.data_at == db_now
    assert hit.value.raw == b"settled"
    moved = DataFp("moved")
    hit, data_fp, db_now = await consult(session, settled, moved)
    assert hit is None and data_fp == "moved" and db_now is not None and moved.calls == 1  # the caller need not read it again
    assert ledger.stats() == {"hits_exact": 1, "hits_open": 0, "misses": 1, "errors": 0}


async def test_consult_with_no_row_or_a_judged_miss_reads_nothing_more(db, session):
    read = DataFp()
    hit, data_fp, db_now = await consult(session, datetime.now(UTC) + timedelta(hours=1), read)
    assert (hit, data_fp) == (None, None) and db_now is not None and read.calls == 0
    await put(session, engine="another-build")
    assert (await consult(session, datetime.now(UTC) + timedelta(hours=1), read))[0] is None
    assert read.calls == 0 and ledger.stats()["misses"] == 2 and ledger.stats()["errors"] == 0


async def test_consult_under_require_fresh_checks_the_data_even_for_a_young_open_row(db, session):
    await put(session)
    read = DataFp("d")
    hit, _, _ = await consult(session, datetime.now(UTC) + timedelta(hours=1), read, fresh=True)
    assert hit is not None and hit.exact and read.calls == 1
    moved = DataFp("moved")
    assert (await consult(session, datetime.now(UTC) + timedelta(hours=1), moved, fresh=True))[0] is None


async def test_consult_never_raises_for_a_failing_header_and_says_it_learned_nothing(db, session, monkeypatch, caplog):
    async def broken(*args, **kwargs):
        raise ProgrammingError("SELECT ...", {}, Exception("relation figure_ledger does not exist"))

    monkeypatch.setattr(ledger, "read_header", broken)
    with caplog.at_level(logging.WARNING, logger="dcdash.core.ledger"):
        result = await consult(session, datetime.now(UTC) + timedelta(hours=1), DataFp())
        await consult(session, datetime.now(UTC) + timedelta(hours=1), DataFp())
    assert result == (None, None, None)
    assert ledger.stats() == {"hits_exact": 0, "hits_open": 0, "misses": 2, "errors": 2}
    assert len([r for r in caplog.records if "ProgrammingError" in r.getMessage()]) == 1  # once per type


@pytest.mark.parametrize(
    "case", ["garbage", "decoder raises", "another config in the value", "no config in the value"]
)
async def test_consult_turns_an_unusable_payload_into_a_miss_that_keeps_what_it_learned(db, session, case):
    await put(session, payload=b"\x00not zlib")

    def raising(raw):
        raise ValueError("cannot decode " + repr(raw))

    decode = {
        "garbage": ledger_codec.decode_json,
        "decoder raises": raising,
        "another config in the value": decoder("another"),
        "no config in the value": lambda raw: {"a": 1},
    }[case]
    # an exact check on a settled window: the data fingerprint was read and is handed back
    read = DataFp("d")
    hit, data_fp, db_now = await consult(session, datetime.now(UTC) - timedelta(days=30), read, decode=decode)
    assert hit is None and data_fp == "d" and db_now is not None
    assert ledger.stats()["errors"] == 1 and ledger.stats()["misses"] == 1 and ledger.stats()["hits_exact"] == 0
    assert await session.scalar(text("SELECT 1")) == 1  # the session is fine
    # on an open window the same: no data read
    ledger.reset_stats()
    hit, data_fp, db_now = await consult(session, datetime.now(UTC) + timedelta(hours=1), DataFp(), decode=decode)
    assert hit is None and data_fp is None and db_now is not None and ledger.stats()["errors"] == 1


async def test_consult_lets_the_requests_own_data_read_fail_as_it_would_without_the_ledger(db, session):
    await put(session)

    async def failing():
        raise RuntimeError("the data fingerprint could not be read")

    with pytest.raises(RuntimeError):
        await consult(session, datetime.now(UTC) - timedelta(days=30), failing)
    assert ledger.stats()["errors"] == 0


async def test_consult_decodes_off_the_event_loop(db, session, monkeypatch):
    import threading

    await put(session)
    seen = {}

    def decode(raw):
        seen["thread"] = threading.current_thread().name
        return SimpleNamespace(config_fp="c")

    hit, _, _ = await consult(session, datetime.now(UTC) + timedelta(hours=1), DataFp(), decode=decode)
    assert hit is not None and seen["thread"].startswith("dcdash-compute") and seen["thread"] != threading.current_thread().name
