"""The operations text of W2 and the pages it moved to in W10: the general upgrade and go-back runbook, scheduled backups, the restore drill.

W10 split the README into README.md (a front door), CHANGELOG.md and docs/*.md. Each test reads the page that holds the text it pins
(docs_text.page) and the tests that pin a fact which may sit on any page read the whole corpus (docs_text.docs_corpus). Plain text
checks, no database and no Docker. They pin what other things depend on: the page titles and section names the scripts and the
migration point to, the README lines that keep the OLD section names pointing at their new pages (the migration's error messages and
the scripts already installed say "README, Upgrading and going back, step 6"), the numbered steps of docs/upgrading.md, the single SQL
block that test_schema_tiers.py extracts, and that every script the docs name exists.
"""
import re

import pytest

from docs_text import ROOT, docs_corpus, flat, heading, page, section

README = page("README")
CORPUS = docs_corpus()


@pytest.mark.parametrize(
    ("name", "level", "title"),
    [
        ("backup-and-restore", 1, "Backup and restore"),
        ("backup-and-restore", 2, "What the backup does not contain"),  # scripts/setup.sh and setup.ps1 point here
        ("backup-and-restore", 2, "Practise a restore"),
        ("scheduled-backups", 1, "Scheduled backups"),
        ("upgrading", 1, "Upgrading and going back"),
        ("CHANGELOG", 1, "Changelog"),  # the old "Release notes" section; README.md keeps the name in its index (see below)
        ("operating", 2, "If you are blocked from signing in"),
    ],
)
def test_the_runbook_headings_exist(name, level, title):
    where = f"{name}.md" if name == "CHANGELOG" else f"docs/{name}.md"
    assert heading(page(name), level, title), f"{where} has no '{'#' * level} {title}' heading"


@pytest.mark.parametrize(
    ("old_name", "new_path"),
    [
        ("Backup and restore", "docs/backup-and-restore.md"),
        ("What the backup does not contain", "docs/backup-and-restore.md"),
        ("Scheduled backups", "docs/scheduled-backups.md"),
        ("Upgrading and going back", "docs/upgrading.md"),
        ("Release notes", "CHANGELOG.md"),
        ("Upgrading an existing database to Phase 3", "CHANGELOG.md"),
    ],
)
def test_the_readme_keeps_the_old_section_names(old_name, new_path):
    # Migration 0004's error messages and the scripts already installed quote these README names and cannot be edited: the README
    # index keeps every name, spelled exactly like that, on a line that also names the page the text moved to.
    assert old_name in README, f"README.md no longer names {old_name!r}"
    assert any(old_name in line and new_path in line for line in README.splitlines()), \
        f"no README.md line names {old_name!r} together with {new_path}"


def test_the_pages_the_script_messages_point_at_keep_their_targets():
    # scripts/setup.*, update.ps1 and migration 0004 send the operator to these places by name
    assert heading(page("backup-and-restore"), 2, "What the backup does not contain")
    upgrading = page("upgrading")
    assert re.search(r"^4\. \*\*Apply\.\*\*", upgrading, flags=re.M), "docs/upgrading.md has no numbered step '4. **Apply.**'"
    assert re.search(r"^6\. \*\*Going back\.\*\*", upgrading, flags=re.M), "docs/upgrading.md has no numbered step '6. **Going back.**'"
    assert ".dcdash-backup-target" in page("scheduled-backups")


@pytest.mark.parametrize(
    ("name", "text"),
    [
        ("backup-and-restore", "--keep"),
        ("backup-and-restore", "--copy-to"),
        ("scheduled-backups", ".dcdash-backup-target"),
        ("scheduled-backups", ".dcdash-backup.lock"),
        ("scheduled-backups", "Register-ScheduledTask"),
        ("scheduled-backups", "LastTaskResult"),
        ("install-and-run", "-ExecutionPolicy Bypass"),
        ("backup-and-restore", "OPS_COMPOSE_PROJECT"),
        ("scheduled-backups", "exit 5"),
        ("upgrading", "git rev-parse"),
        ("install-and-run", "18443"),
        ("install-and-run", "scripts\\setup.ps1 -Timezone Africa/Cairo"),
        ("install-and-run", "scripts/setup.sh --timezone Africa/Cairo"),
        ("install-and-run", "scripts/timezones.txt"),
        ("operating", "unknown timezone: <name>"),
        ("install-and-run", "(a name that is not on the list is still refused)"),
        ("install-and-run", "Do not install inside OneDrive"),
    ],
)
def test_the_readme_mentions(name, text):
    assert text in page(name), f"docs/{name}.md does not mention {text!r}"


