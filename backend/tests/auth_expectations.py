"""What each API route asks of the caller, by route key ("GET /api/health": method, then the path as the router spells it).

PUBLIC: no sign-in. SIGNED_IN: any signed-in account, whatever its role. Every other route names a permission:
ROUTE_PERMISSIONS, route key -> (mode, ids), where mode "all" means the caller must hold every id and "any" at least one.
The reason is the dict's value so a reader sees why a route is public or open to any account.
"""

# Routes that answer without a session.
PUBLIC: dict[str, str] = {
    "GET /api/health": "the container health check; it says only whether the database answers",
    "POST /api/login": "it is how a session starts",
    "POST /api/logout": "it ends the caller's own session; with none it is a no-op",
    "GET /api/setup": "tells the sign-in screen whether the first account still has to be created",
    "POST /api/setup": "creates the first account, once; refused (409) as soon as any account exists",
}

# Routes any signed-in account may call.
SIGNED_IN: dict[str, str] = {
    "GET /api/me": "the caller's own account",
    "POST /api/me/password": "changing your own password (it asks for the current one)",
    "PUT /api/me/preferences": "your own display settings (mode and theme)",
    "GET /api/site": "the site name every page header shows",
    "GET /api/version": "the build id every account may see in the profile menu",
    "GET /api/status": "the collector-alive chip in the shell",
}


def satisfies(held, mode: str, ids) -> bool:
    """Whether a caller holding the permission ids `held` passes a gate of this mode: "all" of `ids`, or "any" of them."""
    if mode == "all":
        return set(ids) <= set(held)
    if mode == "any":
        return not set(ids).isdisjoint(held)
    raise ValueError(f"unknown gate mode {mode!r}")


def _table(*groups: tuple[str, tuple[str, ...], tuple[str, ...]]) -> dict[str, tuple[str, tuple[str, ...]]]:
    table: dict[str, tuple[str, tuple[str, ...]]] = {}
    for mode, ids, keys in groups:
        for key in keys:
            assert key not in table, f"{key} is listed twice"
            table[key] = (mode, ids)
    return table


def _all(permission: str, *keys: str):
    return ("all", (permission,), keys)


def _any(ids: tuple[str, ...], *keys: str):
    return ("any", ids, keys)


