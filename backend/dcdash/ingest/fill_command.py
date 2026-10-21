"""The fill command (w30 D14): `python -m dcdash.ingest.backfill --source N [--start ISO --end ISO] [--yes] [--before-first-reading]`.

The command line over `Backfill.fill_range`, for the copy-and-paste loop of a site nobody can watch live: what it prints is what a
person pastes back. Without `--yes` it only plans (the windows, the rows expected, one plain sentence) and writes nothing; with
`--yes` it fills the range and prints the one line the engine returns (`12,480 rows read, 12,000 new, ...`).

Exit codes: 0 done (or planned), 1 refused or failed (the reason is one sentence on stderr), 2 bad arguments or settings, 3 the
backfill loop (or another fill) holds this source's lease right now. A secret is never printed: every sentence that came from a
connector or the database is scrubbed with the source's own credentials first."""
import argparse
import asyncio
import os
import sys
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import UTC, datetime, timedelta

import asyncpg

from dcdash import connectors  # noqa: F401  (registers the built-in connectors: connector_types() is empty without it)
from dcdash.connectors.base import ConnectorFactory, connector_types, create_connector
from dcdash.core import journal
from dcdash.core.audit import clip_error, scrub_url_credentials
from dcdash.core.crypto import decrypt
from dcdash.core.pg import create_pool
from dcdash.ingest import rollups
from dcdash.ingest.backfill import Backfill, FillRefused
from dcdash.ingest.settings import HistorySettings

EXIT_REFUSED, EXIT_USAGE, EXIT_LEASE = 1, 2, 3
LEASE_HELD = "working on this source right now"  # what the engine's sentence says when the lease is taken (a test pins it)
WINDOWS_SHOWN = (4, 1)  # of a long plan: this many windows from the start, this many from the end


def _say(text: str = "", *, error: bool = False) -> None:
    """The one place the command prints: a line to stdout, or (a refusal, a failure) to stderr, flushed so a pasted log is whole."""
    print(text, file=sys.stderr if error else sys.stdout, flush=True)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m dcdash.ingest.backfill",
        description="Fill the readings an outage left out of a source from the history the source keeps. Read-only towards the "
        "source; without --yes nothing is asked and nothing is written.",
    )
    parser.add_argument("--source", type=int, required=True, help="the id of the source to fill")
    parser.add_argument("--start", type=_iso, help="the start of the range, an ISO time with a UTC offset (2026-10-20T08:00:00Z)")
    parser.add_argument("--end", type=_iso, help="the end of the range, in the same form; give both --start and --end, or neither")
    parser.add_argument("--yes", action="store_true", help="really fill the range (without it: show the plan and write nothing)")
    parser.add_argument(
        "--before-first-reading", action="store_true",
        help="also fill the time before a point's first reading; this changes the past figures of the assets above it",
    )
    return parser


def _iso(text: str) -> datetime:
    try:
        return datetime.fromisoformat(text.strip())
    except ValueError:
        raise argparse.ArgumentTypeError(f"'{text}' is not a time like 2026-10-20T08:00:00Z") from None


def _utc(moment: datetime) -> str:
    return f"{moment.astimezone(UTC):%Y-%m-%d %H:%M} UTC"


