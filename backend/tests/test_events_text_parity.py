"""The System events page words every kind of event the backend writes and every failure code of a source (frontend/src/lib/eventText.ts).

The table of words is TypeScript, so this test reads its TEXT (no import): a kind or a code the backend can write that the table
does not name as a quoted word would reach the page as raw text. It collects what the backend writes from the code itself:
the kind constants of `dcdash/core/journal.py`, `dcdash/ingest/kinds.py` and `dcdash/collector/identity.py` (w33: the server at a source's
address is not the one it used to talk to), and every `ConnectorError("<status>"` literal under
`dcdash/connectors/`.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend" / "dcdash"
EVENT_TEXT = (ROOT / "frontend" / "src" / "lib" / "eventText.ts").read_text(encoding="utf-8")

# A module constant such as `SOURCE_OFFLINE = "source.offline"`: a kind is a dotted lower-case word.
KIND = re.compile(r'^[A-Z][A-Z0-9_]* = "([a-z0-9_]+\.[a-z0-9_]+)"', re.M)
# `raise ConnectorError("unreachable", ...)` / `return ConnectorError("timeout", ...)`
STATUS = re.compile(r'ConnectorError\(\s*"([a-z_]+)"')
# Written as the `code` of a source.offline event by collector/scheduler.py itself, not by a connector.
SCHEDULER_CODES = ("exception", "config_invalid", "secret_undecryptable")


def kinds() -> set[str]:
    found: set[str] = set()
    for path in (BACKEND / "core" / "journal.py", BACKEND / "ingest" / "kinds.py", BACKEND / "collector" / "identity.py"):
        found |= set(KIND.findall(path.read_text(encoding="utf-8")))
    return found


def statuses() -> set[str]:
    found: set[str] = set()
    for path in sorted((BACKEND / "connectors").rglob("*.py")):
        found |= set(STATUS.findall(path.read_text(encoding="utf-8")))
    return found


def named(word: str) -> bool:
    """The word is in eventText.ts as a quoted string (a key of one of its tables)."""
    return re.search(rf"""["']{re.escape(word)}["']""", EVENT_TEXT) is not None


def test_the_collection_sees_what_the_backend_writes():
    # a guard for the guard: a regex that matched nothing would make the checks below pass for the wrong reason
    assert {
        "source.offline", "source.online", "points.bad", "check.finished", "job.finished", "readings.conflict", "import.finished", "source.identity_changed",
    } <= kinds()
    assert len(kinds()) >= 15
    assert {"unreachable", "auth_failed", "timeout", "protocol_error", "needs_profile", "not_supported"} <= statuses()


def test_every_kind_the_backend_writes_has_a_name_in_the_events_table():
    missing = sorted(kind for kind in kinds() if not named(kind))
    assert missing == [], f"add these kinds to KIND_NAMES (and a headline) in frontend/src/lib/eventText.ts: {missing}"


def test_every_failure_code_of_a_source_has_a_sentence_in_the_events_table():
    missing = sorted(code for code in statuses() | set(SCHEDULER_CODES) if not named(code))
    assert missing == [], f"add these codes to CODE_REASONS (and OFFLINE_HEADLINES) in frontend/src/lib/eventText.ts: {missing}"


def test_the_table_exports_the_banner_threshold_the_sources_page_reads():
    assert re.search(r"export const OFFLINE_BANNER_SECONDS = 120;", EVENT_TEXT)


# ---- the words the server builds (events/read.py) are the words the page uses ------------------------------------------------

DIAGNOSTICS = (ROOT / "frontend" / "src" / "lib" / "diagnostics.ts").read_text(encoding="utf-8")


def table_of(source: str, declaration: str, key: str) -> dict[str, str]:
    """The `key: "text"` entries of the object literal that follows `declaration` in a TypeScript file."""
    block = re.search(rf"{re.escape(declaration)}[^=]*=\s*\{{(.*?)\n?\s*\}};", source, re.S)
    assert block is not None, f"{declaration} not found"
    return dict(re.findall(key + r':\s*"([^"]*)"', block.group(1)))


def test_the_plain_sentence_of_each_failure_code_is_the_same_on_the_server_and_on_the_page():
    from dcdash.events.read import CODE_REASONS

    page = table_of(EVENT_TEXT, "const CODE_REASONS", r'"([a-z_]+)"')
    assert len(page) == 9, page  # a guard for the guard
    assert dict(CODE_REASONS) == page
    assert CODE_REASONS["unreachable"] == "Could not connect to the server."


def test_the_step_words_of_an_outcome_are_the_page_s_step_labels():
    from dcdash.events.read import _STEP_WORDS

    page = table_of(DIAGNOSTICS, "const STEP_NAMES", r"([a-z_]+)")
    assert len(page) == 10, page
    assert dict(_STEP_WORDS) == page
