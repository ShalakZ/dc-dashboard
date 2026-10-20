"""The figure ledger's proof and rebuild command (w26b): `python -m dcdash.figures.rebuild --check | --all | --month YYYY-MM`.
It runs under `docker compose exec -T figures python -m dcdash.figures.rebuild --check` (no terminal, nothing is asked).

`--check` is the owner's PROOF that the stored figures equal what the live code computes. For every row of the ledger it takes ONE
repeatable-read snapshot and, inside it, reads the row's header and decides:

- `stale`: the row was made by another build (`engine`) or under another configuration (`config_fp`): a reader would not use it
  either, and nothing is recomputed.
- `moved on`: the readings in the row's window changed since it was made (the data fingerprint differs): that is not a
  difference, only a row that is not current any more (an open month is normally this). Nothing is recomputed.
- otherwise the figure is recomputed IN THE SAME SNAPSHOT with the very builder the worker uses, the stored payload is decoded,
  and the two are compared by `ledger_codec.canonical` (every type, every digit, every key order): `equal`, or `DIFFERENT` with
  the first differing asset and local day (or, for a Check month row, the first group and item). A payload that cannot be
  decoded is `DIFFERENT` too (the error type is the detail).

A row whose data moved on, or whose configuration or engine changed, is never a difference: there is no false alarm. A row that
is stale or moved on cannot be proven either way, which is why the summary always prints all four counts. Nothing is written.
The exit code is 1 when any row is `DIFFERENT`.

`--all` and `--month YYYY-MM` rebuild: they run the worker's own cycle once with `force`, so every target (or every target of that
month) is recomputed and stored even when its row is current. `--month` refuses (exit 2) a month the worker does not keep: the
worker would delete what the rebuild wrote. The rebuild does not take the worker's advisory lock (it must run inside the
running figures container): correctness holds through the repeatable-read snapshot and the guarded writes, only the CPU of both
adds up while they run together, and a write that loses a race to the worker is counted as an error of that target.
"""
import argparse
import asyncio
import dataclasses
import json
import os
import sys
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from functools import partial
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from dcdash.api import billing_check
from dcdash.api.settings import current_timezone
from dcdash.collector.logs import configure_logging
from dcdash.core import compute, figure_cache, figures, ledger, ledger_codec
from dcdash.core.config import get_settings
from dcdash.core.timeutil import month_bounds
from dcdash.figures import worker

EQUAL, MOVED_ON, STALE, DIFFERENT = "equal", "moved on", "stale", "DIFFERENT"
STATUSES = (EQUAL, MOVED_ON, STALE, DIFFERENT)

_SNAPSHOT = text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
_DECODERS = {
    "month-days": ledger_codec.decode_month_days,
    "window-values": ledger_codec.decode_window_values,
    ledger.CHECK_KIND: ledger_codec.decode_json,
}


@dataclass(frozen=True)
class Line:
    """What the check found for one row: its kind, its window as a person reads it (a month row: the LOCAL month `YYYY-MM`, a Check
    month row also the hour it was read up to; a window row: `first..last` in UTC), the verdict (one of `STATUSES`) and a short
    detail (never a value or a name). `key` is the row's key, for a caller that deletes it; it is not printed."""

    kind: str
    window: str
    status: str
    detail: str = ""
    key: tuple | None = field(default=None, compare=False, repr=False)

    def text(self) -> str:
        return " ".join(part for part in (self.kind, self.window, self.status, self.detail) if part)


# ---- the pieces of one row -------------------------------------------------------------------------------------------------------


