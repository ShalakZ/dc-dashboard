"""The figure ledger's store (core/ledger.py): the rules of when a row may be used (`decide`, pure, every branch), the engine id,
and the writer side and the header read against a real database.

The consultation of the ledger from inside the figure cache (the hook in `_run`) is tested in test_figure_cache_ledger.py.
"""
import asyncio
import importlib.metadata
import json
import logging
import subprocess
import sys
import time
import zoneinfo
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import event, text
from sqlalchemy.exc import DBAPIError, ProgrammingError

from dcdash.core import ledger, ledger_codec
from dcdash.core.db import get_engine, get_sessionmaker

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


def decide(head, *, window_end=OPEN_END, fresh=False, replaced_data_at=None, replaced_exists=None, replaced_data_fp=None, config_fp="c"):
    """`replaced_exists` defaults to "there is an entry exactly when one of its facts is given"."""
    if replaced_exists is None:
        replaced_exists = replaced_data_at is not None or replaced_data_fp is not None
    return ledger.decide(
        head, config_fp=config_fp, window_end=window_end, fresh=fresh, replaced_exists=replaced_exists,
        replaced_data_at=replaced_data_at, replaced_data_fp=replaced_data_fp,
    )


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
    [(0, "open"), (54, "open"), (55, "open"), (55.001, "check"), (56, "check"), (60, "check"), (61, "check"), (3600, "check")],
)
def test_an_open_window_uses_a_row_checked_at_most_fifty_five_seconds_ago(age, expected):
    # 55 s = OPEN_MAX_AGE - BORN_ALIVE_SECONDS: the entry made from such a row keeps at least BORN_ALIVE_SECONDS of life, so the
    # figure it shows is never trusted past max(TTL, 60 s) after the check of its data (plan review I2)
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


def test_an_entry_that_does_not_know_the_time_of_its_data_is_never_replaced_on_trust():
    # I4: the entry exists but was made when the ledger could not be read (data_at None): an older row cannot be told apart
    head = header()
    assert decide(head, replaced_exists=True, replaced_data_at=None) == "check"
    assert decide(head, replaced_exists=True, replaced_data_at=None, replaced_data_fp="another") == "check"
    assert decide(head, replaced_exists=False) == "open"  # no entry at all: nothing to be older than
    assert decide(head, replaced_exists=True, replaced_data_at=head.checked_at - SECOND, replaced_data_fp="another") == "open"


def test_the_row_an_entry_already_holds_is_checked_not_taken_again():
    # M1: the entry was found stale, and it holds this very row's fingerprint: taking the row again would only extend its life
    head = header(data_fp="the-row")
    older = head.checked_at - SECOND
    assert decide(head, replaced_data_at=older, replaced_data_fp="the-row") == "check"
    assert decide(head, replaced_data_at=older, replaced_data_fp="another-row") == "open"
    assert decide(head, replaced_data_at=older, replaced_data_fp=None) == "open"
    # only the choice between the rules changes: a row of another engine or configuration is still a miss
    assert decide(header(data_fp="the-row", config_fp="other"), replaced_data_at=older, replaced_data_fp="the-row") == "miss"
    assert decide(header(data_fp="the-row", engine="x"), replaced_data_at=older, replaced_data_fp="the-row") == "miss"


def test_the_constants_are_the_ones_of_the_plan():
    assert ledger.OPEN_DAYS_PLUS == timedelta(days=7, hours=1) and ledger.OPEN_MAX_AGE == timedelta(seconds=60)
    assert ledger.BORN_ALIVE_SECONDS == 5.0


# ---- the switch, the counters -------------------------------------------------------------------------------------------------


def test_the_ledger_is_on_unless_the_variable_is_zero_and_it_is_read_at_call_time(monkeypatch):
    monkeypatch.delenv("DCDASH_FIGURE_LEDGER", raising=False)
    assert ledger.enabled()
    monkeypatch.setenv("DCDASH_FIGURE_LEDGER", "0")
    assert not ledger.enabled()
    monkeypatch.setenv("DCDASH_FIGURE_LEDGER", "1")
    assert ledger.enabled()


