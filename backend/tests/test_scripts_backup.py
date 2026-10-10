"""scripts/backup.sh (and backup.ps1) must never delete a good backup, and must say so when a copy did not happen.

backup.sh runs from a COPY in a temporary folder (it does `cd` to the folder above its own), against fake `docker` and `date`
programs that only write down how they were called; no container is touched and the repository is never written to. The fake
`pg_dump` writes `DUMPDUMP` (8 bytes), the fake `pg_restore` reads all of stdin and fails below 4 bytes (a cut-off dump), the fake
`psql` prints the schema revision. Every test starts with old backup pairs in the output folder, so a wrong deletion shows.
backup.ps1 cannot run here: it is parsed by PowerShell and its text is checked, see the last section.
"""
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"

FAKE_DOCKER = r"""#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
[ "$1" = compose ] || exit 0
case " $* " in
  *" config --no-interpolate "*)
    if [ -n "$FAKE_CONFIG_FAILS" ]; then echo "no configuration file provided: not found" >&2; exit 1; fi
    echo "name: ${FAKE_PROJECT:-dcdash}"; exit 0 ;;
  *" pg_dump "*)
    case "$FAKE_DUMP" in
      fail) echo "pg_dump: error: connection to server failed" >&2; exit 1 ;;
      empty) exit 0 ;;
      short) printf 'DU'; exit 0 ;;
      *) printf '%s' "${FAKE_DUMP_HEAD-DUMP}"; [ -n "$FAKE_DUMP_SLEEP" ] && sleep "$FAKE_DUMP_SLEEP"; printf '%s' "${FAKE_DUMP_TAIL-DUMP}"; exit 0 ;;
    esac ;;
  *" pg_restore "*)
    n="$(wc -c | tr -d ' ')"   # reads ALL of stdin, like a full read of the archive
    echo "pg_restore stdin: $n bytes" >> "$FAKE_LOG"
    [ "$n" -ge 4 ] && exit 0
    echo "pg_restore: error: unexpected end of file" >&2; exit 1 ;;
  *" psql "*)
    if [ "$FAKE_PSQL" = fail ]; then echo "psql: error: connection to server failed" >&2; exit 7; fi
    echo 0005; exit 0 ;;
esac
exit 0
"""
# the stamp the script asks for is fixed by FAKE_DATE; anything else goes to the real date
FAKE_DATE_PROGRAM = (
    '#!/usr/bin/env bash\n'
    'if [ -n "$FAKE_DATE" ] && [ "$*" = "+%Y%m%d-%H%M%S" ]; then echo "$FAKE_DATE"; exit 0; fi\n'
    'exec /bin/date "$@"\n'
)
FAKE_CP_FAILS_ON_VERSION = '#!/usr/bin/env bash\ncase "$*" in *.version.partial) echo "cp: error writing" >&2; exit 1 ;; esac\nexec /bin/cp "$@"\n'
FAKE_CMP_DIFFERS = "#!/usr/bin/env bash\nexit 1\n"
FAKE_SYNC = '#!/usr/bin/env bash\necho "sync $*" >> "$FAKE_LOG"\n'  # the default: writes down how it was called, flushes nothing
FAKE_SYNC_FAILS = "#!/usr/bin/env bash\nexit 1\n"
# writes down every rm and fails for the calls that contain $FAKE_RM_FAILS (a removal that does not work); everything else is the real rm
FAKE_RM = (
    '#!/usr/bin/env bash\necho "rm $*" >> "$FAKE_LOG"\n'
    'if [ -n "$FAKE_RM_FAILS" ]; then case "$*" in *"$FAKE_RM_FAILS"*) echo "rm: cannot remove: Permission denied" >&2; exit 1 ;; esac; fi\n'
    'exec /bin/rm "$@"\n'
)
# what the scripts and the fakes use, for a PATH that has no flock
TOOLS = ("bash", "env", "dirname", "basename", "sed", "head", "tr", "mkdir", "rm", "mv", "cp", "cmp", "wc", "cat", "sleep")

NEW = "20260615-120000"  # what the fake date says; the old backups below are all older
NEW_DUMP, NEW_VERSION = f"dcdash-{NEW}.dump", f"dcdash-{NEW}.dump.version"
OLD = ["20250101-000000", "20250102-000000", "20250103-000000"]
MARKER = ".dcdash-backup-target"
USAGE_FAILURES = [["--keep", "0"], ["--keep", "x"], ["--keep", "-1"], ["--keep", "18446744073709551617"], ["--keep", "100000"],
                  ["--keep"], ["--keep", "01"], ["--keep", "1.5"], ["--keep", ""]]
CANNOT_BLOCK_WRITES = os.name == "nt" or os.geteuid() == 0  # root ignores a read-only folder


def pairs(folder: Path, stamps: list[str] = OLD) -> list[str]:
    """Old backups: a dump and its .version for every stamp. Returns the file names."""
    folder.mkdir(parents=True, exist_ok=True)
    for stamp in stamps:
        (folder / f"dcdash-{stamp}.dump").write_bytes(b"OLD-" + stamp.encode())
        (folder / f"dcdash-{stamp}.dump.version").write_text("0005\n")
    return names(folder)


def names(folder: Path) -> list[str]:
    return sorted(p.name for p in folder.iterdir())


def pair_names(*stamps: str) -> list[str]:
    return sorted(n for s in stamps for n in (f"dcdash-{s}.dump", f"dcdash-{s}.dump.version"))


