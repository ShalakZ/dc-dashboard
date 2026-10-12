"""The appearance lists live in three places: the server (dcdash.core.preferences), the front end (src/lib/appearance.ts) and the
first-paint script (public/theme-init.js, plain ES5, which cannot import anything). This test fails when they drift apart."""

import re
from pathlib import Path

from dcdash.core.preferences import DEFAULTS, MODES, THEMES

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
APPEARANCE_TS = (FRONTEND / "src" / "lib" / "appearance.ts").read_text(encoding="utf-8")
THEME_INIT_JS = (FRONTEND / "public" / "theme-init.js").read_text(encoding="utf-8")
INDEX_HTML = (FRONTEND / "index.html").read_text(encoding="utf-8")


def quoted(text: str) -> tuple[str, ...]:
    return tuple(re.findall(r'"([^"]+)"', text))


def test_modes_match_in_the_front_end_and_the_first_paint_script():
    ts = re.search(r"export const MODES = \[([^\]]*)\]", APPEARANCE_TS)
    js = re.search(r"var MODES = \[([^\]]*)\]", THEME_INIT_JS)
    assert ts and js
    assert quoted(ts.group(1)) == MODES
    assert quoted(js.group(1)) == MODES


def test_themes_match_in_the_front_end_and_the_first_paint_script():
    ts = re.search(r"export const THEMES\b.*?= \[(.*?)\n\];", APPEARANCE_TS, re.S)
    js = re.search(r"var THEMES = \[([^\]]*)\]", THEME_INIT_JS)
    assert ts and js
    assert tuple(re.findall(r'\bid: "([^"]+)"', ts.group(1))) == THEMES
    assert quoted(js.group(1)) == THEMES


def test_defaults_match_everywhere():
    ts = re.search(r'DEFAULT_APPEARANCE: Appearance = \{ mode: "([^"]+)", theme: "([^"]+)" \}', APPEARANCE_TS)
    assert ts
    assert {"mode": ts.group(1), "theme": ts.group(2)} == DEFAULTS
    js_mode = re.search(r'var DEFAULT_MODE = "([^"]+)"', THEME_INIT_JS)
    js_theme = re.search(r'var DEFAULT_THEME = "([^"]+)"', THEME_INIT_JS)
    assert js_mode and js_theme
    assert {"mode": js_mode.group(1), "theme": js_theme.group(1)} == DEFAULTS
    html = re.search(r'<html [^>]*data-mode="([^"]+)" data-theme="([^"]+)"', INDEX_HTML)
    assert html
    assert {"mode": html.group(1), "theme": html.group(2)} == DEFAULTS


def test_the_mirror_key_matches():
    ts = re.search(r'export const MIRROR_KEY = "([^"]+)"', APPEARANCE_TS)
    js = re.search(r'var MIRROR_KEY = "([^"]+)"', THEME_INIT_JS)
    assert ts and js
    assert ts.group(1) == js.group(1)
