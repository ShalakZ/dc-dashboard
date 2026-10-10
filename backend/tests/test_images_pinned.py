"""Every external container image is pinned by digest, and scripts/pin_images.sh is the one command that re-pins them.

The first three tests read the real backend/Dockerfile, frontend/Dockerfile and compose.yaml (static, no Docker). The script tests
run `scripts/pin_images.sh` on a copy of those files in tmp_path (the script works on the tree around itself, so a copy of the
script next to copies of the files is a whole tree); `docker` is a FAKE program on PATH that only writes down how it was called
and answers the way `docker buildx imagetools inspect` does, so nothing touches the network or the daemon.
"""
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "pin_images.sh"
FILES = ["backend/Dockerfile", "frontend/Dockerfile", "compose.yaml"]

# The only external images the project builds on or runs. A new one must be added here AND to the table in scripts/pin_images.sh.
EXPECTED = {
    ("backend/Dockerfile", "python:3.12-slim"),
    ("backend/Dockerfile", "ghcr.io/astral-sh/uv:0.13.0"),
    ("frontend/Dockerfile", "node:22-alpine"),
    ("frontend/Dockerfile", "caddy:2-alpine"),
    ("compose.yaml", "timescale/timescaledb:2.30.2-pg16"),
}
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
A64 = "a" * 64


def dockerfile_references(text: str) -> list[str]:
    """`FROM x [AS y]` and `COPY --from=x`; a FROM or --from that names an earlier stage is not an external image."""
    stages: set[str] = set()
    refs: list[str] = []
    for line in text.splitlines():
        from_line = re.match(r"\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?", line, re.IGNORECASE)
        if from_line:
            if from_line.group(1).lower() not in stages and from_line.group(1).lower() != "scratch":
                refs.append(from_line.group(1))
            if from_line.group(2):
                stages.add(from_line.group(2).lower())
            continue
        copy_from = re.match(r"\s*COPY\s+(?:.*\s)?--from=(\S+)", line, re.IGNORECASE)
        if copy_from and copy_from.group(1).lower() not in stages and not copy_from.group(1).isdigit():
            refs.append(copy_from.group(1))
    return refs


def compose_references(text: str) -> list[str]:
    """The `image:` of every service that is not a locally built tag (those end in :local)."""
    services = yaml.safe_load(text)["services"]
    return [s["image"] for s in services.values() if "image" in s and not s["image"].endswith(":local")]


def references(root: Path) -> list[tuple[str, str]]:
    found = []
    for name in FILES:
        text = (root / name).read_text()
        refs = compose_references(text) if name == "compose.yaml" else dockerfile_references(text)
        found += [(name, r) for r in refs]
    return found


def test_the_external_references_are_exactly_the_five_the_script_knows():
    found = {(name, ref.split("@")[0]) for name, ref in references(ROOT)}
    assert found == EXPECTED, (
        f"external image references changed (new: {sorted(found - EXPECTED)}, gone: {sorted(EXPECTED - found)}); "
        "update EXPECTED here and the table in scripts/pin_images.sh together"
    )


def test_every_external_reference_is_pinned_by_a_full_sha256_digest():
    unpinned = []
    for name, ref in references(ROOT):
        _, _, digest = ref.partition("@")
        if not DIGEST.match(digest):
            unpinned.append(f"{name}: {ref}")
    assert not unpinned, "not pinned as <ref>@sha256:<64 hex> (run scripts/pin_images.sh --update): " + "; ".join(unpinned)


def test_no_external_reference_is_a_latest_tag():
    assert [r for _, r in references(ROOT) if r.split("@")[0].endswith(":latest")] == []


def test_the_parsers_skip_stage_names_and_local_tags():
    docker = "FROM node:22-alpine AS build\nCOPY x .\nFROM caddy:2-alpine\nCOPY --from=build /a /b\nFROM build\nCOPY --from=0 /a /b\n"
    assert dockerfile_references(docker) == ["node:22-alpine", "caddy:2-alpine"]
    compose = "services:\n  db:\n    image: x/y:1\n  api:\n    build: .\n    image: dcdash-backend:local\n"
    assert compose_references(compose) == ["x/y:1"]