def prepare_script(script: str, tmp_path: Path, *, fakes: dict[str, str] | None = None, without: tuple[str, ...] = (), **env: str):
    """A COPY of scripts/<script>, the fakes first on PATH; returns (command, environment, log file)."""
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True, exist_ok=True)
    for name in (script, "restore_retention.sql") if script == "restore.sh" else (script,):
        shutil.copy(SCRIPTS / name, root / "scripts" / name)
    bin_dir, work = tmp_path / "bin", tmp_path / "tmp"
    bin_dir.mkdir(exist_ok=True)
    work.mkdir(exist_ok=True)
    log = tmp_path / "calls.log"
    log.write_text("")
    programs = {"docker": FAKE_DOCKER, "date": FAKE_DATE_PROGRAM, "sync": FAKE_SYNC, **(fakes or {})}
    for name, body in programs.items():
        path = bin_dir / name
        path.write_text(body)
        path.chmod(0o755)
    environment = {k: v for k, v in os.environ.items() if not k.startswith(("COMPOSE_", "DCDASH_", "FAKE_", "OPS_"))}
    if without:  # a PATH of its own: the fakes and the tools the scripts use, minus the ones named (e.g. flock is not installed)
        for tool in TOOLS:
            if tool not in without and not (bin_dir / tool).exists():
                (bin_dir / tool).symlink_to(shutil.which(tool))
        environment["PATH"] = str(bin_dir)
        assert all(shutil.which(tool, path=environment["PATH"]) is None for tool in without)
    else:
        environment["PATH"] = f"{bin_dir}{os.pathsep}{os.environ['PATH']}"
    environment.update(FAKE_LOG=str(log), TMPDIR=str(work), FAKE_DATE=NEW)
    environment.update(env)
    assert shutil.which("docker", path=environment["PATH"]) == str(bin_dir / "docker"), "the real docker could be reached"
    return [shutil.which("bash"), str(root / "scripts" / script)], environment, log


def check_calls(script: str, calls: list[str]):
    allowed = {"config", "exec"} | ({"stop", "start"} if script == "restore.sh" else set())
    assert all(c.startswith("docker compose ") and c.split()[2] in allowed for c in calls if c.startswith("docker ")), calls


def run_script(script: str, tmp_path: Path, *args, fakes: dict[str, str] | None = None, without: tuple[str, ...] = (), **env: str):
    """Run a COPY of scripts/<script> against the fakes; returns (result, the lines the fakes wrote down)."""
    command, environment, log = prepare_script(script, tmp_path, fakes=fakes, without=without, **env)
    result = subprocess.run([*command, *map(str, args)], capture_output=True, text=True, env=environment, timeout=60, cwd=tmp_path)
    calls = log.read_text().splitlines()
    check_calls(script, calls)
    return result, calls


def run_backup(tmp_path: Path, *args, fakes: dict[str, str] | None = None, without: tuple[str, ...] = (), **env: str):
    return run_script("backup.sh", tmp_path, *args, fakes=fakes, without=without, **env)


requires_flock = pytest.mark.skipif(os.name == "nt" or shutil.which("flock") is None, reason="needs flock(1) and a POSIX shell")


@pytest.fixture
def out(tmp_path) -> Path:
    return tmp_path / "backups"


def no_partials(*folders: Path):
    for folder in folders:
        assert [n for n in names(folder) if n.endswith(".partial")] == [], names(folder)


# ---- 1-3. a dump that cannot be trusted deletes nothing and creates nothing ---------------------------------------------

def test_a_failing_pg_dump_deletes_nothing_and_leaves_no_new_file(tmp_path, out):
    before = pairs(out)
    result, calls = run_backup(tmp_path, out, "--keep", "1", FAKE_DUMP="fail")
    assert result.returncode == 1, result.stdout + result.stderr
    assert "pg_dump failed" in result.stderr and "no old backup was touched" in result.stderr
    assert names(out) == before  # the 3 old pairs; no new dump, no .version, no .partial
    assert not any("pg_restore" in c or "psql" in c for c in calls)  # nothing after the failed dump was tried


def test_an_empty_dump_deletes_nothing(tmp_path, out):
    before = pairs(out)
    result, calls = run_backup(tmp_path, out, "--keep", "1", FAKE_DUMP="empty")
    assert result.returncode == 1, result.stdout + result.stderr
    assert "pg_dump wrote nothing" in result.stderr and "no old backup was touched" in result.stderr
    assert names(out) == before
    assert not any("pg_restore" in c or "psql" in c for c in calls)  # nothing to read back


def test_a_dump_cut_off_in_its_data_section_deletes_nothing(tmp_path, out):
    before = pairs(out)
    result, calls = run_backup(tmp_path, out, "--keep", "1", FAKE_DUMP="short")
    assert result.returncode == 1, result.stdout + result.stderr
    assert "cannot be read back" in result.stderr and "no old backup was touched" in result.stderr
    assert names(out) == before  # the partial is removed too
    assert "pg_restore stdin: 2 bytes" in calls  # the partial was really fed to pg_restore, which failed on it
    assert not any("psql" in c for c in calls)  # the schema is not read for a dump that was refused


def test_the_new_dump_is_read_back_in_full_not_just_listed(tmp_path, out):
    pairs(out)
    result, calls = run_backup(tmp_path, out)
    assert result.returncode == 0, result.stderr
    assert "docker compose exec -T db pg_restore -f /dev/null" in calls
    assert "pg_restore stdin: 8 bytes" in calls  # all 8 bytes of the dump reached pg_restore
    assert not any("--list" in c or "pg_restore -l" in c for c in calls)


def test_a_failed_schema_read_exits_1_with_a_message_and_keeps_nothing(tmp_path, out):
    before = pairs(out)
    result, _ = run_backup(tmp_path, out, "--keep", "1", FAKE_PSQL="fail")
    assert result.returncode == 1
    assert "could not read the schema revision" in result.stderr and "no old backup was touched" in result.stderr
    assert names(out) == before  # no new dump (it is renamed only after the revision is known), old pairs intact


# ---- 4-6. --keep ---------------------------------------------------------------------------------------------------------

def test_a_plain_backup_writes_the_pair_and_never_deletes(tmp_path, out):
    before = pairs(out)
    result, _ = run_backup(tmp_path, out)
    assert result.returncode == 0, result.stderr
    assert names(out) == sorted(before + [NEW_DUMP, NEW_VERSION])  # no --keep: nothing is ever deleted
    assert f"wrote {out}/{NEW_DUMP} (schema 0005)" in result.stdout
    assert "DCDASH_SECRET_KEY" in result.stderr  # the note about .env and certs/ is still printed


def test_keep_removes_the_oldest_dumps_with_their_version_files(tmp_path, out):
    pairs(out, OLD + ["20250104-000000"])
    result, _ = run_backup(tmp_path, out, "--keep", "2")
    assert result.returncode == 0, result.stderr
    assert names(out) == sorted(pair_names("20250104-000000") + [NEW_DUMP, NEW_VERSION])  # the newest old pair and the new pair
    assert result.stderr.count("removed old backup") == 3