def test_the_blocked_sign_in_section_names_every_way_out_and_the_docker_caveat():
    text = section(page("operating"), 2, "If you are blocked from signing in")
    for needle in ("Unblock", "Users & Roles", "Settings", "3 to 20", "1 to 60", "docker compose restart api", "one computer"):
        assert needle in text, f"the blocked sign-in section does not mention {needle!r}"


def test_the_feature_lists_name_delete_unblock_the_sign_in_protection_and_what_is_audited():
    screens = page("screens")  # the Users & Roles and Settings bullets
    users = re.search(r"^- \*\*Users & Roles\*\* \(admin\):(.*?)(?=^- \*\*)", screens, flags=re.M | re.S)
    settings = re.search(r"^- \*\*Settings\*\* \(admin\):(.*?)(?=^- \*\*)", screens, flags=re.M | re.S)
    audited = re.search(r"^   Audited:(.*?)Never recorded:", page("sources-and-discovery"), flags=re.M | re.S)  # item 8 of Discovery
    assert users and settings and audited, "a feature list moved: the Users or Settings bullet or the Audited list"
    for needle in ("delete", "last administrator", "blocked", "Unblock", "If you are blocked from signing in"):
        assert needle in users.group(1), f"the Users bullet does not mention {needle!r}"
    for needle in ("Sign-in protection", "3 to 20", "1 to 60", "applied at once", "If you are blocked from signing in"):
        assert needle in settings.group(1), f"the Settings bullet does not mention {needle!r}"
    for needle in ("`user.deleted`", "`login.unblocked`", "`settings.sign_in_changed`"):
        assert needle in audited.group(1), f"the Audited list does not mention {needle}"


def test_the_release_specific_upgrade_sections_are_no_longer_top_level():
    for text in (README, page("CHANGELOG")):  # they were `##` sections of the README once; they are `###` entries of the CHANGELOG now
        assert not re.search(r"^## Upgrading an existing database to Phase 3", text, flags=re.M)
        assert not re.search(r"^## Upgrading to W1a", text, flags=re.M)


def test_the_release_notes_keep_the_names_and_steps_that_the_migration_points_to():
    # backend/migrations/versions/0004_billing_dashboards.py tells the operator to read this section, "step 4" (the retention SQL) and
    # "step 6" (going back). Moving the text must not break those pointers. The notes are the whole CHANGELOG.md now.
    notes = page("CHANGELOG")
    assert re.search(r"^### Upgrading an existing database to Phase 3", notes, flags=re.M)
    assert re.search(r"^### Upgrading to W1a \(migration 0005\)", notes, flags=re.M)
    phase3 = section(notes, 3, "Upgrading an existing database to Phase 3")
    assert re.search(r"^4\. \*\*If something goes wrong\.\*\*", phase3, flags=re.M)
    assert "raw_retention_days" in phase3.split("4. **If something goes wrong.**")[1].split("5. **Verify.**")[0]
    assert re.search(r"^6\. \*\*Going back\.\*\*", phase3, flags=re.M)


def test_the_precheck_query_that_test_schema_tiers_extracts_appears_exactly_once():
    # test_schema_tiers.py::test_the_readme_precheck_query_finds_what_the_widening_check_refuses unpacks exactly one match.
    found = re.findall(r"```sql\n\s*(SELECT min\(bucket\) AS oldest.*?;)\n\s*```", CORPUS, flags=re.S)
    assert len(found) == 1


