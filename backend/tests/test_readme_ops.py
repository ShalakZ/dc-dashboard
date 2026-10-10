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
    # step 4 (the hand-typed `up -d --build`) points at that paragraph
    apply = runbook.split("4. **Apply.**")[1].split("5. **Verify.**")[0]
    assert "BUILDX_NO_DEFAULT_ATTESTATIONS" in apply and "Upgrading images" in apply


def flat(text: str) -> str:
    """The text on one line, so a phrase may wrap across the README's hard line breaks."""
    return " ".join(text.split())


def test_the_runbook_says_the_first_start_after_the_pins_recreates_db():
    # measured in a drill: the `image:` line of `db` gained the digest, so Compose recreated db (same image, data volume kept) once
    runbook = flat(section(2, "Upgrading and going back"))
    assert "The first `docker compose up -d` after the digests arrived recreates `db` as well as the other services, once" in runbook
    assert "The database is unavailable for a short while" in runbook
    assert "The data volume is kept" in runbook
    assert 'Take a backup first, as for any upgrade (step 1 above, and "Backup and restore")' in runbook
    assert "`db` is kept after that first time" in runbook  # the BUILDX paragraph no longer promises that db is never recreated


def test_the_https_section_says_the_certificate_must_stay_readable_by_the_collector():
    https = flat(section(3, "Optional HTTPS"))
    assert "`fullchain.pem` must stay readable by everyone (mode 644)" in https
    assert "the collector (uid 10001) reads the certificate" in https and "never reads the key" in https
    assert "cannot be read" in https  # what the Settings page and the notice say when it is not


def test_the_https_section_says_error_answers_carry_the_headers_and_how_to_enforce_the_policy_later():
    https = flat(section(3, "Optional HTTPS"))
    assert "That includes the error answer Caddy gives while the `api` restarts" in https and "`502 Bad Gateway`" in https
    assert "`handle_errors`" in https
    assert "rename `Content-Security-Policy-Report-Only` to `Content-Security-Policy` in `deploy/security-headers.caddy`" in https
    assert "run the Playwright `headers` project first (it must stay at zero violations)" in https
    assert "`docker compose up -d --build web`" in https
    assert "`test_the_policy_is_report_only_on_purpose` in `backend/tests/test_caddy_headers.py`" in https
    # the order: rename, then the Playwright project, then the rebuild
    assert (https.index("rename `Content-Security-Policy-Report-Only`") < https.index("run the Playwright `headers` project")
            < https.rindex("`docker compose up -d --build web`"))