def test_keep_larger_than_the_number_of_backups_deletes_nothing(tmp_path, out):
    before = pairs(out)
    result, _ = run_backup(tmp_path, out, "--keep", "99999")
    assert result.returncode == 0, result.stderr
    assert names(out) == sorted(before + [NEW_DUMP, NEW_VERSION])


def test_files_with_other_names_are_never_touched(tmp_path, out):
    pairs(out, OLD[1:])
    survivors = {
        "before-upgrade.dump": b"HAND", "before-upgrade.dump.version": b"0005\n",
        "dcdash-20250101-000000.dump": b"NO-VERSION-BESIDE-IT",  # looks rotated, but no .version beside it
        "dcdash-20250101-000000.dump.corrupt": b"C", "dcdash-20250104-000000.dump.version": b"0005\n",  # orphan version
        "dcdash-2025.dump": b"S", "dcdash-2025.dump.version": b"0005\n", "notes.txt": b"N",
        "dcdash-20250105-000000.DUMP": b"U", "dcdash-20250105-000000.DUMP.version": b"0005\n",
    }
    for name, body in survivors.items():
        (out / name).write_bytes(body)
    result, _ = run_backup(tmp_path, out, "--keep", "1")
    assert result.returncode == 0, result.stderr
    assert names(out) == sorted([*survivors, NEW_DUMP, NEW_VERSION])  # only the two old pairs went
    for name, body in survivors.items():
        assert (out / name).read_bytes() == body


FUTURE = "dcdash-20990101-000000.dump"
LATER_MESSAGE = "is named later than this backup (is the clock right?)"


def test_a_clock_that_jumped_back_cannot_delete_the_new_backup(tmp_path, out):
    before = pairs(out, OLD[:2] + ["20990101-000000"])  # a dump from the future: the NEW file sorts before it
    result, _ = run_backup(tmp_path, out, "--keep", "1")
    assert result.returncode == 0, result.stderr
    assert (out / NEW_DUMP).read_bytes() == b"DUMPDUMP" and (out / NEW_VERSION).exists()
    assert names(out) == sorted(before + [NEW_DUMP, NEW_VERSION])  # and nothing else is deleted either
    assert f"not rotating {out}: {FUTURE} {LATER_MESSAGE}" in result.stderr


def test_the_new_backup_survives_even_when_it_sorts_first_and_keep_would_have_evicted_it(tmp_path, out):
    before = pairs(out, ["20990101-000000", "20990102-000000"])
    result, _ = run_backup(tmp_path, out, "--keep", "1")
    assert result.returncode == 0, result.stderr
    assert names(out) == sorted(before + [NEW_DUMP, NEW_VERSION])


def test_a_clock_that_stays_wrong_for_three_nights_deletes_no_earlier_backup(tmp_path, out):
    # the clock was reset to 2000 after three good nights: night 2 used to delete night 1's backup, night 3 night 2's
    good = pairs(out, ["20261001-020000", "20261002-020000", "20261003-020000"])
    made: list[str] = []
    for night in ("20000101-020000", "20000102-020000", "20000103-020000"):
        result, _ = run_backup(tmp_path, out, "--keep", "3", FAKE_DATE=night)
        assert result.returncode == 0, result.stderr
        assert f"not rotating {out}: dcdash-20261003-020000.dump {LATER_MESSAGE}" in result.stderr
        assert "removed old backup" not in result.stderr
        made += pair_names(night)
    assert names(out) == sorted(good + made)  # six dumps, all of them


def test_a_folder_with_a_later_dump_is_left_alone_but_the_other_folder_is_still_rotated(tmp_path, out):
    copy = tmp_path / "offsite"
    kept = pairs(out, OLD[:2] + ["20990101-000000"])
    pairs(copy, ["20250201-000000", "20250202-000000"])
    (copy / MARKER).write_text("dcdash\n")
    result, _ = run_backup(tmp_path, out, "--keep", "1", "--copy-to", copy)
    assert result.returncode == 0, result.stdout + result.stderr
    assert names(out) == sorted(kept + [NEW_DUMP, NEW_VERSION])  # blocked
    assert names(copy) == sorted([MARKER, *pair_names(NEW)])  # the copy folder has no later dump: rotated as usual
    assert f"not rotating {out}:" in result.stderr and "not rotating " + str(copy) not in result.stderr


def test_the_first_argument_is_the_output_folder_and_the_default_is_backups_next_to_the_scripts(tmp_path):
    result, _ = run_backup(tmp_path)
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "repo" / "backups" / NEW_DUMP).read_bytes() == b"DUMPDUMP"  # ./backups of the (copied) repository


# ---- 7-8. usage errors: exit 2 and not a single docker call ---------------------------------------------------------------

@pytest.mark.parametrize("args", USAGE_FAILURES, ids=lambda a: "keep" + "-".join(a[1:]) if a[1:] else "keep-without-value")
def test_keep_must_be_a_whole_number_from_1_to_99999(tmp_path, out, args):
    before = pairs(out)
    result, calls = run_backup(tmp_path, out, *args)
    assert result.returncode == 2, result.stdout + result.stderr
    assert "usage" in result.stderr and "backing up Compose project" not in result.stderr
    assert calls == []  # not one docker call
    assert names(out) == before


@pytest.mark.parametrize("args", [["--copy-to", "--keep", "3"], ["--copy-to"], ["--copy-to", ""]], ids=["flag-as-value", "no-value", "empty"])
def test_copy_to_without_a_value_is_refused(tmp_path, out, args):
    before = pairs(out)
    result, calls = run_backup(tmp_path, out, *args)
    assert result.returncode == 2 and "usage" in result.stderr
    assert calls == [] and names(out) == before


@pytest.mark.parametrize("args", [["--keeep", "2"], ["second-folder"], ["--keep", "2", "extra"]], ids=["typo", "second-positional", "trailing"])
def test_unknown_arguments_are_refused_before_any_docker_call(tmp_path, out, args):
    result, calls = run_backup(tmp_path, out, *args)
    assert result.returncode == 2 and "usage" in result.stderr and calls == []