@pytest.mark.parametrize("spelling", ["0", "false", "off", "no", "FALSE", "Off", "No", " 0 ", "\tfalse\n", " OFF "])
def test_every_spelling_of_off_turns_the_ledger_off(monkeypatch, spelling):
    monkeypatch.setenv("DCDASH_FIGURE_LEDGER", spelling)
    assert not ledger.enabled()


@pytest.mark.parametrize("spelling", ["1", "true", "on", "yes", "", " ", "anything", "00", "2", "offf", "n"])
def test_anything_else_leaves_the_ledger_on(monkeypatch, spelling):
    monkeypatch.setenv("DCDASH_FIGURE_LEDGER", spelling)
    assert ledger.enabled()


def test_the_figure_cache_switch_still_treats_only_zero_as_off(monkeypatch):
    from dcdash.core import figure_cache

    for spelling, expected in (("0", False), ("false", True), ("off", True), ("no", True), ("1", True)):
        monkeypatch.setenv("DCDASH_FIGURE_CACHE", spelling)
        assert figure_cache.enabled() is expected, spelling


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


def test_the_engine_id_is_fixed_at_import_and_nothing_is_read_again_per_call(monkeypatch):
    def forbidden(root):
        raise AssertionError("the engine id was computed again")

    monkeypatch.setattr(ledger, "_engine_id_for", forbidden)
    first = ledger.engine_id()
    assert first == ledger.engine_id() == ledger._engine_id and first != ledger.UNAVAILABLE
    assert decide(header()) == "open"  # `decide` does not read it again either
    assert ledger.engine_matches(first) and not ledger.engine_matches("another") and not ledger.engine_matches(None)


def test_an_unreadable_engine_source_makes_the_id_unavailable_and_every_row_a_miss(tmp_path, monkeypatch, caplog):
    root = make_tree(tmp_path)
    (root / "core" / "broken.py").mkdir()  # `rglob("*.py")` lists a directory of that name; reading it raises an OSError
    with caplog.at_level(logging.WARNING, logger="dcdash.core.ledger"):
        sentinel = ledger._load_engine_id(root)
    assert sentinel == ledger.UNAVAILABLE and "engine id could not be computed" in caplog.text
    assert "IsADirectoryError" in caplog.text

    monkeypatch.setattr(ledger, "_engine_id", sentinel)
    reads = []
    monkeypatch.setattr(ledger, "_engine_id_for", lambda root: reads.append(root) or "never")
    assert ledger.engine_id() == ledger.UNAVAILABLE
    # every row is a miss, even one that carries the very text of the sentinel, and nothing is read per request
    for engine in (ledger.UNAVAILABLE, "0123456789abcdef", None):
        for window_end in (OPEN_END, SETTLED_END):
            assert decide(header(engine=engine), window_end=window_end) == "miss"
    assert not ledger.engine_matches(ledger.UNAVAILABLE)
    assert reads == []


def test_a_readable_root_gives_a_real_id_not_the_sentinel(tmp_path):
    root = make_tree(tmp_path)
    assert ledger._load_engine_id(root) == ledger._engine_id_for(root) != ledger.UNAVAILABLE