def _z(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def window_label(kind: str, start: datetime, end: datetime, params: str) -> str:
    """The window of a row as `Line.window` shows it. Raises for a key it cannot read (an unknown kind, parameters that are not
    what the kind's writer makes)."""
    values = json.loads(params)
    if kind == "window-values":
        date.fromisoformat(values[0])
        return f"{_z(start)}..{_z(end)}"
    if kind not in _DECODERS:
        raise ValueError(f"unknown kind {kind}")
    local = start.astimezone(ZoneInfo(values[0]))
    label = f"{local.year:04d}-{local.month:02d}"
    return label if kind == "month-days" else f"{label} stop {_z(end)}"


async def _data_fp(session: AsyncSession, kind: str, start: datetime, end: datetime) -> str:
    """The data fingerprint of the row's window, as the worker reads it for the kind."""
    if kind == ledger.CHECK_KIND:
        return await worker.check_data_fp(session, start, end)
    return await figure_cache.data_fingerprint(session, start, end)


async def _live(session: AsyncSession, kind: str, start: datetime, end: datetime, params: str) -> Any:
    """The live figure of a row, in `session`, by the very builder the worker's target for the kind uses."""
    values = json.loads(params)
    if kind == "month-days":
        return await figures.compute_month_days(session, values[0], start, end)
    if kind == "window-values":
        return await figures.compute_window_values(session, start, end, date.fromisoformat(values[0]), values[1], bool(values[2]))
    return await billing_check.month_report(session, values[0], start, end)


def _same(was: Any, now: Any) -> bool:
    """Whether two PLAIN parts (a day entry, a window tuple, a report item: floats, ints, bools, strings, None, and lists, tuples
    and dicts of them) are the same, as the codec's canonical form means it: `repr` shows the type, every digit, `-0.0` and NaN, and
    the order of the keys. (`ledger_codec.canonical` itself takes only a whole value.)"""
    return repr(was) == repr(now)


def _differs_in(stored: Any, live: Any, name: str) -> bool:
    """Whether `live` would be a different value if its member `name` were the stored one: the whole value is compared by
    `canonical`, so a member that only LOOKS different (the order of a tree's nodes) is not one."""
    try:
        return ledger_codec.canonical(dataclasses.replace(live, **{name: getattr(stored, name)})) != ledger_codec.canonical(live)
    except Exception:
        return True


def _members(stored: Any, live: Any) -> str:
    """The first top-level member that differs, for values that have no finer way to say where."""
    if dataclasses.is_dataclass(live) and dataclasses.is_dataclass(stored):
        for item in dataclasses.fields(live):
            if _differs_in(stored, live, item.name):
                return f"member {item.name}"
    elif isinstance(live, dict) and isinstance(stored, dict):
        for key in live:
            if key not in stored or not _same(stored[key], live[key]):
                return f"member {key}"
        for key in stored:
            if key not in live:
                return f"member {key}"
        return "the order of the members"
    return "the value"


def _month_days_difference(stored: figures.MonthDays, live: figures.MonthDays) -> str:
    for asset_id, live_entries in live.entries.items():
        stored_entries = stored.entries.get(asset_id)
        if stored_entries is None:
            return f"asset {asset_id} is missing from the stored row"
        if len(stored_entries) != len(live_entries):
            return f"asset {asset_id}: {len(stored_entries)} days stored, {len(live_entries)} live"
        for index, (was, now) in enumerate(zip(stored_entries, live_entries)):
            if not _same(was, now):
                day = live.days[index][0].isoformat() if index < len(live.days) else f"#{index}"
                return f"asset {asset_id}, day {day}"
    for asset_id in stored.entries:
        if asset_id not in live.entries:
            return f"asset {asset_id} is not in the live figure"
    if list(stored.entries) != list(live.entries):
        return "the order of the assets"
    return _members(stored, live)


def _window_values_difference(stored: figures.WindowValues, live: figures.WindowValues) -> str:
    for asset_id, now in live.values.items():
        if asset_id not in stored.values:
            return f"asset {asset_id} is missing from the stored row"
        if not _same(stored.values[asset_id], now):
            return f"asset {asset_id}"
    for asset_id in stored.values:
        if asset_id not in live.values:
            return f"asset {asset_id} is not in the live figure"
    if list(stored.values) != list(live.values):
        return "the order of the assets"
    return _members(stored, live)


def _report_difference(stored: dict, live: dict) -> str:
    """The first group and item of a Check month report that differs (the item by its place in the group and its asset id: the
    path, the point and the source are names and stay out)."""
    stored_groups, live_groups = stored.get("groups"), live.get("groups")
    if isinstance(stored_groups, dict) and isinstance(live_groups, dict):
        for name, live_group in live_groups.items():
            stored_group = stored_groups.get(name)
            if not isinstance(stored_group, dict):
                return f"group {name} is missing from the stored row"
            stored_items, live_items = stored_group.get("items", []), live_group.get("items", [])
            for index, (was, now) in enumerate(zip(stored_items, live_items)):
                if not _same(was, now):
                    asset = now.get("asset_id") if isinstance(now, dict) else None
                    return f"group {name}, item {index} (asset {asset})"
            if len(stored_items) != len(live_items):
                return f"group {name}: {len(stored_items)} items stored, {len(live_items)} live"
            for key, member in live_group.items():
                if key != "items" and not _same(stored_group.get(key), member):
                    return f"group {name}, member {key}"
        for key in live:
            if key != "groups" and not _same(stored.get(key), live[key]):
                return f"member {key}"
    return _members(stored, live)


def first_difference(stored: Any, live: Any) -> str:
    """Where a stored value first differs from the live one, in words that name an asset id and a local day (a month), an asset id
    (a window), a group and an item (a Check month report), or else the first differing top-level member. Never a value."""
    if isinstance(stored, figures.MonthDays) and isinstance(live, figures.MonthDays):
        return _month_days_difference(stored, live)
    if isinstance(stored, figures.WindowValues) and isinstance(live, figures.WindowValues):
        return _window_values_difference(stored, live)
    if isinstance(stored, dict) and isinstance(live, dict):
        return _report_difference(stored, live)
    return _members(stored, live)


def _compare(decode: Callable[[bytes], Any], raw: bytes, live: Any) -> tuple[str, str]:
    """Decode the stored bytes and compare them with the live value: (status, detail). Pure, so it runs on the compute thread."""
    try:
        stored = decode(raw)
    except Exception as exc:
        return DIFFERENT, type(exc).__name__  # a payload that cannot be read is no figure at all
    try:
        if ledger_codec.canonical(stored) == ledger_codec.canonical(live):
            return EQUAL, ""
    except Exception as exc:  # (the live value cannot be encoded: the worker would have refused to store it)
        return DIFFERENT, f"the live figure cannot be compared ({type(exc).__name__})"
    return DIFFERENT, first_difference(stored, live)


async def _check_row(session_factory: async_sessionmaker[AsyncSession], row: ledger.Row) -> Line | None:
    """The verdict on one row, in ONE repeatable-read snapshot (the header, the data fingerprint, the payload and the live figure
    are all read in it). None when the row has been deleted since the listing (the worker's clean-up)."""
    kind, params = row.kind, row.params
    start, end = row.start_ts.astimezone(timezone.utc), row.end_ts.astimezone(timezone.utc)
    key = (kind, row.start_ts, row.end_ts, params)
    try:
        label = window_label(kind, start, end, params)
    except Exception:
        return Line(kind, f"{_z(start)}..{_z(end)}", STALE, "a key this check cannot read", key)
    async with session_factory() as session:
        await session.execute(_SNAPSHOT)
        config_fp = await figure_cache.config_fingerprint(session)
        header = await ledger.read_header(session, kind, row.start_ts, row.end_ts, params)
        if header.engine is None:
            return None
        if header.engine != ledger.engine_id():
            return Line(kind, label, STALE, "made by another build", key)
        if header.config_fp != config_fp:
            return Line(kind, label, STALE, "made under another configuration", key)
        if await _data_fp(session, kind, start, end) != header.data_fp:
            return Line(kind, label, MOVED_ON, "the readings changed since the row was made", key)
        raw = await ledger.read_payload(session, kind, row.start_ts, row.end_ts, params)
        if raw is None:
            return None
        live = await _live(session, kind, start, end, params)
        status, detail = await compute.run(_compare, _DECODERS[kind], raw, live)
    return Line(kind, label, status, detail, key)


async def check_rows(session_factory: async_sessionmaker[AsyncSession], *, beat: Callable[[], None] | None = None) -> list[Line]:
    """One `Line` for every row of the ledger, read-only (nothing is written, nothing deleted). The rows are listed first and the
    session closed (the engine's pool is one connection), then each row is judged in a snapshot of its own. `beat` is called after
    every row (the worker beats its heartbeat). Raises when the database or a builder fails: the check did not finish."""
    async with session_factory() as session:
        rows = await ledger.list_rows(session)
    lines: list[Line] = []
    for row in rows:
        line = await _check_row(session_factory, row)
        if line is not None:
            lines.append(line)
        if beat is not None:
            beat()
    return lines


# ---- the command -----------------------------------------------------------------------------------------------------------------


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m dcdash.figures.rebuild",
        description="Prove that the figure ledger equals the live computation (--check), or rebuild it (--all, --month).",
    )
    parser.add_argument("--check", action="store_true", help="compare every stored row with the live computation; writes nothing; exit 1 if any DIFFERS")
    parser.add_argument("--all", action="store_true", help="recompute and store every figure the worker keeps")
    parser.add_argument("--month", metavar="YYYY-MM", help="recompute and store the figures of one local month the worker keeps")
    return parser


