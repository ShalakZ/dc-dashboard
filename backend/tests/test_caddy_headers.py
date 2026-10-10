"""The web container sends security headers from one shared Caddy snippet, imported in EVERY site block of both Caddyfiles.

Static checks on the files in the repository (no Docker, no Caddy): which headers the snippet sets, that the Content-Security-Policy
is Report-Only and keeps `script-src 'self'` strict, that both Caddyfiles import the snippet in each of their site blocks (the
`:80` redirect block of Caddyfile.tls included, so the redirect carries the headers too), and that the Dockerfile copies the
snippet to the path the Caddyfiles import. frontend/e2e/headers.spec.ts and scripts/check_tls.sh check the real responses.
"""
import re
import shlex
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SNIPPET = ROOT / "deploy" / "security-headers.caddy"
CADDYFILES = {"Caddyfile": [":80"], "Caddyfile.tls": [":80", ":443"]}
IMPORT_PATH = "/etc/caddy/security-headers.caddy"

HEADERS = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
}
CSP_HEADER = "content-security-policy-report-only"


def blocks(text: str) -> list[tuple[str, list[str]]]:
    """(address, the directives written directly inside the block) for every site block of a Caddyfile.

    The Caddyfiles here are one directive per line, braces last on their line; the global options block has no address and is skipped.
    A directive that opens a nested block counts by its first line (`handle /api/* {`), and nested content is not listed.
    """
    found: list[tuple[str, list[str]]] = []
    depth = 0
    address, directives = "", []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if depth == 0 and line.endswith("{") and line != "{":
            address, directives = line[:-1].strip(), []
        elif depth == 1 and address and line != "}":
            directives.append(line)
        depth += line.count("{") - line.count("}")
        if depth == 0 and address:  # the closing brace of a site block
            found.append((address, directives))
            address = ""
    assert depth == 0, "unbalanced braces"
    return found


def snippet_header_block() -> list[list[str]]:
    """The lines of the single `header { ... }` block of the snippet, each split the way Caddy reads it (quotes honoured)."""
    lines = [line.strip() for line in SNIPPET.read_text().splitlines() if line.strip() and not line.strip().startswith("#")]
    assert lines[0] == "header {" and lines[-1] == "}", "the snippet is one `header { ... }` block"
    return [shlex.split(line) for line in lines[1:-1]]


def snippet_fields() -> dict[str, str | None]:
    """Field name (lower case; `-Server` keeps its minus) -> value, None for a removal."""
    fields: dict[str, str | None] = {}
    for tokens in snippet_header_block():
        name = tokens[0].lower()
        assert name not in fields, f"{tokens[0]} is set twice"
        fields[name] = " ".join(tokens[1:]) if len(tokens) > 1 else None
    return fields


def csp_directives() -> dict[str, list[str]]:
    value = snippet_fields()[CSP_HEADER]
    assert value
    directives: dict[str, list[str]] = {}
    for part in value.split(";"):
        tokens = part.split()
        if tokens:
            assert tokens[0] not in directives, f"{tokens[0]} appears twice in the policy"
            directives[tokens[0]] = tokens[1:]
    return directives


# ---- the snippet ------------------------------------------------------------------------------------------------------

def test_the_snippet_sets_exactly_the_four_headers_and_removes_server():
    fields = snippet_fields()
    assert set(fields) == {*HEADERS, CSP_HEADER, "-server"}
    for name, value in HEADERS.items():
        assert fields[name] == value
    assert fields["-server"] is None  # `-Server` removes the header (it would say `Caddy`, or `uvicorn` for a proxied answer)


def test_the_policy_is_report_only_on_purpose():
    # Enforcing waits for a browser pass over every page; until then a violation must only be written to the console.
    assert "content-security-policy" not in snippet_fields()
    assert CSP_HEADER in snippet_fields()


def test_script_src_is_strict():
    directives = csp_directives()
    assert directives["script-src"] == ["'self'"]
    for name in ("default-src", "script-src"):  # default-src applies to scripts too wherever script-src is missing
        assert "'unsafe-inline'" not in directives[name] and "'unsafe-eval'" not in directives[name], name
    # only style-src loosens: React and ECharts write `style` attributes
    assert "'unsafe-inline'" in directives["style-src"]
    unsafe = {name for name, sources in directives.items() if any(s in ("'unsafe-inline'", "'unsafe-eval'") for s in sources)}
    assert unsafe == {"style-src"}


def test_the_policy_closes_the_other_doors_and_names_no_report_route():
    directives = csp_directives()
    assert directives["default-src"] == ["'self'"]
    assert directives["object-src"] == ["'none'"]
    assert directives["base-uri"] == ["'self'"]
    assert directives["form-action"] == ["'self'"]
    assert directives["connect-src"] == ["'self'"]  # the SSE stream and the API are same-origin
    # no report route: it would be a new unauthenticated endpoint
    assert not {"report-uri", "report-to"} & set(directives)
    # left out on purpose: X-Frame-Options already forbids framing, and Chromium may log a console message for frame-ancestors
    # in a Report-Only header, which would fail the zero-violation walk in headers.spec.ts on every page
    assert "frame-ancestors" not in directives


# ---- the Caddyfiles ---------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("name", list(CADDYFILES))
def test_every_site_block_imports_the_snippet(name):
    found = blocks((ROOT / "deploy" / name).read_text())
    assert [address for address, _ in found] == CADDYFILES[name]
    for address, directives in found:
        assert f"import {IMPORT_PATH}" in directives, f"{name}: the {address} block does not import the snippet"


@pytest.mark.parametrize("name", list(CADDYFILES))
def test_the_import_appears_only_as_a_site_level_directive(name):
    # inside a handle block it would cover only that route; the redirect and the static files must carry the headers too
    lines = [line.strip() for line in (ROOT / "deploy" / name).read_text().splitlines()]
    assert len([line for line in lines if line.startswith("import ")]) == len(CADDYFILES[name])


# ---- the image --------------------------------------------------------------------------------------------------------

def test_the_dockerfile_copies_the_snippet_to_where_the_caddyfiles_import_it():
    copies = [
        line.split()
        for line in (ROOT / "frontend" / "Dockerfile").read_text().splitlines()
        if re.match(r"\s*COPY\s", line, re.IGNORECASE) and "security-headers.caddy" in line
    ]
    assert len(copies) == 1, copies
    args = [a for a in copies[0][1:] if not a.startswith("--")]
    assert args[0] == "deploy/security-headers.caddy"
    destination = args[-1]
    assert destination == IMPORT_PATH or (destination.endswith("/") and destination + "security-headers.caddy" == IMPORT_PATH)
    assert destination.startswith("/etc/caddy/")
