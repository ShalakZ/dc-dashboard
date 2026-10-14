"""Asset kinds: when two kind texts are one kind, and what a person may type as a kind's name.

`assets.kind` is free text. The registry (`asset_kinds`, migration 0010) holds the kinds an administrator has set up, one row
per KEY, the normalised name: "Rack", " rack " and "RACK" are one kind. The key rule is the front end's `kindKey`
(frontend/src/lib/kinds.ts) computed here in Python, because SQL `lower()` depends on the database collation;
backend/tests/test_asset_kinds_parity.py holds both to one file of answers (tests/fixtures/kind_samples.json).

The built-in kinds, by name: SEEDED_STARTERS (the ten migration 0010 seeds), STARTER_PACK (the 39 data-centre kinds, with their
icons), COMMON_NAMES / COMMON_PACK (the 16 of them most sites have). STARTER_KEYS is the key of every one of the 49 and is what
the API's `starter` flag on a kind is computed from; pack_for picks the pack a press of the starter-pack route registers.
"""

import re
import unicodedata
from collections.abc import Mapping

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.models import AssetKind

MAX_NAME = 60  # characters (code points) of a name a person writes; a seeded name may be longer

# The data-centre starter kinds (W7o), as (name, icon id), in the order the pack adds them. One press of "Add all 39 data-centre kinds"
# (or of the common 16) registers the ones whose key is not in the registry yet; a kind that is there is never touched, whatever
# its spelling or icon.
# None of the ten kinds migration 0010 seeds is in it (site, building, room, row, rack, panel, meter, circuit, other equipment,
# generic), and every key is distinct: test_api_asset_kinds.py holds the list to both.
STARTER_PACK: tuple[tuple[str, str], ...] = (
    ("UPS", "ups"), ("Battery", "battery"), ("PDU", "pdu"), ("RPP", "rpp"), ("ATS", "ats"), ("STS", "sts"),
    ("Switchgear", "switchgear"), ("Busway", "busway"), ("Ring main unit", "rmu"), ("Transformer", "transformer"),
    ("Generator", "generator"), ("Fuel tank", "fueltank"),
    ("Chiller", "chiller"), ("CRAC", "crac"), ("Air handling unit", "ahu"), ("Cooling distribution unit", "cdu"),
    ("Cooling tower", "coolingtower"), ("Dry cooler", "drycooler"), ("Heat exchanger", "heatexchanger"), ("Pump", "pump"),
    ("Fan", "fan"), ("Valve", "valve"), ("Variable frequency drive", "vfd"),
    ("Server", "server"), ("Network switch", "switch"), ("Router", "router"), ("Firewall", "firewall"),
    ("Patch panel", "patchpanel"), ("Cable tray", "cabletray"), ("Data hall", "hall"),
    ("Controller", "controller"), ("Sensor", "sensor"), ("Smoke detector", "smokedetector"), ("Humidity sensor", "humidity"),
    ("Fire suppression", "fire"), ("Leak detector", "leak"), ("Camera", "camera"), ("Door", "door"), ("Lighting", "lighting"),
)

# The ten names migration 0010 seeds (its `STARTERS`, same spelling), copied here because the migration is frozen history and an
# application module must not import it; backend/tests/test_asset_kinds_pack.py imports the migration and holds the two equal.
SEEDED_STARTERS: tuple[str, ...] = (
    "Site", "Building", "Room", "Row", "Rack", "Panel", "Meter", "Circuit", "Other equipment", "generic",
)

# The 16 kinds most data centres have (W7q): what the "Add common data-centre kinds" button registers. Each is in STARTER_PACK.
COMMON_NAMES: tuple[str, ...] = (
    "UPS", "Battery", "PDU", "RPP", "ATS", "STS", "Switchgear", "Transformer", "Generator", "Chiller", "CRAC", "Cooling tower",
    "Server", "Network switch", "Sensor", "Fire suppression",
)

# The common kinds in STARTER_PACK's order, not in COMMON_NAMES' order: every press inserts its kinds one by one, and two presses
# at once (a common one and an "all" one) wait on each other's uncommitted rows only if they take the same keys in different
# orders. Both walk the pack's order, so the second always waits behind the first and neither can wait for the other in a circle.
COMMON_PACK: tuple[tuple[str, str], ...] = tuple((name, icon) for name, icon in STARTER_PACK if name in COMMON_NAMES)

def pack_for(set_name: str) -> tuple[tuple[str, str], ...]:
    """The pack a press of the starter-pack route registers: 'common' (the 16) or 'all' (the 39)."""
    return STARTER_PACK if set_name == "all" else COMMON_PACK

# ECMAScript white space, spelled out: it is what JavaScript's trim() and \s remove. Python's str.split() and \s differ (they
# treat U+001C to U+001F and U+0085 as white space and U+FEFF as a letter), so neither may stand in for this class.
_BLANKS = re.compile(r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")


def kind_key(text: str) -> str:
    """The comparison key of a kind text: Unicode NFC, every run of white space one plain space, none at the ends, lower case."""
    return _BLANKS.sub(" ", unicodedata.normalize("NFC", text)).strip(" ").lower()


# The keys that make a registry kind a "starter" (W7q): the ten seeded kinds plus the whole pack, 49 keys. The test is by KEY, never
# by name, because the registry keeps the spelling the assets used (" rack " is the starter Rack) and a rename moves the key.
STARTER_KEYS: frozenset[str] = frozenset(kind_key(name) for name in (*SEEDED_STARTERS, *(name for name, _icon in STARTER_PACK)))


def clean_kind_name(raw: str) -> str:
    """The name to store for a kind a person typed: NFC, white space tidied the way the front end's cleanKind does it, 1 to
    MAX_NAME characters, nothing invisible or unprintable in it. 422 with a plain sentence otherwise."""
    # Imported here: api.roles pulls in the whole API layer, which importing this module (the migration test does) must not.
    from dcdash.api.roles import refuse_unseen_characters

    name = _BLANKS.sub(" ", unicodedata.normalize("NFC", raw)).strip(" ")
    if not name:
        raise HTTPException(422, "A kind needs a name")
    if len(name) > MAX_NAME:
        raise HTTPException(422, f"A kind name is at most {MAX_NAME} characters")
    refuse_unseen_characters(name, "A kind name")
    return name


async def kind_icons(db: AsyncSession) -> dict[str, str]:
    """The whole registry as key -> icon: one query, however many assets a response then holds."""
    return {key: icon for key, icon in (await db.execute(select(AssetKind.key, AssetKind.icon))).all()}


def icon_for(kind: str, icons: Mapping[str, str], cache: dict[str, str | None]) -> str | None:
    """The icon of the registry kind that `kind` (an asset's free text) names, None when none does. `cache` is one response's
    own dict: a site has a handful of kinds and thousands of assets, so each distinct text is normalised once."""
    if kind not in cache:
        cache[kind] = icons.get(kind_key(kind))
    return cache[kind]
