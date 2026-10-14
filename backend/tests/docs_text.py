"""Shared reader for the doc-reading tests: README.md, CHANGELOG.md and the pages under docs/.

W10 split the README into pages. A test that pins a sentence reads the page that now holds it (page()), and a test that pins a fact
which may live on any page (a script name, an SQL block) reads the whole corpus (docs_corpus()). heading() and section() are the
level-exact readers the README tests always used; they take the text to read.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def page(name: str) -> str:
    """README.md, CHANGELOG.md, or docs/<name>.md for any other name (no extension)."""
    if name in ("README", "CHANGELOG"):
        path = ROOT / f"{name}.md"
    else:
        path = ROOT / "docs" / f"{name}.md"
    return path.read_text(encoding="utf-8")


def docs_corpus() -> str:
    """README.md, CHANGELOG.md and every docs/*.md (not the subfolders: docs/superpowers is history), joined with newlines."""
    paths = [ROOT / "README.md", ROOT / "CHANGELOG.md", *sorted((ROOT / "docs").glob("*.md"))]
    return "\n".join(path.read_text(encoding="utf-8") for path in paths)


def heading(text: str, level: int, title: str) -> bool:
    return re.search(rf"^{'#' * level} {re.escape(title)}$", text, flags=re.M) is not None


def section(text: str, level: int, title: str) -> str:
    """The text from the heading to the next heading of the same or a higher level."""
    marks = "#" * level
    match = re.search(rf"^{marks} {re.escape(title)}$(.*?)(?=^#{{1,{level}}} |\Z)", text, flags=re.M | re.S)
    assert match, f"no '{marks} {title}' heading"
    return match.group(1)


def flat(text: str) -> str:
    """The text on one line, so a phrase may wrap across the pages' hard line breaks."""
    return " ".join(text.split())