# ---- 9. --copy-to with the marker -----------------------------------------------------------------------------------------

def test_copy_to_with_the_marker_copies_the_pair_and_rotates_both_folders(tmp_path, out):
    copy = tmp_path / "offsite"
    pairs(out)
    pairs(copy, ["20250201-000000", "20250202-000000", "20250203-000000"])
    (copy / MARKER).write_text("dcdash\n")
    (copy / "before-upgrade.dump").write_bytes(b"HAND")
    result, _ = run_backup(tmp_path, out, "--keep", "2", "--copy-to", copy)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (copy / NEW_DUMP).read_bytes() == (out / NEW_DUMP).read_bytes() == b"DUMPDUMP"
    assert (copy / NEW_VERSION).read_bytes() == (out / NEW_VERSION).read_bytes() == b"0005\n"
    assert f"copied to {copy}" in result.stdout
    no_partials(out, copy)  # the temporary names are dotfiles: .<name>.partial and .<name>.version.partial
    # the same rule in both folders: the newest old pair and the new pair
    assert names(out) == pair_names("20250103-000000", NEW)
    assert names(copy) == sorted([MARKER, "before-upgrade.dump", *pair_names("20250203-000000", NEW)])
    assert (copy / MARKER).read_text() == "dcdash\n" and (copy / "before-upgrade.dump").read_bytes() == b"HAND"


def test_a_marker_made_on_windows_with_a_carriage_return_is_accepted(tmp_path, out):
    copy = tmp_path / "offsite"
    copy.mkdir()
    (copy / MARKER).write_bytes(b"dcdash\r\n")
    result, _ = run_backup(tmp_path, out, "--copy-to", copy)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (copy / NEW_DUMP).exists() and (copy / NEW_VERSION).exists()


# ---- 10-13. a copy that does not happen: exit 5, a verified local backup, nothing rotated -----------------------------------

def test_a_missing_copy_folder_still_makes_the_local_backup_and_exits_5(tmp_path, out):
    before = pairs(out)
    missing = tmp_path / "mnt" / "offsite"  # an unplugged drive: the path does not exist and must not be created
    result, _ = run_backup(tmp_path, out, "--keep", "1", "--copy-to", missing)
    assert result.returncode == 5, result.stdout + result.stderr
    assert (out / NEW_DUMP).read_bytes() == b"DUMPDUMP" and (out / NEW_VERSION).read_bytes() == b"0005\n"
    assert names(out) == sorted(before + [NEW_DUMP, NEW_VERSION])  # nothing rotated although --keep 1 was given
    assert not (tmp_path / "mnt").exists()  # neither the folder nor its parent was created
    assert "NOT copied" in result.stderr and "is not an existing folder" in result.stderr
    no_partials(out)


def test_an_empty_mount_point_without_the_marker_is_not_a_backup_target(tmp_path, out):
    before = pairs(out)
    mount = tmp_path / "mnt-offsite"  # what an unmounted drive looks like: an empty folder on the root disk
    mount.mkdir()
    result, _ = run_backup(tmp_path, out, "--keep", "1", "--copy-to", mount)
    assert result.returncode == 5, result.stdout + result.stderr
    assert names(mount) == []  # nothing copied into it
    assert names(out) == sorted(before + [NEW_DUMP, NEW_VERSION])  # local backup made, nothing rotated
    assert f"echo dcdash > '{mount}/{MARKER}'" in result.stderr  # the exact command that sets the drive up
    assert "NOT copied" in result.stderr


@pytest.mark.parametrize(
    "marker, project",
    [("other\n", "dcdash"), ("dcdash2\n", "dcdash"), ("\n", "dcdash"), ("dcdash\n", "dcdash_e2e_w2_clone")],
    ids=["another-installation", "a-name-with-the-same-prefix", "empty-first-line", "marker-of-the-normal-stack-on-a-clone"],
)
def test_a_marker_naming_another_installation_is_refused(tmp_path, out, marker, project):
    before = pairs(out)
    copy = tmp_path / "shared-stick"
    other_set = pairs(copy, ["20250301-000000", "20250302-000000"])
    (copy / MARKER).write_text(marker)
    result, _ = run_backup(tmp_path, out, "--keep", "1", "--copy-to", copy, FAKE_PROJECT=project)
    assert result.returncode == 5, result.stdout + result.stderr
    assert "belongs to another installation" in result.stderr and "NOT copied" in result.stderr
    assert names(copy) == sorted([MARKER, *other_set])  # nothing copied in, and the other installation's set is not rotated
    assert names(out) == sorted(before + [NEW_DUMP, NEW_VERSION])  # local backup made, nothing rotated


@pytest.mark.skipif(CANNOT_BLOCK_WRITES, reason="root (or Windows) can write to a read-only folder")
def test_a_failed_copy_keeps_the_local_backup_and_rotates_nothing(tmp_path, out):
    before = pairs(out)
    copy = tmp_path / "offsite"
    old_copy = pairs(copy, ["20250201-000000"])
    (copy / MARKER).write_text("dcdash\n")
    copy.chmod(0o555)  # exists, has the marker, but nothing can be written to it
    try:
        result, _ = run_backup(tmp_path, out, "--keep", "1", "--copy-to", copy)
    finally:
        copy.chmod(0o755)
    assert result.returncode == 5, result.stdout + result.stderr
    assert "the copy to" in result.stderr and "failed" in result.stderr and "NOT copied" in result.stderr
    assert names(out) == sorted(before + [NEW_DUMP, NEW_VERSION])  # the new pair AND the old pairs
    assert (out / NEW_DUMP).read_bytes() == b"DUMPDUMP"
    assert names(copy) == sorted([MARKER, *old_copy])  # not rotated either


@pytest.mark.parametrize(
    "fakes", [{"cp": FAKE_CP_FAILS_ON_VERSION}, {"cmp": FAKE_CMP_DIFFERS}], ids=["fails-half-way", "copy-differs-from-the-original"]
)
def test_a_copy_that_fails_half_way_leaves_no_partial_and_no_dump_in_the_copy_folder(tmp_path, out, fakes):
    before = pairs(out)
    copy = tmp_path / "offsite"
    old_copy = pairs(copy, ["20250201-000000"])
    (copy / MARKER).write_text("dcdash\n")
    result, _ = run_backup(tmp_path, out, "--keep", "1", "--copy-to", copy, fakes=fakes)
    assert result.returncode == 5, result.stdout + result.stderr
    assert names(copy) == sorted([MARKER, *old_copy])  # no dump under the final name, no .partial
    assert names(out) == sorted(before + [NEW_DUMP, NEW_VERSION])


