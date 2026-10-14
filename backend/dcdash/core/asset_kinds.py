"""Asset kinds: when two kind texts are one kind, and what a person may type as a kind's name.

`assets.kind` is free text. The registry (`asset_kinds`, migration 0010) holds the kinds an administrator has set up, one row
per KEY, the normalised name: "Rack", " rack " and "RACK" are one kind. The key rule is the front end's `kindKey`
(frontend/src/lib/kinds.ts) computed here in Python, because SQL `lower()` depends on the database collation;
backend/tests/test_asset_kinds_parity.py holds both to one file of answers (tests/fixtures/kind_samples.json).
"""

import re
import unicodedata
from collections.abc import Mapping

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.models import AssetKind

MAX_NAME = 60  # characters (code points) of a name a person writes; a seeded name may be longer

# ECMAScript white space, spelled out: it is what JavaScript's trim() and \s remove. Python's str.split() and \s differ (they
# treat U+001C to U+001F and U+0085 as white space and U+FEFF as a letter), so neither may stand in for this class.
_BLANKS = re.compile(r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")


def kind_key(text: str) -> str:
    """The comparison key of a kind text: Unicode NFC, every run of white space one plain space, none at the ends, lower case."""
    return _BLANKS.sub(" ", unicodedata.normalize("NFC", text)).strip(" ").lower()


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
