"""The per-account appearance choice (`users.preferences`): which values exist and how stored text becomes a valid choice.

The front end keeps the same lists (frontend/src/lib/appearance.ts and public/theme-init.js); backend/tests/test_preferences_parity.py
fails when they drift apart.
"""

MODES = ("light", "dark", "system")
THEMES = ("navy-gold", "maroon-gold", "graphite", "desert-gold")
DEFAULTS = {"mode": "light", "theme": "navy-gold"}

_CHOICES = {"mode": MODES, "theme": THEMES}


def normalize(stored: object) -> dict[str, str]:
    """Exactly the two keys, each a valid value: anything missing, unknown, mistyped or from the wrong list becomes the default.

    The type is checked before the membership so a stored list or object cannot raise; this never raises.
    """
    source = stored if isinstance(stored, dict) else {}
    result = {}
    for key, allowed in _CHOICES.items():
        value = source.get(key)
        result[key] = value if isinstance(value, str) and value in allowed else DEFAULTS[key]
    return result