def test_a_dump_of_the_same_name_in_the_copy_folder_is_never_overwritten(tmp_path, out):
    pairs(out)
    copy = tmp_path / "offsite"
    copy.mkdir()
    (copy / MARKER).write_text("dcdash\n")
    (copy / NEW_DUMP).write_bytes(b"ORIGINAL")
    result, _ = run_backup(tmp_path, out, "--keep", "1", "--copy-to", copy)
    assert result.returncode == 5, result.stdout + result.stderr
    assert (copy / NEW_DUMP).read_bytes() == b"ORIGINAL" and names(copy) == sorted([MARKER, NEW_DUMP])
    assert (out / NEW_DUMP).exists() and len(names(out)) == len(OLD) * 2 + 2  # nothing rotated


# ---- 14. two backups in the same second -------------------------------------------------------------------------------------

def test_two_backups_in_the_same_second_do_not_overwrite(tmp_path, out):
    before = pairs(out)
    (out / NEW_DUMP).write_bytes(b"ORIGINAL")
    result, calls = run_backup(tmp_path, out, "--keep", "1")
    assert result.returncode == 1, result.stdout + result.stderr
    assert (out / NEW_DUMP).read_bytes() == b"ORIGINAL"
    assert "already exists" in result.stderr and "Nothing was changed" in result.stderr
    assert names(out) == sorted([*before, NEW_DUMP])  # nothing created, nothing deleted
    assert not any("pg_dump" in c for c in calls)  # it did not even start a dump


# ---- 16. the files and the first line ---------------------------------------------------------------------------------------

def test_version_file_holds_the_schema_revision(tmp_path, out):
    result, _ = run_backup(tmp_path, out)
    assert result.returncode == 0, result.stderr
    assert (out / NEW_VERSION).read_bytes() == b"0005\n"
    assert names(out) == sorted([NEW_DUMP, NEW_VERSION])
    # restore.sh reads exactly this file: the schema it finds (0005) matches, and a different one is refused with exit 3
    restored, calls = run_script("restore.sh", tmp_path, out / NEW_DUMP)
    assert restored.returncode == 0, restored.stdout + restored.stderr
    assert "restored" in restored.stdout and any(" pg_restore " in c and "--no-owner" in c for c in calls)
    (out / NEW_VERSION).write_text("0004\n")
    refused, calls = run_script("restore.sh", tmp_path, out / NEW_DUMP)
    assert refused.returncode == 3 and "dump schema '0004' differs from running schema '0005'" in refused.stderr
    assert not any(" pg_restore " in c for c in calls)


@pytest.mark.parametrize("project", ["dcdash", "dcdash_e2e_w2_clone"])
def test_the_project_line_comes_first(tmp_path, out, project):
    result, calls = run_backup(tmp_path, out, FAKE_PROJECT=project)
    assert result.returncode == 0, result.stderr
    assert result.stderr.splitlines()[0] == f"backing up Compose project: {project}"
    assert "config --no-interpolate" in calls[0]  # asked before anything else is done to the stack


def test_a_config_call_that_fails_prints_unknown_and_the_backup_still_runs(tmp_path, out):
    result, _ = run_backup(tmp_path, out, FAKE_CONFIG_FAILS="1")
    assert result.returncode == 0, result.stderr
    assert result.stderr.splitlines()[0] == "backing up Compose project: unknown"
    assert (out / NEW_DUMP).exists()


def test_paths_with_spaces_work(tmp_path):
    out = tmp_path / "my backups" / "nightly 1"
    copy = tmp_path / "off site"
    pairs(out)
    pairs(copy, ["20250201-000000", "20250202-000000"])
    (copy / MARKER).write_text("dcdash\n")
    result, _ = run_backup(tmp_path, out, "--keep", "1", "--copy-to", copy)
    assert result.returncode == 0, result.stdout + result.stderr
    assert names(out) == pair_names(NEW) and names(copy) == sorted([MARKER, *pair_names(NEW)])
    assert (copy / NEW_DUMP).read_bytes() == b"DUMPDUMP"


# ---- one backup at a time per folder ---------------------------------------------------------------------------------------

@requires_flock
def test_a_free_folder_is_locked_without_a_warning_and_no_lock_file_appears(tmp_path, out):
    result, _ = run_backup(tmp_path, out)
    assert result.returncode == 0, result.stderr
    assert "warning" not in result.stderr and "another backup" not in result.stderr
    assert names(out) == sorted([NEW_DUMP, NEW_VERSION])  # the lock is on the folder itself: nothing but the pair is in it


@requires_flock
def test_a_run_refuses_while_another_backup_holds_the_folder(tmp_path, out):
    import fcntl

    before = pairs(out)
    fd = os.open(out, os.O_RDONLY)  # what the other run holds: a lock on the folder
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result, calls = run_backup(tmp_path, out, "--keep", "1")
    finally:
        os.close(fd)
    assert result.returncode == 1, result.stdout + result.stderr
    assert f"another backup is running in {out}; nothing was changed" in result.stderr
    assert names(out) == before and not any("pg_dump" in c for c in calls)  # not even a partial
    again, _ = run_backup(tmp_path, out, "--keep", "1")  # the lock is gone with the other run
    assert again.returncode == 0, again.stderr
    assert names(out) == pair_names(NEW)