async def amain(
    argv: Sequence[str] | None = None, environ: Mapping[str, str] = os.environ, *, pool: asyncpg.Pool | None = None,
    factory: ConnectorFactory = create_connector, clock: Callable[[], datetime] | None = None,
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> int:
    """The command, as a coroutine (a test awaits it with the pool it already has; the command line goes through `main`).
    `factory`, `clock` and `sleep` are the engine's own hooks."""
    parser = _parser()
    try:
        args = parser.parse_args(argv)
        if (args.start is None) != (args.end is None):
            parser.error("--start and --end go together: give both, or neither to fill the last days")
    except SystemExit as exit_:  # argparse prints its own message (usage on stderr) and exits 2; --help exits 0
        return exit_.code if isinstance(exit_.code, int) else EXIT_USAGE
    try:
        settings = HistorySettings.from_env(environ)
    except ValueError as exc:
        _say(str(exc), error=True)
        return EXIT_USAGE
    for name, moment in (("--start", args.start), ("--end", args.end)):
        if moment is not None and moment.utcoffset() is None:
            _say(
                f"{name} has no UTC offset, so it is not a moment in time: write it like 2026-10-20T08:00:00Z or "
                "2026-10-20T10:00:00+02:00", error=True,
            )
            return EXIT_REFUSED
    own = pool is None
    if pool is None:
        try:
            pool = await create_pool()
        except Exception as exc:  # no database, no key: the class says which; the message could quote the connection string
            _say(f"could not open the database: {type(exc).__name__}", error=True)
            return EXIT_REFUSED
    try:
        hooks = {name: hook for name, hook in (("clock", clock), ("sleep", sleep)) if hook is not None}
        return await _fill(args, Backfill(pool, factory, settings, **hooks), pool, settings, clock or (lambda: datetime.now(UTC)))
    finally:
        if own:
            await pool.close()


async def _fill(
    args: argparse.Namespace, engine: Backfill, pool: asyncpg.Pool, settings: HistorySettings, clock: Callable[[], datetime]
) -> int:
    row = await pool.fetchrow("SELECT name, connector_type, config, secret FROM sources WHERE id = $1", args.source)
    if row is None:
        _say(f"there is no source with id {args.source}", error=True)
        return EXIT_REFUSED
    kind = connector_types().get(row["connector_type"])
    name = " ".join(row["name"].split())
    if kind is None or not kind.supports_history:
        _say(
            f"source {args.source} ({name}) is a {row['connector_type']} source; this connector does not read history, so there is "
            "nothing to fill", error=True,
        )
        return EXIT_REFUSED
    try:
        secret = decrypt(row["secret"]) if row["secret"] else None
    except Exception:
        secret = None  # the engine says so in its own sentence; here it only means one thing fewer to scrub
    known = journal.known_for(row["config"], secret)
    now = clock()
    if args.start is None:
        # The lookback of the loop, and never further back than the loop itself goes (raw retention minus two days).
        days = max(1, min(settings.lookback_days, await rollups.raw_retention_days(pool) - 2))
        start, end = now - timedelta(days=days), now
    else:
        start, end = args.start, args.end
    try:
        report = await engine.fill_range(
            args.source, start, end, before_first_reading=args.before_first_reading, dry_run=not args.yes, yes=args.yes
        )
    except FillRefused as refused:
        sentence = clip_error(scrub_url_credentials(str(refused), known))
        _say(sentence, error=True)
        return EXIT_LEASE if LEASE_HELD in sentence else EXIT_REFUSED
    except Exception as exc:  # whatever else: a sentence with the class, scrubbed, never a traceback that could quote a credential
        _say(f"the fill failed: {type(exc).__name__}: {clip_error(scrub_url_credentials(str(exc), known), 300)}", error=True)
        return EXIT_REFUSED
    if args.yes:
        _say(report.text)
        return 0
    _say(f"Dry run for source {args.source} ({name}).")
    _say(report.text)
    if report.windows:
        shown = len(report.windows)
        head, tail = WINDOWS_SHOWN
        _say(f"Windows ({shown}), each asked in turn, oldest first:")
        for number, (lo, hi) in enumerate(report.windows, 1):
            if number <= head or number > shown - tail:
                _say(f"  {number:>3}. {_utc(lo)} to {_utc(hi)}")
            elif number == head + 1:
                _say(f"       ... {shown - head - tail} more windows ...")
        _say(f"About {report.expected_rows:,} rows are expected.")
        _say("Dry run: nothing was written; run again with --yes to fill it.")
    else:
        _say("Dry run: nothing was written.")
    return 0


def main(argv: Sequence[str] | None = None, environ: Mapping[str, str] = os.environ) -> int:
    """The command line: returns the exit code (the module guard of backfill.py raises SystemExit with it)."""
    try:
        return asyncio.run(amain(argv, environ))
    except KeyboardInterrupt:
        _say("Stopped. What was stored stays; running the same fill again adds only what is missing.", error=True)
        return 130