# --- scripts/pin_images.sh, on a copy of the tree, with a fake docker -------------------------------------------------------

# Answers like `docker buildx imagetools inspect <ref>` without --format: a few lines of text, the index digest on the first
# `Digest:` line, a platform manifest further down. FAKE_HEX changes the digest; FAKE_DIGEST_LINE replaces the whole Digest line.
FAKE_DOCKER = f"""#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
[ "$1 $2 $3" = "buildx imagetools inspect" ] || exit 0
case "$*" in *--format*) echo "unexpected --format" >&2; exit 1 ;; esac
echo "Name:      docker.io/library/x"
echo "MediaType: application/vnd.oci.image.index.v1+json"
if [ -n "${{FAKE_DIGEST_LINE-}}" ]; then echo "$FAKE_DIGEST_LINE"; else echo "Digest:    sha256:${{FAKE_HEX:-{A64}}}"; fi
echo
echo "Manifests:"
echo "  Name:      docker.io/library/x@sha256:{"b" * 64}"
echo "  Digest:    sha256:{"b" * 64}"
"""


def unpinned_copy(root: Path) -> None:
    """The real files as they would be before a pin: no digests, and the uv reference written the way the script's table has it
    (the real Dockerfile says :latest until the pin commit changes it; the copy does not depend on that)."""
    for name in FILES:
        text = re.sub(r"@sha256:[0-9a-f]+", "", (ROOT / name).read_text())
        text = text.replace("ghcr.io/astral-sh/uv:latest", "ghcr.io/astral-sh/uv:0.13.0")
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text)


def make_tree(tmp_path: Path) -> Path:
    tree = tmp_path / "tree"
    (tree / "scripts").mkdir(parents=True)
    shutil.copy2(SCRIPT, tree / "scripts" / "pin_images.sh")
    unpinned_copy(tree)
    return tree


