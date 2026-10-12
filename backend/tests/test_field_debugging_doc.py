"""The field-debugging protocol names things that must exist: its headings, the offline script, the page's labels and the report's markers."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOC = (ROOT / "docs" / "field-debugging.md").read_text(encoding="utf-8")
PAGE = (ROOT / "frontend" / "src" / "pages" / "DiagnosticsPage.tsx").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")


def test_the_protocol_has_its_sections():
    for heading in (
        "## The loop", "## First connection day: checklist", "## Produce the report", "## The connection check",
        "## Reading a report", "## What never to paste", "## When the web app is down", "## Message template to Claude",
        "## How a fix comes back",
    ):
        assert heading in DOC, heading


def test_the_scripts_and_labels_it_names_exist():
    assert (ROOT / "scripts" / "collect-diagnostics.ps1").is_file() and "scripts\\collect-diagnostics.ps1" in DOC
    for label in ("Build report", "Hide host names and addresses", "Address key", "Download .txt"):
        assert label in DOC and label in PAGE, label
    assert "Copy part" in DOC and "Copy part" in PAGE


def test_the_report_markers_it_describes_are_the_ones_the_code_writes():
    redact = (ROOT / "backend" / "dcdash" / "diagnostics" / "redact.py").read_text(encoding="utf-8")
    script = (ROOT / "scripts" / "collect-diagnostics.ps1").read_text(encoding="utf-8")
    for marker in ("DCDASH-REPORT v1", "END OF REPORT"):
        assert marker in DOC and marker in redact, marker
    assert "END OF DIAGNOSTICS" in DOC and "END OF DIAGNOSTICS" in script
    assert "LATEST CHECK" in DOC and "LATEST CHECK" in (ROOT / "backend" / "dcdash" / "diagnostics" / "report.py").read_text(encoding="utf-8")


def test_the_readme_links_to_it():
    assert "docs/field-debugging.md" in README