def test_the_engine_id_hashes_the_zone_data_that_is_loaded(tmp_path, monkeypatch):
    root = make_tree(tmp_path / "pkg")
    first, second = tmp_path / "zones-1", tmp_path / "zones-2"
    first.mkdir()
    second.mkdir()
    monkeypatch.setattr(zoneinfo, "TZPATH", (str(first),))
    nothing = ledger._engine_id_for(root)
    assert ledger._engine_id_for(root) == nothing

    (first / "tzdata.zi").write_bytes(b"# version 2026c\nR a 1\n")
    rules_c = ledger._engine_id_for(root)
    assert rules_c != nothing
    (first / "tzdata.zi").write_bytes(b"# version 2026d\nR a 1\n")
    rules_d = ledger._engine_id_for(root)
    assert rules_d not in (nothing, rules_c)  # a package upgrade of the zone rules in the image changes the id

    (first / "tzdata.zi").unlink()
    (first / "+VERSION").write_bytes(b"2026c\n")  # the other file that names a version
    by_version = ledger._engine_id_for(root)
    assert by_version not in (nothing, rules_c, rules_d)
    (first / "+VERSION").write_bytes(b"2026d\n")
    assert ledger._engine_id_for(root) != by_version

    # the first directory that has one counts: a later directory's file changes nothing, an earlier one's takes over
    (first / "tzdata.zi").write_bytes(b"# version 2026c\nR a 1\n")
    (first / "+VERSION").unlink()
    monkeypatch.setattr(zoneinfo, "TZPATH", (str(first), str(second)))
    (second / "tzdata.zi").write_bytes(b"one")
    both = ledger._engine_id_for(root)
    (second / "tzdata.zi").write_bytes(b"another")
    assert ledger._engine_id_for(root) == both
    # (the list of directories is part of the id as well)
    monkeypatch.setattr(zoneinfo, "TZPATH", (str(first),))
    assert ledger._engine_id_for(root) != both


def test_the_engine_id_hashes_the_lock_file_next_to_the_package_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(zoneinfo, "TZPATH", ())
    root = make_tree(tmp_path / "backend" / "dcdash")  # as `backend/dcdash` in the repository and `/app/dcdash` in the image
    without = ledger._engine_id_for(root)
    lock = tmp_path / "backend" / "uv.lock"
    lock.write_bytes(b'[[package]]\nname = "asyncpg"\nversion = "0.30.0"\n')
    with_lock = ledger._engine_id_for(root)
    assert with_lock != without
    lock.write_bytes(b'[[package]]\nname = "asyncpg"\nversion = "0.31.0"\n')
    assert ledger._engine_id_for(root) not in (without, with_lock)
    lock.write_bytes(b"")  # an empty file is not an absent one
    assert ledger._engine_id_for(root) != without
    lock.unlink()
    assert ledger._engine_id_for(root) == without
    (tmp_path / "uv.lock").write_bytes(b"in the wrong directory")  # only the file next to the package's parent counts
    assert ledger._engine_id_for(root) == without


def test_the_real_package_sits_next_to_the_lock_file_the_id_reads():
    assert (ledger._PACKAGE.parent / ledger._LOCKFILE).is_file()


# What the engine id does NOT hash must not feed a figure. The id covers `dcdash/core`, `dcdash/figures` and `api/billing_check.py`;
# these are the other `dcdash` modules those builders import, each with the reason it is not part of any figure. If a builder starts
# to use one of them for a value, hash it (add its file to `ledger._ENGINE_FILES`) instead of listing it here.
NOT_HASHED_ON_PURPOSE = {
    "dcdash": "the package's empty __init__",
    "dcdash.api": "the api package's empty __init__",
    "dcdash.api.billing": "billing_check takes MONTH_PATTERN (query validation) and `_now()` (the endpoint's clock, which only picks "
                          "`stop`, a part of the key) from it; month_report and build_report never call it",
    "dcdash.api.settings": "`current_timezone` reads the site zone for the endpoint; the zone is an argument of month_report and part "
                           "of the key",
    "dcdash.api.deps": "authentication, permissions and the request's database session",
    "dcdash.api.auth": "imported by deps: sign-in and sessions",
    "dcdash.api.security": "imported by auth: password hashing and tokens",
    "dcdash.api.security_events": "imported by auth: the sign-in event log",
}


