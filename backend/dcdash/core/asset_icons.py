"""The icons an asset can be given (`assets.icon`): which ids exist and how an incoming value is checked.

The database stores whatever was last written (NULL = Automatic, the icon follows the asset's kind), so the list can grow
without a migration. The front end keeps the same list in order (frontend/src/lib/assetIcons.ts);
backend/tests/test_asset_icons_parity.py fails when they drift apart.
"""

from typing import Annotated

from pydantic import BeforeValidator

# The order of the picker, which lists the icons in these six groups (the front end holds the group names and the search words, which the
# server never needs: it stores ids). The ids are stable and independent of the front end's drawing names. 28 of them were stored before
# the data-centre pack (W7o) and are never renamed or removed; the pack added 20 and moved the whole list into groups.
ICONS = (
    # Structure
    "site", "building", "hall", "room", "row", "rack",
    # Power
    "panel", "meter", "circuit", "ups", "battery", "pdu", "rpp", "ats", "sts", "busway", "switchgear", "rmu", "transformer", "generator", "fueltank",
    # Cooling
    "chiller", "crac", "ahu", "cdu", "coolingtower", "drycooler", "heatexchanger", "fan", "pump", "valve", "vfd",
    # IT and network
    "server", "switch", "router", "firewall", "patchpanel", "cabletray",
    # Monitoring and safety
    "controller", "sensor", "smokedetector", "humidity", "leak", "fire", "camera", "door",
    # Other
    "lighting", "generic",
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