# What each remaining route asks for. Written from the routes the code had before W9a (docs/superpowers/plans/
# 2026-10-13-w9a-permissions-enforcement.md, Appendix B); tests/fixtures/auth_matrix_pre_w9a.json proves the built-in
# roles still get the answers they got. Keys are "METHOD path" with the path as the router spells it.
ROUTE_PERMISSIONS: dict[str, tuple[str, tuple[str, ...]]] = _table(
    _all("assets.view", "GET /api/assets", "GET /api/assets/{asset_id}/series", "GET /api/assets/{asset_id}/summary",
         "GET /api/fleet/summary"),
    _all("assets.edit", "POST /api/assets", "PATCH /api/assets/{asset_id}", "POST /api/mappings",
         "PATCH /api/mappings/{mapping_id}", "DELETE /api/mappings/{mapping_id}"),
    # Added in W7m (asset kinds): after the freeze, so not in auth_matrix_pre_w9a.json; the gate and isolation tests cover them.
    _all("assets.view", "GET /api/asset-kinds"),
    # Added in W7p (moving assets in the tree): after the freeze, so not in auth_matrix_pre_w9a.json; the gate and isolation tests cover them.
    _all("assets.edit", "POST /api/assets/move", "POST /api/assets/move-preview"),
    # Every change to the kinds list moved from assets.edit to assets.kinds in W7o (migration 0011 grants it to the custom roles that held assets.edit).
    _all("assets.kinds", "POST /api/asset-kinds", "PATCH /api/asset-kinds/{kind_id}", "DELETE /api/asset-kinds/{kind_id}",
         "POST /api/asset-kinds/starter-pack"),
    _all("assets.delete", "DELETE /api/assets/{asset_id}", "GET /api/assets/{asset_id}/impact"),
    _all("dashboards.view", "GET /api/dashboards", "GET /api/dashboards/default", "GET /api/dashboards/{dashboard_id}",
         "POST /api/widget-data", "POST /api/widget-data/csv"),
    _all("dashboards.edit", "POST /api/dashboards", "PUT /api/dashboards/{dashboard_id}",
         "DELETE /api/dashboards/{dashboard_id}"),
    _all("dashboards.default", "PUT /api/dashboards/default"),
    _all("billing.view", "GET /api/billing/costs", "GET /api/billing/months"),
    _all("billing.export", "GET /api/billing/costs.csv"),
    # The currency read moved from tariffs.edit to tariffs.view in W9b (the read-only Tariffs page shows it): the one cell of
    # the frozen matrix that differs on purpose, named in test_auth_matrix.py (CHANGED_AFTER_FREEZE).
    _all("tariffs.view", "GET /api/tariffs", "GET /api/settings/billing"),
    _all("tariffs.edit", "POST /api/tariffs", "PATCH /api/tariffs/{tariff_id}", "DELETE /api/tariffs/{tariff_id}",
         "PUT /api/settings/billing"),
    _all("sources.view", "GET /api/sources", "GET /api/sources/{source_id}/points", "GET /api/collector/status",
         "GET /api/secret-key/status"),
    _all("sources.edit", "POST /api/sources", "PATCH /api/sources/{source_id}", "DELETE /api/sources/{source_id}",
         "POST /api/sources/{source_id}/browse", "GET /api/connectors", "GET /api/sources/{source_id}/impact"),
    _all("sources.test", "POST /api/sources/test-all", "POST /api/sources/{source_id}/test"),
    _all("diagnostics.run", "POST /api/sources/{source_id}/check"),
    _all("diagnostics.view", "GET /api/diagnostics/report"),
    _all("discovery.view", "GET /api/discovery/graph", "GET /api/scans", "GET /api/scans/{scan_id}", "GET /api/scopes"),
    _all("discovery.edit", "PUT /api/discovery/layout", "POST /api/scopes", "PATCH /api/scopes/{scope_id}",
         "DELETE /api/scopes/{scope_id}", "GET /api/scopes/suggestions"),
    # A scan is confirmed against its preview (how many hosts, which digest), so a role that may start scans must read it.
    _any(("discovery.edit", "discovery.scan"), "GET /api/scopes/{scope_id}/preview"),
    _all("discovery.scan", "POST /api/scopes/{scope_id}/scan"),
    _all("discovery.accept", "POST /api/discovery/accept"),
    # Added in W7r (removing discovered sources that have nothing mapped): after the freeze, so not in auth_matrix_pre_w9a.json;
    # the gate and isolation tests cover it.
    _all("discovery.edit", "POST /api/discovery/sources/remove"),
    # Added in W7t (Tidy layout: clears every saved node position); after the freeze, like the route above.
    _all("discovery.edit", "DELETE /api/discovery/layout"),
    _all("storage.view", "GET /api/storage", "GET /api/storage/rows-per-day", "GET /api/settings/storage"),
    _all("storage.edit", "PUT /api/settings/storage", "PUT /api/settings/storage/default"),
    _all("settings.view", "GET /api/settings/general", "GET /api/settings/sign-in", "GET /api/tls/status"),
    _all("settings.edit", "PUT /api/settings/general"),
    # Added in W9b: the sign-in protection left settings.edit. The built-in roles are unaffected (Admin holds every id).
    _all("settings.security", "PUT /api/settings/sign-in"),
    _all("audit.view", "GET /api/audit", "GET /api/audit/options", "GET /api/audit/position",
         "GET /api/audit/{entry_id:int}"),
    _all("audit.export", "GET /api/audit.csv"),
    _all("users.view", "GET /api/users"),
    _all("users.edit", "POST /api/users", "PATCH /api/users/{user_id}", "DELETE /api/users/{user_id}",
         "POST /api/users/{user_id}/unblock"),
    # Added after the freeze (the roles API): not in auth_matrix_pre_w9a.json, covered by the gate and isolation tests.
    _all("roles.manage", "GET /api/permissions", "POST /api/roles", "PATCH /api/roles/{role_id}",
         "DELETE /api/roles/{role_id}", "POST /api/roles/{role_id}/duplicate"),
    # The Users page needs the role names for its select, so whoever may see or change users may list the roles.
    _any(("roles.manage", "users.view", "users.edit"), "GET /api/roles"),
    # Every kind of job the API starts needs one of these, so whoever started one may follow it.
    _any(("sources.test", "diagnostics.run", "discovery.scan", "sources.edit"), "GET /api/jobs/{job_id}"),
    # The live values: the Assets Tree and the dashboards both show them.
    _any(("assets.view", "dashboards.view"), "GET /api/stream"),
)
