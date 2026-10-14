"""Every relative link and anchor in the user-facing docs resolves, and the docs keep their shape.

Plain pytest: no Docker, no database, no network. External links (http, https, mailto) are never followed.
Scope: README.md, CHANGELOG.md, docs/*.md and docs/field-debugging-examples/*.md (not docs/superpowers, not docs/brand).
Anchors follow the GitHub slug rule: lowercase, punctuation dropped except hyphens and underscores, spaces to hyphens,
a repeated slug gets -1, -2 ... in order of appearance. Links and headings inside fenced code blocks do not count.
"""
import os
import re
from pathlib import Path
from urllib.parse import unquote

import pytest

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
README = ROOT / "README.md"
CHANGELOG = ROOT / "CHANGELOG.md"

README_MAX_LINES = 260
PAGE_MAX_BYTES = 80_000
EXTERNAL = ("http://", "https://", "mailto:")


def doc_files() -> list[Path]:
    files = [README, CHANGELOG]
    files += sorted(DOCS.glob("*.md"))
    files += sorted((DOCS / "field-debugging-examples").glob("*.md"))
    return files


# ---- markdown reading -----------------------------------------------------------------------------------------------


def split_fenced(text: str) -> tuple[list[str], list[bool]]:
    """The file's lines, and for each line whether it is a fence line or sits inside a fenced code block."""
    lines = text.split("\n")
    fenced: list[bool] = []
    fence: tuple[str, int] | None = None
    for line in lines:
        stripped = line.strip()
        if fence is None:
            m = re.match(r"(`{3,}|~{3,})", stripped)
            if m:
                fence = (m.group(1)[0], len(m.group(1)))
                fenced.append(True)
            else:
                fenced.append(False)
        else:
            fenced.append(True)
            m = re.fullmatch(r"(`{3,}|~{3,})", stripped)
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= fence[1]:
                fence = None
    return lines, fenced


def blank(match: re.Match) -> str:
    """Same length, newlines kept, so offsets and line numbers survive."""
    return re.sub(r"[^\n]", " ", match.group(0))


def prose(text: str) -> str:
    """The text with fenced blocks and inline code spans blanked out."""
    lines, fenced = split_fenced(text)
    kept = ["" if is_fenced else line for line, is_fenced in zip(lines, fenced)]
    joined = "\n".join(kept)
    # A code span is a run of backticks closed by a run of the same length; it cannot cross a blank line.
    return re.sub(r"(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n).)+?(?<!`)\1(?!`)", blank, joined, flags=re.DOTALL)


def clean_heading(text: str) -> str:
    text = re.sub(r"\s+#+\s*$", "", text.strip())  # closing hashes
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)  # links and images keep their text
    text = re.sub(r"<[^>]+>", "", text)
    return text.replace("`", "").replace("*", "").strip()


def slugify(heading: str) -> str:
    text = clean_heading(heading).lower()
    text = re.sub(r"[^\w\- ]", "", text)  # \w keeps letters, digits and underscore
    return text.replace(" ", "-")


def heading_slugs(text: str) -> set[str]:
    """Every anchor a file offers, headings in fenced code blocks excluded, repeated slugs numbered."""
    lines, fenced = split_fenced(text)
    seen: dict[str, int] = {}
    slugs: set[str] = set()
    for line, is_fenced in zip(lines, fenced):
        if is_fenced:
            continue
        m = re.match(r" {0,3}#{1,6}[ \t]+(\S.*)$", line)
        if not m:
            continue
        slug = slugify(m.group(1))
        n = seen.get(slug, 0)
        seen[slug] = n + 1
        slugs.add(slug if n == 0 else f"{slug}-{n}")
    return slugs


LINK = re.compile(
    r"(?<!\\)\[(?:[^\[\]\\]|\\.|\[[^\[\]]*\])*\]"  # [text], one level of nested brackets allowed
    r"\(\s*(<[^>\n]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)"  # (target), <target> or one level of parentheses
    r"(?:\s+(?:\"[^\"]*\"|'[^']*'))?\s*\)"  # optional "title"
)
DEFINITION = re.compile(
    r"^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+(?:\"[^\"]*\"|'[^']*'|\([^)\n]*\)))?[ \t]*$", re.MULTILINE
)


def extract_links(text: str) -> list[tuple[int, str]]:
    """(line, target) for each inline link and reference definition outside code."""
    body = prose(text)
    found: list[tuple[int, int, str]] = []
    for regex in (LINK, DEFINITION):
        for m in regex.finditer(body):
            target = m.group(1)
            if target.startswith("<") and target.endswith(">"):
                target = target[1:-1]
            found.append((m.start(), body.count("\n", 0, m.start()) + 1, target))
    return [(line, target) for _offset, line, target in sorted(found)]


# ---- resolving ------------------------------------------------------------------------------------------------------


def exists_exact(path: Path) -> bool:
    """Exists with the exact letter case, as on Linux and GitHub (a Windows checkout would not tell)."""
    path = Path(os.path.normpath(path))
    try:
        rel = path.relative_to(ROOT)
    except ValueError:
        return path.exists()
    here = ROOT
    for part in rel.parts:
        if part not in os.listdir(here):
            return False
        here = here / part
    return True


_slug_cache: dict[Path, set[str]] = {}


def slugs_of(path: Path) -> set[str]:
    if path not in _slug_cache:
        _slug_cache[path] = heading_slugs(path.read_text(encoding="utf-8"))
    return _slug_cache[path]


