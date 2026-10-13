"""No git-tracked file, and no blob in a local commit, may be larger than 2 MB.

Added after the W7i incident: a script wrote a 133 MB docs/superpowers/backlog.md into local commits and GitHub refused the push
(its limit is 100 MB). The largest tracked files today are a 726 KB plan and backend/uv.lock at 354 KB. Two checks, because they
catch different mistakes: the working-tree check fails for a file that grew but is not committed yet; the local-commits check
fails for a blob that is already committed, even after the working-tree file was fixed (the push would still be refused).
"""
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
LIMIT = 2_000_000  # bytes
# path (as git prints it) -> why it may be bigger than LIMIT. Empty on purpose: add a line only for a file that must be big.
ALLOWED_LARGE: dict[str, str] = {}


def git(repo: Path, *args: str, stdin: bytes | None = None) -> bytes:
    """Run git in `repo`; a broken git (for example 'detected dubious ownership' on a Windows checkout used from WSL) fails the
    test with git's own message instead of a bare CalledProcessError."""
    try:
        return subprocess.run(["git", *args], cwd=repo, input=stdin, capture_output=True, check=True).stdout
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode("utf-8", "replace").strip()
        pytest.fail(f"`git {' '.join(args)}` failed in {repo} (exit {exc.returncode}): {stderr}", pytrace=False)


def oversized(sizes: dict[str, int], limit: int, allowed: dict[str, str]) -> list[str]:
    return sorted(f"{path} ({size:,} bytes)" for path, size in sizes.items() if size > limit and path not in allowed)


def tracked_sizes(repo: Path = REPO) -> dict[str, int]:
    out = git(repo, "ls-files", "-z")
    sizes = {}
    for raw in out.split(b"\0"):
        if not raw:
            continue
        path = raw.decode("utf-8", "surrogateescape")
        file = repo / path
        if file.is_symlink():  # git stores only the link text; stat() would measure the target, which is not what gets pushed
            sizes[path] = file.lstat().st_size
        elif file.is_file():  # a tracked file deleted in the working tree has no size; a submodule (gitlink) is a directory
            sizes[path] = file.stat().st_size
    return sizes


def local_blob_sizes(repo: Path = REPO, base: str = "origin/main") -> dict[str, int]:
    """Every blob the next push would send (reachable from HEAD, not from `base`): path -> its largest size.

    `rev-list --objects` prints 'sha path' (a tree or blob) and `cat-file --batch-check` reads those lines back, so the path
    survives in %(rest)."""
    listed = git(repo, "rev-list", "--objects", f"{base}..HEAD")
    checked = git(repo, "cat-file", "--batch-check=%(objecttype) %(objectsize) %(rest)", stdin=listed)
    sizes: dict[str, int] = {}
    for line in checked.decode("utf-8", "surrogateescape").splitlines():
        kind, _, rest = line.partition(" ")
        size, _, path = rest.partition(" ")
        if kind == "blob":
            sizes[path] = max(sizes.get(path, 0), int(size))
    return sizes


needs_git = pytest.mark.skipif(shutil.which("git") is None or not (REPO / ".git").exists(), reason="not a git checkout")


def test_oversized_names_only_the_files_over_the_limit_that_are_not_allowed():
    sizes = {"a": 10, "b": 3_000_000, "c": 5_000_000, "d": 2_000_000}
    assert oversized(sizes, 2_000_000, {"c": "a fixture"}) == ["b (3,000,000 bytes)"]


@needs_git
def test_no_tracked_file_is_larger_than_two_megabytes():
    big = oversized(tracked_sizes(), LIMIT, ALLOWED_LARGE)
    assert big == [], "a tracked file is over 2 MB (a script that rewrites a whole file can do this): " + "; ".join(big)


@needs_git
def test_every_allowed_large_file_is_still_tracked_and_still_explained():
    sizes = tracked_sizes()
    for path, reason in ALLOWED_LARGE.items():
        assert path in sizes and reason.strip(), f"ALLOWED_LARGE entry {path!r} is stale or has no reason"


@needs_git
def test_no_blob_in_the_commits_not_yet_on_origin_main_is_larger_than_two_megabytes():
    if subprocess.run(["git", "rev-parse", "--verify", "-q", "origin/main"], cwd=REPO, capture_output=True).returncode != 0:
        pytest.skip("origin/main does not resolve here (no remote, or a fresh clone)")
    big = oversized(local_blob_sizes(), LIMIT, ALLOWED_LARGE)
    assert big == [], "a blob in a local commit is over 2 MB, so GitHub would refuse the push even if the file was fixed since: " + "; ".join(big)


def _scratch_repo(path: Path) -> None:
    for args in (["init", "-q"], ["config", "user.name", "t"], ["config", "user.email", "t@example.invalid"], ["config", "commit.gpgsign", "false"]):
        git(path, *args)


@needs_git
def test_a_big_blob_in_a_local_commit_is_found_after_the_file_was_fixed(tmp_path):
    """The check itself, on a throwaway repo and with a tiny limit: the W7i shape (a big file committed, then shrunk in the next commit)."""
    _scratch_repo(tmp_path)
    (tmp_path / "ok.txt").write_text("small")
    git(tmp_path, "add", "ok.txt")
    git(tmp_path, "commit", "-q", "-m", "base")
    git(tmp_path, "update-ref", "refs/remotes/origin/main", "HEAD")  # what the remote already has
    (tmp_path / "backlog.md").write_text("x" * 5000)
    git(tmp_path, "add", "backlog.md")
    git(tmp_path, "commit", "-q", "-m", "oops")
    (tmp_path / "backlog.md").write_text("fixed")
    git(tmp_path, "add", "backlog.md")
    git(tmp_path, "commit", "-q", "-m", "fix")

    assert oversized(tracked_sizes(tmp_path), 1000, {}) == []  # the working tree is clean...
    assert oversized(local_blob_sizes(tmp_path), 1000, {}) == ["backlog.md (5,000 bytes)"]  # ...but the history still carries it
    assert oversized(local_blob_sizes(tmp_path), 1000, {"backlog.md": "a fixture"}) == []


@needs_git
def test_a_tracked_symlink_is_measured_as_the_link_not_its_target(tmp_path):
    _scratch_repo(tmp_path)
    (tmp_path / "big.bin").write_bytes(b"x" * 5000)
    try:
        (tmp_path / "link").symlink_to("big.bin")
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are not available here")
    git(tmp_path, "add", "link")  # only the link; big.bin stays untracked
    sizes = tracked_sizes(tmp_path)
    assert sizes == {"link": len("big.bin")}
