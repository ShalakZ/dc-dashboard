"""README.md carries the operations text of W2: the general upgrade and go-back runbook, scheduled backups, the restore drill.

Plain text checks, no database and no Docker. They pin what other things depend on: the section names the scripts and the migration
point to, the single SQL block that test_schema_tiers.py extracts, and that every script the README names exists.
"""
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
README = (ROOT / "README.md").read_text(encoding="utf-8")


def heading(level: int, title: str) -> bool:
    return re.search(rf"^{'#' * level} {re.escape(title)}$", README, flags=re.M) is not None


def section(level: int, title: str) -> str:
    """The text from the heading to the next heading of the same or a higher level."""
    marks = "#" * level
    match = re.search(rf"^{marks} {re.escape(title)}$(.*?)(?=^#{{1,{level}}} |\Z)", README, flags=re.M | re.S)
    assert match, f"no '{marks} {title}' heading"
    return match.group(1)


@pytest.mark.parametrize(
    ("level", "title"),
    [
        (2, "Backup and restore"),
        (3, "What the backup does not contain"),  # scripts/setup.sh and setup.ps1 point here
        (3, "Practise a restore"),
        (2, "Scheduled backups"),
        (2, "Upgrading and going back"),
        (2, "Release notes"),
    ],
)
def test_the_runbook_headings_exist(level, title):
    assert heading(level, title), f"README.md has no '{'#' * level} {title}' heading"


@pytest.mark.parametrize(
    "text",
    [
        "--keep",
        "--copy-to",
        ".dcdash-backup-target",
        ".dcdash-backup.lock",
        "Register-ScheduledTask",
        "LastTaskResult",
        "-ExecutionPolicy Bypass",
        "OPS_COMPOSE_PROJECT",
        "exit 5",
        "git rev-parse",
        "18443",
    ],
)
def test_the_readme_mentions(text):
    assert text in README


def test_the_release_specific_upgrade_sections_are_no_longer_top_level():
    assert not re.search(r"^## Upgrading an existing database to Phase 3", README, flags=re.M)
    assert not re.search(r"^## Upgrading to W1a", README, flags=re.M)


def test_the_release_notes_keep_the_names_and_steps_that_the_migration_points_to():
    # backend/migrations/versions/0004_billing_dashboards.py tells the operator to read this section, "step 4" (the retention SQL) and
    # "step 6" (going back). Moving the text must not break those pointers.
    notes = section(2, "Release notes")
    assert re.search(r"^### Upgrading an existing database to Phase 3", notes, flags=re.M)
    assert re.search(r"^### Upgrading to W1a \(migration 0005\)", notes, flags=re.M)
    phase3 = section(3, "Upgrading an existing database to Phase 3")
    assert re.search(r"^4\. \*\*If something goes wrong\.\*\*", phase3, flags=re.M)
    assert "raw_retention_days" in phase3.split("4. **If something goes wrong.**")[1].split("5. **Verify.**")[0]
    assert re.search(r"^6\. \*\*Going back\.\*\*", phase3, flags=re.M)


def test_the_precheck_query_that_test_schema_tiers_extracts_appears_exactly_once():
    # test_schema_tiers.py::test_the_readme_precheck_query_finds_what_the_widening_check_refuses unpacks exactly one match.
    found = re.findall(r"```sql\n\s*(SELECT min\(bucket\) AS oldest.*?;)\n\s*```", README, flags=re.S)
    assert len(found) == 1


def test_every_script_the_readme_names_exists():
    names = {m.group(1).rstrip(".,;:").replace("\\", "/") for m in re.finditer(r"scripts[/\\]([A-Za-z0-9_./\\-]+)", README)}
    assert {"backup.sh", "backup.ps1", "restore.sh", "restore.ps1", "setup.sh", "setup.ps1", "backup_smoke.sh", "check_tls.sh",
            "check_web.sh", "e2e.sh", "pin_images.sh"} <= names, f"the README no longer names the scripts it documents: {sorted(names)}"
    missing = sorted(n for n in names if not (ROOT / "scripts" / n).exists())
    assert not missing, f"README.md names scripts that do not exist: {missing}"


def test_the_phase_2_commit_is_not_offered_as_a_place_to_go_back_to():
    assert "855cbf8" not in README
    assert "not a place to go back to" in README  # said in words instead: a 0004 or 0005 database fails on Phase 2 code
    assert "1ef27a2" in README  # the code to go back to from W1a (schema 0004)


def test_the_upgrade_runbook_says_how_to_re_pin_the_images_and_how_to_keep_unchanged_containers():
    runbook = section(2, "Upgrading and going back")
    assert "scripts/pin_images.sh --update" in runbook
    assert "monthly" in runbook and "release" in runbook  # the cadence
    assert "backend/tests/conftest.py" in runbook  # its testcontainers pin is re-pinned by hand
    # a hand-typed `up -d --build` needs the variable first, in both shells; the setup scripts set it themselves
    assert "export BUILDX_NO_DEFAULT_ATTESTATIONS=1" in runbook
    assert "$env:BUILDX_NO_DEFAULT_ATTESTATIONS = '1'" in runbook