def split_target(target: str) -> tuple[str, str]:
    path, _, anchor = target.partition("#")
    return unquote(path), unquote(anchor)


def resolve(source: Path, path_part: str) -> Path:
    if not path_part:
        return source
    if path_part.startswith("/"):
        return ROOT / path_part.lstrip("/")
    return source.parent / path_part


def check_link(source: Path, target: str) -> str | None:
    """None when the link is fine, else the reason it is not."""
    if target.lower().startswith(EXTERNAL):
        return None
    path_part, anchor = split_target(target)
    dest = resolve(source, path_part)
    if not exists_exact(dest):
        return f"no such file or folder: {os.path.normpath(dest).replace(str(ROOT) + os.sep, '')}"
    if anchor and dest.is_file() and dest.suffix.lower() == ".md":
        if anchor not in slugs_of(Path(os.path.normpath(dest))):
            return f"no heading with the anchor #{anchor} in {dest.name}"
    return None


def broken_links() -> tuple[list[str], int]:
    problems: list[str] = []
    checked = 0
    for source in doc_files():
        rel = source.relative_to(ROOT).as_posix()
        for line, target in extract_links(source.read_text(encoding="utf-8")):
            if target.lower().startswith(EXTERNAL):
                continue
            checked += 1
            reason = check_link(Path(os.path.normpath(source)), target)
            if reason:
                problems.append(f"{rel}:{line}: {target} -> {reason}")
    return problems, checked


# ---- the tests ------------------------------------------------------------------------------------------------------


def test_every_relative_link_and_anchor_resolves():
    problems, checked = broken_links()
    assert checked > 50, f"only {checked} relative links found: the link reader is probably broken"
    assert not problems, "broken links:\n" + "\n".join(problems)


@pytest.mark.parametrize(
    ("heading", "slug"),
    [
        ("Users & Roles", "users--roles"),
        ("What the backup does not contain", "what-the-backup-does-not-contain"),
        ("Optional HTTPS", "optional-https"),
        ("`docker compose up`", "docker-compose-up"),
        ("Upgrading to W1a (migration 0005)", "upgrading-to-w1a-migration-0005"),
        ("The **bold** [link text](other.md) heading", "the-bold-link-text-heading"),
        ("snake_case stays", "snake_case-stays"),
        ("Closed with hashes ##", "closed-with-hashes"),
    ],
)
def test_slug_function(heading, slug):
    assert slugify(heading) == slug


def test_duplicate_headings_are_numbered_in_order_of_appearance():
    assert heading_slugs("# X\n\ntext\n\n## X\n\n### X\n") == {"x", "x-1", "x-2"}


def test_headings_in_fenced_code_blocks_do_not_count():
    text = "# Real\n\n```bash\n# not a heading\n```\n\n~~~\n## nor this\n~~~\n\n## After\n"
    assert heading_slugs(text) == {"real", "after"}


def test_link_reader_skips_code_and_external_links_and_reports_lines():
    text = (
        "one [a](a.md) and `[b](b.md)` here\n"
        "```\n[c](c.md)\n```\n"
        "[d](https://example.com/x) and [e](docs/e.md#top \"A title\")\n"
        "[ref]: ref.md\n"
    )
    assert extract_links(text) == [
        (1, "a.md"),
        (5, "https://example.com/x"),
        (5, "docs/e.md#top"),
        (6, "ref.md"),
    ]


def test_check_link_reports_missing_files_and_anchors():
    assert check_link(README, "https://example.com/nowhere") is None
    assert check_link(README, "docs/no-such-page.md") is not None
    assert check_link(README, "docs/install-and-run.md") is None
    assert check_link(README, "docs/install-and-run.md#no-such-heading-anywhere") is not None
    assert check_link(README, "#no-such-heading-anywhere") is not None
    assert check_link(README, "docs/field-debugging-examples/") is None


def test_the_readme_is_a_short_front_door():
    lines = README.read_text(encoding="utf-8").count("\n") + 1
    assert lines <= README_MAX_LINES, f"README.md has {lines} lines (limit {README_MAX_LINES})"


def test_no_page_is_too_big():
    too_big = [
        f"{p.relative_to(ROOT).as_posix()}: {p.stat().st_size} bytes"
        for p in [CHANGELOG, *sorted(DOCS.glob("*.md"))]
        if p.stat().st_size > PAGE_MAX_BYTES
    ]
    assert not too_big, f"over {PAGE_MAX_BYTES} bytes: {too_big}"


def test_every_page_starts_with_a_title():
    missing = []
    for page in sorted(DOCS.glob("*.md")):
        if page.name == "field-debugging.md":
            continue
        first = next((ln for ln in page.read_text(encoding="utf-8").splitlines() if ln.strip()), "")
        if not first.startswith("# "):
            missing.append(page.name)
    assert not missing, f"pages that do not start with a '# ' title line: {missing}"


def test_the_readme_links_to_every_page():
    linked = {
        Path(os.path.normpath(resolve(README, split_target(target)[0])))
        for _line, target in extract_links(README.read_text(encoding="utf-8"))
        if not target.lower().startswith(EXTERNAL)
    }
    missing = [p.name for p in sorted(DOCS.glob("*.md")) if Path(os.path.normpath(p)) not in linked]
    assert not missing, f"docs pages the README does not link to: {missing}"
