"""The permission catalogue: what an account may do, named once, here.

Every API route declares the permission it needs (dcdash.api.deps.require_permission); a role is a set of these ids. The
front end mirrors the ids and labels in frontend/src/lib/permissions.ts (backend/tests/test_permissions_parity.py fails
when the two drift apart). The list is the single source of truth: Admin is "every id in CATALOGUE", computed here at run
time, so a new permission is Admin's without a migration.

Viewer, Operator and Admin are built in and come from this file (BUILTIN), never from the `roles.permissions` column of
their rows, which is only a mirror for people who read the database. A custom role stores its ids in `roles.permissions`;
effective_permissions() ignores anything in it that is not a known id and never lets a custom role hold NOT_FOR_CUSTOM_ROLES.
"""
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal, NamedTuple

Kind = Literal["see", "change", "risky"]


@dataclass(frozen=True)
class Permission:
    id: str
    area: str
    kind: Kind
    label: str
    description: str


def _p(id: str, area: str, kind: Kind, label: str, description: str) -> Permission:
    return Permission(id, area, kind, label, description)


CATALOGUE: tuple[Permission, ...] = (
    _p("assets.view", "Assets Tree", "see", "See the Assets Tree",
       "Open the Assets Tree, an asset's details and charts, and the fleet summary."),
    _p("assets.edit", "Assets Tree", "change", "Change assets", "Add and edit assets, and map points to them."),
    _p("assets.delete", "Assets Tree", "risky", "Delete assets", "Delete an asset (its mappings go with it)."),
    _p("dashboards.view", "Dashboards", "see", "See dashboards",
       "Open dashboards and their widgets, receive live values, and read the values of any point through a widget."),
    _p("dashboards.edit", "Dashboards", "change", "Change dashboards", "Create, edit and delete dashboards and their widgets."),
    _p("dashboards.default", "Dashboards", "risky", "Choose the default dashboard", "Choose the dashboard everybody lands on."),
    _p("billing.view", "Billing and tariffs", "see", "See billing", "Open the Billing page: energy and cost per asset and month."),
    _p("billing.export", "Billing and tariffs", "risky", "Export billing as CSV", "Download the billing table as a CSV file."),
    _p("tariffs.view", "Billing and tariffs", "see", "See tariffs", "Read the tariff list."),
    _p("tariffs.edit", "Billing and tariffs", "change", "Change tariffs", "Set the currency, the site rate and per-asset rates."),
    _p("sources.view", "Sources and discovery", "see", "See sources",
       "Open the Sources page, a source's points and the collector status."),
    _p("sources.edit", "Sources and discovery", "change", "Change sources",
       "Add, edit and delete data sources and browse their points."),
    _p("sources.test", "Sources and discovery", "change", "Test source connections",
       "Make the server try to reach a source (Test and Test all)."),
    _p("discovery.view", "Sources and discovery", "see", "See scans and the graph", "Open the Scans and Discovery pages."),
    _p("discovery.edit", "Sources and discovery", "change", "Change scan scopes and the graph layout",
       "Add, edit and delete scan scopes; save the graph layout."),
    _p("discovery.scan", "Sources and discovery", "risky", "Run network scans", "Start a scan of a scope (it probes a network)."),
    _p("discovery.accept", "Sources and discovery", "risky", "Accept scan results",
       "Turn scan results into sources, assets and mappings."),
    _p("storage.view", "Storage and settings", "see", "See storage", "Open the Storage page."),
    _p("storage.edit", "Storage and settings", "change", "Change storage settings",
       "Change retention, compression and disk limits."),
    _p("settings.view", "Storage and settings", "see", "See settings", "Open the Settings page."),
    _p("settings.edit", "Storage and settings", "change", "Change settings", "Change the general settings, such as the time zone."),
    _p("settings.security", "Storage and settings", "risky", "Change sign-in protection",
       "Switch the brute-force protection on or off and change its limits."),
    _p("audit.view", "Audit log", "see", "See the audit log", "Open the audit log and its entries."),
    _p("audit.export", "Audit log", "risky", "Export the audit log", "Download the audit log as CSV."),
    _p("users.view", "Users", "see", "See users", "Open the Users page."),
    _p("users.edit", "Users", "change", "Change users",
       "Create, edit, deactivate and delete accounts; reset passwords; lift sign-in blocks."),
    _p("roles.manage", "Roles", "risky", "Manage roles", "Create, edit and delete roles. Only the built-in Admin role holds it."),
    _p("diagnostics.view", "Diagnostics", "see", "See diagnostics",
       "Open the Diagnostics page and build a report, which includes settings, retention, the audit tail and each source's "
       "security settings."),
    _p("diagnostics.run", "Diagnostics", "change", "Run the connection check",
       "Run the step-by-step connection check of a source."),
)

