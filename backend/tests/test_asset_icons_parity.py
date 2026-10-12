"""The icon list lives on the server (dcdash.core.asset_icons) and in the front end (src/lib/assetIcons.ts, with the drawings
in src/components/Icon.tsx). This test fails when the ids, their order, or the drawing each one names drift apart."""

import re
from pathlib import Path

from dcdash.core.asset_icons import ICONS, MAX_LENGTH

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
ASSET_ICONS_TS = (FRONTEND / "src" / "lib" / "assetIcons.ts").read_text(encoding="utf-8")
ICON_TSX = (FRONTEND / "src" / "components" / "Icon.tsx").read_text(encoding="utf-8")


def catalogue() -> str:
    match = re.search(r"export const ASSET_ICONS\b.*?= \[(.*?)\n\];", ASSET_ICONS_TS, re.S)
    assert match, "ASSET_ICONS array not found in assetIcons.ts"
    return match.group(1)


def drawings() -> set[str]:
    match = re.search(r"export const ICONS = \{(.*?)\n\} satisfies", ICON_TSX, re.S)
    assert match, "ICONS object not found in Icon.tsx"
    return set(re.findall(r"^  (\w+): ", match.group(1), re.M))


def test_the_ids_and_their_order_match():
    assert tuple(re.findall(r'\bid: "([^"]+)"', catalogue())) == ICONS


def test_every_entry_names_a_drawing_that_exists_and_no_two_share_one():
    named = re.findall(r'\bicon: "([^"]+)"', catalogue())
    assert len(named) == len(ICONS)
    assert len(set(named)) == len(named)
    assert set(named) <= drawings()
    assert all(name.startswith("kind") for name in named)


def test_every_kind_drawing_is_in_the_catalogue():
    named = set(re.findall(r'\bicon: "([^"]+)"', catalogue()))
    assert {name for name in drawings() if name.startswith("kind")} == named


def test_every_entry_has_a_label():
    labels = re.findall(r'\blabel: "([^"]+)"', catalogue())
    assert len(labels) == len(ICONS)
    assert len(set(labels)) == len(labels)


def test_the_ids_fit_the_stored_length():
    assert all(len(icon) <= MAX_LENGTH for icon in ICONS)
