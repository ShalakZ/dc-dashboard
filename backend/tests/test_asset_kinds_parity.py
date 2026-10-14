"""The kind rules live twice, in TypeScript (frontend/src/lib/kinds.ts and kindIcon.ts, which draw the screen) and in Python
(`dcdash.core.asset_kinds.kind_key` and the copy of the keyword matcher frozen inside migration 0010, which seeds the
registry). Python cannot run TypeScript, so both languages are held to ONE file of answers, `fixtures/kind_samples.json`,
whose rows were produced by RUNNING the TypeScript; frontend/src/lib/kindSamples.test.ts asserts the same rows. A wrong row
fails exactly one of the two tests.

Never edit the migration to follow a later change of kindIcon.ts: a wave that changes the matcher updates the rows here and
in the vitest file (or marks them "as of 0010"); the migration is frozen history."""

import importlib.util
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from dcdash.core.asset_icons import ICONS
from dcdash.core.asset_kinds import MAX_NAME, clean_kind_name, kind_key

HERE = Path(__file__).resolve().parent
SAMPLES_FILE = HERE / "fixtures" / "kind_samples.json"
MIGRATION_FILE = HERE.parent / "migrations" / "versions" / "0010_asset_kinds.py"

SAMPLES = json.loads(SAMPLES_FILE.read_text(encoding="ascii"))
EMOJI = "\U0001F600"

# Rows nobody may thin out silently: the brief's names, the starters and the default kind, and every trap row of plan decision 11.
REQUIRED_KINDS = [
    "DC", "LV_Panel", "LV Panel", "UPS", "Battery", "CRAC", "Fan", "Pump", "Sensor", "Pump Control Panel", "Cooling Pump",
    "Fuel Transfer Pump",
    "Site", "Building", "Room", "Row", "Rack", "Panel", "Meter", "Circuit", "Other equipment", "generic",
    "  LV   Panel ", " rack ", "RACK", "Rack\u00a0", "\ufeffRack", "Pump\u00a0Room", "Pump\u3000Room", "Cooling\tPump",
    "\u00c9clair", "E\u0301clair", "\u0391\u03a3", "mIxEd CaSe",
    "UPS\u0663", "Rack\uff11", "Pump\u0e53", EMOJI * 100 + " pump", "LVPanel", "lvpanel", "UPSRoom", "PDUs", "PDUS", "DC1", "12Rack",
    "Transfer Switches", "data centres", "Distribution Unit", "\u0130stanbul Room", "ups_room",
    "Pump\u0085Room", "Pump\u001cRoom", "\u200b",
]


def load_migration():
    # The file name starts with a digit, so it cannot be imported by name.
    spec = importlib.util.spec_from_file_location("migration_0010_asset_kinds", MIGRATION_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MIGRATION = load_migration()


def shown(kind: str) -> str:
    return ascii(kind) if len(kind) < 40 else f"{ascii(kind[:12])}...len{len(kind)}"


ROWS = [pytest.param(row, id=f"{n:02d}-{shown(row['kind'])}") for n, row in enumerate(SAMPLES)]


def test_the_sample_file_is_pure_ascii_with_escapes_and_has_every_required_row():
    text = SAMPLES_FILE.read_text(encoding="ascii")  # raises on a literal invisible character
    assert text.isascii()
    # W7o: a row whose TypeScript answer moved on carries `now` (the id the front end gives today); `icon` stays what the frozen 0010 copy answers.
    assert all(set(row) in ({"kind", "key", "icon"}, {"kind", "key", "icon", "now"}) for row in SAMPLES)
    assert all(row["now"] in ICONS and row["now"] != row["icon"] for row in SAMPLES if "now" in row)
    kinds = [row["kind"] for row in SAMPLES]
    assert len(kinds) == len(set(kinds)), "a kind appears twice"
    assert [kind for kind in REQUIRED_KINDS if kind not in kinds] == []
    assert {row["icon"] for row in SAMPLES} <= set(ICONS)


@pytest.mark.parametrize("row", ROWS)
def test_the_migrations_matcher_gives_the_icon_the_typescript_gave(row):
    assert MIGRATION.suggest_icon(row["kind"]) == row["icon"]


@pytest.mark.parametrize("row", ROWS)
def test_kind_key_gives_the_key_the_typescript_gave_and_the_migrations_copy_agrees(row):
    assert kind_key(row["kind"]) == row["key"]
    assert MIGRATION.kind_key(row["kind"]) == row["key"]
    assert kind_key(row["key"]) == row["key"]  # a key is its own key


def test_the_matcher_table_names_only_catalogue_icons():
    assert {icon for icon, _ in MIGRATION.TABLE} <= set(ICONS)
    assert MIGRATION.suggest_icon("") == "generic"


def test_the_migration_copy_of_the_clean_text_rule_leaves_single_plain_spaces():
    assert MIGRATION.clean_kind("\t Cooling \n\u00a0 Pump\ufeff ") == "Cooling Pump"
    assert MIGRATION.clean_kind("   ") == ""


# ---- the name a person types --------------------------------------------------------------------------------------------

def test_a_kind_name_is_stored_the_way_the_front_end_cleans_it():
    assert clean_kind_name("  Rack   Room ") == "Rack Room"
    assert clean_kind_name("\ufeffRack\u00a0") == "Rack"  # a BOM or a no-break space at an edge is white space, not part of the name
    assert clean_kind_name("Cooling\tPump") == "Cooling Pump"
    assert clean_kind_name("Pump\u3000Room") == "Pump Room"
    assert clean_kind_name("E\u0301clair") == "\u00c9clair"  # NFC
    assert kind_key(clean_kind_name(" RACK ")) == kind_key("rack")


@pytest.mark.parametrize("raw", ["", "   ", "\ufeff\u00a0\u3000", "\t\n"])
def test_a_name_that_is_only_white_space_is_refused(raw):
    with pytest.raises(HTTPException) as refused:
        clean_kind_name(raw)
    assert (refused.value.status_code, refused.value.detail) == (422, "A kind needs a name")


def test_the_limit_is_sixty_characters_counted_as_code_points():
    assert clean_kind_name("x" * MAX_NAME) == "x" * MAX_NAME
    assert clean_kind_name(EMOJI * MAX_NAME) == EMOJI * MAX_NAME  # 120 UTF-16 units, 60 characters
    for too_long in ("x" * (MAX_NAME + 1), EMOJI * (MAX_NAME + 1), " " + "x" * (MAX_NAME + 1)):
        with pytest.raises(HTTPException) as refused:
            clean_kind_name(too_long)
        assert (refused.value.status_code, refused.value.detail) == (422, "A kind name is at most 60 characters")


@pytest.mark.parametrize("raw", ["\u200b", "Rack\u200bRoom", "Rack\u0000", "Rack\u0007", "\u202eRack", "Rack\u0301\ufe0f", "\u3164"])
def test_a_name_with_invisible_or_control_characters_is_refused(raw):
    with pytest.raises(HTTPException) as refused:
        clean_kind_name(raw)
    assert refused.value.status_code == 422
    assert refused.value.detail.startswith("A kind name cannot contain")