def test_every_script_the_readme_names_exists():
    names = {m.group(1).rstrip(".,;:").replace("\\", "/") for m in re.finditer(r"scripts[/\\]([A-Za-z0-9_./\\-]+)", CORPUS)}
    assert {"backup.sh", "backup.ps1", "restore.sh", "restore.ps1", "setup.sh", "setup.ps1", "backup_smoke.sh", "check_tls.sh",
            "check_web.sh", "e2e.sh", "pin_images.sh"} <= names, f"the docs no longer name the scripts they document: {sorted(names)}"
    missing = sorted(n for n in names if not (ROOT / "scripts" / n).exists())
    assert not missing, f"README.md, CHANGELOG.md or docs/*.md name scripts that do not exist: {missing}"


def test_the_phase_2_commit_is_not_offered_as_a_place_to_go_back_to():
    assert "855cbf8" not in CORPUS
    assert "not a place to go back to" in CORPUS  # said in words instead: a 0004 or 0005 database fails on Phase 2 code
    assert "1ef27a2" in CORPUS  # the code to go back to from W1a (schema 0004)


def test_the_upgrade_runbook_says_how_to_re_pin_the_images_and_how_to_keep_unchanged_containers():
    runbook = section(page("upgrading"), 1, "Upgrading and going back")
    assert "scripts/pin_images.sh --update" in runbook
    assert "monthly" in runbook and "release" in runbook  # the cadence
    assert "backend/tests/conftest.py" in runbook  # its testcontainers pin is re-pinned by hand
    # a hand-typed `up -d --build` needs the variable first, in both shells; the setup scripts set it themselves
    assert "export BUILDX_NO_DEFAULT_ATTESTATIONS=1" in runbook
    assert "$env:BUILDX_NO_DEFAULT_ATTESTATIONS = '1'" in runbook
    # step 4 (the hand-typed `up -d --build`) points at that paragraph
    apply = runbook.split("4. **Apply.**")[1].split("5. **Verify.**")[0]
    assert "BUILDX_NO_DEFAULT_ATTESTATIONS" in apply and "Upgrading images" in apply


def test_the_runbook_says_the_first_start_after_the_pins_recreates_db():
    # measured in a drill: the `image:` line of `db` gained the digest, so Compose recreated db (same image, data volume kept) once
    runbook = flat(section(page("upgrading"), 1, "Upgrading and going back"))
    assert "The first `docker compose up -d` after the digests arrived recreates `db` as well as the other services, once" in runbook
    assert "The database is unavailable for a short while" in runbook
    assert "The data volume is kept" in runbook
    assert 'Take a backup first, as for any upgrade (step 1 above, and "Backup and restore")' in runbook
    assert "`db` is kept after that first time" in runbook  # the BUILDX paragraph no longer promises that db is never recreated


def test_the_https_section_says_the_certificate_must_stay_readable_by_the_collector():
    https = flat(section(page("install-and-run"), 2, "Optional HTTPS"))
    assert "`fullchain.pem` must stay readable by everyone (mode 644)" in https
    assert "the collector (uid 10001) reads the certificate" in https and "never reads the key" in https
    assert "cannot be read" in https  # what the Settings page and the notice say when it is not


def test_the_https_section_says_error_answers_carry_the_headers_and_how_to_enforce_the_policy_later():
    https = flat(section(page("install-and-run"), 2, "Optional HTTPS"))
    assert "That includes the error answer Caddy gives while the `api` restarts" in https and "`502 Bad Gateway`" in https
    assert "`handle_errors`" in https
    assert "rename `Content-Security-Policy-Report-Only` to `Content-Security-Policy` in `deploy/security-headers.caddy`" in https
    assert "run the Playwright `headers` project first (it must stay at zero violations)" in https
    assert "`docker compose up -d --build web`" in https
    assert "`test_the_policy_is_report_only_on_purpose` in `backend/tests/test_caddy_headers.py`" in https
    # the order: rename, then the Playwright project, then the rebuild
    assert (https.index("rename `Content-Security-Policy-Report-Only`") < https.index("run the Playwright `headers` project")
            < https.rindex("`docker compose up -d --build web`"))