def _month_of(target: worker.Target, tz_name: str) -> str:
    """The local month a target belongs to: the one its window begins in (every target begins at a local month start)."""
    local = target.start.astimezone(ZoneInfo(tz_name))
    return f"{local.year:04d}-{local.month:02d}"


def _in_month(target: worker.Target, tz_name: str, month: str) -> bool:
    return _month_of(target, tz_name) == month


async def _check(sessions: async_sessionmaker[AsyncSession]) -> int:
    try:
        lines = await check_rows(sessions)
    except Exception as exc:
        print(f"the check could not be completed: {type(exc).__name__}: {str(exc)[:200]}", file=sys.stderr)
        return 1
    for line in lines:
        print(line.text())
    found = Counter(line.status for line in lines)
    print(f"{len(lines)} rows: " + ", ".join(f"{found[status]} {status}" for status in STATUSES))
    return 1 if found[DIFFERENT] else 0


async def _rebuild(sessions: async_sessionmaker[AsyncSession], month: str | None, clock: Callable[[], datetime]) -> int:
    if not ledger.enabled():
        print("DCDASH_FIGURE_LEDGER=0: the ledger is switched off, so nothing is rebuilt", file=sys.stderr)
        return 2
    async with sessions() as session:
        tz_name = await current_timezone(session)
    now = clock()
    months = worker.months_kept()
    plan = worker.targets(now, tz_name, months)
    only: Callable[[worker.Target], bool] | None = None
    if month is not None:
        kept = sorted({_month_of(target, tz_name) for target in plan}, reverse=True)
        if month not in kept:
            print(
                f"{month} is not a month the worker keeps ready ({', '.join(kept) or 'none: the site timezone cannot be used'}); "
                "the worker would delete what a rebuild of it wrote",
                file=sys.stderr,
            )
            return 2
        only = partial(_in_month, tz_name=tz_name, month=month)

    wanted = sum(1 for target in plan if only is None or only(target))
    # the heartbeat file is the worker's: a rebuild run inside its container must not make a stuck worker look alive
    state = worker.WorkerState(heartbeat_path=os.devnull)
    report = await worker.run_once(sessions, now, tz_name, months, state, only=only, force=True)
    print(
        f"rebuilt {wanted} figures{'' if month is None else f' of {month}'}: {report.written} written, {report.unchanged} unchanged, "
        f"{report.touched} touched, {report.skipped} skipped, {report.deleted} deleted, {report.refused} refused, {report.errors} errors"
    )
    return 1 if report.errors else 0


async def amain(argv: list[str] | None = None, *, clock: Callable[[], datetime] = worker._utcnow) -> int:
    """The command, as a coroutine (`main` runs it; `clock` is for tests). Returns the exit code: 0 all well, 1 a row DIFFERS or a
    target failed, 2 for arguments that make no sense or a rebuild that is refused."""
    parser = _parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as stop:  # argparse exits for a bad argument (2) and for --help (0)
        return stop.code if isinstance(stop.code, int) else 2
    if sum([args.check, args.all, args.month is not None]) != 1:
        parser.print_usage(sys.stderr)
        print("choose exactly one of --check, --all and --month YYYY-MM", file=sys.stderr)
        return 2
    if args.month is not None:
        try:
            month_bounds(args.month, "UTC")  # only its shape is looked at
        except ValueError:
            print("--month must look like 2026-10", file=sys.stderr)
            return 2
    engine = worker.make_engine(get_settings().sqlalchemy_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        return await (_check(sessions) if args.check else _rebuild(sessions, args.month, clock))
    finally:
        await engine.dispose()
        compute.shutdown()


def main(argv: list[str] | None = None) -> int:
    configure_logging()
    return asyncio.run(amain(argv))


if __name__ == "__main__":
    sys.exit(main())