@requires_flock
def test_two_runs_started_in_the_same_second_cannot_share_one_partial(tmp_path, out):
    pairs(out)
    command, environment, log = prepare_script("backup.sh", tmp_path)
    slow = {**environment, "FAKE_DUMP_HEAD": "AAAA", "FAKE_DUMP_TAIL": "aaaa", "FAKE_DUMP_SLEEP": "2"}  # A: AAAA, 2 s, aaaa
    quick = {**environment, "FAKE_DUMP_HEAD": "BBBB", "FAKE_DUMP_TAIL": "bbbb"}
    first = subprocess.Popen([*command, str(out), "--keep", "1"], env=slow, cwd=tmp_path, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 20
        while "pg_dump" not in log.read_text():  # A is inside its dump; B starts only now, in the same second
            assert time.monotonic() < deadline and first.poll() is None, "run A never reached pg_dump"
            time.sleep(0.05)
        second = subprocess.run([*command, str(out), "--keep", "1"], env=quick, cwd=tmp_path, capture_output=True, text=True, timeout=60)
        _, first_stderr = first.communicate(timeout=60)
    finally:
        if first.poll() is None:
            first.kill()
            first.communicate()
    assert second.returncode == 1 and f"another backup is running in {out}" in second.stderr
    assert first.returncode == 0, first_stderr
    assert (out / NEW_DUMP).read_bytes() == b"AAAAaaaa"  # the bytes A read back, not a mix with B's
    assert names(out) == pair_names(NEW)  # A rotated the old pairs; B changed nothing and left no partial


def test_without_flock_the_backup_goes_on_with_a_warning_that_does_not_blame_another_run(tmp_path, out):
    pairs(out)
    result, _ = run_backup(tmp_path, out, "--keep", "1", without=("flock",))
    assert result.returncode == 0, result.stdout + result.stderr
    assert "flock is not installed" in result.stderr and "another backup is running" not in result.stderr
    assert names(out) == pair_names(NEW)


# ---- the copy is flushed before anything is deleted ---------------------------------------------------------------------------

def test_the_copy_is_flushed_to_the_drive_before_either_folder_is_rotated(tmp_path, out):
    copy = tmp_path / "offsite"
    pairs(out)
    pairs(copy, ["20250201-000000", "20250202-000000"])
    (copy / MARKER).write_text("dcdash\n")
    result, calls = run_backup(tmp_path, out, "--keep", "1", "--copy-to", copy, fakes={"rm": FAKE_RM})
    assert result.returncode == 0, result.stdout + result.stderr
    sync = f"sync {copy}/{NEW_DUMP} {copy}/{NEW_VERSION} {copy}"
    assert sync in calls
    removals = [i for i, c in enumerate(calls) if c.startswith("rm -f -- ") and "/dcdash-2025" in c]
    assert len(removals) == (3 + 2) * 2 and calls.index(sync) < min(removals)  # a dump and a .version of every old pair, 3 in out_dir and 2 in the copy folder


def test_a_sync_that_fails_does_not_fail_the_backup(tmp_path, out):
    copy = tmp_path / "offsite"
    copy.mkdir()
    (copy / MARKER).write_text("dcdash\n")
    result, _ = run_backup(tmp_path, out, "--copy-to", copy, fakes={"sync": FAKE_SYNC_FAILS})
    assert result.returncode == 0, result.stdout + result.stderr
    assert f"copied to {copy}" in result.stdout and (copy / NEW_DUMP).exists()


# ---- a removal that fails is reported, and does not turn a good backup into exit 1 -------------------------------------------

COPY_OLD = ["20250201-000000", "20250202-000000", "20250203-000000"]


@pytest.mark.parametrize(
    "fails, out_left, copy_left",
    [
        # the dump of the oldest pair in out_dir cannot be removed: that pair stays whole, the rest of out_dir and the copy folder are rotated
        ("backups/dcdash-20250101-000000.dump", pair_names("20250101-000000", NEW), pair_names(NEW)),
        ("offsite/dcdash-20250201-000000.dump", pair_names(NEW), pair_names("20250201-000000", NEW)),
        # the dump went, its .version cannot: an orphan .version stays (rotation never counts it), the rest is rotated
        ("backups/dcdash-20250102-000000.dump.version", ["dcdash-20250102-000000.dump.version", *pair_names(NEW)], pair_names(NEW)),
    ],
    ids=["dump-in-out_dir", "dump-in-the-copy-folder", "version-in-out_dir"],
)
def test_a_removal_that_fails_is_reported_and_the_backup_still_exits_0(tmp_path, out, fails, out_left, copy_left):
    copy = tmp_path / "offsite"
    pairs(out)
    pairs(copy, COPY_OLD)
    (copy / MARKER).write_text("dcdash\n")
    result, _ = run_backup(tmp_path, out, "--keep", "1", "--copy-to", copy, fakes={"rm": FAKE_RM}, FAKE_RM_FAILS=fails)
    assert result.returncode == 0, result.stdout + result.stderr
    assert f"could not remove {tmp_path / fails}; the new backup is fine" in result.stderr
    assert names(out) == sorted(out_left)
    assert names(copy) == sorted([MARKER, *copy_left])
    assert f"copied to {copy}" in result.stdout


# ---- --copy-to when the project name cannot be read, a two-line marker, a byte order mark -----------------------------------

@pytest.mark.parametrize("marker", ["other-site\n", "dcdash\n"], ids=["another-name", "the-right-name"])
def test_when_the_project_name_cannot_be_read_the_marker_cannot_be_checked_so_nothing_is_copied(tmp_path, out, marker):
    before = pairs(out)
    copy = tmp_path / "offsite"
    other_set = pairs(copy, ["20250201-000000", "20250202-000000"])
    (copy / MARKER).write_text(marker)
    result, _ = run_backup(tmp_path, out, "--keep", "1", "--copy-to", copy, FAKE_CONFIG_FAILS="1")
    assert result.returncode == 5, result.stdout + result.stderr
    assert result.stderr.splitlines()[0] == "backing up Compose project: unknown"
    assert "cannot tell which Compose project this is" in result.stderr and "NOT copied" in result.stderr
    assert names(copy) == sorted([MARKER, *other_set])  # nothing copied in, nothing rotated
    assert names(out) == sorted(before + [NEW_DUMP, NEW_VERSION])


@pytest.mark.parametrize(
    "marker, accepted",
    [(b"other\ndcdash\n", False), (b"dcdash\nother\n", True), (b"\xef\xbb\xbfdcdash\r\n", True), (b"\xef\xbb\xbfother\n", False),
     (b" dcdash\n", False), (b"dcdash \n", False)],
    ids=["right-name-on-line-2", "other-name-on-line-2", "with-a-byte-order-mark", "other-name-with-a-byte-order-mark",
         "leading-space", "trailing-space"],
)
def test_only_the_first_line_of_the_marker_counts(tmp_path, out, marker, accepted):
    pairs(out)
    copy = tmp_path / "offsite"
    copy.mkdir()
    (copy / MARKER).write_bytes(marker)
    result, _ = run_backup(tmp_path, out, "--copy-to", copy)
    assert result.returncode == (0 if accepted else 5), result.stdout + result.stderr
    assert (copy / NEW_DUMP).exists() == accepted and (copy / NEW_VERSION).exists() == accepted
    assert (out / NEW_DUMP).exists()  # the local backup is made either way


def test_a_directory_named_like_a_dump_is_never_counted_or_removed(tmp_path, out):
    pairs(out, OLD[1:])
    folder = out / "dcdash-20240102-000000.dump"
    folder.mkdir()
    (folder / "keep.txt").write_text("x")
    (out / "dcdash-20240102-000000.dump.version").write_text("0005\n")
    result, _ = run_backup(tmp_path, out, "--keep", "1")
    assert result.returncode == 0, result.stdout + result.stderr
    assert (folder / "keep.txt").read_text() == "x" and (out / "dcdash-20240102-000000.dump.version").exists()
    assert "could not remove" not in result.stderr and "dcdash-20240102-000000" not in result.stderr  # it was not even tried
    assert names(out) == sorted(["dcdash-20240102-000000.dump", "dcdash-20240102-000000.dump.version", *pair_names(NEW)])


# ---- the copy folder is not the output folder; wording -----------------------------------------------------------------------

@pytest.mark.parametrize("how", ["same-path", "symlink", "dot-segment"])
def test_the_output_folder_is_not_a_copy_folder(tmp_path, out, how):
    before = pairs(out)
    (out / MARKER).write_text("dcdash\n")
    link = tmp_path / "link-to-backups"
    link.symlink_to(out)
    target = {"same-path": out, "symlink": link, "dot-segment": out / "."}[how]
    result, _ = run_backup(tmp_path, out, "--keep", "1", "--copy-to", target)
    assert result.returncode == 5, result.stdout + result.stderr
    assert "is the output folder" in result.stderr and "NOT copied" in result.stderr
    assert names(out) == sorted(before + [MARKER, NEW_DUMP, NEW_VERSION])  # the local backup, nothing rotated, nothing copied over


def test_a_dump_that_fails_exits_1_and_does_not_claim_a_local_backup_was_made(tmp_path, out):
    before = pairs(out)
    result, _ = run_backup(tmp_path, out, "--keep", "1", "--copy-to", tmp_path / "unplugged", FAKE_DUMP="fail")
    assert result.returncode == 1, result.stdout + result.stderr  # not 5: there is no backup
    assert "will still be attempted" in result.stderr and "still made" not in result.stderr
    assert "no backup was made" in result.stderr and "local backup made" not in result.stderr
    assert names(out) == before


# ---- shell syntax ---------------------------------------------------------------------------------------------------------

def test_backup_sh_parses():
    assert subprocess.run(["bash", "-n", str(SCRIPTS / "backup.sh")], capture_output=True).returncode == 0


# ---- 17. backup.ps1: parsed by PowerShell, and its text checked (it cannot be run here) -------------------------------------

POWERSHELL = shutil.which("powershell.exe") or shutil.which("pwsh")
PS1 = SCRIPTS / "backup.ps1"


def ps1_code() -> str:
    """The script without its comment-only lines (the comments name cmd /c, --list, exit codes)."""
    return "\n".join(line for line in PS1.read_text().splitlines() if not line.lstrip().startswith("#"))


@pytest.mark.skipif(POWERSHELL is None, reason="no PowerShell on this machine")
def test_backup_ps1_parses():
    script = str(PS1)
    if POWERSHELL.endswith(".exe"):  # Windows PowerShell started from WSL wants a Windows path
        script = subprocess.run(["wslpath", "-w", script], capture_output=True, text=True, check=True).stdout.strip()
    command = ("$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile("
               f"'{script}',[ref]$t,[ref]$e); if($e.Count){{$e|ForEach-Object{{$_.Message}}; exit 1}}")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", command],
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


def test_backup_ps1_is_plain_ascii():
    assert PS1.read_text(encoding="utf-8").isascii()  # Windows PowerShell 5.1 reads a file without a BOM as ANSI


def test_backup_ps1_keep_is_a_string_checked_by_hand_and_bad_usage_exits_2():
    text = PS1.read_text()
    param = next(line for line in text.splitlines() if line.startswith("param("))
    assert "[string]$Keep" in param and "[int]" not in param  # an [int] parameter fails binding with exit 1, the contract says 2
    assert "^[1-9][0-9]{0,4}$" in text
    guard = next(line for line in text.splitlines() if "$args.Count -gt 0" in line)
    assert '$Out -like "-*"' in guard and '$CopyTo -like "-*"' in guard and "exit 2" in guard  # bash-style --keep binds to $Out
    keep_check = next(line for line in text.splitlines() if "-notmatch" in line)
    assert "$Keep -notmatch '^[1-9][0-9]{0,4}$'" in keep_check and "exit 2" in keep_check
    assert text.index("[int]$Keep") > text.index("-notmatch")  # the cast happens only after the check


def test_backup_ps1_reads_the_dump_back_in_full():
    text = PS1.read_text()
    code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))  # the comment names --list
    assert "pg_restore -f /dev/null" in code and "--list" not in code and "pg_restore -l" not in code
    assert ps1_code().count("cmd /c") == 2  # binary in (pg_dump > file) and binary out (pg_restore < file) only through cmd