def run_script(tree: Path, *args: str, docker: str = FAKE_DOCKER, **env: str):
    """Runs the script of `tree`; returns the result and the docker calls of this run."""
    bin_dir = tree.parent / "bin"
    bin_dir.mkdir(exist_ok=True)
    fake = bin_dir / "docker"
    fake.write_text(docker)
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    log = tree.parent / "calls.log"
    log.write_text("")
    environment = {k: v for k, v in os.environ.items() if not k.startswith(("FAKE_", "COMPOSE_"))}
    environment.update(PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", FAKE_LOG=str(log), **env)
    result = subprocess.run(
        ["bash", str(tree / "scripts" / "pin_images.sh"), *args], capture_output=True, text=True, env=environment, timeout=60
    )
    return result, log.read_text().splitlines()


@pytest.fixture
def pinned_tree(tmp_path):
    tree = make_tree(tmp_path)
    result, _ = run_script(tree, "--update")
    assert result.returncode == 0, result.stdout + result.stderr
    return tree


def test_check_on_the_real_files_passes():
    result = subprocess.run(["bash", str(SCRIPT), "--check"], capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr


def test_check_fails_on_unpinned_files_and_names_each_file(tmp_path):
    tree = make_tree(tmp_path)
    result, calls = run_script(tree, "--check")
    assert result.returncode == 1
    for name in FILES:
        assert name in result.stderr
    assert calls == []  # --check needs neither docker nor a network


def test_check_passes_on_a_pinned_copy_without_calling_docker(pinned_tree):
    result, calls = run_script(pinned_tree, "--check")
    assert result.returncode == 0, result.stdout + result.stderr
    assert calls == []


@pytest.mark.parametrize("name, ref", sorted(EXPECTED))
def test_a_digest_of_63_hex_fails_check_and_names_the_file_and_the_reference(pinned_tree, name, ref):
    path = pinned_tree / name
    text = path.read_text()
    assert f"{ref}@sha256:{A64}" in text
    path.write_text(text.replace(f"{ref}@sha256:{A64}", f"{ref}@sha256:{A64[:63]}"))
    result, _ = run_script(pinned_tree, "--check")
    assert result.returncode == 1
    assert name in result.stderr and ref in result.stderr


@pytest.mark.parametrize("bad", ["A" * 64, "g" * 64, "a" * 65, ""], ids=["upper", "not-hex", "65-hex", "empty"])
def test_other_malformed_digests_fail_check(pinned_tree, bad):
    path = pinned_tree / "frontend/Dockerfile"
    path.write_text(path.read_text().replace(f"caddy:2-alpine@sha256:{A64}", f"caddy:2-alpine@sha256:{bad}"))
    result, _ = run_script(pinned_tree, "--check")
    assert result.returncode == 1
    assert "frontend/Dockerfile" in result.stderr


def test_a_tag_without_a_digest_fails_check(pinned_tree):
    path = pinned_tree / "compose.yaml"
    path.write_text(path.read_text().replace(f"@sha256:{A64}", ""))
    result, _ = run_script(pinned_tree, "--check")
    assert result.returncode == 1
    assert "compose.yaml" in result.stderr


def test_a_reference_that_is_not_in_the_table_fails_check_and_names_the_file(pinned_tree):
    path = pinned_tree / "backend/Dockerfile"
    path.write_text(path.read_text() + "FROM alpine:3.20\n")
    result, _ = run_script(pinned_tree, "--check")
    assert result.returncode == 1
    assert "backend/Dockerfile" in result.stderr and "alpine:3.20" in result.stderr


def test_a_table_reference_missing_from_its_file_fails_check_and_names_the_file(pinned_tree):
    path = pinned_tree / "frontend/Dockerfile"
    path.write_text(path.read_text().replace("node:22-alpine", "node:24-alpine"))
    result, _ = run_script(pinned_tree, "--check")
    assert result.returncode == 1
    assert "frontend/Dockerfile" in result.stderr and "node:22-alpine" in result.stderr


def test_update_resolves_the_five_tags_pins_them_and_changes_nothing_else(tmp_path):
    tree = make_tree(tmp_path)
    before = {name: (tree / name).read_text() for name in FILES}
    result, calls = run_script(tree, "--update")
    assert result.returncode == 0, result.stdout + result.stderr
    # one lookup per reference, by tag, with the default output (the digest is read from the `Digest:` line)
    assert sorted(calls) == sorted(f"docker buildx imagetools inspect {ref}" for _, ref in EXPECTED)
    after = {name: (tree / name).read_text() for name in FILES}
    for name, ref in EXPECTED:
        assert f"{ref}@sha256:{A64}" in after[name]
    # the exact lines, one per kind of reference
    assert f"FROM python:3.12-slim@sha256:{A64}\n" in after["backend/Dockerfile"]
    assert f"COPY --from=ghcr.io/astral-sh/uv:0.13.0@sha256:{A64} /uv /usr/local/bin/uv\n" in after["backend/Dockerfile"]
    assert f"FROM node:22-alpine@sha256:{A64} AS build\n" in after["frontend/Dockerfile"]
    assert f"FROM caddy:2-alpine@sha256:{A64}\n" in after["frontend/Dockerfile"]
    assert f"    image: timescale/timescaledb:2.30.2-pg16@sha256:{A64}\n" in after["compose.yaml"]
    # nothing but the digests changed
    for name in FILES:
        assert re.sub(r"@sha256:[0-9a-f]{64}", "", after[name]) == before[name]
    # the digest of the index, not of a platform manifest listed further down in the same answer
    assert "b" * 64 not in "".join(after.values())
    check, _ = run_script(tree, "--check")
    assert check.returncode == 0, check.stdout + check.stderr


def test_update_is_idempotent_and_replaces_an_older_digest(tmp_path):
    tree = make_tree(tmp_path)
    run_script(tree, "--update")
    once = {name: (tree / name).read_bytes() for name in FILES}
    again, _ = run_script(tree, "--update")
    assert again.returncode == 0, again.stdout + again.stderr
    assert {name: (tree / name).read_bytes() for name in FILES} == once
    # a newer digest from the registry replaces the old one in place
    newer, _ = run_script(tree, "--update", FAKE_HEX="c" * 64)
    assert newer.returncode == 0, newer.stdout + newer.stderr
    for name in FILES:
        text = (tree / name).read_text()
        assert A64 not in text and "c" * 64 in text
        assert re.sub(r"@sha256:[0-9a-f]{64}", "", text) == re.sub(r"@sha256:[0-9a-f]{64}", "", once[name].decode())


@pytest.mark.parametrize("quote", ['"', "'"], ids=["double", "single"])
def test_update_pins_a_quoted_image_reference_and_keeps_the_quotes(tmp_path, quote):
    tree = make_tree(tmp_path)
    path = tree / "compose.yaml"
    plain = "image: timescale/timescaledb:2.30.2-pg16\n"
    assert plain in path.read_text()
    path.write_text(path.read_text().replace(plain, f"image: {quote}timescale/timescaledb:2.30.2-pg16{quote}\n"))
    result, _ = run_script(tree, "--update")
    assert result.returncode == 0, result.stdout + result.stderr
    assert f"image: {quote}timescale/timescaledb:2.30.2-pg16@sha256:{A64}{quote}\n" in path.read_text()
    assert run_script(tree, "--check")[0].returncode == 0
    # a quoted, already pinned line takes a newer digest in place (the old digest must not swallow the closing quote)
    newer, _ = run_script(tree, "--update", FAKE_HEX="c" * 64)
    assert newer.returncode == 0, newer.stdout + newer.stderr
    assert f"image: {quote}timescale/timescaledb:2.30.2-pg16@sha256:{'c' * 64}{quote}\n" in path.read_text()


def test_update_prints_a_before_and_after_table(tmp_path):
    tree = make_tree(tmp_path)
    result, _ = run_script(tree, "--update")
    for _, ref in EXPECTED:
        assert ref in result.stdout
    assert A64[:12] in result.stdout


@pytest.mark.parametrize("answer", ["Digest:    sha256:" + "a" * 63, "Digest:    sha256:" + "A" * 64, "Digest:    nonsense", "no digest line"],
                         ids=["63-hex", "upper", "nonsense", "missing"])
def test_update_refuses_an_answer_that_is_not_a_digest_and_changes_no_file(tmp_path, answer):
    tree = make_tree(tmp_path)
    before = {name: (tree / name).read_text() for name in FILES}
    result, _ = run_script(tree, "--update", FAKE_DIGEST_LINE=answer)
    assert result.returncode == 1
    assert "python:3.12-slim" in result.stderr  # says which reference
    assert {name: (tree / name).read_text() for name in FILES} == before


def test_update_stops_when_docker_cannot_answer_and_changes_no_file(tmp_path):
    tree = make_tree(tmp_path)
    before = {name: (tree / name).read_text() for name in FILES}
    result, _ = run_script(tree, "--update", docker='#!/usr/bin/env bash\necho "no route to registry" >&2\nexit 1\n')
    assert result.returncode == 1
    assert "python:3.12-slim" in result.stderr and "no route to registry" in result.stderr
    assert {name: (tree / name).read_text() for name in FILES} == before


def test_update_refuses_when_the_table_and_the_files_disagree_before_asking_the_registry(tmp_path):
    tree = make_tree(tmp_path)
    path = tree / "backend/Dockerfile"
    path.write_text(path.read_text().replace("uv:0.13.0", "uv:latest"))
    result, calls = run_script(tree, "--update")
    assert result.returncode == 1
    assert "backend/Dockerfile" in result.stderr
    assert calls == []


@pytest.mark.parametrize("args", [[], ["--nonsense"], ["--check", "--update"]], ids=["none", "unknown", "both"])
def test_bad_usage_exits_2_and_says_how(tmp_path, args):
    tree = make_tree(tmp_path)
    result, calls = run_script(tree, *args)
    assert result.returncode == 2
    assert "usage" in result.stderr and "--check" in result.stderr and "--update" in result.stderr
    assert calls == []