def test_every_module_the_builders_import_is_hashed_or_listed_as_not_feeding_a_figure():
    code = (
        "import json, sys\n"
        "import dcdash.core.figures, dcdash.api.billing_check\n"
        "print(json.dumps(sorted(name for name in sys.modules if name == 'dcdash' or name.startswith('dcdash.'))))\n"
    )
    done = subprocess.run(  # a fresh interpreter: `sys.modules` of the test session holds whatever other tests imported
        [sys.executable, "-c", code], cwd=ledger._PACKAGE.parent, capture_output=True, text=True, check=True, timeout=120
    )
    reached = json.loads(done.stdout)
    hashed = set()
    for name, _ in ledger._engine_sources(ledger._PACKAGE):
        module = "dcdash." + name.removesuffix(".py").replace("/", ".")
        hashed.add(module.removesuffix(".__init__"))
    assert {"dcdash.core.figures", "dcdash.core.energy", "dcdash.core.cost", "dcdash.api.billing_check"} <= set(reached)
    loose = [name for name in reached if name not in hashed and name not in NOT_HASHED_ON_PURPOSE]
    assert loose == [], f"a module the builders import is neither hashed into the engine id nor listed with a reason: {loose}"


# ---- the writer side and the header read, against a database ------------------------------------------------------------------

START = datetime(2026, 9, 1, tzinfo=UTC)
END = datetime(2026, 10, 1, tzinfo=UTC)
KEY = ("month-days", START, END, '["UTC"]')


@pytest.fixture
async def session(db):
    async with get_sessionmaker()() as s:
        yield s


async def database_now(session) -> datetime:
    """The DATABASE clock: `decide` judges every row against the database `now()`, so a row's times are built on it too (a database
    clock that differs from the test process's by seconds must not change what a test means)."""
    return await session.scalar(text("SELECT now()"))


async def put(session, *, key=KEY, payload=b"payload", engine=None, config_fp="c", data_fp="d", snapshot_at=None,
              checked_at=None) -> bool:
    now = await database_now(session)
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


def decoder(config_fp="c", **carried):
    """A stand-in for `decode_month_days`: a value that carries the configuration and what a `MonthDays` says of its key (its zone
    and its month), each of which a test may override."""
    value = dict(config_fp=config_fp, tz_name="UTC", start_utc=START, end=END)
    value.update(carried)
    return lambda raw: SimpleNamespace(raw=raw, **value)


def spec(window_end, decode=None) -> ledger.LedgerSpec:
    return ledger.LedgerSpec(KEY[0], KEY[3], window_end, decode or decoder())


class DataFp:
    """The data fingerprint reader a caller passes to `consult`: counts its calls."""

    def __init__(self, value="d"):
        self.value, self.calls = value, 0

    async def __call__(self):
        self.calls += 1
        return self.value


async def consult(session, window_end, read, *, decode=None, fresh=False, replaced=None, replaced_exists=None, replaced_fp=None,
                  config_fp="c"):
    if replaced_exists is None:
        replaced_exists = replaced is not None or replaced_fp is not None
    return await ledger.consult(
        session, spec(window_end, decode), START, END, config_fp=config_fp, fresh=fresh, replaced_exists=replaced_exists,
        replaced_data_at=replaced, replaced_data_fp=replaced_fp, read_data_fp=read,
    )


async def test_consult_uses_a_young_row_of_an_open_window_without_reading_the_data(db, session):
    await put(session, payload=b"the bytes", checked_at=await database_now(session) - 10 * SECOND)
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
    "case",
    [
        "garbage", "decoder raises", "another config in the value", "no config in the value", "another zone in the value",
        "no zone in the value", "another month in the value", "another end in the value",
    ],
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
        "another zone in the value": decoder(tz_name="Europe/Berlin"),
        "no zone in the value": lambda raw: SimpleNamespace(config_fp="c", start_utc=START, end=END),
        "another month in the value": decoder(start_utc=START - timedelta(days=31)),
        "another end in the value": decoder(end=END + timedelta(days=1)),
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
        return decoder()(raw)

    hit, _, _ = await consult(session, datetime.now(UTC) + timedelta(hours=1), DataFp(), decode=decode)
    assert hit is not None and seen["thread"].startswith("dcdash-compute") and seen["thread"] != threading.current_thread().name