def test_backup_ps1_moves_the_dump_into_place_before_it_writes_the_version_file():
    text = PS1.read_text()
    move = text.index("Move-Item -LiteralPath $Partial -Destination $File")
    write = text.index('Set-Content -LiteralPath "$File.version.partial" -Encoding ascii -NoNewline -Value $Version')
    rename = text.index('Move-Item -LiteralPath "$File.version.partial" -Destination "$File.version"')
    assert move < write < rename  # the .version appears under its final name in one step, like bash's mv; -LiteralPath survives [ ] in the folder
    assert "Set-Content -Path" not in text
    assert text.index("could not read the schema revision") < move  # the revision is known before the dump gets its final name
    assert text.index("the new dump cannot be read back") < move
    assert '"$File.version.partial"' in text[text.index("} finally {"):]  # and a leftover partial is removed


def test_backup_ps1_checks_the_marker_and_exits_5_when_the_copy_did_not_happen():
    text = PS1.read_text()
    assert ".dcdash-backup-target" in text and "Test-Path -LiteralPath $Marker -PathType Leaf" in text
    assert "Test-Path -LiteralPath $CopyTo -PathType Container" in text  # the folder must exist; New-Item is never used on it
    assert "New-Item" in text and "New-Item -ItemType Directory -Force -Path $Out" in text
    assert text.count("New-Item") == 1  # only the output folder is ever created
    assert "belongs to another installation" in text and "exit 5" in text and "NOT copied" in text
    rotate = text[text.index("if ($KeepN -gt 0"):]
    assert rotate.startswith("if ($KeepN -gt 0 -and -not $CopyProblem)")  # nothing rotates after a copy problem
    assert rotate.index("exit 5") > rotate.index("Invoke-Rotate $CopyTo")


