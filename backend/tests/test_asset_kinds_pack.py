"""The built-in kind lists (W7q): the ten migration 0010 seeds, the 39-kind starter pack, the 16 common ones and the 49 keys the
API's `starter` flag is computed from. Pure data checks, no database: the API behaviour is in test_api_asset_kinds.py."""

import importlib.util
from pathlib import Path

from dcdash.core import asset_icons
from dcdash.core import asset_kinds as kinds_module
from dcdash.core.asset_kinds import (
    COMMON_NAMES,
    COMMON_PACK,
    MAX_NAME,
    SEEDED_STARTERS,
    STARTER_KEYS,
    STARTER_PACK,
    kind_key,
    pack_for,
)

MIGRATION_FILE = Path(__file__).resolve().parent.parent / "migrations" / "versions" / "0010_asset_kinds.py"
PACK_NAMES = [name for name, _icon in STARTER_PACK]
# The brief's 16, in the order the owner listed them (not the pack's order).
EXPECTED_COMMON = [
    "UPS", "Battery", "PDU", "RPP", "ATS", "STS", "Switchgear", "Transformer", "Generator", "Chiller", "CRAC", "Cooling tower",
    "Server", "Network switch", "Sensor", "Fire suppression",
]


def load_migration():
    # The file name starts with a digit, so it cannot be imported by name (as test_asset_kinds_parity.py does).
    spec = importlib.util.spec_from_file_location("migration_0010_asset_kinds_pack", MIGRATION_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_seeded_starters_are_the_ten_names_migration_0010_seeds_with_its_spelling():
    assert SEEDED_STARTERS == load_migration().STARTERS
    assert len(SEEDED_STARTERS) == 10
    assert len({kind_key(name) for name in SEEDED_STARTERS}) == 10


def test_the_starter_pack_is_39_distinct_kinds_with_listed_icons_and_none_that_migration_0010_seeds():
    keys = [kind_key(name) for name in PACK_NAMES]
    assert len(PACK_NAMES) == 39 and len(set(keys)) == 39
    assert set(keys).isdisjoint(kind_key(name) for name in SEEDED_STARTERS)
    assert all(icon in asset_icons.ICONS for _name, icon in STARTER_PACK)
    # Names are stored as written: already tidy and within the length a person may type.
    assert all(name == " ".join(name.split()) and 0 < len(name) <= MAX_NAME for name in PACK_NAMES)


def test_the_common_names_are_16_distinct_pack_kinds_and_the_common_pack_keeps_the_packs_order():
    assert list(COMMON_NAMES) == EXPECTED_COMMON
    assert len(COMMON_NAMES) == 16 and len({kind_key(name) for name in COMMON_NAMES}) == 16
    assert all(name in PACK_NAMES for name in COMMON_NAMES)
    assert [name for name, _icon in COMMON_PACK] == [name for name in PACK_NAMES if name in COMMON_NAMES]
    assert set(COMMON_PACK) <= set(STARTER_PACK)  # same icons as the full pack
    # Two presses at once (a common and an all) insert in ONE order: the relative order of the common kinds is the pack's.
    positions = [PACK_NAMES.index(name) for name, _icon in COMMON_PACK]
    assert positions == sorted(positions)


def test_the_starter_keys_are_the_49_keys_of_the_seeded_ten_and_the_pack():
    assert len(STARTER_KEYS) == 49
    assert STARTER_KEYS == {kind_key(name) for name in (*SEEDED_STARTERS, *PACK_NAMES)}
    assert "rack" in STARTER_KEYS and "ups" in STARTER_KEYS and "generic" in STARTER_KEYS
    assert "pump" in STARTER_KEYS and "server rack" not in STARTER_KEYS and "racks" not in STARTER_KEYS
    assert all(key == kind_key(key) for key in STARTER_KEYS)


def test_pack_for_gives_the_common_pack_by_default_and_the_whole_pack_for_all():
    assert pack_for("common") is COMMON_PACK
    assert pack_for("all") is STARTER_PACK
    assert kinds_module.pack_for("all") == STARTER_PACK