# ---- the identity of a stored value: it must say it is the one the key asks for (review M5) ----------------------------------------


async def test_consult_takes_a_value_that_says_what_the_key_says(db, session):
    await put(session)
    hit, _, _ = await consult(session, datetime.now(UTC) + timedelta(hours=1), DataFp(), decode=decoder(end=END.astimezone(timezone(timedelta(hours=3)))))
    assert hit is not None  # the same instant in another zone is the same end: bounds are compared as instants


@pytest.mark.parametrize(
    ("params", "carried", "ok"),
    [
        ('["2026-09-30","UTC",true]', dict(tz_name="UTC"), True),
        ('["2026-09-30","UTC",false]', dict(tz_name="UTC", start_utc=None, end=None), True),  # a window carries no bounds
        ('["2026-09-30","UTC",true]', dict(tz_name="Asia/Riyadh"), False),
        ('["2026-09-30","Asia/Riyadh",true]', dict(tz_name="UTC"), False),
        ('["2026-09-30","UTC",true]', dict(tz_name=None), False),
        ("not json", dict(tz_name="UTC"), False),
        ("[]", dict(tz_name="UTC"), False),
    ],
)
async def test_consult_checks_the_zone_of_a_window_values_row_against_its_key(db, session, params, carried, ok):
    key = ("window-values", START, END, params)
    await put(session, key=key)
    window_spec = ledger.LedgerSpec(key[0], params, datetime.now(UTC) + timedelta(hours=1), decoder(**carried))
    hit, _, _ = await ledger.consult(session, window_spec, START, END, config_fp="c", fresh=False, read_data_fp=DataFp())
    assert (hit is not None) is ok
    assert ledger.stats()["errors"] == (0 if ok else 1)


async def test_a_kind_the_ledger_does_not_know_is_not_checked_for_its_identity(db, session):
    key = ("some-other-kind", START, END, "[1]")
    await put(session, key=key)
    other = ledger.LedgerSpec(key[0], key[3], datetime.now(UTC) + timedelta(hours=1), lambda raw: SimpleNamespace(config_fp="c"))
    hit, _, _ = await ledger.consult(session, other, START, END, config_fp="c", fresh=False, read_data_fp=DataFp())
    assert hit is not None


# ---- the future tests use the real clock, not the start of the transaction (review M4) ------------------------------------------------


async def test_a_long_writer_does_not_roll_back_a_row_committed_after_its_transaction_began(db, session):
    began = await session.scalar(text("SELECT now()"))  # `now()` is frozen at this moment for the whole transaction
    await asyncio.sleep(0.3)
    committed = began + timedelta(milliseconds=100)  # in the past by now, but later than the writer's `now()`
    async with get_sessionmaker()() as other:
        assert await put(other, payload=b"newer", snapshot_at=committed, checked_at=committed)
    older = began - 60 * SECOND
    written = await ledger.write(
        session, *KEY, b"older", engine=ledger.engine_id(), config_fp="c", data_fp="d", snapshot_at=older, checked_at=older
    )
    await session.rollback()
    assert not written, "a row that is not from the future was rolled back by an older snapshot"
    assert bytes((await stored(db))["payload"]) == b"newer"


async def test_delete_future_does_not_delete_a_row_committed_after_its_transaction_began(db, session):
    began = await session.scalar(text("SELECT now()"))
    await asyncio.sleep(0.3)
    committed = began + timedelta(milliseconds=100)
    async with get_sessionmaker()() as other:
        await put(other, snapshot_at=committed, checked_at=committed)
    assert await ledger.delete_future(session) == 0
    await session.commit()
    assert await db.fetchval("SELECT count(*) FROM figure_ledger") == 1
    await db.execute("UPDATE figure_ledger SET checked_at = now() + interval '1 minute'")  # a row really from the future
    assert await ledger.delete_future(session) == 1