def test_backup_ps1_rotation_touches_only_exact_names_with_a_version_and_never_the_new_dump():
    text = PS1.read_text()
    assert "'^dcdash-[0-9]{8}-[0-9]{6}\\.dump$'" in text and "-cmatch" in text  # exact, case-sensitive
    assert "Test-Path -LiteralPath ($_.FullName + \".version\")" in text  # a dump without a .version is not rotated
    assert "if ($all[$i].Name -eq $Name) { continue }" in text


def test_backup_ps1_prints_the_project_before_the_first_docker_call_that_acts_on_the_stack():
    text = PS1.read_text()
    line = text.index('Write-Host "backing up Compose project: $ProjectShown"')
    assert text.rindex("exit 2", 0, line) > 0  # after the argument checks ...
    assert text.index("docker compose config --no-interpolate") < line < text.index("docker compose exec")  # ... and before pg_dump
    assert 'catch { }' in text[:line]  # the project line never aborts the backup


def test_backup_ps1_copy_is_checked_by_hash_before_it_gets_its_final_name():
    text = PS1.read_text()
    assert text.index("Get-FileHash") < text.index("Move-Item -LiteralPath $v") < text.index("Move-Item -LiteralPath $p")
    assert 'throw "$Name already exists there"' in text  # an existing copy is never overwritten


def test_backup_ps1_refuses_to_rotate_a_folder_with_a_dump_named_later_than_this_backup():
    text = PS1.read_text()
    function = text[text.index("function Invoke-Rotate"):]
    guard = function.index("$all.Count -gt 0 -and $all[$all.Count - 1].Name -ne $Name")
    assert guard < function.index("for ($i") < function.index("Remove-Item")  # before anything is removed
    assert "return" in function[guard:function.index("for ($i")]
    assert "not rotating ${Dir}: $($all[$all.Count - 1].Name) is named later than this backup (is the clock right?)" in function


def test_backup_ps1_holds_a_lock_for_the_whole_run_and_releases_it_in_a_finally():
    text = ps1_code()
    lock = text.index("[IO.File]::Open((Join-Path $Out \".dcdash-backup.lock\"), 'OpenOrCreate', 'ReadWrite', 'None')")
    assert lock < text.index("Test-Path -LiteralPath $File") < text.index("cmd /c")  # before the same-second check and the dump
    assert lock < text.index("Invoke-Rotate $Out")  # rotation runs under the lock too
    assert "another backup is running in $Out; nothing was changed" in text
    assert "-band 0xFFFF) -eq 32" in text  # a sharing violation is "another backup"; any other failure has its own message
    assert text.rstrip().endswith("} finally {\n  $Lock.Dispose()\n}")  # released also when the script runs inside an open console


def test_backup_ps1_reports_a_removal_that_fails_and_goes_on():
    text = ps1_code()
    function = text[text.index("function Invoke-Rotate"):text.index("if ($KeepN -gt 0 -and -not $CopyProblem)")]
    assert function.count("Remove-Item -Force -ErrorAction Stop") == 2 and function.count("try {") == 2  # terminating, so the catch sees it
    assert function.count("could not remove") == 2 and "the new backup is fine" in function
    assert "continue" in function[function.index("could not remove"):] and "exit" not in function  # the exit code is not touched


def test_backup_ps1_will_not_copy_when_the_project_is_unknown_or_the_copy_folder_is_the_output_folder():
    text = PS1.read_text()
    assert "cannot tell which Compose project this is" in text and "is the output folder itself" in text
    folder, unknown, marker = (text.index(s) for s in ("Resolve-Path -LiteralPath $CopyTo", "elseif (-not $Project)", "Test-Path -LiteralPath $Marker"))
    assert folder < unknown < marker  # the marker is only read once the project name is known
    assert "} elseif ((Resolve-Path -LiteralPath $CopyTo).ProviderPath.TrimEnd('\\') -ieq $Out.TrimEnd('\\')) {" in text  # the whole condition


def test_backup_ps1_header_says_how_to_run_it_and_what_binding_errors_do():
    text = PS1.read_text()
    header = " ".join(line.lstrip("# ") for line in text.splitlines() if line.startswith("#"))
    assert "Run it with powershell.exe -File: the exit code 5 does not reach the caller under -Command" in header
    assert "parameter-binding errors (a missing value, a duplicate parameter) exit 1, not 2" in header
    empty = next(line for line in text.splitlines() if "ContainsKey('CopyTo')" in line)
    assert "-not $CopyTo" in empty and "exit 2" in empty  # an explicit empty -CopyTo is a usage error, like bash


def test_backup_ps1_makes_out_absolute_and_refuses_a_percent_sign():
    text = ps1_code()
    absolute = text.index("$Out = (New-Item -ItemType Directory -Force -Path $Out).FullName")
    percent = next(line for line in text.splitlines() if '$Out.Contains("%")' in line)
    assert "exit 2" in percent
    assert absolute < text.index('$Out.Contains("%")') < text.index("Resolve-Path -LiteralPath $CopyTo") < text.index("cmd /c")
