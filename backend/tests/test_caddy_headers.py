"""The web container sends security headers from one shared Caddy snippet, imported in EVERY site block of both Caddyfiles.

Static checks on the files in the repository (no Docker, no Caddy): which headers the snippet sets, that the Content-Security-Policy
is Report-Only and keeps `script-src 'self'` strict, that both Caddyfiles import the snippet in each of their site blocks (the
`:80` redirect block of Caddyfile.tls included, so the redirect carries the headers too) and again inside each block's
`handle_errors` (Caddy's own error answer, such as the 502 while the api restarts, would carry none otherwise), and that the
Dockerfile copies the snippet to the path the Caddyfiles import. frontend/e2e/headers.spec.ts and scripts/check_tls.sh check the real responses.
Also here: both files open with one global options block that keeps the admin API requests (the web healthcheck polls them every few
seconds) out of Caddy's default (runtime) log, where the admin API writes them (not an access log).
And the static-file handles (W7i): hashed files under /assets/ are compressed and cached for a year, everything else (index.html, the
un-hashed theme-init.js, the SPA routes) is compressed and revalidated, the API route is never compressed (the SSE stream must not be
buffered) and every error answer is `no-store` (a stale chunk's 404 must never carry the year of cache the handle before it set).
frontend/e2e/headers.spec.ts and scripts/check_web.sh check the real responses.
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


def handle_errors_bodies(text: str) -> list[tuple[str, list[str] | None]]:
    """(address, the lines directly inside the site block's `handle_errors { ... }`, None when it has none) for every site block."""
    found: list[tuple[str, list[str] | None]] = []
    depth = 0
    address, body, collecting = "", None, False
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if depth == 0 and line.endswith("{") and line != "{":
            address, body, collecting = line[:-1].strip(), None, False
        elif depth == 1 and line == "handle_errors {":
            body, collecting = [], True
        elif depth == 2 and collecting:
            if line == "}":
                collecting = False
            else:
                body.append(line)
        depth += line.count("{") - line.count("}")
        if depth == 0 and address:
            found.append((address, body))
            address = ""
    assert depth == 0, "unbalanced braces"
    return found


def global_blocks(text: str) -> list[list[str]]:
    """The lines (nested ones included) of every global options block, a bare `{` at the top level, in file order."""
    found: list[list[str]] = []
    depth = 0
    body: list[str] | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if depth == 0 and line == "{":
            body = []
        elif body is not None and depth >= 1 and not (depth == 1 and line == "}"):
            body.append(line)
        depth += line.count("{") - line.count("}")
        if depth == 0 and body is not None:
            found.append(body)
            body = None
    assert depth == 0, "unbalanced braces"
    return found


def child_blocks(text: str, address: str) -> list[tuple[str, list[str]]]:
    """(the opening line without its brace, every line inside it, nested ones included) for each block written directly inside
    the site block `address`, in file order. `handle_errors { ... }` counts like any other."""
    found: list[tuple[str, list[str]]] = []
    depth = 0
    in_site = False
    current: tuple[str, list[str]] | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if depth == 0 and line.endswith("{") and line != "{":
            in_site = line[:-1].strip() == address
        elif in_site and depth == 1 and line.endswith("{"):
            current = (line[:-1].strip(), [])
        elif current is not None and depth >= 2 and not (depth == 2 and line == "}"):
            current[1].append(line)
        depth += line.count("{") - line.count("}")
        if depth == 1 and current is not None:
            found.append(current)
            current = None
        if depth == 0:
            in_site = False
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
def test_every_site_block_answers_its_own_errors_with_the_headers(name):
    # `header` runs only when the next handler writes; an error that reverse_proxy returns (502 while the api restarts) never
    # does, so Caddy's own error answer needs the snippet again inside `handle_errors`
    found = handle_errors_bodies((ROOT / "deploy" / name).read_text())
    assert [address for address, _ in found] == CADDYFILES[name]
    for address, body in found:
        assert body is not None, f"{name}: the {address} block has no handle_errors"
        assert f"import {IMPORT_PATH}" in body, f"{name}: the {address} handle_errors does not import the snippet"
        assert any(line.startswith("respond ") for line in body), f"{name}: the {address} handle_errors answers nothing"


@pytest.mark.parametrize("name", list(CADDYFILES))
def test_the_import_appears_only_at_the_site_level_and_in_handle_errors(name):
    # inside a handle block it would cover only that route; the redirect and the static files must carry the headers too
    text = (ROOT / "deploy" / name).read_text()
    site_level = sum(f"import {IMPORT_PATH}" in directives for _, directives in blocks(text))
    in_errors = sum(body is not None and f"import {IMPORT_PATH}" in body for _, body in handle_errors_bodies(text))
    every_import = len([line for line in text.splitlines() if line.strip().startswith("import ")])
    assert site_level == in_errors == len(CADDYFILES[name])
    assert every_import == site_level + in_errors


@pytest.mark.parametrize("name", list(CADDYFILES))
def test_the_global_options_block_keeps_the_admin_api_out_of_the_access_log(name):
    # The web healthcheck polls 127.0.0.1:2019 every few seconds; each poll is an `admin.api` "received request" line in
    # `docker compose logs web` that buries everything else (found on the first real install, W8c). It is the default (runtime) log of
    # the admin API, not an access log.
    text = (ROOT / "deploy" / name).read_text()
    first = next(line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#"))
    assert first == "{", f"{name}: the global options block must come first (Caddy rejects it anywhere else)"
    found = global_blocks(text)
    assert len(found) == 1, f"{name}: exactly one global options block"
    body = found[0]
    assert "log {" in body and "exclude admin.api" in body, body
    assert body.index("log {") < body.index("exclude admin.api")
    if name == "Caddyfile.tls":
        assert "auto_https off" in body  # the TLS file's existing option stays in the same block


def test_the_web_healthcheck_still_polls_the_admin_api_which_is_why_it_is_excluded_from_the_log():
    compose = (ROOT / "compose.yaml").read_text()
    web = compose[compose.index("\n  web:"):]
    assert "http://127.0.0.1:2019/config/" in web


# ---- the static files: compression and cache headers (W7i) ------------------------------------------------------------

# Where each Caddyfile serves /srv (the TLS file's :80 block only redirects), and what the two static handles must contain.
STATIC_SITE = {"Caddyfile": ":80", "Caddyfile.tls": ":443"}
HASHED_MATCHER = r"@hashed path_regexp hashed ^/assets/[^/]+\.(js|css|woff2?|svg|png|jpe?g|webp|ico)$"
HASHED_HANDLE = [
    "root * /srv",
    'header Cache-Control "public, max-age=31536000, immutable"',
    "encode zstd gzip",
    "file_server",  # no try_files: a hashed file that is gone is a real 404, never index.html with a year of cache
]
SHELL_HANDLE = [
    "root * /srv",
    'header Cache-Control "no-cache"',
    "encode zstd gzip",
    "try_files {path} /index.html",
    "file_server",
]


def site_text(name: str) -> str:
    return (ROOT / "deploy" / name).read_text()


@pytest.mark.parametrize("name", list(STATIC_SITE))
def test_the_static_files_have_a_hashed_handle_and_a_revalidating_shell_handle_in_this_order(name):
    site = STATIC_SITE[name]
    text = site_text(name)
    directives = dict(blocks(text))[site]
    assert HASHED_MATCHER in directives, f"{name}: the {site} block lacks the @hashed matcher"
    handles = [(opening, body) for opening, body in child_blocks(text, site) if opening == "handle" or opening.startswith("handle ")]
    assert [opening for opening, _ in handles] == ["handle /api/*", "handle @hashed", "handle"]
    assert handles[1][1] == HASHED_HANDLE
    assert handles[2][1] == SHELL_HANDLE


def test_both_caddyfiles_serve_the_static_files_the_same_way():
    parts = []
    for name, site in STATIC_SITE.items():
        text = site_text(name)
        matcher = [line for line in dict(blocks(text))[site] if line.startswith("@hashed ")]
        handles = [body for opening, body in child_blocks(text, site) if opening in ("handle @hashed", "handle")]
        parts.append((matcher, handles))
    assert parts[0] == parts[1]
    assert len(parts[0][0]) == 1 and len(parts[0][1]) == 2


def test_the_hashed_matcher_keys_on_the_extension_so_the_spa_routes_under_assets_still_get_the_shell():
    # /assets is the Assets Tree page and /assets/<id> an asset's page: same prefix as the hashed files, but no extension
    pattern = HASHED_MATCHER.split()[-1]
    for path in ("/assets/index-DXBCBP4n.js", "/assets/index-BufBEXK1.css", "/assets/font-1.woff2", "/assets/logo.svg", "/assets/nope.js"):
        assert re.search(pattern, path), path
    for path in ("/assets", "/assets/", "/assets/4", "/assets/4/edit", "/", "/theme-init.js", "/favicon.ico", "/assets/a/b.js", "/api/assets/1.js"):
        assert not re.search(pattern, path), path


@pytest.mark.parametrize("name", list(STATIC_SITE))
def test_encode_never_touches_the_api_route(name):
    # /api/stream is a Server-Sent Events stream (`flush_interval -1`): an encoder in front of it would buffer it
    text = site_text(name)
    api = [body for opening, body in child_blocks(text, STATIC_SITE[name]) if opening == "handle /api/*"]
    assert len(api) == 1, f"{name}: one API route"
    assert not any(line.split()[0] == "encode" for line in api[0] if line.split()), api[0]
    assert "flush_interval -1" in api[0]
    # nor at the site level, where it would wrap every route, the API included
    assert not any(line.split()[0] == "encode" for _, directives in blocks(text) for line in directives)


@pytest.mark.parametrize("name", list(CADDYFILES))
def test_every_error_answer_is_never_cached(name):
    # `header` inside a `handle` runs before file_server, on the same response writer: without this, the 404 of a stale hashed chunk
    # would go out with the `immutable` the handle set. It also keeps a cache from storing the 502 page of a restarting api.
    for address, body in handle_errors_bodies(site_text(name)):
        assert body is not None, f"{name}: the {address} block has no handle_errors"
        assert 'header Cache-Control "no-store"' in body, f"{name}: the {address} handle_errors does not send Cache-Control: no-store"
        order = [text.split()[0] for text in body]
        assert order.index("header") < order.index("respond"), f"{name}: the {address} handle_errors sets the header after it answers"


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
