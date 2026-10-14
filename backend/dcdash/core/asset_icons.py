"""The icons an asset can be given (`assets.icon`): which ids exist and how an incoming value is checked.

The database stores whatever was last written (NULL = Automatic, the icon follows the asset's kind), so the list can grow
without a migration. The front end keeps the same list in order (frontend/src/lib/assetIcons.ts);
backend/tests/test_asset_icons_parity.py fails when they drift apart.
"""

from typing import Annotated

from pydantic import BeforeValidator

# The order of the picker. The ids are stable and independent of the front end's drawing names.
ICONS = (
    "site", "building", "room", "row", "rack", "panel", "meter", "circuit", "ups", "battery", "pdu", "generator",
    "transformer", "fueltank", "chiller", "crac", "fan", "pump", "server", "switch", "controller", "sensor",
    "lighting", "camera", "door", "fire", "leak", "generic",
)
MAX_LENGTH = 32


def check_icon(value: object) -> object:
    """`value` unchanged when it is a listed id; anything else (a number, a list, another case, a lookalike) is refused.

    Runs before any type coercion. `None` (Automatic) is not handled here: the field type allows it separately.
    """
    if isinstance(value, str) and value in ICONS:
        return value
    raise ValueError("unknown icon")


AssetIcon = Annotated[str, BeforeValidator(check_icon)]
# The same check, named for the registry: a kind always has an icon, so its fields never add `| None` (Automatic is for assets).
KindIcon = Annotated[str, BeforeValidator(check_icon)]