ALL_IDS: frozenset[str] = frozenset(p.id for p in CATALOGUE)

# Held by the built-in Admin role only: a custom role can never carry these, whatever its stored list says.
NOT_FOR_CUSTOM_ROLES: frozenset[str] = frozenset({"roles.manage"})

_VIEWER = frozenset({"assets.view", "dashboards.view", "billing.view", "billing.export"})
_OPERATOR = _VIEWER | {"dashboards.edit", "tariffs.view", "sources.view", "sources.test", "diagnostics.run", "discovery.view"}

BUILTIN: dict[str, frozenset[str]] = {"viewer": _VIEWER, "operator": _OPERATOR, "admin": ALL_IDS}

# The ids migration 0009 gives the built-in rows (and the order of the three).
BUILTIN_IDS: dict[str, int] = {"viewer": 1, "operator": 2, "admin": 3}


def effective_permissions(name: str, builtin: bool, stored: object) -> frozenset[str]:
    """What a role really grants. A built-in role comes from BUILTIN (an unknown built-in name grants nothing); a custom
    role grants the known ids in its stored list, minus NOT_FOR_CUSTOM_ROLES; anything that is not a list grants nothing."""
    if builtin:
        return BUILTIN.get(name, frozenset())
    if not isinstance(stored, list):
        return frozenset()
    return frozenset(item for item in stored if isinstance(item, str) and item in ALL_IDS) - NOT_FOR_CUSTOM_ROLES


def catalogue_order(ids: Iterable[str]) -> list[str]:
    """The known ids among `ids`, each once, in catalogue order (how a custom role's list is stored and shown)."""
    wanted = set(ids)
    return [p.id for p in CATALOGUE if p.id in wanted]


class CleanedIds(NamedTuple):
    """A requested permission list for a custom role, sorted into what the API must answer to each part of it."""

    ok: list[str]  # known, allowed, de-duplicated, in catalogue order: what may be stored
    unknown: list[str]  # not in the catalogue (or not text), each once, in the order given
    forbidden: list[str]  # NOT_FOR_CUSTOM_ROLES ids, each once, in the order given
    duplicates: list[str]  # allowed ids that were given more than once, each once, in the order given


def clean_custom(ids: Iterable[object]) -> CleanedIds:
    """Sort a requested permission list for a custom role into accepted, unknown, forbidden and repeated ids.

    A list with anything in unknown, forbidden or duplicates is refused by the API; ok is what a clean list would store.
    An item that is not text counts as unknown (shown as its text), so a raw JSON list can never raise here.
    """
    seen: set[str] = set()
    unknown: list[str] = []
    forbidden: list[str] = []
    duplicates: list[str] = []
    for item in ids:
        if not isinstance(item, str) or item not in ALL_IDS:
            shown = item if isinstance(item, str) else str(item)
            if shown not in unknown:
                unknown.append(shown)
        elif item in NOT_FOR_CUSTOM_ROLES:
            if item not in forbidden:
                forbidden.append(item)
        elif item in seen:
            if item not in duplicates:
                duplicates.append(item)
        else:
            seen.add(item)
    return CleanedIds(catalogue_order(seen), unknown, forbidden, duplicates)