# ---- a read never stalls on a lock, and always rolls its savepoint back (review M8) --------------------------------------------------


@contextmanager
def statements():
    seen: list[str] = []

    def on(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", on)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", on)


async def test_a_read_is_a_savepoint_with_a_lock_timeout_that_is_rolled_back_not_released(db, session):
    await put(session)
    await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
    with statements() as seen:
        assert (await ledger.read_header(session, *KEY)).engine == ledger.engine_id()
        assert await ledger.read_payload(session, *KEY) == b"payload"
    shape = ["read" if "figure_ledger" in s else " ".join(s.split()[:2]) for s in seen]
    assert shape == ["SAVEPOINT sa_savepoint_1", "SET LOCAL", "read", "ROLLBACK TO"] + [
        "SAVEPOINT sa_savepoint_2", "SET LOCAL", "read", "ROLLBACK TO"], seen
    assert not [s for s in seen if s.startswith("RELEASE")]
    assert "lock_timeout = '200ms'" in seen[1] and "figure_ledger header" in seen[2] and "figure_ledger payload" in seen[6]
    # the SET LOCAL went with the savepoint: the session's own setting is back
    assert await session.scalar(text("SHOW lock_timeout")) == "0"


async def test_a_failing_read_rolls_its_savepoint_back_too(db, session, monkeypatch):
    monkeypatch.setattr(ledger, "_HEADER", text("SELECT 1 FROM a_table_that_does_not_exist WHERE :k = :s AND :e = :p"))
    with statements() as seen:
        with pytest.raises(ProgrammingError):
            await ledger.read_header(session, *KEY)
    assert seen[0].startswith("SAVEPOINT") and seen[-1].startswith("ROLLBACK TO SAVEPOINT")
    monkeypatch.undo()
    assert await session.scalar(text("SELECT 1")) == 1 and await session.scalar(text("SHOW lock_timeout")) == "0"


async def test_a_lock_on_the_table_makes_a_read_a_prompt_error_and_leaves_the_session_usable(db, session):
    await put(session)
    await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
    # the snapshot is taken on another table, as `figure_cache._run` takes it (a transaction that already read `figure_ledger` would
    # hold a lock on it, and the ACCESS EXCLUSIVE lock below would wait for that transaction instead of the other way round)
    assert await session.scalar(text("SELECT count(*) FROM assets")) == 0
    async with db.acquire() as holder:
        async with holder.transaction():
            await holder.execute("LOCK TABLE figure_ledger IN ACCESS EXCLUSIVE MODE")
            began = time.monotonic()
            with pytest.raises(DBAPIError):  # (a lock timeout, SQLSTATE 55P03)
                await ledger.read_header(session, *KEY)
            waited = time.monotonic() - began
            assert 0.15 <= waited < 5, waited  # about 200 ms: it neither fails at once nor waits for the lock
            with pytest.raises(DBAPIError):
                await ledger.read_payload(session, *KEY)
            # through `consult` it is an ordinary, counted miss
            hit, data_fp, db_now = await consult(session, datetime.now(UTC) + timedelta(hours=1), DataFp())
            assert (hit, data_fp, db_now) == (None, None, None)
            assert ledger.stats() == {"hits_exact": 0, "hits_open": 0, "misses": 1, "errors": 1}
    assert await session.scalar(text("SELECT 1")) == 1  # the snapshot and the transaction are still usable
    assert await session.scalar(text("SELECT count(*) FROM figure_ledger")) == 1
    assert await session.scalar(text("SHOW lock_timeout")) == "0"
    assert (await ledger.read_header(session, *KEY)).engine == ledger.engine_id()  # and a read works once the lock is gone
